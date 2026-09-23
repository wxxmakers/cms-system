const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const db = require('../../db');
const config = require('../../config');
const { authMiddleware, requireRoles, isTenantUser, scopedDeviceIds, deviceOutOfScope, hasPerm } = require('../../middleware/auth');
const { audit, ok, fail, clientIp } = require('../../middleware/common');

const router = express.Router();
// customer 可访问本路由下的只读/控制类接口 (内部再按设备归属过滤), 管理类接口单独限制
router.use(authMiddleware, requireRoles('super_admin', 'operator', 'customer', 'tenant_admin'));

function randToken(n) { return crypto.randomBytes(n).toString('hex'); }
function randPassword() { return Math.random().toString(36).slice(-6) + 'Aa1'; }

function withOnline(device) {
  const last = device.last_online ? new Date(device.last_online).getTime() : 0;
  return { ...device, online: Date.now() - last < config.offlineThresholdMs };
}

// 权限校验 (子账号细粒度)
function requirePerm(key) {
  return (req, res, next) => {
    if (!hasPerm(req, key)) return res.status(403).json(fail('无此操作权限'));
    next();
  };
}

// 设备归属校验 (租户账号只能访问本租户的设备)
async function asyncGuard(req, res, next) {
  try {
    if (await deviceOutOfScope(req, req.params.id)) return res.status(404).json(fail('设备不存在'));
    next();
  } catch (e) { next(e); }
}

// ===== 设备列表 =====
router.get('/', async (req, res, next) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Number(req.query.pageSize) || 20);
    let q = db('devices').whereNull('deleted_at');
    if (!hasPerm(req, 'devices')) return res.status(403).json(fail('无设备查看权限'));
    if (isTenantUser(req)) {
      // 租户账号只能看到本租户的设备
      const ids = await scopedDeviceIds(req);
      q = q.whereIn('id', ids.length ? ids : [-1]);
    }
    if (req.query.keyword) q = q.andWhere((w) => w.where('device_name', 'like', `%${req.query.keyword}%`).orWhere('username', 'like', `%${req.query.keyword}%`).orWhere('fingerprint', 'like', `%${req.query.keyword}%`));
    if (req.query.groupId) q = q.andWhere('group_id', Number(req.query.groupId));
    const total = await q.clone().count('* as c').first();
    const rows = await q.clone().orderBy('id', 'desc').offset((page - 1) * pageSize).limit(pageSize);
    const groups = await db('groups');
    const gmap = {}; groups.forEach((g) => { gmap[g.id] = g.name; });
    const tenants = await db('tenants');
    const tmap = {}; tenants.forEach((t) => { tmap[t.id] = t.name; });
    const list = rows.map((d) => {
      const dev = withOnline(d);
      return {
        ...dev,
        password: undefined,
        groupName: d.group_id ? gmap[d.group_id] : null,
        tenantName: d.tenant_id ? tmap[d.tenant_id] : null,
        screenshotUrl: d.screenshot ? `/files/${d.screenshot}` : null,
      };
    });
    if (req.query.status === 'online') return res.json(ok({ total: list.filter((d) => d.online).length, list: list.filter((d) => d.online) }));
    if (req.query.status === 'offline') return res.json(ok({ total: list.filter((d) => !d.online).length, list: list.filter((d) => !d.online) }));
    return res.json(ok({ total: total.c, list }));
  } catch (e) { next(e); }
});

// ===== 租户列表 (设备归属选择用, 注意必须定义在 /:id 之前) =====
router.get('/tenants-lite', requireRoles('super_admin', 'operator'), async (req, res, next) => {
  try {
    const rows = await db('tenants').where({ status: 'active' }).select('id', 'name').orderBy('id');
    return res.json(ok(rows));
  } catch (e) { next(e); }
});

// ===== 新增设备 =====
// 平台账号: 名称/分组/租户/备注, 生成账号密码展示
// 租户管理员: 必须输入设备序列号认领 (配额校验), 设备端首次连接即自动绑定上线
router.post('/', requireRoles('super_admin', 'operator', 'tenant_admin'), async (req, res, next) => {
  try {
    const { deviceName, groupId, remark, tenantId, serial } = req.body || {};
    const username = `dev_${randToken(3)}`;
    const password = randPassword();
    const common = { username, password: await bcrypt.hash(password, 10), remark: remark || null };

    if (req.auth.role === 'tenant_admin') {
      // ---- 租户自助: 序列号认领 ----
      const sn = String(serial || '').trim();
      if (!sn || sn.length < 6) return res.status(400).json(fail('请输入设备序列号 (机身标签/adb devices 可查)'));
      if (!deviceName) return res.status(400).json(fail('请输入设备名称'));
      // 配额校验
      const tenant = await db('tenants').where({ id: req.auth.tenantId }).first();
      const used = await db('devices').where({ tenant_id: req.auth.tenantId }).whereNull('deleted_at').count('* as c').first();
      if (used.c >= tenant.device_quota) {
        return res.status(400).json(fail(`设备配额已满 (${used.c}/${tenant.device_quota}), 请联系平台扩容`));
      }
      // 序列号已存在: 认领待批准设备 / 拒绝他人设备
      const exist = await db('devices').where({ fingerprint: sn }).whereNull('deleted_at').first();
      if (exist) {
        if (exist.tenant_id && exist.tenant_id !== req.auth.tenantId) {
          return res.status(400).json(fail('该序列号已被其他租户绑定'));
        }
        await db('devices').where({ id: exist.id }).update({
          tenant_id: req.auth.tenantId, device_name: deviceName, approved: true, updated_at: new Date(),
        });
        audit(req, '认领设备', `device:${deviceName}`, `sn=${sn} (已有记录 #${exist.id})`);
        return res.json(ok(null, '认领成功, 设备连接服务器后将自动上线'));
      }
      const [id] = await db('devices').insert({
        ...common, device_name: deviceName, fingerprint: sn, approved: true, tenant_id: req.auth.tenantId,
      });
      audit(req, '登记设备', `device:${deviceName}`, `sn=${sn} quota=${used.c + 1}/${tenant.device_quota}`);
      return res.json(ok(null, `登记成功 (${used.c + 1}/${tenant.device_quota}), 设备输入服务器地址后将自动绑定上线`));
    }

    // ---- 平台新增 ----
    if (!deviceName) return res.status(400).json(fail('设备名称必填'));
    let tid = null;
    if (tenantId) {
      const t = await db('tenants').where({ id: Number(tenantId), status: 'active' }).first();
      if (!t) return res.status(400).json(fail('所选租户不存在'));
      tid = t.id;
    }
    const [id] = await db('devices').insert({
      ...common, device_name: deviceName, group_id: groupId || null, tenant_id: tid,
    });
    audit(req, '新增设备', `device:${deviceName}`, tid ? `tenant#${tid}` : null);
    return res.json(ok({ id, username, password }));
  } catch (e) { next(e); }
});

// ===== 设备详情 =====
router.get('/:id', asyncGuard, async (req, res, next) => {
  try {
    const d = await db('devices').where({ id: req.params.id }).whereNull('deleted_at').first();
    if (!d) return res.status(404).json(fail('设备不存在'));
    const group = d.group_id ? await db('groups').where({ id: d.group_id }).first() : null;
    const tenant = d.tenant_id ? await db('tenants').where({ id: d.tenant_id }).first() : null;
    const commands = await db('commands').where({ device_id: d.id }).orderBy('id', 'desc').limit(10);
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const plays = await db('play_logs').where({ device_id: d.id }).where('start_ts', '>=', today.getTime()).count('* as c').first();
    return res.json(ok({
      ...withOnline(d),
      password: undefined,
      group,
      tenantName: tenant ? tenant.name : null,
      commands,
      todayPlays: plays.c,
      screenshotUrl: d.screenshot ? `/files/${d.screenshot}` : null,
    }));
  } catch (e) { next(e); }
});

// ===== 编辑设备 =====
router.put('/:id', requireRoles('super_admin', 'operator'), async (req, res, next) => {
  try {
    const d = await db('devices').where({ id: req.params.id }).whereNull('deleted_at').first();
    if (!d) return res.status(404).json(fail('设备不存在'));
    const { deviceName, groupId, remark, tenantId } = req.body || {};
    const patch = { updated_at: new Date() };
    if (deviceName != null) patch.device_name = deviceName;
    if (groupId !== undefined) patch.group_id = groupId || null;
    if (remark !== undefined) patch.remark = remark;
    if (tenantId !== undefined) {
      // 所属租户
      if (tenantId) {
        const t = await db('tenants').where({ id: Number(tenantId), status: 'active' }).first();
        if (!t) return res.status(400).json(fail('所选租户不存在'));
      }
      patch.tenant_id = tenantId || null;
    }
    await db('devices').where({ id: d.id }).update(patch);
    audit(req, '编辑设备', `device:${d.device_name}`, tenantId !== undefined ? `所属租户=${tenantId || '无'}` : null);
    return res.json(ok());
  } catch (e) { next(e); }
});

// ===== 删除设备 (软删除) =====
router.delete('/:id', requireRoles('super_admin', 'operator'), async (req, res, next) => {
  try {
    const d = await db('devices').where({ id: req.params.id }).whereNull('deleted_at').first();
    if (!d) return res.status(404).json(fail('设备不存在'));
    await db('devices').where({ id: d.id }).update({ deleted_at: new Date() });
    audit(req, '删除设备', `device:${d.device_name}`);
    return res.json(ok());
  } catch (e) { next(e); }
});

// ===== 批准指纹自动注册的设备 =====
router.put('/:id/approve', requireRoles('super_admin', 'operator'), async (req, res, next) => {
  try {
    const d = await db('devices').where({ id: req.params.id }).whereNull('deleted_at').first();
    if (!d) return res.status(404).json(fail('设备不存在'));
    await db('devices').where({ id: d.id }).update({ approved: true, updated_at: new Date() });
    audit(req, '批准设备', `device:${d.device_name}`);
    return res.json(ok(null, '已批准, 设备将在 10 秒内自动上线'));
  } catch (e) { next(e); }
});

// ===== 重置设备密码 =====
router.post('/:id/reset-password', requireRoles('super_admin', 'operator'), async (req, res, next) => {
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
router.post('/import', requireRoles('super_admin', 'operator'), async (req, res, next) => {
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
const CMD_TYPES = ['restart_app', 'refresh_playlist', 'clear_cache', 'screenshot', 'set_volume', 'set_brightness', 'set_power_schedule', 'reboot', 'shutdown', 'sleep', 'wakeup', 'logout'];
router.post('/:id/command', asyncGuard, requirePerm('control'), async (req, res, next) => {
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
router.get('/:id/commands', asyncGuard, requirePerm('devices'), async (req, res, next) => {
  try {
    const rows = await db('commands').where({ device_id: req.params.id }).orderBy('id', 'desc').limit(10);
    return res.json(ok(rows));
  } catch (e) { next(e); }
});

// ===== 清空指令历史 =====
router.delete('/:id/commands', asyncGuard, async (req, res, next) => {
  try {
    const d = await db('devices').where({ id: req.params.id }).whereNull('deleted_at').first();
    if (!d) return res.status(404).json(fail('设备不存在'));
    const n = await db('commands').where({ device_id: d.id }).del();
    audit(req, '清空指令历史', `device:${d.device_name}`, `删除 ${n} 条`);
    return res.json(ok({ deleted: n }, `已清空 ${n} 条指令记录`));
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
