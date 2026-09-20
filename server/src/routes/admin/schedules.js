const express = require('express');
const db = require('../../db');
const { authMiddleware, requireRoles } = require('../../middleware/auth');
const { audit, ok, fail } = require('../../middleware/common');
const engine = require('../../services/schedule-engine');

const router = express.Router();
router.use(authMiddleware, requireRoles('super_admin', 'operator'));

function validate(sch) {
  if (!sch.name) return '排期名称必填';
  if (!sch.playlistId) return '请选择节目单';
  if (!['P0', 'P1'].includes(sch.priority || 'P1')) return '优先级不合法';
  if (!['all', 'group', 'device'].includes(sch.targetType || 'all')) return '目标不合法';
  if ((sch.targetType || 'all') !== 'all' && !sch.targetId) return '请选择目标设备/分组';
  const timeRe = /^([01]\d|2[0-3]):[0-5]\d$/;
  if (sch.startTime && !timeRe.test(sch.startTime)) return '开始时间格式应为 HH:MM';
  if (sch.endTime && !timeRe.test(sch.endTime)) return '结束时间格式应为 HH:MM';
  if (sch.startTime && sch.endTime && sch.startTime > sch.endTime) return '开始时间不能晚于结束时间';
  if (sch.startDate && sch.endDate && String(sch.startDate).slice(0, 10) > String(sch.endDate).slice(0, 10)) return '开始日期不能晚于结束日期';
  if (sch.weekdays) {
    const days = String(sch.weekdays).split(',').map((s) => parseInt(s, 10));
    if (days.some((n) => !n || n < 1 || n > 7)) return '星期取值应为 1-7 (1=周一)';
  }
  return null;
}

function toRow(b) {
  return {
    name: b.name,
    playlist_id: Number(b.playlistId),
    priority: b.priority || 'P1',
    start_date: b.startDate || null,
    end_date: b.endDate || null,
    start_time: b.startTime || '00:00',
    end_time: b.endTime || '23:59',
    weekdays: b.weekdays || '',
    target_type: b.targetType || 'all',
    target_id: (b.targetType || 'all') === 'all' ? null : Number(b.targetId),
    enabled: b.enabled !== false,
  };
}

// ===== 排期列表 (含节目单名/冲突标记) =====
router.get('/', async (req, res, next) => {
  try {
    const rows = await db('schedules').orderBy('id', 'desc');
    const playlists = await db('playlists');
    const pmap = {}; playlists.forEach((p) => { pmap[p.id] = p.name; });
    const conflicts = await engine.detectConflicts();
    const conflictIds = new Set();
    conflicts.forEach((c) => { conflictIds.add(c.a.id); conflictIds.add(c.b.id); });
    const groups = await db('groups');
    const devices = await db('devices').whereNull('deleted_at');
    return res.json(ok(rows.map((s) => ({
      ...s,
      playlistName: pmap[s.playlist_id] || '(已删除)',
      hasConflict: conflictIds.has(s.id),
      targetName: s.target_type === 'all' ? '全部设备'
        : s.target_type === 'group' ? (groups.find((g) => g.id === s.target_id)?.name || '未知分组')
        : (devices.find((d) => d.id === s.target_id)?.device_name || '未知设备'),
    }))));
  } catch (e) { next(e); }
});

// ===== 新建排期 =====
router.post('/', async (req, res, next) => {
  try {
    const err = validate(req.body || {});
    if (err) return res.status(400).json(fail(err));
    const [id] = await db('schedules').insert({ ...toRow(req.body), created_by: req.auth.id });
    audit(req, '创建排期', `schedule:${req.body.name}`);
    return res.json(ok({ id }));
  } catch (e) { next(e); }
});

// ===== 编辑排期 =====
router.put('/:id', async (req, res, next) => {
  try {
    const s = await db('schedules').where({ id: req.params.id }).first();
    if (!s) return res.status(404).json(fail('排期不存在'));
    const err = validate(req.body || {});
    if (err) return res.status(400).json(fail(err));
    await db('schedules').where({ id: s.id }).update({ ...toRow(req.body), updated_at: new Date() });
    audit(req, '编辑排期', `schedule:${req.body.name || s.name}`);
    return res.json(ok());
  } catch (e) { next(e); }
});

// ===== 启用/停用 =====
router.put('/:id/toggle', async (req, res, next) => {
  try {
    const s = await db('schedules').where({ id: req.params.id }).first();
    if (!s) return res.status(404).json(fail('排期不存在'));
    await db('schedules').where({ id: s.id }).update({ enabled: !s.enabled, updated_at: new Date() });
    audit(req, s.enabled ? '停用排期' : '启用排期', `schedule:${s.name}`);
    return res.json(ok({ enabled: !s.enabled }));
  } catch (e) { next(e); }
});

// ===== 删除排期 =====
router.delete('/:id', async (req, res, next) => {
  try {
    const s = await db('schedules').where({ id: req.params.id }).first();
    if (!s) return res.status(404).json(fail('排期不存在'));
    await db('schedules').where({ id: s.id }).del();
    audit(req, '删除排期', `schedule:${s.name}`);
    return res.json(ok());
  } catch (e) { next(e); }
});

// ===== 紧急插播: P0 立即生效, 结束后自动恢复原排期 (需求 6.7) =====
router.post('/emergency', async (req, res, next) => {
  try {
    const { playlistId, targetType, targetId, minutes, name } = req.body || {};
    if (!playlistId) return res.status(400).json(fail('请选择要插播的节目单'));
    if (!['all', 'group', 'device'].includes(targetType || 'all')) return res.status(400).json(fail('目标不合法'));
    if (targetType !== 'all' && !targetId) return res.status(400).json(fail('请选择目标设备/分组'));
    const p = await db('playlists').where({ id: playlistId }).first();
    if (!p) return res.status(400).json(fail('节目单不存在'));
    const mins = Math.min(1440, Math.max(1, Number(minutes) || 10));
    const now = new Date();
    const end = new Date(now.getTime() + mins * 60000);
    const fmt = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    const [id] = await db('schedules').insert({
      name: name || `紧急插播-${p.name}-${fmt(now)}`,
      playlist_id: p.id,
      priority: 'P0',
      start_date: null, end_date: null, // 不限日期, 由时段控制
      start_time: fmt(now),
      end_time: fmt(end) < fmt(now) ? '23:59' : fmt(end),
      weekdays: '',
      target_type: targetType || 'all',
      target_id: targetType === 'all' ? null : Number(targetId),
      enabled: true,
      created_by: req.auth.id,
    });
    audit(req, '紧急插播', `playlist:${p.name}`, `target=${targetType}:${targetId || '全部'} ${mins}分钟`);
    return res.json(ok({ id }, '插播指令已生效'));
  } catch (e) { next(e); }
});

// ===== 冲突列表 (需求 5.1.6) =====
router.get('/conflicts/list', async (req, res, next) => {
  try {
    const conflicts = await engine.detectConflicts();
    return res.json(ok(conflicts));
  } catch (e) { next(e); }
});

module.exports = router;
