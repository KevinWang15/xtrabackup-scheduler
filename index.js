import { spawn } from "child_process";
import fs from "fs/promises";
import path from "path";
import os from "os";
import {
  S3Client,
  PutObjectCommand,
  ListObjectsCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import axios from "axios";

// Configuration
const config = {
  dbUser: process.env.DB_USER,
  dbPassword: process.env.DB_PASSWORD,
  dbHost: process.env.DB_HOST,
  s3Bucket: process.env.S3_BUCKET,
  s3Endpoint: process.env.S3_ENDPOINT,
  s3BackupDir: process.env.BACKUP_DIR || "",
  healthCheckUrl: process.env.HEALTH_CHECK_URL,
  backupInterval: 3 * 60 * 60 * 1000, // 3 hours
  retentionDays: 30,
  backupRoot: path.join(os.tmpdir(), "mysql-backup-" + process.pid),
};

// Validate environment variables
const requiredEnvVars = [
  "DB_USER",
  "DB_PASSWORD",
  "DB_HOST",
  "S3_BUCKET",
  "S3_ENDPOINT",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
];

for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    logError(`Error: Required environment variable ${envVar} is not set`);
    process.exit(1);
  }
}

// Custom logging functions to prepend timestamp
function log(...args) {
  const timestamp = new Date().toISOString();
  console.log(timestamp, ...args);
}

function logError(...args) {
  const timestamp = new Date().toISOString();
  console.error(timestamp, ...args);
}

// Helper function to format dates
function formatDate(date = new Date()) {
  return date.toISOString().slice(0, 10).replace(/-/g, "");
}

function formatDateTime(date = new Date()) {
  return date
    .toISOString()
    .slice(0, 19)
    .replace(/[-:T]/g, "")
    .replace(/\.\d{3}Z$/, "");
}

// Initialize S3 client for Backblaze B2
const s3Client = new S3Client({
  endpoint: `https://${config.s3Endpoint}`,
  region: "us-east-1",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

// Helper function to run commands with streaming output
function runCommand(command, args = []) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });

    proc.stdout.pipe(process.stdout);
    proc.stderr.pipe(process.stderr);

    proc.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(
            `${command} ${args.join(" ")} failed with exit code ${code}`,
          ),
        );
      }
    });
  });
}

// Helper function to upload to B2
async function uploadToB2(filePath, key) {
  log(`Uploading ${filePath} to B2 with key: ${key}`);
  const fileContent = await fs.readFile(filePath);
  const s3Key = config.s3BackupDir
    ? `${config.s3BackupDir.replace(/^\/+|\/+$/g, "")}/${key}`
    : key;
  await s3Client.send(
    new PutObjectCommand({
      Bucket: config.s3Bucket,
      Key: s3Key,
      Body: fileContent,
    }),
  );
  log(`Upload of ${filePath} as ${s3Key} completed.`);
}

// Helper function to cleanup old backups in B2
async function cleanupOldBackups() {
  const cutoffDate = new Date(
    Date.now() - config.retentionDays * 24 * 60 * 60 * 1000,
  );

  const listCommand = new ListObjectsCommand({
    Bucket: config.s3Bucket,
    Prefix: config.s3BackupDir
      ? config.s3BackupDir.replace(/^\/+|\/+$/g, "") + "/"
      : undefined,
  });

  try {
    const response = await s3Client.send(listCommand);
    if (!response.Contents) return;

    for (const object of response.Contents) {
      if (object.LastModified && object.LastModified < cutoffDate) {
        await s3Client.send(
          new DeleteObjectCommand({
            Bucket: config.s3Bucket,
            Key: object.Key,
          }),
        );
        log(`Deleted old backup: ${object.Key}`);
      }
    }
  } catch (error) {
    logError("Error cleaning up old backups:", error);
  }
}

// Helper function to cleanup old backup directories
async function cleanupOldDirectories(currentDate) {
  const entries = await fs.readdir(config.backupRoot);

  for (const entry of entries) {
    if (
      entry.startsWith("full_backup_") &&
      entry !== `full_backup_${currentDate}`
    ) {
      const dirPath = path.join(config.backupRoot, entry);
      try {
        await fs.rm(dirPath, { recursive: true, force: true });
        log(`Removed old backup directory: ${dirPath}`);
      } catch (error) {
        logError(`Error removing directory ${dirPath}:`, error);
      }
    }
  }
}

// Function to perform full backup
async function performFullBackup() {
  const currentDate = formatDate();
  const backupDir = path.join(config.backupRoot, `full_backup_${currentDate}`);

  log("Performing full backup...");

  try {
    // Clean up old backup directories first
    await cleanupOldDirectories(currentDate);

    // Create new backup directory
    await fs.mkdir(backupDir, { recursive: true });

    await runCommand("xtrabackup", [
      "--backup",
      `--user=${config.dbUser}`,
      `--password=${config.dbPassword}`,
      `--host=${config.dbHost}`,
      `--target-dir=${backupDir}`,
      "--no-lock",
    ]);

    log("Backup complete. Now creating tar archive for full backup...");
    const tarFile = path.join(
      config.backupRoot,
      `full_backup_${currentDate}.tar.gz`,
    );
    await runCommand("tar", ["czf", tarFile, "-C", backupDir, "."]);

    log(`Full backup tar created at ${tarFile}. Uploading to B2...`);
    await uploadToB2(tarFile, path.basename(tarFile));

    // Cleanup tar file
    await fs.unlink(tarFile);
    log(`Tar file ${tarFile} removed after upload.`);

    log("Full backup completed successfully");
    return backupDir;
  } catch (error) {
    logError("Error during full backup:", error);
    throw error;
  }
}

// Function to perform incremental backup
async function performIncrementalBackup(baseDir) {
  const currentDateTime = formatDateTime();
  log("Performing incremental backup...");

  try {
    const incrementalDir = path.join(
      config.backupRoot,
      `inc_backup_${currentDateTime}`,
    );
    await fs.mkdir(incrementalDir, { recursive: true });

    await runCommand("xtrabackup", [
      "--backup",
      `--user=${config.dbUser}`,
      `--password=${config.dbPassword}`,
      `--host=${config.dbHost}`,
      `--target-dir=${incrementalDir}`,
      `--incremental-basedir=${baseDir}`,
      "--no-lock",
    ]);

    log("Incremental backup complete. Creating tar archive...");
    const tarFile = path.join(
      config.backupRoot,
      `inc_backup_${currentDateTime}.tar.gz`,
    );
    await runCommand("tar", ["czf", tarFile, "-C", incrementalDir, "."]);

    log(`Incremental backup tar created at ${tarFile}. Uploading to B2...`);
    await uploadToB2(tarFile, path.basename(tarFile));

    // Cleanup
    await fs.unlink(tarFile);
    await fs.rm(incrementalDir, { recursive: true, force: true });
    log(`Tar file ${tarFile} and incremental directory removed after upload.`);

    log("Incremental backup completed successfully");
  } catch (error) {
    logError("Error during incremental backup:", error);
    throw error;
  }
}

// Function to ping healthchecks.io
async function pingHealthcheck() {
  if (config.healthCheckUrl) {
    try {
      await axios.get(config.healthCheckUrl, { timeout: 10000 });
      log("Successfully pinged healthcheck");
    } catch (error) {
      logError("Failed to ping healthcheck:", error);
    }
  }
}

// Function to get current full backup directory
async function getCurrentFullBackupDir() {
  const currentDate = formatDate();
  const fullBackupDir = path.join(
    config.backupRoot,
    `full_backup_${currentDate}`,
  );

  try {
    await fs.access(fullBackupDir);
    return fullBackupDir;
  } catch {
    return null;
  }
}

// Main backup function
async function runBackup() {
  try {
    let baseDir = await getCurrentFullBackupDir();

    if (!baseDir) {
      log("No full backup for today found. Starting a new full backup.");
      await performFullBackup();
    } else {
      log("Found today's full backup. Performing incremental backup.");
      await performIncrementalBackup(baseDir);
    }

    log("Cleaning up old backups...");
    await cleanupOldBackups();

    await pingHealthcheck();
  } catch (error) {
    logError("Backup failed:", error);
    process.exit(1);
  }
}

// Main loop
async function main() {
  // Create backup root directory on startup
  await fs.mkdir(config.backupRoot, { recursive: true });
  log(`Created backup directory: ${config.backupRoot}`);

  while (true) {
    await runBackup();
    log(`Sleeping for ${config.backupInterval / (60 * 60 * 1000)} hours...`);
    await new Promise((resolve) => setTimeout(resolve, config.backupInterval));
  }
}

// Start the backup process
main().catch((error) => {
  logError("Fatal error:", error);
  process.exit(1);
});
