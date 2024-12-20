# XtraBackup Scheduler

Automated MySQL backup solution using Percona XtraBackup with S3 storage.

**Docker Image**: `ghcr.io/kevinwang15/xtrabackup-scheduler:latest`

## Features

- Daily full backups, hourly incremental backups
- Automatic upload to S3-compatible storage (Backblaze B2, AWS S3, etc.)
- 30-day retention with automatic cleanup
- Restore tool with point-in-time recovery
- Proxy support (HTTP/HTTPS/SOCKS5)
- Healthchecks.io monitoring

## Important Note

XtraBackup requires **direct filesystem access** to MySQL data directory. It cannot perform remote backups over the network.

## Quick Start

1. Create a `.env` file:
```env
# Required
MYSQL_ROOT_PASSWORD=your_mysql_password
S3_BUCKET=your_bucket_name
S3_ENDPOINT=s3.us-west-001.backblazeb2.com
AWS_ACCESS_KEY_ID=your_key_id
AWS_SECRET_ACCESS_KEY=your_secret_key

# Optional
BACKUP_DIR=mysql-backups/
HEALTH_CHECK_URL=https://hc-ping.com/your-uuid
PROXY=socks5://proxy.example.com:1080
```

2. Run with Docker Compose:
```bash
docker-compose up -d
```

This starts MySQL and the backup scheduler together.

## Restore

```bash
node restore.js
```

Select a backup from the list, and the tool will download and prepare it. For incremental backups, it automatically handles the full backup chain.

## How It Works

- **Full backups**: Created daily (format: `full_backup_YYYYMMDD.tar.gz`)
- **Incremental backups**: Created hourly (format: `inc_backup_YYYYMMDDHHmmss.tar.gz`)
- **Retention**: 30 days (configurable)
- **Storage**: Temporary files cleaned up after S3 upload

## Other Deployment Options

**Standalone Docker:**
```bash
docker run -d --name xtrabackup-scheduler \
  --env-file .env \
  -v /var/lib/mysql:/var/lib/mysql:ro \
  ghcr.io/kevinwang15/xtrabackup-scheduler:latest
```

**For existing MySQL installations:** Mount your MySQL data directory as shown above.

## Troubleshooting

- **XtraBackup errors**: Ensure the container has access to MySQL data directory
- **S3 upload fails**: Check credentials and network connectivity
- **Restore issues**: MySQL must be stopped before restore; fix file ownership after (`chown -R mysql:mysql /var/lib/mysql`)

## License

MIT