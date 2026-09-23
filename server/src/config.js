const path = require('path');
const fs = require('fs');

require('dotenv').config();

const config = {
  env: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || '3000', 10),
  jwtSecret: process.env.JWT_SECRET || 'cms-default-jwt-secret-change-me-in-production',
  accessTtl: parseInt(process.env.ACCESS_TOKEN_TTL || '7200', 10),
  refreshTtl: parseInt(process.env.REFRESH_TOKEN_TTL || '604800', 10),
  deviceTtl: parseInt(process.env.DEVICE_TOKEN_TTL || '2592000', 10),
  autoApprove: (process.env.AUTO_APPROVE || 'true') === 'true',
  publicBaseUrl: process.env.PUBLIC_BASE_URL || '',
  db: {
    client: process.env.DB_CLIENT || 'better-sqlite3',
    file: process.env.DB_FILE || './data/cms.sqlite',
    host: process.env.DB_HOST || '127.0.0.1',
    port: parseInt(process.env.DB_PORT || '3306', 10),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'cms',
  },
  // 心跳判定: 90 秒无心跳 = 离线 (需求 5.1.3)
  offlineThresholdMs: 90 * 1000,
  // 心跳采样与状态翻转扫描间隔
  sweepIntervalMs: 30 * 1000,
  dataDir: process.env.DATA_DIR || path.join(__dirname, '..', 'data'),
  uploadsDir: process.env.UPLOADS_DIR || path.join(__dirname, '..', 'uploads'),
  // Cloudflare R2 对象存储 (S3 兼容): 环境变量齐全时自动启用, 否则全部走本地磁盘
  r2: {
    accountId: process.env.R2_ACCOUNT_ID || '',
    bucket: process.env.R2_BUCKET || '',
    accessKeyId: process.env.R2_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || '',
  },
};

config.r2.enabled = !!(config.r2.accountId && config.r2.bucket && config.r2.accessKeyId && config.r2.secretAccessKey);

// SQLite 默认落到 DATA_DIR (PaaS 持久盘), 保证随数据目录持久化
config.db.file = process.env.DB_FILE || path.join(config.dataDir, 'cms.sqlite');

fs.mkdirSync(config.dataDir, { recursive: true });
fs.mkdirSync(path.join(config.uploadsDir, 'videos'), { recursive: true });
fs.mkdirSync(path.join(config.uploadsDir, 'covers'), { recursive: true });
fs.mkdirSync(path.join(config.uploadsDir, 'screenshots'), { recursive: true });

module.exports = config;
