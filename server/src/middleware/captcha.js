// 手写 SVG 图形验证码 (零依赖): 4 位字符 + 干扰线/噪点
const store = new Map(); // captchaId -> { code, expireAt }
const CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function genCode(len = 4) {
  let s = '';
  for (let i = 0; i < len; i++) s += CHARS[Math.floor(Math.random() * CHARS.length)];
  return s;
}

function rnd(min, max) { return Math.random() * (max - min) + min; }

function genSvg(code) {
  const W = 120, H = 44;
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`;
  svg += `<rect width="${W}" height="${H}" fill="#f0f2f5"/>`;
  for (let i = 0; i < 5; i++) {
    svg += `<line x1="${rnd(0, W)}" y1="${rnd(0, H)}" x2="${rnd(0, W)}" y2="${rnd(0, H)}" stroke="hsl(${rnd(0, 360)},60%,60%)" stroke-width="1"/>`;
  }
  for (let i = 0; i < 40; i++) {
    svg += `<circle cx="${rnd(0, W)}" cy="${rnd(0, H)}" r="1" fill="hsl(${rnd(0, 360)},60%,50%)"/>`;
  }
  for (let i = 0; i < code.length; i++) {
    const x = 12 + i * 26 + rnd(-2, 2);
    const y = 30 + rnd(-4, 4);
    svg += `<text x="${x}" y="${y}" font-family="Arial" font-size="${rnd(24, 30)}" font-weight="bold" fill="hsl(${rnd(0, 360)},70%,40%)" transform="rotate(${rnd(-18, 18)} ${x} ${y})">${code[i]}</text>`;
  }
  svg += '</svg>';
  return svg;
}

function createCaptcha() {
  const id = require('crypto').randomUUID();
  const code = genCode();
  store.set(id, { code, expireAt: Date.now() + 5 * 60 * 1000 });
  // 顺手清理过期项
  for (const [k, v] of store) if (v.expireAt < Date.now()) store.delete(k);
  const res = { captchaId: id, svg: genSvg(code) };
  if (process.env.NODE_ENV === 'development') res.debugCode = code; // 便于开发调试/自测
  return res;
}

function verifyCaptcha(id, code) {
  const item = store.get(id);
  if (!item) return false;
  store.delete(id); // 一次性
  if (Date.now() > item.expireAt) return false;
  return String(code || '').toUpperCase() === item.code;
}

module.exports = { createCaptcha, verifyCaptcha };
