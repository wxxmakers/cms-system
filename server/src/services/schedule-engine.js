// 排期引擎: 计算设备在指定时刻应播放的节目单
// 优先级: P0 紧急插播 > P1 定时排期 > P2 默认下发节目单 (需求 6.2)
// 兜底素材(P3)由设备端内置, 服务端无可播内容时返回空列表由设备自行兜底
const db = require('../db');

function parseDate(v) { return v ? String(v).slice(0, 10) : null; }

// 判断排期是否命中指定时刻 (服务器时间)
// weekdays: "1,3,5" (1=周一..7=周日), 空串=不限
function matchScheduleTime(sch, now) {
  const dateStr = parseDate(sch.start_date);
  const endDateStr = parseDate(sch.end_date);
  const ymd = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  if (dateStr && ymd < dateStr) return false;
  if (endDateStr && ymd > endDateStr) return false;

  const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  if (sch.start_time && hhmm < sch.start_time) return false;
  if (sch.end_time && hhmm > sch.end_time) return false;

  if (sch.weekdays) {
    // JS: 0=周日..6=周六 -> 本系统 1=周一..7=周日
    const dow = now.getDay() === 0 ? 7 : now.getDay();
    const days = String(sch.weekdays).split(',').map((s) => parseInt(s, 10)).filter((n) => n >= 1 && n <= 7);
    if (days.length && !days.includes(dow)) return false;
  }
  return true;
}

// 判断排期/下发目标是否包含该设备
function matchTarget(targetType, targetId, device) {
  if (targetType === 'all') return true;
  if (targetType === 'group') return device.group_id != null && device.group_id === Number(targetId);
  if (targetType === 'device') return device.id === Number(targetId);
  return false;
}

// 计算版本号: 节目单版本 + 内容指纹, 设备据此增量拉取
function computeVersion(playlistId, playlistVersion, items) {
  const crypto = require('crypto');
  const fingerprint = items.map((i) => `${i.videoId}:${i.md5}:${i.sortOrder}`).join('|');
  const h = crypto.createHash('md5').update(`${playlistId}|${fingerprint}`).digest();
  const hashInt = h.readUInt32BE(0) % 100000000;
  return playlistVersion * 100000000 + hashInt;
}

// 解析设备当前应播节目
async function resolveForDevice(device, now = new Date()) {
  const schedules = await db('schedules').where({ enabled: 1 });
  const allPlaylists = await db('playlists');
  const plMap = new Map(allPlaylists.map((p) => [p.id, p]));
  const hit = schedules
    .filter((s) => plMap.has(s.playlist_id)) // 跳过引用已删除节目单的排期 (防御)
    .filter((s) => matchTarget(s.target_type, s.target_id, device))
    .filter((s) => matchScheduleTime(s, now))
    .sort((a, b) => (a.priority === b.priority ? b.id - a.id : a.priority < b.priority ? -1 : 1)); // P0 < P1

  let playlistId = null;
  let source = 'none';
  if (hit.length > 0) {
    playlistId = hit[0].playlist_id;
    source = hit[0].priority === 'P0' ? 'emergency' : 'schedule';
  } else {
    // P2: 最近一次下发给该设备的默认节目单 (跳过已删除节目单的悬空记录)
    const issues = await db('device_playlist').orderBy('issued_at', 'desc');
    const issue = issues.find((i) => matchTarget(i.target_type, i.target_id, device) && plMap.has(i.playlist_id));
    if (issue) {
      playlistId = issue.playlist_id;
      source = 'default';
    }
  }

  if (!playlistId) {
    return { source: 'none', playlistId: null, playlistName: null, version: 0, items: [] };
  }

  const playlist = await db('playlists').where({ id: playlistId }).first();
  if (!playlist) {
    return { source: 'none', playlistId: null, playlistName: null, version: 0, items: [] };
  }

  // 只下发已过审 + 未过期的素材 (先审后发 / 素材过期自动下架, 需求 附录A.5/A.10)
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const rows = await db('playlist_items as pi')
    .join('videos as v', 'v.id', 'pi.video_id')
    .where('pi.playlist_id', playlistId)
    .where('v.status', 'approved')
    .orderBy('pi.sort_order', 'asc');

  const items = rows
    .filter((r) => !r.expire_at || parseDate(r.expire_at) >= today)
    .map((r) => ({
      videoId: r.video_id,
      name: r.name,
      type: r.type,
      md5: r.md5,
      size: r.size,
      duration: r.duration || 0,
      itemDuration: r.duration_pi || r.duration || 10,
      sortOrder: r.sort_order,
      fileName: r.file_path,
      width: r.width,
      height: r.height,
    }))
    .map((it) => ({ ...it, duration: it.itemDuration || it.duration || 10 }));

  return {
    source,
    playlistId,
    playlistName: playlist.name,
    playlistVersion: playlist.version,
    version: computeVersion(playlistId, playlist.version, items),
    items,
  };
}

// 冲突检测: 同优先级 + 时间窗重叠 + 目标设备有交集 (需求 5.1.6)
async function detectConflicts() {
  const schedules = await db('schedules').where({ enabled: 1 }).orderBy('id');
  const conflicts = [];
  for (let i = 0; i < schedules.length; i++) {
    for (let j = i + 1; j < schedules.length; j++) {
      const a = schedules[i], b = schedules[j];
      if (a.priority !== b.priority) continue;
      if (a.priority === 'P0') continue; // 紧急插播允许覆盖
      // 日期区间是否相交
      const as = parseDate(a.start_date) || '0000-01-01';
      const ae = parseDate(a.end_date) || '9999-12-31';
      const bs = parseDate(b.start_date) || '0000-01-01';
      const be = parseDate(b.end_date) || '9999-12-31';
      if (as > be || bs > ae) continue;
      // 时段是否相交
      const ast = a.start_time || '00:00', aet = a.end_time || '23:59';
      const bst = b.start_time || '00:00', bet = b.end_time || '23:59';
      if (ast > bet || bst > aet) continue;
      // 星期是否相交
      const aw = a.weekdays ? new Set(a.weekdays.split(',')) : null;
      const bw = b.weekdays ? new Set(b.weekdays.split(',')) : null;
      if (aw && bw) {
        const inter = [...aw].filter((d) => bw.has(d));
        if (inter.length === 0) continue;
      }
      // 目标是否可能重叠 (all 与任何目标重叠; 同 group / 同 device 重叠)
      if (a.target_type === 'all' || b.target_type === 'all'
        || (a.target_type === b.target_type && a.target_id === b.target_id)) {
        conflicts.push({ a: { id: a.id, name: a.name }, b: { id: b.id, name: b.name } });
      }
    }
  }
  return conflicts;
}

module.exports = { resolveForDevice, detectConflicts, matchScheduleTime, matchTarget };
