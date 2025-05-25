import { spawn } from "child_process";
import fs from "fs/promises";
import path from "path";
import os from "os";
import readline from "readline";
import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
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
  proxy: process.env.PROXY,
  restoreRoot: path.join(process.cwd(), "mysql-restore-" + new Date().toISOString().slice(0, 19).replace(/[:-]/g, "")),
};

// Validate environment variables
const requiredEnvVars = [
  "S3_BUCKET",
  "S3_ENDPOINT",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
];

for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    console.error(`Error: Required environment variable ${envVar} is not set`);
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

// Helper function to format bytes to human readable
function formatBytes(bytes) {
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  if (bytes === 0) return "0 B";
  const i = parseInt(Math.floor(Math.log(bytes) / Math.log(1024)));
  return Math.round(bytes / Math.pow(1024, i) * 100) / 100 + " " + sizes[i];
}

// Helper function to list backups from S3
async function listBackups() {
  const prefix = config.s3BackupDir
    ? config.s3BackupDir.replace(/^\/+|\/+$/g, "") + "/"
    : "";

  const command = new ListObjectsV2Command({
    Bucket: config.s3Bucket,
    Prefix: prefix,
    MaxKeys: 1000,
  });

  try {
    const response = await s3Client.send(command);
    if (!response.Contents || response.Contents.length === 0) {
      log("No backups found in S3");
      return [];
    }

    // Filter and sort backups
    const backups = response.Contents
      .filter((obj) => obj.Key.endsWith(".tar.gz"))
      .map((obj) => {
        const filename = path.basename(obj.Key);
        const isIncremental = filename.startsWith("inc_backup_");
        let date;
        
        if (isIncremental) {
          // inc_backup_YYYYMMDDHHmmss.tar.gz
          const dateStr = filename.replace("inc_backup_", "").replace(".tar.gz", "");
          date = new Date(
            dateStr.substr(0, 4) + "-" +
            dateStr.substr(4, 2) + "-" +
            dateStr.substr(6, 2) + "T" +
            dateStr.substr(8, 2) + ":" +
            dateStr.substr(10, 2) + ":" +
            dateStr.substr(12, 2)
          );
        } else {
          // full_backup_YYYYMMDD.tar.gz
          const dateStr = filename.replace("full_backup_", "").replace(".tar.gz", "");
          date = new Date(
            dateStr.substr(0, 4) + "-" +
            dateStr.substr(4, 2) + "-" +
            dateStr.substr(6, 2)
          );
        }

        return {
          key: obj.Key,
          filename: filename,
          size: obj.Size,
          date: date,
          isIncremental: isIncremental,
          lastModified: obj.LastModified,
        };
      })
      .sort((a, b) => b.date - a.date)
      .slice(0, 20); // Get only the 20 most recent

    return backups;
  } catch (error) {
    logError("Error listing backups:", error);
    throw error;
  }
}

// Helper function to download file from S3
async function downloadFromS3(key, localPath) {
  log(`Downloading ${key} from S3...`);
  
  const command = new GetObjectCommand({
    Bucket: config.s3Bucket,
    Key: key,
  });

  try {
    const response = await s3Client.send(command);
    const stream = response.Body;
    
    // Convert stream to buffer
    const chunks = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
    }
    const buffer = Buffer.concat(chunks);
    
    await fs.writeFile(localPath, buffer);
    log(`Downloaded ${key} to ${localPath}`);
  } catch (error) {
    logError("Error downloading from S3:", error);
    throw error;
  }
}

// Helper function to run commands with streaming output
function runCommand(command, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, { 
      stdio: ["ignore", "pipe", "pipe"],
      ...options 
    });

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

// Helper function to get user input
function getUserInput(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

// Function to find related backups
function findRelatedBackups(backups, selectedBackup) {
  const relatedBackups = [];
  
  if (selectedBackup.isIncremental) {
    // Find the full backup for this incremental
    const incDate = selectedBackup.date;
    const dateStr = incDate.toISOString().slice(0, 10).replace(/-/g, "");
    
    // Find the full backup from the same day
    const fullBackup = backups.find(
      (b) => !b.isIncremental && b.filename === `full_backup_${dateStr}.tar.gz`
    );
    
    if (!fullBackup) {
      throw new Error(`Cannot find full backup for date ${dateStr}. Incremental backups cannot be restored without their base full backup.`);
    }
    
    relatedBackups.push(fullBackup);
    
    // Find all incrementals between the full backup and selected incremental
    const incrementals = backups
      .filter(
        (b) =>
          b.isIncremental &&
          b.date >= fullBackup.date &&
          b.date <= selectedBackup.date &&
          b.filename.startsWith(`inc_backup_${dateStr}`)
      )
      .sort((a, b) => a.date - b.date);
    
    relatedBackups.push(...incrementals);
  } else {
    // Just the full backup
    relatedBackups.push(selectedBackup);
  }
  
  return relatedBackups;
}

// Function to restore backups
async function restoreBackups(backupsToRestore) {
  const baseDir = path.join(config.restoreRoot, "base");
  await fs.mkdir(baseDir, { recursive: true });

  log("\n=== Starting restore process ===");
  log(`Restoring ${backupsToRestore.length} backup(s)...`);

  // Download and extract full backup first
  const fullBackup = backupsToRestore[0];
  log(`\n1. Restoring full backup: ${fullBackup.filename}`);
  
  const fullBackupPath = path.join(config.restoreRoot, fullBackup.filename);
  await downloadFromS3(fullBackup.key, fullBackupPath);
  
  log("Extracting full backup...");
  await runCommand("tar", ["xzf", fullBackupPath, "-C", baseDir]);
  await fs.unlink(fullBackupPath);

  // If we have incremental backups, prepare the base backup with --apply-log-only
  if (backupsToRestore.length > 1) {
    log("\nPreparing base backup for incremental restore...");
    await runCommand("xtrabackup", [
      "--prepare",
      "--apply-log-only",
      `--target-dir=${baseDir}`,
    ]);
  }

  // Apply incrementals if any
  for (let i = 1; i < backupsToRestore.length; i++) {
    const incBackup = backupsToRestore[i];
    log(`\n${i + 1}. Applying incremental backup: ${incBackup.filename}`);
    
    const incBackupPath = path.join(config.restoreRoot, incBackup.filename);
    const incDir = path.join(config.restoreRoot, `inc_${i}`);
    
    await downloadFromS3(incBackup.key, incBackupPath);
    await fs.mkdir(incDir, { recursive: true });
    
    log("Extracting incremental backup...");
    await runCommand("tar", ["xzf", incBackupPath, "-C", incDir]);
    await fs.unlink(incBackupPath);
    
    log("Preparing incremental backup...");
    await runCommand("xtrabackup", [
      "--prepare",
      "--apply-log-only",
      `--target-dir=${baseDir}`,
      `--incremental-dir=${incDir}`,
    ]);
    
    // Clean up incremental directory
    await fs.rm(incDir, { recursive: true, force: true });
  }

  // Final prepare
  log("\nRunning final prepare...");
  await runCommand("xtrabackup", [
    "--prepare",
    `--target-dir=${baseDir}`,
  ]);

  log("\n=== Restore preparation complete ===");
  log(`\nRestored data is ready in: ${baseDir}`);
  
  log("\n📁 IMPORTANT: The restored data is saved in the above directory.");
  log("   This directory will NOT be automatically deleted.\n");
  
  log("To restore this backup to MySQL:");
  log("1. Stop MySQL server");
  log("2. Back up your current data directory (just in case)");
  log("3. Empty your MySQL data directory");
  log("4. Run: xtrabackup --copy-back --datadir=/var/lib/mysql --target-dir=" + baseDir);
  log("5. Fix ownership: chown -R mysql:mysql /var/lib/mysql");
  log("6. Start MySQL server");
  
  log("\nAlternatively, you can manually copy the files from the restore directory.");
}

// Main function
async function main() {
  try {
    log("=== XtraBackup Restore Tool ===\n");
    
    // List backups
    log("Fetching backup list from S3...");
    const backups = await listBackups();
    
    if (backups.length === 0) {
      log("No backups found.");
      return;
    }
    
    // Display backups
    console.log("\nAvailable backups (most recent first):");
    console.log("─".repeat(80));
    console.log("No. | Type        | Date & Time          | Size      | Filename");
    console.log("─".repeat(80));
    
    backups.forEach((backup, index) => {
      const type = backup.isIncremental ? "Incremental" : "Full      ";
      const dateStr = backup.date.toISOString().replace("T", " ").slice(0, 19);
      const sizeStr = formatBytes(backup.size).padEnd(9);
      console.log(
        `${(index + 1).toString().padStart(2)}. | ${type} | ${dateStr} | ${sizeStr} | ${backup.filename}`
      );
    });
    console.log("─".repeat(80));
    
    // Get user selection
    const selection = await getUserInput("\nEnter backup number to restore (or 'q' to quit): ");
    
    if (selection.toLowerCase() === "q") {
      log("Restore cancelled.");
      return;
    }
    
    const selectedIndex = parseInt(selection) - 1;
    if (isNaN(selectedIndex) || selectedIndex < 0 || selectedIndex >= backups.length) {
      logError("Invalid selection.");
      return;
    }
    
    const selectedBackup = backups[selectedIndex];
    log(`\nSelected: ${selectedBackup.filename}`);
    
    // Find all related backups needed for restore
    const backupsToRestore = findRelatedBackups(backups, selectedBackup);
    
    log("\nBackups required for restore:");
    backupsToRestore.forEach((backup, index) => {
      log(`  ${index + 1}. ${backup.filename} (${formatBytes(backup.size)})`);
    });
    
    const proceed = await getUserInput("\nProceed with restore? (yes/no): ");
    
    if (proceed.toLowerCase() !== "yes") {
      log("Restore cancelled.");
      return;
    }
    
    // Create restore directory
    await fs.mkdir(config.restoreRoot, { recursive: true });
    
    // Perform restore
    await restoreBackups(backupsToRestore);
    
  } catch (error) {
    logError("Restore failed:", error);
    process.exit(1);
  }
}

// Run the restore tool
main().catch((error) => {
  logError("Fatal error:", error);
  process.exit(1);
});