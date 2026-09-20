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
      req.auth = { id: user.id, type: 'admin', role: user.role, username: user.username };
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

function md5Hex(data) {
  return crypto.createHash('md5').update(data).digest('hex');
}

module.exports = { signAdminTokens, signDeviceToken, verify, authMiddleware, requireRoles, requireDevice, md5Hex };
