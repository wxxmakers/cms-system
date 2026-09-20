const express = require('express');
const db = require('../../db');
const config = require('../../config');
const { authMiddleware } = require('../../middleware/auth');
const { ok } = require('../../middleware/common');

const router = express.Router();
router.use(authMiddleware);

function dayStartTs(daysAgo = 0) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
function ymd(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ===== 总览卡片 =====
router.get('/summary', async (req, res, next) => {
  try {
    const devices = await db('devices').whereNull('deleted_at');
    const now = Date.now();
    const online = devices.filter((d) => d.last_online && now - new Date(d.last_online).getTime() < config.offlineThresholdMs).length;
    const videos = await db('videos').count('* as c').first();
    const approvedVideos = await db('videos').where({ status: 'approved' }).count('* as c').first();
    const playlists = await db('playlists').count('* as c').first();
    const todayPlays = await db('play_logs').where('start_ts', '>=', dayStartTs(0)).count('* as c').first();
    const todayRows = await db('play_logs').where('start_ts', '>=', dayStartTs(0));
    const todayDuration = todayRows.reduce((s, r) => s + (r.duration || 0), 0);
    return res.json(ok({
      deviceTotal: devices.length,
      deviceOnline: online,
      deviceOffline: devices.length - online,
      videoTotal: videos.c,
      videoApproved: approvedVideos.c,
      playlistTotal: playlists.c,
      todayPlays: todayPlays.c,
      todayPlayDuration: todayDuration, // 秒
    }));
  } catch (e) { next(e); }
});

// ===== 在线率趋势 (按天, 依据心跳采样) =====
router.get('/online-trend', async (req, res, next) => {
  try {
    const days = Math.min(30, Math.max(1, Number(req.query.days) || 7));
    const since = dayStartTs(days - 1);
    const samples = await db('heartbeat_logs').where('ts', '>=', since);
    const devices = await db('devices').whereNull('deleted_at').count('* as c').first();
    const totalDevices = Math.max(1, devices.c);
    const byDay = {};
    for (let i = 0; i < days; i++) byDay[ymd(dayStartTs(i))] = { online: 0, total: 0 };
    samples.forEach((s) => {
      const k = ymd(s.ts);
      if (!byDay[k]) return;
      byDay[k].total += 1;
      if (s.online) byDay[k].online += 1;
    });
    const list = Object.entries(byDay).map(([date, v]) => ({
      date,
      onlineRate: v.total ? Math.round((v.online / v.total) * 1000) / 10 : 0,
      samples: v.total,
    }));
    return res.json(ok(list.reverse()));
  } catch (e) { next(e); }
});

// ===== 广告播放次数排行 =====
router.get('/play-ranking', async (req, res, next) => {
  try {
    const days = Math.min(90, Math.max(1, Number(req.query.days) || 7));
    const limit = Math.min(50, Math.max(5, Number(req.query.limit) || 10));
    const since = dayStartTs(days - 1);
    const logs = await db('play_logs').where('start_ts', '>=', since).select('video_id', 'duration', 'device_id');
    const videos = await db('videos');
    const vmap = {}; videos.forEach((v) => { vmap[v.id] = v.name; });
    const agg = {};
    logs.forEach((l) => {
      if (!agg[l.video_id]) agg[l.video_id] = { videoId: l.video_id, name: vmap[l.video_id] || `素材#${l.video_id}`, plays: 0, duration: 0, devices: new Set() };
      agg[l.video_id].plays += 1;
      agg[l.video_id].duration += l.duration || 0;
      agg[l.video_id].devices.add(l.device_id);
    });
    const list = Object.values(agg)
      .map((a) => ({ videoId: a.videoId, name: a.name, plays: a.plays, duration: a.duration, deviceCount: a.devices.size }))
      .sort((x, y) => y.plays - x.plays)
      .slice(0, limit);
    return res.json(ok(list));
  } catch (e) { next(e); }
});

// ===== 各设备播放时长统计 =====
router.get('/play-duration', async (req, res, next) => {
  try {
    const days = Math.min(90, Math.max(1, Number(req.query.days) || 7));
    const since = dayStartTs(days - 1);
    const logs = await db('play_logs').where('start_ts', '>=', since).select('device_id', 'duration');
    const devices = await db('devices').whereNull('deleted_at');
    const agg = {};
    devices.forEach((d) => { agg[d.id] = { deviceId: d.id, deviceName: d.device_name, plays: 0, duration: 0 }; });
    logs.forEach((l) => {
      if (!agg[l.device_id]) agg[l.device_id] = { deviceId: l.device_id, deviceName: `设备#${l.device_id}`, plays: 0, duration: 0 };
      agg[l.device_id].plays += 1;
      agg[l.device_id].duration += l.duration || 0;
    });
    return res.json(ok(Object.values(agg).sort((a, b) => b.duration - a.duration)));
  } catch (e) { next(e); }
});

// ===== 分时段播放曲线 (触达报表, 需求 6.3) =====
router.get('/hourly-plays', async (req, res, next) => {
  try {
    const days = Math.min(90, Math.max(1, Number(req.query.days) || 1));
    const since = dayStartTs(days - 1);
    const logs = await db('play_logs').where('start_ts', '>=', since).select('start_ts');
    const hours = new Array(24).fill(0);
    logs.forEach((l) => { hours[new Date(l.start_ts).getHours()] += 1; });
    return res.json(ok(hours.map((c, h) => ({ hour: `${String(h).padStart(2, '0')}:00`, plays: c }))));
  } catch (e) { next(e); }
});

// ===== 明细: 某设备最近播放记录 =====
router.get('/device-plays', async (req, res, next) => {
  try {
    const deviceId = Number(req.query.deviceId);
    if (!deviceId) return res.json(ok([]));
    const rows = await db('play_logs as pl')
      .join('videos as v', 'v.id', 'pl.video_id')
      .where('pl.device_id', deviceId)
      .orderBy('pl.start_ts', 'desc')
      .limit(100)
      .select('pl.*', 'v.name as videoName');
    return res.json(ok(rows));
  } catch (e) { next(e); }
});

module.exports = router;
