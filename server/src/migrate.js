const db = require('./db');

async function migrate() {
  const hasTable = await db.schema.hasTable('users');
  if (!hasTable) await db.schema.createTable('users', (t) => {
    t.increments('id').primary();
    t.string('username', 64).notNullable().unique();
    t.string('password').notNullable();
    t.string('display_name', 64);
    t.string('role', 32).notNullable().defaultTo('operator'); // super_admin | operator | auditor | advertiser
    t.string('status', 16).notNullable().defaultTo('active');
    t.datetime('created_at').notNullable().defaultTo(db.fn.now());
    t.datetime('updated_at');
  });

  if (!(await db.schema.hasTable('groups'))) await db.schema.createTable('groups', (t) => {
    t.increments('id').primary();
    t.string('name', 64).notNullable().unique();
    t.integer('parent_id').nullable();
    t.string('remark', 255);
    t.datetime('created_at').notNullable().defaultTo(db.fn.now());
  });

  if (!(await db.schema.hasTable('devices'))) await db.schema.createTable('devices', (t) => {
    t.increments('id').primary();
    t.string('device_name', 128).notNullable();
    t.string('username', 64).notNullable().unique();
    t.string('password').notNullable();
    t.integer('group_id').nullable();
    t.string('remark', 255);
    t.datetime('last_online').nullable();
    t.string('ip', 64);
    t.string('model', 128);
    t.string('android_version', 32);
    t.string('resolution', 32);
    t.string('app_version', 32);
    t.string('network_type', 32);
    t.string('storage_total');
    t.string('storage_free');
    t.string('temperature', 32);
    t.integer('current_video_id').nullable();
    t.string('screenshot', 255).nullable();
    t.datetime('deleted_at').nullable();
    t.datetime('created_at').notNullable().defaultTo(db.fn.now());
    t.datetime('updated_at').nullable();
  });

  if (!(await db.schema.hasTable('videos'))) await db.schema.createTable('videos', (t) => {
    t.increments('id').primary();
    t.string('name', 255).notNullable();
    t.string('file_path', 255).notNullable();
    t.string('md5', 64).notNullable();
    t.bigInteger('size').notNullable().defaultTo(0);
    t.real('duration').defaultTo(0);
    t.integer('width').defaultTo(0);
    t.integer('height').defaultTo(0);
    t.string('cover', 255).nullable();
    t.string('type', 16).notNullable().defaultTo('video'); // video | image
    t.string('status', 16).notNullable().defaultTo('pending'); // pending | approved | rejected
    t.string('reject_reason', 255);
    t.date('expire_at').nullable();
    t.integer('uploader_id').nullable();
    t.datetime('created_at').notNullable().defaultTo(db.fn.now());
    t.datetime('updated_at').nullable();
  });

  if (!(await db.schema.hasTable('playlists'))) await db.schema.createTable('playlists', (t) => {
    t.increments('id').primary();
    t.string('name', 128).notNullable();
    t.string('remark', 255);
    t.integer('version').notNullable().defaultTo(1);
    t.integer('created_by').nullable();
    t.datetime('created_at').notNullable().defaultTo(db.fn.now());
    t.datetime('updated_at').nullable();
  });

  if (!(await db.schema.hasTable('playlist_items'))) await db.schema.createTable('playlist_items', (t) => {
    t.increments('id').primary();
    t.integer('playlist_id').notNullable();
    t.integer('video_id').notNullable();
    t.integer('sort_order').notNullable().defaultTo(0);
    t.integer('duration').notNullable().defaultTo(0); // 秒, 图片等无固有时长素材使用
  });

  if (!(await db.schema.hasTable('device_playlist'))) await db.schema.createTable('device_playlist', (t) => {
    t.increments('id').primary();
    t.integer('playlist_id').notNullable();
    t.string('target_type', 16).notNullable().defaultTo('device'); // device | group | all
    t.integer('target_id').nullable();
    t.integer('issued_by').nullable();
    t.datetime('issued_at').notNullable().defaultTo(db.fn.now());
  });

  if (!(await db.schema.hasTable('schedules'))) await db.schema.createTable('schedules', (t) => {
    t.increments('id').primary();
    t.string('name', 128).notNullable();
    t.integer('playlist_id').notNullable();
    t.string('priority', 8).notNullable().defaultTo('P1'); // P0 紧急插播 | P1 定时
    t.date('start_date').nullable();
    t.date('end_date').nullable();
    t.string('start_time', 8).notNullable().defaultTo('00:00');
    t.string('end_time', 8).notNullable().defaultTo('23:59');
    t.string('weekdays', 20).notNullable().defaultTo(''); // 空=每天; "1,3,5" 1=周一..7=周日
    t.string('target_type', 16).notNullable().defaultTo('all');
    t.integer('target_id').nullable();
    t.boolean('enabled').notNullable().defaultTo(true);
    t.integer('created_by').nullable();
    t.datetime('created_at').notNullable().defaultTo(db.fn.now());
    t.datetime('updated_at').nullable();
  });

  if (!(await db.schema.hasTable('play_logs'))) await db.schema.createTable('play_logs', (t) => {
    t.increments('id').primary();
    t.integer('device_id').notNullable();
    t.integer('video_id').notNullable();
    t.bigInteger('start_ts').notNullable();
    t.bigInteger('end_ts').nullable();
    t.integer('duration').notNullable().defaultTo(0); // 秒
    t.index(['device_id', 'start_ts']);
    t.index(['video_id', 'start_ts']);
  });

  if (!(await db.schema.hasTable('heartbeat_logs'))) await db.schema.createTable('heartbeat_logs', (t) => {
    t.increments('id').primary();
    t.integer('device_id').notNullable();
    t.boolean('online').notNullable();
    t.bigInteger('ts').notNullable();
    t.index(['ts']);
  });

  if (!(await db.schema.hasTable('device_status_logs'))) await db.schema.createTable('device_status_logs', (t) => {
    t.increments('id').primary();
    t.integer('device_id').notNullable();
    t.string('status', 16).notNullable(); // online | offline
    t.bigInteger('ts').notNullable();
    t.index(['device_id', 'ts']);
  });

  if (!(await db.schema.hasTable('commands'))) await db.schema.createTable('commands', (t) => {
    t.increments('id').primary();
    t.integer('device_id').notNullable();
    t.string('type', 32).notNullable(); // restart_app | refresh_playlist | clear_cache | screenshot | set_volume | set_brightness | reboot | shutdown
    t.string('value', 255).nullable();
    t.string('status', 16).notNullable().defaultTo('pending'); // pending | done | failed
    t.string('result', 255).nullable();
    t.integer('created_by').nullable();
    t.datetime('created_at').notNullable().defaultTo(db.fn.now());
    t.datetime('done_at').nullable();
  });

  if (!(await db.schema.hasTable('audit_logs'))) await db.schema.createTable('audit_logs', (t) => {
    t.increments('id').primary();
    t.integer('user_id').nullable();
    t.string('username', 64);
    t.string('action', 128).notNullable();
    t.string('target', 128).nullable();
    t.string('detail', 512).nullable();
    t.string('ip', 64);
    t.datetime('ts').notNullable().defaultTo(db.fn.now());
  });

  if (!(await db.schema.hasTable('login_logs'))) await db.schema.createTable('login_logs', (t) => {
    t.increments('id').primary();
    t.string('username', 64).notNullable();
    t.string('type', 16).notNullable().defaultTo('admin'); // admin | device
    t.string('ip', 64);
    t.string('ua', 255);
    t.boolean('success').notNullable().defaultTo(false);
    t.string('msg', 128);
    t.datetime('ts').notNullable().defaultTo(db.fn.now());
  });
}

module.exports = { migrate };
