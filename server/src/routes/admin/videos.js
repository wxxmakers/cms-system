const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const db = require('../../db');
const config = require('../../config');
const { authMiddleware, requireRoles, isTenantUser, hasPerm } = require('../../middleware/auth');
const { audit, ok, fail } = require('../../middleware/common');
const storageSvc = require('../../services/storage');

const router = express.Router();
router.use(authMiddleware);

const ALLOWED_EXT = { '.mp4': 'video', '.avi': 'video', '.mov': 'video', '.jpg': 'image', '.jpeg': 'image', '.png': 'image' };

const storage = multer.diskStorage({
  destination: path.join(config.uploadsDir, 'videos'),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${Date.now()}_${crypto.randomBytes(4).toString('hex')}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 2 * 1024 * 1024 * 1024 }, // 2GB
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_EXT[ext]) return cb(new Error('仅支持 mp4/avi/mov 视频与 jpg/png 图片'));
    cb(null, true);
  },
});

function md5File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('md5');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (d) => hash.update(d));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

function saveCover(dataUrl) {
  try {
    const m = /^data:image\/(png|jpeg|jpg);base64,(.+)$/.exec(String(dataUrl || ''));
    if (!m) return null;
    const ext = m[1] === 'png' ? 'png' : 'jpg';
    const name = `cover_${Date.now()}_${crypto.randomBytes(3).toString('hex')}.${ext}`;
    storageSvc.putBuffer(Buffer.from(m[2], 'base64'), `covers/${name}`).catch(() => {});
    return `covers/${name}`;
  } catch { return null; }
}

function toVO(v) {
  return { ...v, coverUrl: v.cover ? `/files/${v.cover}` : null };
}

// ===== 素材列表 =====
router.get('/', async (req, res, next) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Number(req.query.pageSize) || 20);
    let q = db('videos');
    if (!hasPerm(req, 'materials')) return res.status(403).json(fail('无素材管理权限'));
    if (isTenantUser(req)) q = q.where('tenant_id', req.auth.tenantId); // 租户只看本租户素材
    if (req.query.keyword) q = q.andWhere('name', 'like', `%${req.query.keyword}%`);
    if (req.query.type) q = q.andWhere('type', req.query.type);
    if (req.query.status) q = q.andWhere('status', req.query.status);
    const total = await q.clone().count('* as c').first();
    const rows = await q.clone().orderBy('id', 'desc').offset((page - 1) * pageSize).limit(pageSize);
    return res.json(ok({ total: total.c, list: rows.map(toVO) }));
  } catch (e) { next(e); }
});

// ===== 上传素材: 文件由后端计算 MD5; 时长/分辨率/封面由 Web 端读取后一并提交 =====
router.post('/upload', requireRoles('super_admin', 'operator', 'customer', 'tenant_admin'), upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json(fail('缺少文件'));
    const meta = req.body || {};
    const ext = path.extname(req.file.originalname).toLowerCase();
    const md5 = await md5File(req.file.path);
    const cover = saveCover(meta.cover);
    const status = config.autoApprove ? 'approved' : 'pending';
    const [id] = await db('videos').insert({
      name: meta.name || req.file.originalname,
      file_path: `videos/${req.file.filename}`,
      md5,
      size: req.file.size,
      duration: Number(meta.duration) || 0,
      width: Number(meta.width) || 0,
      height: Number(meta.height) || 0,
      cover,
      type: ALLOWED_EXT[ext] || 'video',
      status,
      expire_at: meta.expireAt || null,
      uploader_id: req.auth.id,
      tenant_id: req.auth.tenantId, // 租户账号上传的素材自动归属租户
    });
    // R2 启用时上传到对象存储 (本地模式为空操作); 失败不阻塞响应, 设备拉取时重试
    storageSvc.putFile(req.file.path, `videos/${req.file.filename}`).catch((e) => console.error('[storage] 上传R2失败', e.message));
    audit(req, '上传素材', `video:${meta.name || req.file.originalname}`, `md5=${md5}`);
    return res.json(ok({ id, md5 }));
  } catch (e) {
    if (req.file?.path) { try { fs.unlinkSync(req.file.path); } catch { /* ignore */ } }
    next(e);
  }
});

// ===== 重命名 / 设置过期时间 =====
router.put('/:id', requireRoles('super_admin', 'operator', 'customer', 'tenant_admin'), async (req, res, next) => {
  try {
    const v = await db('videos').where({ id: req.params.id }).first();
    if (!v) return res.status(404).json(fail('素材不存在'));
    if (isTenantUser(req) && v.tenant_id !== req.auth.tenantId) return res.status(404).json(fail('素材不存在'));
    const { name, expireAt } = req.body || {};
    const patch = { updated_at: new Date() };
    if (name != null) patch.name = name;
    if (expireAt !== undefined) patch.expire_at = expireAt || null;
    await db('videos').where({ id: v.id }).update(patch);
    audit(req, '编辑素材', `video:${v.name}`);
    return res.json(ok());
  } catch (e) { next(e); }
});

// ===== 删除素材 (未被节目单引用时同时删文件) =====
router.delete('/:id', requireRoles('super_admin', 'operator', 'customer', 'tenant_admin'), async (req, res, next) => {
  try {
    const v = await db('videos').where({ id: req.params.id }).first();
    if (!v) return res.status(404).json(fail('素材不存在'));
    if (isTenantUser(req) && v.tenant_id !== req.auth.tenantId) return res.status(404).json(fail('素材不存在'));
    const used = await db('playlist_items').where({ video_id: v.id }).first();
    if (used) return res.status(400).json(fail('素材已被节目单引用, 请先从节目单移除'));
    await db('videos').where({ id: v.id }).del();
    await storageSvc.remove(v.file_path);
    if (v.cover) await storageSvc.remove(v.cover);
    audit(req, '删除素材', `video:${v.name}`);
    return res.json(ok());
  } catch (e) { next(e); }
});

// ===== 批量删除 =====
router.post('/batch-delete', requireRoles('super_admin', 'operator', 'customer', 'tenant_admin'), async (req, res, next) => {
  try {
    const ids = (req.body?.ids || []).map(Number).filter(Boolean);
    let deleted = 0, skipped = 0;
    for (const id of ids) {
      const v = await db('videos').where({ id }).first();
      if (!v) continue;
      if (isTenantUser(req) && v.tenant_id !== req.auth.tenantId) continue;
      const used = await db('playlist_items').where({ video_id: id }).first();
      if (used) { skipped += 1; continue; }
      await db('videos').where({ id }).del();
      await storageSvc.remove(v.file_path);
      if (v.cover) await storageSvc.remove(v.cover);
      deleted += 1;
    }
    audit(req, '批量删除素材', `deleted=${deleted} skipped=${skipped}`);
    return res.json(ok({ deleted, skipped }));
  } catch (e) { next(e); }
});

// ===== 素材审核 (先审后发, 需求 2/附录A.5) =====
router.put('/:id/audit', requireRoles('super_admin', 'operator'), async (req, res, next) => {
  try {
    const v = await db('videos').where({ id: req.params.id }).first();
    if (!v) return res.status(404).json(fail('素材不存在'));
    const { status, reason } = req.body || {};
    if (!['pending', 'approved', 'rejected'].includes(status)) return res.status(400).json(fail('状态不合法'));
    await db('videos').where({ id: v.id }).update({ status, reject_reason: status === 'rejected' ? (reason || '') : null, updated_at: new Date() });
    audit(req, '审核素材', `video:${v.name}`, `${status} ${reason || ''}`);
    return res.json(ok());
  } catch (e) { next(e); }
});

// ===== 可选素材 (供节目单编辑器拉取) =====
router.get('/selectable/all', async (req, res, next) => {
  try {
    if (!hasPerm(req, 'materials') && !hasPerm(req, 'playlists')) return res.status(403).json(fail('无权限'));
    let q = db('videos').where({ status: 'approved' });
    if (isTenantUser(req)) q = q.andWhere('tenant_id', req.auth.tenantId); // 租户只能选到本租户素材
    const rows = await q.orderBy('id', 'desc').limit(500);
    return res.json(ok(rows.map(toVO)));
  } catch (e) { next(e); }
});

module.exports = router;
