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
import dotenv from "dotenv";
import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";

// Load environment variables from .env file
dotenv.config();

// Parse host and port from DB_HOST
let dbHost = process.env.DB_HOST;
let dbPort = "3306"; // default MySQL port
if (dbHost && dbHost.includes(":")) {
  const parts = dbHost.split(":");
  dbHost = parts[0];
  dbPort = parts[1];
}

// Configuration
const config = {
  dbUser: process.env.DB_USER,
  dbPassword: process.env.DB_PASSWORD,
  dbHost: dbHost,
  dbPort: dbPort,
  s3Bucket: process.env.S3_BUCKET,
  s3Endpoint: process.env.S3_ENDPOINT,
  s3BackupDir: process.env.BACKUP_DIR || "",
  healthCheckUrl: process.env.HEALTH_CHECK_URL,
  proxy: process.env.PROXY,
  backupInterval: 1 * 60 * 60 * 1000, // 1 hour
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

// Helper function to sanitize error messages
function sanitizeError(error) {
  if (error && error.message) {
    // Replace password in error messages
    return error.message.replace(/--password=[^\s]+/g, '--password=***');
  }
  return error;
}

function logError(...args) {
  const timestamp = new Date().toISOString();
  // Sanitize any Error objects in the arguments
  const sanitizedArgs = args.map(arg => {
    if (arg instanceof Error) {
      return sanitizeError(arg);
    }
    return arg;
  });
  console.error(timestamp, ...sanitizedArgs);
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

// Helper function to get proxy agent based on proxy URL
function getProxyAgent(proxyUrl) {
  if (!proxyUrl) return undefined;
  
  if (proxyUrl.startsWith("socks") || proxyUrl.startsWith("socks5://")) {
    return new SocksProxyAgent(proxyUrl);
  } else if (proxyUrl.startsWith("http://") || proxyUrl.startsWith("https://")) {
    return new HttpsProxyAgent(proxyUrl);
  }
  
  log(`Warning: Unknown proxy protocol in ${proxyUrl}, using https-proxy-agent`);
  return new HttpsProxyAgent(proxyUrl);
}

// Initialize S3 client for Backblaze B2
const s3ClientConfig = {
  endpoint: `https://${config.s3Endpoint}`,
  region: "us-east-1",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
};

// Add proxy configuration if provided
if (config.proxy) {
  const agent = getProxyAgent(config.proxy);
  s3ClientConfig.requestHandler = {
    httpsAgent: agent,
  };
  // Redact proxy credentials in log
  const safeProxy = config.proxy.replace(/:\/\/[^@]+@/, '://***@');
  log(`Using proxy: ${safeProxy}`);
}

const s3Client = new S3Client(s3ClientConfig);

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
        // Redact sensitive information from error messages
        const safeArgs = args.map(arg => {
          if (arg.startsWith("--password=")) {
            return "--password=***";
          }
          return arg;
        });
        reject(
          new Error(
            `${command} ${safeArgs.join(" ")} failed with exit code ${code}`,
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
      `--port=${config.dbPort}`,
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
      `--port=${config.dbPort}`,
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
      const axiosConfig = { timeout: 10000 };
      
      // Add proxy configuration if provided
      if (config.proxy) {
        const agent = getProxyAgent(config.proxy);
        axiosConfig.httpsAgent = agent;
        axiosConfig.httpAgent = agent;
      }
      
      await axios.get(config.healthCheckUrl, axiosConfig);
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
    // Check if directory exists
    await fs.access(fullBackupDir);
    
    // Also check if the backup checkpoint file exists (indicates a valid backup)
    const checkpointFile = path.join(fullBackupDir, "xtrabackup_checkpoints");
    await fs.access(checkpointFile);
    
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
