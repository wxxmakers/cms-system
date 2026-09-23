const express = require('express');
const path = require('path');
const cors = require('cors');
const config = require('./config');
const db = require('./db');
const { migrate } = require('./migrate');
const { errorHandler } = require('./middleware/common');
const storage = require('./services/storage');

const app = express();
app.disable('x-powered-by');
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

// 素材静态下载 (/files/videos/xxx.mp4), 支持 Range 断点续传
// R2 启用时从对象存储流式转发; 否则直接读本地磁盘
app.get('/files/*', async (req, res) => {
  try {
    const key = req.path.replace(/^\/files\//, '');
    if (key.includes('..')) return res.status(400).json({ code: 400, msg: '非法路径' });
    const info = await storage.getStream(key, req.headers.range);
    if (!info) return res.status(404).json({ code: 404, msg: '文件不存在' });
    res.setHeader('Content-Type', info.contentType || 'application/octet-stream');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (info.contentRange) {
      res.status(206).setHeader('Content-Range', info.contentRange);
    }
    info.stream.pipe(res);
  } catch (e) {
    if (e.name === 'NoSuchKey') return res.status(404).json({ code: 404, msg: '文件不存在' });
    res.status(500).json({ code: 500, msg: '读取失败' });
  }
});

app.get('/health', (req, res) => res.json({ code: 0, msg: 'ok', time: Date.now() }));

app.use('/api/device', require('./routes/device'));
app.use('/api/admin', require('./routes/admin'));

// ===== 托管 Web 管理端 (编译产物 web/dist): 局域网设备直接访问 http://<本机IP>:3000 =====
const webDist = path.join(__dirname, '../../web/dist');
const fs = require('fs');
if (fs.existsSync(path.join(webDist, 'index.html'))) {
  app.use(express.static(webDist));
  // SPA 路由回退: 非接口路径统一返回 index.html
  app.use((req, res, next) => {
    if (req.path.startsWith('/api/') || req.path.startsWith('/files/')) return next();
    res.sendFile(path.join(webDist, 'index.html'));
  });
}

app.use((req, res) => res.status(404).json({ code: 404, msg: '接口不存在' }));
app.use(errorHandler);

// ===== 在线状态扫描: 记录状态翻转(时间轴) + 心跳采样(在线率统计) =====
const lastStatus = new Map(); // deviceId -> 'online' | 'offline'
let sampleTickCount = 0;

async function sweep() {
  try {
    const devices = await db('devices').whereNull('deleted_at').select('id', 'last_online');
    const now = Date.now();
    for (const d of devices) {
      const online = !!(d.last_online && now - new Date(d.last_online).getTime() < config.offlineThresholdMs);
      const status = online ? 'online' : 'offline';
      // 状态翻转记录 (需求 5.1.3 状态变化时间轴)
      if (lastStatus.has(d.id) && lastStatus.get(d.id) !== status) {
        await db('device_status_logs').insert({ device_id: d.id, status, ts: now });
      }
      lastStatus.set(d.id, status);
    }
    // 每 2 个扫描周期(60s)采样一次, 用于在线率统计
    sampleTickCount = (sampleTickCount + 1) % 2;
    if (sampleTickCount === 0) {
      for (const [id, status] of lastStatus) {
        await db('heartbeat_logs').insert({ device_id: id, online: status === 'online', ts: now });
      }
    }
  } catch (e) {
    console.error('[sweep]', e.message);
  }
}

// 历史数据清理: 心跳采样保留 90 天 (需求 10); 指令历史每设备仅保留最新 10 条 + 30 天过期
async function cleanup() {
  try {
    const pad = (x) => String(x).padStart(2, '0');
    const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    await db('heartbeat_logs').where('ts', '<', Date.now() - 90 * 24 * 3600 * 1000).del();
    await db('commands').where('created_at', '<', fmt(new Date(Date.now() - 30 * 24 * 3600 * 1000))).del();
    // 每设备只保留最新 10 条指令 (pending 未投递的不删, 防止离线设备丢指令)
    const devs = await db('commands').distinct('device_id');
    for (const { device_id } of devs) {
      const keep = await db('commands').where({ device_id }).orderBy('id', 'desc').limit(10).pluck('id');
      if (keep.length === 10) {
        await db('commands').where({ device_id }).whereNotIn('id', keep).whereNot('status', 'pending').del();
      }
    }
  } catch (e) {
    console.error('[cleanup]', e.message);
  }
}

async function main() {
  await migrate();
  // 种子: 默认超管 + 默认分组
  const bcrypt = require('bcryptjs');
  const adminCount = await db('users').count('* as c').first();
  if (adminCount.c === 0) {
    await db('users').insert({
      username: 'admin',
      password: await bcrypt.hash('Admin@123', 10),
      display_name: '超级管理员',
      role: 'super_admin',
    });
    console.log('[seed] 已创建默认管理员: admin / Admin@123');
  }
  const groupCount = await db('groups').count('* as c').first();
  if (groupCount.c === 0) {
    await db('groups').insert({ name: '默认分组', remark: '系统内置' });
  }

  const server = app.listen(config.port, () => {
    console.log(`[cms-server] listening on http://localhost:${config.port} (db=${config.db.client})`);
  });
  server.keepAliveTimeout = 65000;

  setInterval(sweep, config.sweepIntervalMs);
  setInterval(cleanup, 6 * 3600 * 1000);
}

main().catch((e) => {
  console.error('启动失败:', e);
  process.exit(1);
});
