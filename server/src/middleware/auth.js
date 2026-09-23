const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const config = require('../config');
const db = require('../db');

function signToken(payload, ttl) {
  return jwt.sign(payload, config.jwtSecret, { expiresIn: ttl });
}

// 管理端登录成功后签发的 token 对 (短期 access + 长期 refresh, 需求 10)
function signAdminTokens(user) {
  const access = signToken({ id: user.id, type: 'admin', role: user.role, username: user.username }, config.accessTtl);
  const refresh = signToken({ id: user.id, type: 'refresh', role: user.role, username: user.username }, config.refreshTtl);
  return { access, refresh };
}

function signDeviceToken(device) {
  return signToken({ id: device.id, type: 'device', username: device.username }, config.deviceTtl);
}

function verify(token) {
  return jwt.verify(token, config.jwtSecret);
}

async function authMiddleware(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ code: 401, msg: '未登录' });
  try {
    const payload = verify(token);
    if (payload.type === 'admin') {
      const user = await db('users').where({ id: payload.id }).first();
      if (!user || user.status !== 'active') return res.status(401).json({ code: 401, msg: '账号不可用' });
      let perms = null;
      if (user.permissions) { try { perms = JSON.parse(user.permissions); } catch { perms = null; } }
      req.auth = {
        id: user.id, type: 'admin', role: user.role, username: user.username,
        tenantId: user.tenant_id || null,
        permissions: Array.isArray(perms) ? perms : null,
      };
    } else if (payload.type === 'device') {
      const device = await db('devices').where({ id: payload.id }).whereNull('deleted_at').first();
      if (!device) return res.status(401).json({ code: 401, msg: '设备不存在或已删除' });
      req.auth = { id: device.id, type: 'device', username: device.username };
    } else {
      return res.status(401).json({ code: 401, msg: '无效 token' });
    }
    next();
  } catch (e) {
    return res.status(401).json({ code: 401, msg: 'token 已过期或无效' });
  }
}

// 角色控制: requireRoles('super_admin') / requireRoles('super_admin','operator')
function requireRoles(...roles) {
  return (req, res, next) => {
    if (req.auth?.type !== 'admin') return res.status(403).json({ code: 403, msg: '无权限' });
    if (roles.length && !roles.includes(req.auth.role)) {
      return res.status(403).json({ code: 403, msg: '当前角色无权执行此操作' });
    }
    next();
  };
}

function requireDevice(req, res, next) {
  if (req.auth?.type !== 'device') return res.status(403).json({ code: 403, msg: '仅设备可调用' });
  next();
}

// ===== 租户数据隔离 (SaaS) =====
// 凡是挂靠租户的账号 (tenant_admin 租户管理员 / customer 子账号) 只能访问本租户数据; 平台账号不受限
function isTenantUser(req) {
  return req.auth?.type === 'admin' && req.auth.tenantId != null;
}

/** 返回租户可见的设备 id 列表; 平台账号返回 null (不限制) */
async function scopedDeviceIds(req) {
  if (!isTenantUser(req)) return null;
  return db('devices').where({ tenant_id: req.auth.tenantId }).whereNull('deleted_at').pluck('id');
}

/** 校验设备在租户可见范围内, 越权返回 true */
async function deviceOutOfScope(req, deviceId) {
  const ids = await scopedDeviceIds(req);
  if (ids == null) return false;
  return !ids.includes(Number(deviceId));
}

/**
 * 细粒度权限 (子账号勾选): devices/materials/playlists/schedules/control/stats
 * 平台账号与租户管理员默认全通过
 */
function hasPerm(req, key) {
  if (!isTenantUser(req)) return true;           // 平台账号
  if (req.auth.role === 'tenant_admin') return true; // 租户管理员
  return Array.isArray(req.auth.permissions) && req.auth.permissions.includes(key);
}

// 内容归属判断 (素材/节目单/排期): tenant_id 字段或 owner_id(=tenant_id) 字段
function rowOutOfScope(req, row, field = 'tenant_id') {
  if (!isTenantUser(req)) return false;
  return !row || row[field] !== req.auth.tenantId;
}

function md5Hex(data) {
  return crypto.createHash('md5').update(data).digest('hex');
}

module.exports = { signAdminTokens, signDeviceToken, verify, authMiddleware, requireRoles, requireDevice, md5Hex, isTenantUser, scopedDeviceIds, deviceOutOfScope, hasPerm, rowOutOfScope };
