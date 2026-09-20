/* 自测脚本: 走通 管理登录 → 建设备 → 设备登录/心跳 → 上传素材 → 节目单 → 下发 → 设备拉取 → 上报 → 统计 */
const BASE = process.env.BASE || 'http://localhost:3000';
const fs = require('fs');
const path = require('path');

async function api(method, url, body, token, isForm) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload;
  if (isForm) {
    payload = body; // FormData
  } else if (body != null) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${BASE}${url}`, { method, headers, body: payload });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

function assert(cond, name, extra) {
  console.log(`${cond ? '✅' : '❌'} ${name}${cond ? '' : ' -> ' + JSON.stringify(extra)}`);
  if (!cond) process.exitCode = 1;
}

(async () => {
  // 1. 管理端登录
  const cap = (await api('GET', '/api/admin/captcha')).json.data;
  const login = await api('POST', '/api/admin/login', {
    username: 'admin', password: 'Admin@123', captchaId: cap.captchaId, captchaCode: cap.debugCode,
  });
  assert(login.status === 200 && login.json.data?.access, '管理端登录', login.json);
  const token = login.json.data.access;

  // 2. 新增设备
  const dev = await api('POST', '/api/admin/devices', { deviceName: '测试设备-前台大屏', groupId: 1, remark: '自测' }, token);
  assert(dev.status === 200 && dev.json.data?.username, '新增设备(自动生成账号)', dev.json);
  const { username, password, id: deviceId } = dev.json.data;

  // 3. 设备登录
  const dlogin = await api('POST', '/api/device/login', { username, password });
  assert(dlogin.status === 200 && dlogin.json.data?.token, '设备登录', dlogin.json);
  const dtoken = dlogin.json.data.token;

  // 4. 心跳
  const hb = await api('POST', '/api/device/heartbeat', {
    appVersion: '1.0', model: 'EMU64', androidVersion: '14', resolution: '1920x1080',
    storageTotal: 32 * 1024, storageFree: 12 * 1024, networkType: 'wifi',
  }, dtoken);
  assert(hb.status === 200 && hb.json.data?.serverTime, '心跳上报', hb.json);

  // 5. 上传素材 (伪 mp4 测试文件)
  const tmp = path.join(__dirname, 'test.mp4');
  fs.writeFileSync(tmp, Buffer.alloc(1024 * 64, 7));
  const form = new FormData();
  form.append('file', new Blob([fs.readFileSync(tmp)], { type: 'video/mp4' }), '测试广告.mp4');
  form.append('name', '测试广告');
  form.append('duration', '15');
  form.append('width', '1920');
  form.append('height', '1080');
  const up = await api('POST', '/api/admin/videos/upload', form, token, true);
  assert(up.status === 200 && up.json.data?.md5, '素材上传(MD5 计算)', up.json);
  const videoId = up.json.data.id;
  fs.unlinkSync(tmp);

  // 6. 创建节目单并下发
  const pl = await api('POST', '/api/admin/playlists', { name: '默认轮播节目单', remark: '自测', items: [{ videoId, duration: 15, sortOrder: 0 }] }, token);
  assert(pl.status === 200 && pl.json.data?.id, '创建节目单', pl.json);
  const playlistId = pl.json.data.id;
  const issue = await api('POST', `/api/admin/playlists/${playlistId}/issue`, { targetType: 'all' }, token);
  assert(issue.status === 200, '下发节目单(全部)', issue.json);

  // 7. 设备拉取节目单
  const got = await api('GET', '/api/device/playlist', null, dtoken);
  assert(got.status === 200 && got.json.data?.items?.length === 1 && got.json.data.items[0].md5, '设备拉取节目单(排期引擎)', got.json);
  const item = got.json.data?.items?.[0] || {};
  const dl = await fetch(item.url);
  assert(dl.status === 200, '素材文件下载', item.url);

  // 8. 紧急插播优先级验证
  const pl2 = await api('POST', '/api/admin/playlists', { name: '紧急插播节目单', items: [{ videoId, duration: 5 }] }, token);
  const em = await api('POST', '/api/admin/schedules/emergency', { playlistId: pl2.json.data.id, targetType: 'all', minutes: 10 }, token);
  assert(em.status === 200, '紧急插播下发', em.json);
  const got2 = await api('GET', '/api/device/playlist', null, dtoken);
  assert(got2.json.data?.source === 'emergency', '插播覆盖优先级(P0)', got2.json.data);

  // 9. 播放上报 + 统计
  const rep = await api('POST', '/api/device/report', { logs: [{ videoId, startTs: Date.now() - 15000, endTs: Date.now(), duration: 15 }] }, dtoken);
  assert(rep.status === 200 && rep.json.data.accepted === 1, '播放日志上报', rep.json);
  const rank = await api('GET', '/api/admin/stats/play-ranking?days=1', null, token);
  assert(rank.status === 200 && rank.json.data[0]?.plays === 1, '播放次数统计', rank.json);
  const sum = await api('GET', '/api/admin/stats/summary', null, token);
  assert(sum.json.data?.deviceOnline === 1, '在线统计(心跳后在线)', sum.json.data);

  // 10. 远程控制指令
  const cmd = await api('POST', `/api/admin/devices/${deviceId}/command`, { type: 'set_volume', value: '30' }, token);
  assert(cmd.status === 200, '下发远程指令', cmd.json);
  const hb2 = await api('POST', '/api/device/heartbeat', {}, dtoken);
  assert(hb2.json.data?.commands?.some((c) => c.type === 'set_volume'), '心跳带回指令', hb2.json.data);
  const ack = await api('POST', '/api/device/command/ack', { id: hb2.json.data.commands[0].id, result: 'success' }, dtoken);
  assert(ack.status === 200, '指令回执', ack.json);

  console.log('\n自测完成');
  process.exit(process.exitCode || 0);
})().catch((e) => { console.error('自测异常:', e); process.exit(1); });
