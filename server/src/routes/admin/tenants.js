const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../../db');
const { authMiddleware, requireRoles } = require('../../middleware/auth');
const { audit, ok, fail } = require('../../middleware/common');

const router = express.Router();
router.use(authMiddleware);

// 可分配给子账号的权限项 (细粒度勾选)
const PERM_KEYS = ['devices', 'materials', 'playlists', 'schedules', 'control', 'stats'];
const PERM_NAMES = { devices: '设备查看', materials: '素材管理', playlists: '节目单管理', schedules: '排期管理', control: '远程控制', stats: '数据统计' };

// ===== 租户列表 (含用量统计) — 平台账号可用 =====
router.get('/', requireRoles('super_admin', 'operator'), async (req, res, next) => {
  try {
    const rows = await db('tenants').orderBy('id');
    const devices = await db('devices').whereNull('deleted_at');
    const users = await db('users');
    const list = rows.map((t) => ({
      ...t,
      deviceUsed: devices.filter((d) => d.tenant_id === t.id).length,
      accountUsed: users.filter((u) => u.tenant_id === t.id && u.role !== 'tenant_admin').length,
      adminName: users.find((u) => u.tenant_id === t.id && u.role === 'tenant_admin')?.username || null,
    }));
    return res.json(ok(list));
  } catch (e) { next(e); }
});

// ===== 新建租户 (超管) =====
router.post('/', requireRoles('super_admin'), async (req, res, next) => {
  try {
    const { name, deviceQuota, accountQuota } = req.body || {};
    if (!name) return res.status(400).json(fail('租户名称必填'));
    const exists = await db('tenants').where({ name }).first();
    if (exists) return res.status(400).json(fail('租户名称已存在'));
    const [id] = await db('tenants').insert({
      name,
      device_quota: Math.max(1, Number(deviceQuota) || 50),
      account_quota: Math.max(0, Number(accountQuota) || 5),
    });
    audit(req, '新建租户', `tenant:${name}`, `设备配额=${deviceQuota || 50} 子账号配额=${accountQuota || 5}`);
    return res.json(ok({ id }));
  } catch (e) { next(e); }
});

// ===== 编辑租户 (超管: 改名/配额/停用) =====
router.put('/:id', requireRoles('super_admin'), async (req, res, next) => {
  try {
    const t = await db('tenants').where({ id: req.params.id }).first();
    if (!t) return res.status(404).json(fail('租户不存在'));
    const { name, deviceQuota, accountQuota, status } = req.body || {};
    const patch = {};
    if (name != null) patch.name = name;
    if (deviceQuota != null) patch.device_quota = Math.max(1, Number(deviceQuota) || 1);
    if (accountQuota != null) patch.account_quota = Math.max(0, Number(accountQuota) || 0);
    if (status != null && ['active', 'disabled'].includes(status)) patch.status = status;
    await db('tenants').where({ id: t.id }).update(patch);
    audit(req, '编辑租户', `tenant:${t.name}`, JSON.stringify(patch));
    return res.json(ok());
  } catch (e) { next(e); }
});

// ===== 本租户信息+用量 (租户管理员/子账号: 前端展示配额) =====
router.get('/my', requireRoles('super_admin', 'operator', 'tenant_admin', 'customer'), async (req, res, next) => {
  try {
    if (!req.auth.tenantId) return res.json(ok(null));
    const t = await db('tenants').where({ id: req.auth.tenantId }).first();
    if (!t) return res.json(ok(null));
    const deviceUsed = await db('devices').where({ tenant_id: t.id }).whereNull('deleted_at').count('* as c').first();
    const accountUsed = await db('users').where({ tenant_id: t.id }).whereNot('role', 'tenant_admin').count('* as c').first();
    return res.json(ok({
      id: t.id, name: t.name, deviceQuota: t.device_quota, accountQuota: t.account_quota,
      deviceUsed: deviceUsed.c, accountUsed: accountUsed.c,
    }));
  } catch (e) { next(e); }
});

// ===== 成员管理 (租户管理员): 子账号列表 =====
router.get('/members', requireRoles('tenant_admin'), async (req, res, next) => {
  try {
    const rows = await db('users').where({ tenant_id: req.auth.tenantId })
      .select('id', 'username', 'display_name as displayName', 'role', 'status', 'permissions', 'created_at as createdAt')
      .orderBy('id');
    return res.json(ok(rows.map((u) => ({ ...u, permissions: u.permissions ? JSON.parse(u.permissions) : [] }))));
  } catch (e) { next(e); }
});

// ===== 新建子账号 (租户管理员, 配额校验) =====
router.post('/members', requireRoles('tenant_admin'), async (req, res, next) => {
  try {
    const { username, password, displayName, permissions } = req.body || {};
    if (!username || !password || String(password).length < 6) return res.status(400).json(fail('账号必填且密码至少 6 位'));
    const perms = Array.isArray(permissions) ? permissions.filter((k) => PERM_KEYS.includes(k)) : [];
    if (!perms.length) return res.status(400).json(fail('请至少勾选一项权限'));
    // 子账号配额 (不含租户管理员自己)
    const tenant = await db('tenants').where({ id: req.auth.tenantId }).first();
    const used = await db('users').where({ tenant_id: req.auth.tenantId }).whereNot('role', 'tenant_admin').count('* as c').first();
    if (used.c >= tenant.account_quota) {
      return res.status(400).json(fail(`子账号配额已满 (${used.c}/${tenant.account_quota}), 请联系平台扩容`));
    }
    const exists = await db('users').where({ username }).first();
    if (exists) return res.status(400).json(fail('账号已存在'));
    const [id] = await db('users').insert({
      username, password: await bcrypt.hash(password, 10), display_name: displayName || username,
      role: 'customer', tenant_id: req.auth.tenantId, permissions: JSON.stringify(perms),
    });
    audit(req, '新建子账号', `user:${username}`, `权限=${perms.join(',')}`);
    return res.json(ok({ id }));
  } catch (e) { next(e); }
});

// ===== 编辑子账号 (权限/名称) =====
router.put('/members/:id', requireRoles('tenant_admin'), async (req, res, next) => {
  try {
    const u = await db('users').where({ id: req.params.id, tenant_id: req.auth.tenantId }).first();
    if (!u) return res.status(404).json(fail('成员不存在'));
    if (u.role === 'tenant_admin') return res.status(400).json(fail('不能编辑租户管理员账号'));
    const { displayName, permissions, status } = req.body || {};
    const patch = { updated_at: new Date() };
    if (displayName != null) patch.display_name = displayName;
    if (permissions !== undefined) {
      const perms = Array.isArray(permissions) ? permissions.filter((k) => PERM_KEYS.includes(k)) : [];
      if (!perms.length) return res.status(400).json(fail('请至少勾选一项权限'));
      patch.permissions = JSON.stringify(perms);
    }
    if (status != null && ['active', 'disabled'].includes(status)) patch.status = status;
    await db('users').where({ id: u.id }).update(patch);
    audit(req, '编辑子账号', `user:${u.username}`, JSON.stringify(patch));
    return res.json(ok());
  } catch (e) { next(e); }
});

// ===== 重置子账号密码 =====
router.post('/members/:id/reset-password', requireRoles('tenant_admin'), async (req, res, next) => {
  try {
    const u = await db('users').where({ id: req.params.id, tenant_id: req.auth.tenantId }).first();
    if (!u) return res.status(404).json(fail('成员不存在'));
    if (u.role === 'tenant_admin') return res.status(400).json(fail('不能重置租户管理员密码'));
    const password = (req.body?.password && String(req.body.password).length >= 6) ? String(req.body.password) : null;
    await db('users').where({ id: u.id }).update({ password: await bcrypt.hash(password, 10) });
    audit(req, '重置子账号密码', `user:${u.username}`);
    return res.json(ok({ password }));
  } catch (e) { next(e); }
});

// 权限项说明 (前端渲染勾选框)
router.get('/perm-keys', (req, res) => res.json(ok({ keys: PERM_KEYS, names: PERM_NAMES })));

module.exports = router;
