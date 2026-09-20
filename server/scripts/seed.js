// 种子脚本: 创建默认管理员与分组 (服务启动时也会自动执行)
const bcrypt = require('bcryptjs');
const db = require('../src/db');
const { migrate } = require('../src/migrate');

async function main() {
  await migrate();
  const admin = await db('users').where({ username: 'admin' }).first();
  if (!admin) {
    await db('users').insert({
      username: 'admin',
      password: await bcrypt.hash('Admin@123', 10),
      display_name: '超级管理员',
      role: 'super_admin',
    });
    console.log('已创建默认管理员: admin / Admin@123');
  } else {
    console.log('管理员已存在, 跳过');
  }
  const g = await db('groups').first();
  if (!g) await db('groups').insert({ name: '默认分组', remark: '系统内置' });
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
