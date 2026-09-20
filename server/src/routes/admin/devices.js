const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const db = require('../../db');
const config = require('../../config');
const { authMiddleware, requireRoles } = require('../../middleware/auth');
const { audit, ok, fail, clientIp } = require('../../middleware/common');

const router = express.Router();
router.use(authMiddleware, requireRoles('super_admin', 'operator'));

function randToken(n) { return crypto.randomBytes(n).toString('hex'); }
function randPassword() { return Math.random().toString(36).slice(-6) + 'Aa1'; }

function withOnline(device) {
  const last = device.last_online ? new Date(device.last_online).getTime() : 0;
  return { ...device, online: Date.now() - last < config.offlineThresholdMs };
}

// ===== 设备列表 =====
router.get('/', async (req, res, next) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Number(req.query.pageSize) || 20);
    let q = db('devices').whereNull('deleted_at');
    if (req.query.keyword) q = q.andWhere((w) => w.where('device_name', 'like', `%${req.query.keyword}%`).orWhere('username', 'like', `%${req.query.keyword}%`));
    if (req.query.groupId) q = q.andWhere('group_id', Number(req.query.groupId));
    const total = await q.clone().count('* as c').first();
    const rows = await q.clone().orderBy('id', 'desc').offset((page - 1) * pageSize).limit(pageSize);
    const groups = await db('groups');
    const gmap = {}; groups.forEach((g) => { gmap[g.id] = g.name; });
    const list = rows.map((d) => {
      const dev = withOnline(d);
      return {
        ...dev,
        password: undefined,
        groupName: d.group_id ? gmap[d.group_id] : null,
        screenshotUrl: d.screenshot ? `/files/${d.screenshot}` : null,
      };
    });
    if (req.query.status === 'online') return res.json(ok({ total: list.filter((d) => d.online).length, list: list.filter((d) => d.online) }));
    if (req.query.status === 'offline') return res.json(ok({ total: list.filter((d) => !d.online).length, list: list.filter((d) => !d.online) }));
    return res.json(ok({ total: total.c, list }));
  } catch (e) { next(e); }
});

// ===== 新增设备: 自动生成账号 + 初始密码 (需求 5.1.2) =====
router.post('/', async (req, res, next) => {
  try {
    const { deviceName, groupId, remark } = req.body || {};
    if (!deviceName) return res.status(400).json(fail('设备名称必填'));
    const username = `dev_${randToken(3)}`;
    const password = randPassword();
    const [id] = await db('devices').insert({
      device_name: deviceName,
      username,
      password: await bcrypt.hash(password, 10),
      group_id: groupId || null,
      remark: remark || null,
    });
    audit(req, '新增设备', `device:${deviceName}`, `username=${username}`);
    return res.json(ok({ id, username, password }));
  } catch (e) { next(e); }
});

// ===== 设备详情 =====
router.get('/:id', async (req, res, next) => {
  try {
    const d = await db('devices').where({ id: req.params.id }).whereNull('deleted_at').first();
    if (!d) return res.status(404).json(fail('设备不存在'));
    const group = d.group_id ? await db('groups').where({ id: d.group_id }).first() : null;
    const commands = await db('commands').where({ device_id: d.id }).orderBy('id', 'desc').limit(10);
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const plays = await db('play_logs').where({ device_id: d.id }).where('start_ts', '>=', today.getTime()).count('* as c').first();
    return res.json(ok({
      ...withOnline(d),
      password: undefined,
      group,
      commands,
      todayPlays: plays.c,
      screenshotUrl: d.screenshot ? `/files/${d.screenshot}` : null,
    }));
  } catch (e) { next(e); }
});

// ===== 编辑设备 =====
router.put('/:id', async (req, res, next) => {
  try {
    const d = await db('devices').where({ id: req.params.id }).whereNull('deleted_at').first();
    if (!d) return res.status(404).json(fail('设备不存在'));
    const { deviceName, groupId, remark } = req.body || {};
    const patch = { updated_at: new Date() };
    if (deviceName != null) patch.device_name = deviceName;
    if (groupId !== undefined) patch.group_id = groupId || null;
    if (remark !== undefined) patch.remark = remark;
    await db('devices').where({ id: d.id }).update(patch);
    audit(req, '编辑设备', `device:${d.device_name}`);
    return res.json(ok());
  } catch (e) { next(e); }
});

// ===== 删除设备 (软删除) =====
router.delete('/:id', async (req, res, next) => {
  try {
    const d = await db('devices').where({ id: req.params.id }).whereNull('deleted_at').first();
    if (!d) return res.status(404).json(fail('设备不存在'));
    await db('devices').where({ id: d.id }).update({ deleted_at: new Date() });
    audit(req, '删除设备', `device:${d.device_name}`);
    return res.json(ok());
  } catch (e) { next(e); }
});

// ===== 重置设备密码 =====
router.post('/:id/reset-password', async (req, res, next) => {
  try {
    const d = await db('devices').where({ id: req.params.id }).whereNull('deleted_at').first();
    if (!d) return res.status(404).json(fail('设备不存在'));
    const password = randPassword();
    await db('devices').where({ id: d.id }).update({ password: await bcrypt.hash(password, 10), updated_at: new Date() });
    audit(req, '重置设备密码', `device:${d.device_name}`);
    return res.json(ok({ username: d.username, password }));
  } catch (e) { next(e); }
});

// ===== 批量导入 {rows:[{deviceName, groupName, remark}]} =====
router.post('/import', async (req, res, next) => {
  try {
    const rows = Array.isArray(req.body?.rows) ? req.body.rows.slice(0, 500) : [];
    if (!rows.length) return res.status(400).json(fail('导入数据为空'));
    const groups = await db('groups');
    const result = { created: 0, failed: [], accounts: [] };
    for (const r of rows) {
      if (!r.deviceName) { result.failed.push(`${JSON.stringify(r)}: 缺少设备名称`); continue; }
      let groupId = null;
      if (r.groupName) {
        let g = groups.find((x) => x.name === r.groupName);
        if (!g) { const [gid] = await db('groups').insert({ name: r.groupName }); g = { id: gid }; groups.push(g); }
        groupId = g.id;
      }
      const username = `dev_${randToken(3)}`;
      const password = randPassword();
      await db('devices').insert({
        device_name: r.deviceName, username, password: await bcrypt.hash(password, 10),
        group_id: groupId, remark: r.remark || null,
      });
      result.created += 1;
      result.accounts.push({ deviceName: r.deviceName, username, password });
    }
    audit(req, '批量导入设备', `count=${result.created}`);
    return res.json(ok(result));
  } catch (e) { next(e); }
});

// ===== 远程控制指令下发 (需求 5.1.7) =====
const CMD_TYPES = ['restart_app', 'refresh_playlist', 'clear_cache', 'screenshot', 'set_volume', 'set_brightness', 'reboot', 'shutdown'];
router.post('/:id/command', async (req, res, next) => {
  try {
    const d = await db('devices').where({ id: req.params.id }).whereNull('deleted_at').first();
    if (!d) return res.status(404).json(fail('设备不存在'));
    const { type, value } = req.body || {};
    if (!CMD_TYPES.includes(type)) return res.status(400).json(fail('不支持的指令类型'));
    const [id] = await db('commands').insert({ device_id: d.id, type, value: value != null ? String(value) : null, created_by: req.auth.id });
    audit(req, '下发指令', `device:${d.device_name}`, `${type}=${value || ''}`);
    return res.json(ok({ id }));
  } catch (e) { next(e); }
});

// ===== 指令历史 =====
router.get('/:id/commands', async (req, res, next) => {
  try {
    const rows = await db('commands').where({ device_id: req.params.id }).orderBy('id', 'desc').limit(50);
    return res.json(ok(rows));
  } catch (e) { next(e); }
});

// ===== 状态变化时间轴 (需求 5.1.3) =====
router.get('/:id/timeline', async (req, res, next) => {
  try {
    const rows = await db('device_status_logs').where({ device_id: req.params.id }).orderBy('ts', 'desc').limit(100);
    return res.json(ok(rows));
  } catch (e) { next(e); }
});

module.exports = router;
