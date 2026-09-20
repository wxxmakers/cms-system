// 登录失败锁定: 连续 5 次失败锁定 10 分钟 (需求 5.1.1)
const attempts = new Map(); // key -> { fails, lockedUntil }

function key(prefix, username) { return `${prefix}:${String(username || '').toLowerCase()}`; }

function checkLocked(prefix, username) {
  const a = attempts.get(key(prefix, username));
  if (!a) return false;
  if (a.lockedUntil && Date.now() < a.lockedUntil) {
    const remain = Math.ceil((a.lockedUntil - Date.now()) / 60000);
    return `失败次数过多, 账号已锁定, 请约 ${remain} 分钟后重试`;
  }
  if (a.lockedUntil && Date.now() >= a.lockedUntil) {
    attempts.delete(key(prefix, username));
  }
  return false;
}

function recordFail(prefix, username, maxFails = 5, lockMinutes = 10) {
  const k = key(prefix, username);
  const a = attempts.get(k) || { fails: 0, lockedUntil: 0 };
  a.fails += 1;
  if (a.fails >= maxFails) {
    a.lockedUntil = Date.now() + lockMinutes * 60 * 1000;
    a.fails = 0;
  }
  attempts.set(k, a);
}

function recordSuccess(prefix, username) {
  attempts.delete(key(prefix, username));
}

module.exports = { checkLocked, recordFail, recordSuccess };
