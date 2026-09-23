const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../../db');
const config = require('../../config');
const { signAdminTokens, verify, authMiddleware } = require('../../middleware/auth');
const captcha = require('../../middleware/captcha');
const lockout = require('../../middleware/lockout');
const { clientIp, audit, ok, fail } = require('../../middleware/common');

const router = express.Router();

// 图形验证码
router.get('/captcha', (req, res) => {
  res.json(ok(captcha.createCaptcha()));
});

// 管理端登录: 账号 + 密码 + 图形验证码, 连续 5 次失败锁定 10 分钟
router.post('/login', async (req, res, next) => {
  try {
    const { username, password, captchaId, captchaCode } = req.body || {};
    const ip = clientIp(req);
    const ua = String(req.headers['user-agent'] || '').slice(0, 255);
    const writeLog = (success, msg) =>
      db('login_logs').insert({ username: String(username || '').slice(0, 64), type: 'admin', ip, ua, success: success ? 1 : 0, msg });

    if (!username || !password) return res.status(400).json(fail('账号密码不能为空'));
    if (!captcha.verifyCaptcha(captchaId, captchaCode)) {
      await writeLog(false, '验证码错误');
      return res.status(400).json(fail('验证码错误或已过期'));
    }

    const locked = lockout.checkLocked('admin', username);
    if (locked) {
      await writeLog(false, '锁定中');
      return res.status(423).json(fail(locked));
    }

    const user = await db('users').where({ username }).first();
    const pass = user && await bcrypt.compare(password, user.password);
    if (!user || !pass || user.status !== 'active') {
      lockout.recordFail('admin', username);
      await writeLog(false, '账号或密码错误');
      return res.status(401).json(fail('账号或密码错误'));
    }

    lockout.recordSuccess('admin', username);
    await writeLog(true, '登录成功');
    const tokens = signAdminTokens(user);
    let perms = null;
    if (user.permissions) { try { perms = JSON.parse(user.permissions); } catch { perms = null; } }
    return res.json(ok({
      ...tokens,
      user: {
        id: user.id, username: user.username, displayName: user.display_name, role: user.role,
        tenantId: user.tenant_id || null,
        permissions: Array.isArray(perms) ? perms : null,
      },
    }));
  } catch (e) { next(e); }
});

// 刷新 access token
router.post('/refresh', async (req, res, next) => {
  try {
    const { refreshToken } = req.body || {};
    if (!refreshToken) return res.status(400).json(fail('缺少 refreshToken'));
    let payload;
    try { payload = verify(refreshToken); } catch { return res.status(401).json(fail('refreshToken 无效')); }
    if (payload.type !== 'refresh') return res.status(401).json(fail('token 类型错误'));
    const user = await db('users').where({ id: payload.id }).first();
    if (!user || user.status !== 'active') return res.status(401).json(fail('账号不可用'));
    return res.json(ok(signAdminTokens(user)));
  } catch (e) { next(e); }
});

// 当前用户信息
router.get('/me', authMiddleware, async (req, res) => {
  const user = await db('users').where({ id: req.auth.id }).first();
  let perms = null;
  if (user.permissions) { try { perms = JSON.parse(user.permissions); } catch { perms = null; } }
  return res.json(ok({
    id: user.id, username: user.username, displayName: user.display_name, role: user.role,
    tenantId: user.tenant_id || null, permissions: Array.isArray(perms) ? perms : null,
  }));
});

// 修改自己的密码
router.post('/change-password', authMiddleware, async (req, res, next) => {
  try {
    const { oldPassword, newPassword } = req.body || {};
    if (!oldPassword || !newPassword || String(newPassword).length < 6) {
      return res.status(400).json(fail('新密码长度至少 6 位'));
    }
    const user = await db('users').where({ id: req.auth.id }).first();
    if (!await bcrypt.compare(oldPassword, user.password)) {
      return res.status(400).json(fail('原密码错误'));
    }
    await db('users').where({ id: user.id }).update({ password: await bcrypt.hash(newPassword, 10), updated_at: new Date() });
    audit(req, '修改密码', `user:${user.username}`);
    return res.json(ok(null, '密码已修改'));
  } catch (e) { next(e); }
});

// ===== 用户与角色管理 (super_admin 专属) =====
const requireSuper = [authMiddleware, (req, res, next) => (req.auth.role === 'super_admin' ? next() : res.status(403).json(fail('仅超级管理员可操作', 403)))];

router.get('/users', ...requireSuper, async (req, res, next) => {
  try {
    const users = await db('users').select('id', 'username', 'display_name as displayName', 'role', 'status', 'tenant_id as tenantId', 'created_at as createdAt').orderBy('id');
    const tenants = await db('tenants');
    const tmap = {}; tenants.forEach((t) => { tmap[t.id] = t.name; });
    return res.json(ok(users.map((u) => ({ ...u, tenantName: u.tenantId ? (tmap[u.tenantId] || null) : null }))));
  } catch (e) { next(e); }
});

router.post('/users', ...requireSuper, async (req, res, next) => {
  try {
    const { username, password, displayName, role } = req.body || {};
    if (!username || !password || String(password).length < 6) return res.status(400).json(fail('账号必填且密码至少 6 位'));
    const roles = ['super_admin', 'operator', 'auditor', 'advertiser', 'tenant_admin', 'customer'];
    if (!roles.includes(role)) return res.status(400).json(fail('角色不合法'));
    const exists = await db('users').where({ username }).first();
    if (exists) return res.status(400).json(fail('账号已存在'));
    let tid = null;
    if (role === 'tenant_admin') {
      if (!req.body?.tenantId) return res.status(400).json(fail('租户管理员必须选择所属租户'));
      const t = await db('tenants').where({ id: Number(req.body.tenantId), status: 'active' }).first();
      if (!t) return res.status(400).json(fail('所选租户不存在'));
      tid = t.id;
    }
    const [id] = await db('users').insert({
      username, password: await bcrypt.hash(password, 10), display_name: displayName || username, role, tenant_id: tid,
    });
    audit(req, '新增用户', `user:${username}`, `role=${role}${tid ? ` tenant#${tid}` : ''}`);
    return res.json(ok({ id }));
  } catch (e) { next(e); }
});

router.put('/users/:id', ...requireSuper, async (req, res, next) => {
  try {
    const { displayName, role, status } = req.body || {};
    const target = await db('users').where({ id: req.params.id }).first();
    if (!target) return res.status(404).json(fail('用户不存在'));
    if (target.id === req.auth.id && status && status !== 'active') {
      return res.status(400).json(fail('不能停用自己'));
    }
    const patch = { updated_at: new Date() };
    if (displayName != null) patch.display_name = displayName;
    if (role != null && ['super_admin', 'operator', 'auditor', 'advertiser', 'tenant_admin', 'customer'].includes(role)) {
      if (target.id === req.auth.id && role !== target.role) {
        return res.status(400).json(fail('不能修改自己的角色'));
      }
      patch.role = role;
      // 角色调整时同步租户绑定
      if (role === 'tenant_admin') {
        if (!req.body?.tenantId) return res.status(400).json(fail('租户管理员必须选择所属租户'));
        const t = await db('tenants').where({ id: Number(req.body.tenantId), status: 'active' }).first();
        if (!t) return res.status(400).json(fail('所选租户不存在'));
        patch.tenant_id = t.id;
      } else {
        patch.tenant_id = null; // 调离租户管理员时解除绑定
        patch.permissions = null;
      }
    }
    if (status != null && ['active', 'disabled'].includes(status)) patch.status = status;
    await db('users').where({ id: target.id }).update(patch);
    audit(req, '编辑用户', `user:${target.username}`, JSON.stringify(patch));
    return res.json(ok());
  } catch (e) { next(e); }
});

// ===== 删除用户 (误建账号清理; 内容归属租户不受影响) =====
router.delete('/users/:id', ...requireSuper, async (req, res, next) => {
  try {
    const target = await db('users').where({ id: req.params.id }).first();
    if (!target) return res.status(404).json(fail('用户不存在'));
    if (target.id === req.auth.id) return res.status(400).json(fail('不能删除自己'));
    if (target.role === 'super_admin') {
      const admins = await db('users').where({ role: 'super_admin', status: 'active' }).count('* as c').first();
      if (admins.c <= 1) return res.status(400).json(fail('系统至少保留一名超级管理员'));
    }
    if (target.role === 'tenant_admin' && target.tenant_id) {
      const others = await db('users').where({ tenant_id: target.tenant_id, role: 'tenant_admin' }).whereNot({ id: target.id }).count('* as c').first();
      if (others.c === 0) {
        const devices = await db('devices').where({ tenant_id: target.tenant_id }).whereNull('deleted_at').count('* as c').first();
        if (devices.c > 0) return res.status(400).json(fail('该租户还有 ' + devices.c + ' 台设备, 请先转移设备或为租户指定新管理员'));
      }
    }
    await db('users').where({ id: target.id }).del();
    audit(req, '删除用户', `user:${target.username}`, `role=${target.role}`);
    return res.json(ok(null, '已删除'));
  } catch (e) { next(e); }
});

router.post('/users/:id/reset-password', ...requireSuper, async (req, res, next) => {
  try {
    const target = await db('users').where({ id: req.params.id }).first();
    if (!target) return res.status(404).json(fail('用户不存在'));
    // 支持自定义密码; 留空则自动生成
    const custom = typeof req.body?.password === 'string' ? req.body.password.trim() : '';
    if (custom && custom.length < 6) return res.status(400).json(fail('密码长度至少 6 位'));
    const pwd = custom || (Math.random().toString(36).slice(-8) + 'A1');
    await db('users').where({ id: target.id }).update({ password: await bcrypt.hash(pwd, 10), updated_at: new Date() });
    audit(req, '重置用户密码', `user:${target.username}`, custom ? '自定义密码' : '自动生成');
    return res.json(ok({ password: pwd }));
  } catch (e) { next(e); }
});

// ===== 分组管理 =====
router.get('/groups', authMiddleware, async (req, res, next) => {
  try {
    const groups = await db('groups').orderBy('id');
    const counts = await db('devices').whereNull('deleted_at').select('group_id').count('id as c').groupBy('group_id');
    const map = {};
    counts.forEach((r) => { if (r.group_id != null) map[r.group_id] = r.c; });
    return res.json(ok(groups.map((g) => ({ ...g, deviceCount: map[g.id] || 0 }))));
  } catch (e) { next(e); }
});

router.post('/groups', authMiddleware, async (req, res, next) => {
  try {
    const { name, remark, parentId } = req.body || {};
    if (!name) return res.status(400).json(fail('分组名称必填'));
    const exists = await db('groups').where({ name }).first();
    if (exists) return res.status(400).json(fail('分组名称已存在'));
    const [id] = await db('groups').insert({ name, remark: remark || null, parent_id: parentId || null });
    audit(req, '新增分组', `group:${name}`);
    return res.json(ok({ id }));
  } catch (e) { next(e); }
});

router.put('/groups/:id', authMiddleware, async (req, res, next) => {
  try {
    const { name, remark } = req.body || {};
    const g = await db('groups').where({ id: req.params.id }).first();
    if (!g) return res.status(404).json(fail('分组不存在'));
    await db('groups').where({ id: g.id }).update({ name: name || g.name, remark: remark != null ? remark : g.remark });
    audit(req, '编辑分组', `group:${g.name}`);
    return res.json(ok());
  } catch (e) { next(e); }
});

router.delete('/groups/:id', authMiddleware, async (req, res, next) => {
  try {
    const g = await db('groups').where({ id: req.params.id }).first();
    if (!g) return res.status(404).json(fail('分组不存在'));
    const used = await db('devices').where({ group_id: g.id }).whereNull('deleted_at').first();
    if (used) return res.status(400).json(fail('分组下仍有设备, 不能删除'));
    await db('groups').where({ id: g.id }).del();
    audit(req, '删除分组', `group:${g.name}`);
    return res.json(ok());
  } catch (e) { next(e); }
});

// ===== 日志查询 =====
router.get('/logs/audit', authMiddleware, async (req, res, next) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Number(req.query.pageSize) || 20);
    let q = db('audit_logs').orderBy('id', 'desc');
    if (req.query.keyword) q = q.where('username', 'like', `%${req.query.keyword}%`);
    const total = await q.clone().count('* as c').first();
    const rows = await q.clone().offset((page - 1) * pageSize).limit(pageSize);
    return res.json(ok({ total: total.c, list: rows }));
  } catch (e) { next(e); }
});

router.get('/logs/login', authMiddleware, async (req, res, next) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Number(req.query.pageSize) || 20);
    let q = db('login_logs').orderBy('id', 'desc');
    if (req.query.type) q = q.where('type', req.query.type);
    const total = await q.clone().count('* as c').first();
    const rows = await q.clone().offset((page - 1) * pageSize).limit(pageSize);
    return res.json(ok({ total: total.c, list: rows }));
  } catch (e) { next(e); }
});

module.exports = router;
