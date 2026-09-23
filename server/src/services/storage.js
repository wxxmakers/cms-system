/**
 * 统一存储层: 本地磁盘 ↔ Cloudflare R2 (S3 兼容)
 * R2_* 环境变量齐全时自动启用 R2; 否则全部走本地磁盘, 调用方无感知。
 * 数据库中统一存相对 key (如 videos/xxx.mp4), URL 保持 /files/<key> 不变。
 */
const fs = require('fs');
const path = require('path');
const config = require('../config');

let client = null;
if (config.r2.enabled) {
  const { S3Client } = require('@aws-sdk/client-s3');
  client = new S3Client({
    region: 'auto',
    endpoint: `https://${config.r2.accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: config.r2.accessKeyId,
      secretAccessKey: config.r2.secretAccessKey,
    },
  });
}

const MIME = {
  '.mp4': 'video/mp4', '.avi': 'video/mp4', '.mov': 'video/mp4',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
};

function guessType(key) {
  return MIME[path.extname(key).toLowerCase()] || 'application/octet-stream';
}

/** 上传本地文件到存储 (R2 模式上传后删除本地临时文件; 本地模式为空操作) */
async function putFile(localPath, key) {
  if (!client) return;
  const { PutObjectCommand } = require('@aws-sdk/client-s3');
  await client.send(new PutObjectCommand({
    Bucket: config.r2.bucket,
    Key: key,
    Body: fs.createReadStream(localPath),
    ContentType: guessType(key),
  }));
  try { fs.unlinkSync(localPath); } catch { /* ignore */ }
}

/** 上传内存数据 (封面等小文件) */
async function putBuffer(buf, key) {
  if (!client) {
    fs.writeFileSync(path.join(config.uploadsDir, key), buf);
    return;
  }
  const { PutObjectCommand } = require('@aws-sdk/client-s3');
  await client.send(new PutObjectCommand({
    Bucket: config.r2.bucket,
    Key: key,
    Body: buf,
    ContentType: guessType(key),
  }));
}

/**
 * 读取文件流 (支持 Range 断点续传)
 * 返回 null = 不存在; 否则 { stream, size, contentType, contentRange? }
 */
async function getStream(key, rangeHeader) {
  if (!client) {
    const p = path.join(config.uploadsDir, key);
    if (!fs.existsSync(p)) return null;
    const stat = fs.statSync(p);
    const base = { size: stat.size, contentType: guessType(key) };
    const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader || '');
    if (m && (m[1] || m[2])) {
      const start = m[1] ? parseInt(m[1], 10) : 0;
      const end = m[2] ? parseInt(m[2], 10) : stat.size - 1;
      return { ...base, stream: fs.createReadStream(p, { start, end }), contentRange: `bytes ${start}-${end}/${stat.size}` };
    }
    return { ...base, stream: fs.createReadStream(p) };
  }
  const { GetObjectCommand } = require('@aws-sdk/client-s3');
  const input = { Bucket: config.r2.bucket, Key: key };
  const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader || '');
  if (m && (m[1] || m[2])) {
    const size = await headSize(key);
    const start = m[1] ? parseInt(m[1], 10) : 0;
    const end = m[2] ? parseInt(m[2], 10) : size - 1;
    input.Range = `bytes=${start}-${end}`;
    const res = await client.send(new GetObjectCommand(input));
    return { stream: res.Body, size, contentType: res.ContentType || guessType(key), contentRange: `bytes ${start}-${end}/${size}` };
  }
  const res = await client.send(new GetObjectCommand(input));
  return { stream: res.Body, size: Number(res.ContentLength) || 0, contentType: res.ContentType || guessType(key) };
}

async function headSize(key) {
  const { HeadObjectCommand } = require('@aws-sdk/client-s3');
  const res = await client.send(new HeadObjectCommand({ Bucket: config.r2.bucket, Key: key }));
  return Number(res.ContentLength) || 0;
}

/** 删除文件 (两种模式都安全, 不存在时静默) */
async function remove(key) {
  if (!client) {
    try { fs.unlinkSync(path.join(config.uploadsDir, key)); } catch { /* ignore */ }
    return;
  }
  const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
  await client.send(new DeleteObjectCommand({ Bucket: config.r2.bucket, Key: key }));
}

module.exports = { putFile, putBuffer, getStream, remove, enabled: !!client };
