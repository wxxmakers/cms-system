const db = require('../db');

function clientIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || '';
}

// 操作审计: 记录管理端写操作 (需求 5.1.9)
function audit(req, action, target, detail) {
  db('audit_logs').insert({
    user_id: req.auth?.id || null,
    username: req.auth?.username || null,
    action,
    target: target ? String(target).slice(0, 128) : null,
    detail: detail ? String(detail).slice(0, 512) : null,
    ip: clientIp(req),
  }).catch(() => {});
}

function ok(data, msg = 'success') { return { code: 0, msg, data }; }
function fail(msg, code = 1) { return { code, msg }; }

function errorHandler(err, req, res, next) { // eslint-disable-line no-unused-vars
  console.error('[error]', err);
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({ code: 413, msg: '请求体过大' });
  }
  res.status(err?.status || 500).json({ code: err?.status || 500, msg: err?.message || '服务器内部错误' });
}

module.exports = { clientIp, audit, ok, fail, errorHandler };
