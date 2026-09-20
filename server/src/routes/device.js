const express = require('express');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('../db');
const config = require('../config');
const { signDeviceToken, authMiddleware, requireDevice } = require('../middleware/auth');
const lockout = require('../middleware/lockout');
const { clientIp, ok, fail } = require('../middleware/common');
const engine = require('../services/schedule-engine');

const router = express.Router();
const uploadScreenshot = multer({
  storage: multer.diskStorage({
    destination: path.join(config.uploadsDir, 'screenshots'),
    filename: (req, file, cb) => cb(null, `device_${req.auth.id}_${Date.now()}.jpg`),
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
});

function baseUrl(req) {
  if (config.publicBaseUrl) return config.publicBaseUrl.replace(/\/$/, '');
  const host = req.headers.host || `localhost:${config.port}`;
  return `http://${host}`;
}

// ===== 设备登录 =====
router.post('/login', async (req, res, next) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json(fail('账号密码不能为空'));

    const locked = lockout.checkLocked('device', username);
    if (locked) {
      await db('login_logs').insert({ username, type: 'device', ip: clientIp(req), ua: String(req.headers['user-agent'] || '').slice(0, 255), success: 0, msg: '锁定中' });
      return res.status(423).json(fail(locked));
    }

    const device = await db('devices').where({ username }).whereNull('deleted_at').first();
    const pass = device && await bcrypt.compare(password, device.password);
    if (!device || !pass) {
      lockout.recordFail('device', username);
      await db('login_logs').insert({ username, type: 'device', ip: clientIp(req), ua: String(req.headers['user-agent'] || '').slice(0, 255), success: 0, msg: '账号或密码错误' });
      return res.status(401).json(fail('账号或密码错误'));
    }

    lockout.recordSuccess('device', username);
    await db('devices').where({ id: device.id }).update({ last_online: new Date(), ip: clientIp(req) });
    await db('login_logs').insert({ username, type: 'device', ip: clientIp(req), ua: String(req.headers['user-agent'] || '').slice(0, 255), success: 1, msg: '登录成功' });

    return res.json(ok({
      token: signDeviceToken(device),
      deviceId: device.id,
      deviceName: device.device_name,
      serverTime: Date.now(),
    }));
  } catch (e) { next(e); }
});

// ===== 心跳: 每 30 秒一次, 携带硬件信息, 返回服务器时间 + 待执行指令 + 当前节目单版本 =====
router.post('/heartbeat', authMiddleware, requireDevice, async (req, res, next) => {
  try {
    const b = req.body || {};
    const now = new Date();
    await db('devices').where({ id: req.auth.id }).update({
      last_online: now,
      ip: clientIp(req),
      app_version: b.appVersion || null,
      model: b.model || null,
      android_version: b.androidVersion || null,
      resolution: b.resolution || null,
      network_type: b.networkType || null,
      storage_total: b.storageTotal != null ? String(b.storageTotal) : null,
      storage_free: b.storageFree != null ? String(b.storageFree) : null,
      temperature: b.temperature != null ? String(b.temperature) : null,
      current_video_id: b.currentVideoId || null,
      updated_at: now,
    });

    const pending = await db('commands')
      .where({ device_id: req.auth.id, status: 'pending' })
      .orderBy('id', 'asc')
      .limit(5);

    const device = await db('devices').where({ id: req.auth.id }).first();
    const resolved = await engine.resolveForDevice(device, now);

    return res.json(ok({
      serverTime: now.getTime(),
      playlistVersion: resolved.version,
      commands: pending.map((c) => ({ id: c.id, type: c.type, value: c.value })),
    }));
  } catch (e) { next(e); }
});

// ===== 拉取当前节目单 (排期引擎计算, 含素材下载地址 + MD5) =====
router.get('/playlist', authMiddleware, requireDevice, async (req, res, next) => {
  try {
    const device = await db('devices').where({ id: req.auth.id }).first();
    const resolved = await engine.resolveForDevice(device);
    const base = baseUrl(req);
    return res.json(ok({
      version: resolved.version,
      source: resolved.source,
      playlistId: resolved.playlistId,
      playlistName: resolved.playlistName,
      serverTime: Date.now(),
      items: resolved.items.map((it) => ({
        videoId: it.videoId,
        name: it.name,
        type: it.type,
        duration: it.duration,
        sortOrder: it.sortOrder,
        width: it.width,
        height: it.height,
        md5: it.md5,
        size: it.size,
        url: `${base}/files/videos/${path.basename(it.fileName)}`,
      })),
    }));
  } catch (e) { next(e); }
});

// ===== 播放日志上报 (批量) =====
router.post('/report', authMiddleware, requireDevice, async (req, res, next) => {
  try {
    const logs = Array.isArray(req.body?.logs) ? req.body.logs : [];
    const rows = logs
      .filter((l) => l && l.videoId)
      .slice(0, 200)
      .map((l) => ({
        device_id: req.auth.id,
        video_id: Number(l.videoId),
        start_ts: Number(l.startTs) || Date.now(),
        end_ts: Number(l.endTs) || Date.now(),
        duration: Math.max(0, Math.round(Number(l.duration) || 0)),
      }));
    if (rows.length) await db('play_logs').insert(rows);
    return res.json(ok({ accepted: rows.length }));
  } catch (e) { next(e); }
});

// ===== 指令回执 =====
router.post('/command/ack', authMiddleware, requireDevice, async (req, res, next) => {
  try {
    const { id, result, message } = req.body || {};
    if (!id) return res.status(400).json(fail('缺少指令 id'));
    const cmd = await db('commands').where({ id, device_id: req.auth.id }).first();
    if (!cmd) return res.status(404).json(fail('指令不存在'));
    await db('commands').where({ id }).update({
      status: result === 'success' ? 'done' : 'failed',
      result: String(message || '').slice(0, 255),
      done_at: new Date(),
    });
    return res.json(ok());
  } catch (e) { next(e); }
});

// ===== 播放截屏存证上传 (需求 附录A.15) =====
router.post('/screenshot', authMiddleware, requireDevice, uploadScreenshot.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json(fail('缺少截图文件'));
    const rel = path.join('screenshots', req.file.filename).replace(/\\/g, '/');
    await db('devices').where({ id: req.auth.id }).update({ screenshot: rel, updated_at: new Date() });
    // 若有截图指令待回执, 自动完成
    const cmd = await db('commands').where({ device_id: req.auth.id, type: 'screenshot', status: 'pending' }).orderBy('id', 'desc').first();
    if (cmd) await db('commands').where({ id: cmd.id }).update({ status: 'done', result: rel, done_at: new Date() });
    return res.json(ok({ url: `${baseUrl(req)}/files/${rel}` }));
  } catch (e) { next(e); }
});

// ===== OTA 版本检查 (预留, 当前返回无需升级) =====
router.get('/ota/check', authMiddleware, requireDevice, async (req, res) => {
  const current = Number(req.query.currentVersion || 0);
  const latestVersionCode = parseInt(process.env.OTA_LATEST_VERSION_CODE || '1', 10);
  const latestVersionName = process.env.OTA_LATEST_VERSION_NAME || '1.0';
  const otaUrl = process.env.OTA_URL || '';
  const hasUpdate = otaUrl && latestVersionCode > current;
  return res.json(ok({
    hasUpdate: !!hasUpdate,
    latest: hasUpdate ? { versionCode: latestVersionCode, versionName: latestVersionName, url: otaUrl, md5: process.env.OTA_MD5 || '' } : null,
    serverTime: Date.now(),
  }));
});

module.exports = router;
