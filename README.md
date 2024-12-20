# MySQL Backup Script

An automated Node.js script for performing MySQL backups using Percona XtraBackup. The script handles both full and incremental backups, automatically uploads them to Backblaze B2, and maintains a specified retention period.

## Features

- Automated full and incremental MySQL backups using XtraBackup
- Intelligent backup scheduling based on the age of the last full backup
- Automatic upload to Backblaze B2
- Cleanup of old backups (both local and remote)
- Healthchecks.io integration for monitoring
- Uses temporary directories for clean handling of backup files
- Written in modern Node.js with proper error handling

## Prerequisites

- Node.js 16.x or higher
- Percona XtraBackup installed on the system
- Access to a MySQL/MariaDB server
- Backblaze B2 account with bucket and application keys
- (Optional) Healthchecks.io account for monitoring

## Installation

1. Clone this repository:
```bash
git clone https://github.com/yourusername/mysql-backup
cd mysql-backup
```

2. Install dependencies:
```bash
npm install @aws-sdk/client-s3 axios
```

3. Create a `.env` file with your configuration:
```env
DB_USER=your_database_user
DB_PASSWORD=your_database_password
DB_HOST=your_database_host
S3_BUCKET=your_b2_bucket_name
S3_ENDPOINT=your_b2_endpoint
AWS_ACCESS_KEY_ID=your_b2_key_id
AWS_SECRET_ACCESS_KEY=your_b2_application_key
HEALTH_CHECK_URL=your_healthchecks_url  # Optional
```

## Configuration

The script uses the following configuration options, which can be modified in the `config` object:

```javascript
const config = {
  backupInterval: 3 * 60 * 60 * 1000,  // 3 hours in milliseconds
  retentionDays: 30,                   // How long to keep backups
  fullBackupAge: 24 * 60 * 60 * 1000,  // Create new full backup after 1 day
};
```

## Usage

Run the script:
```bash
node backup.js
```

The script will:
1. Check if a full backup is needed (older than 1 day)
2. Perform either a full or incremental backup
3. Upload the backup to Backblaze B2
4. Clean up old backups
5. Ping healthchecks.io (if configured)
6. Sleep for the configured interval (default: 3 hours)

## Backup Process

### Full Backup
- Created when no previous backup exists or the last full backup is older than 1 day
- Uses XtraBackup with --no-lock for minimal impact on the running database
- Compressed using tar before upload

### Incremental Backup
- Created when a valid full backup exists and is less than 1 day old
- Based on the last full backup
- Smaller and faster than full backups
- Also compressed before upload

## Monitoring

The script integrates with healthchecks.io for monitoring. To use this feature:
1. Create a check on healthchecks.io
2. Add the ping URL to your .env file as HEALTH_CHECK_URL
3. The script will ping this URL after each successful backup

## Backup Retention

- Local backups: Stored in temporary directories and cleaned up after upload
- Remote backups: Kept for 30 days (configurable via retentionDays)
- Automatic cleanup of old backups during each backup run

## Error Handling

The script includes comprehensive error handling:
- Validates all required environment variables
- Proper cleanup of temporary files
- Detailed error logging
- Process exit on fatal errors

## Running in Production

For production use, it's recommended to:
1. Run the script using a process manager like PM2:
```bash
npm install -g pm2
pm2 start backup.js --name mysql-backup
```

2. Set up proper logging:
```bash
pm2 start backup.js --name mysql-backup --log ./logs/backup.log
```

3. Configure automatic startup:
```bash
pm2 startup
pm2 save
```

## Troubleshooting

Common issues and solutions:

1. **XtraBackup fails to connect**
    - Verify database credentials
    - Check database host accessibility
    - Ensure proper permissions for the backup user

2. **B2 upload fails**
    - Verify B2 credentials
    - Check bucket permissions
    - Ensure proper network connectivity

3. **Temporary directory issues**
    - Verify sufficient disk space
    - Check filesystem permissions
    - Ensure temp directory is writable

## License

MIT License - See LICENSE file for details

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.