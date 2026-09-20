const express = require('express');
const db = require('../../db');
const { authMiddleware, requireRoles } = require('../../middleware/auth');
const { audit, ok, fail } = require('../../middleware/common');

const router = express.Router();
router.use(authMiddleware);

function normalizeItems(items) {
  return (Array.isArray(items) ? items : [])
    .filter((it) => it && Number(it.videoId))
    .map((it, idx) => ({
      video_id: Number(it.videoId),
      sort_order: it.sortOrder != null ? Number(it.sortOrder) : idx,
      duration: Math.max(0, Math.round(Number(it.duration) || 0)),
    }))
    .sort((a, b) => a.sort_order - b.sort_order)
    .map((it, idx) => ({ ...it, sort_order: idx }));
}

// ===== 节目单列表 =====
router.get('/', async (req, res, next) => {
  try {
    const rows = await db('playlists').orderBy('id', 'desc');
    const counts = await db('playlist_items').select('playlist_id').count('id as c').groupBy('playlist_id');
    const cmap = {}; counts.forEach((r) => { cmap[r.playlist_id] = r.c; });
    const issues = await db('device_playlist').orderBy('id', 'desc');
    return res.json(ok(rows.map((p) => ({
      ...p,
      itemCount: cmap[p.id] || 0,
      issueCount: issues.filter((i) => i.playlist_id === p.id).length,
    }))));
  } catch (e) { next(e); }
});

// ===== 节目单详情 (含素材信息) =====
router.get('/:id', async (req, res, next) => {
  try {
    const p = await db('playlists').where({ id: req.params.id }).first();
    if (!p) return res.status(404).json(fail('节目单不存在'));
    const items = await db('playlist_items as pi')
      .join('videos as v', 'v.id', 'pi.video_id')
      .where('pi.playlist_id', p.id)
      .orderBy('pi.sort_order', 'asc')
      .select('pi.id', 'pi.sort_order', 'pi.duration as itemDuration', 'v.id as videoId', 'v.name', 'v.type', 'v.duration', 'v.size', 'v.md5', 'v.width', 'v.height', 'v.cover', 'v.status');
    return res.json(ok({
      ...p,
      items: items.map((it) => ({
        id: it.id, sortOrder: it.sort_order, videoId: it.videoId, name: it.name,
        type: it.type, md5: it.md5, size: it.size, width: it.width, height: it.height, status: it.status,
        // 播放时长: 条目自定义 > 素材自身时长 > 10 秒
        duration: it.itemDuration || it.duration || 10,
        coverUrl: it.cover ? `/files/${it.cover}` : null,
      })),
    }));
  } catch (e) { next(e); }
});

// ===== 创建节目单 =====
router.post('/', requireRoles('super_admin', 'operator'), async (req, res, next) => {
  try {
    const { name, remark, items } = req.body || {};
    if (!name) return res.status(400).json(fail('节目单名称必填'));
    const [id] = await db('playlists').insert({ name, remark: remark || null, created_by: req.auth.id });
    const norm = normalizeItems(items);
    if (norm.length) await db('playlist_items').insert(norm.map((it) => ({ ...it, playlist_id: id })));
    audit(req, '创建节目单', `playlist:${name}`, `items=${norm.length}`);
    return res.json(ok({ id }));
  } catch (e) { next(e); }
});

// ===== 编辑节目单 (版本号 +1, 设备据此增量拉取) =====
router.put('/:id', requireRoles('super_admin', 'operator'), async (req, res, next) => {
  try {
    const p = await db('playlists').where({ id: req.params.id }).first();
    if (!p) return res.status(404).json(fail('节目单不存在'));
    const { name, remark, items } = req.body || {};
    const patch = { updated_at: new Date(), version: p.version + 1 };
    if (name != null) patch.name = name;
    if (remark !== undefined) patch.remark = remark;
    await db('playlists').where({ id: p.id }).update(patch);
    if (Array.isArray(items)) {
      await db('playlist_items').where({ playlist_id: p.id }).del();
      const norm = normalizeItems(items);
      if (norm.length) await db('playlist_items').insert(norm.map((it) => ({ ...it, playlist_id: p.id })));
    }
    audit(req, '编辑节目单', `playlist:${p.name}`, `version=${patch.version}`);
    return res.json(ok({ version: patch.version }));
  } catch (e) { next(e); }
});

// ===== 删除节目单 (级联清理条目/下发记录/引用排期, 设备自动回退到更早的默认下发) =====
router.delete('/:id', requireRoles('super_admin', 'operator'), async (req, res, next) => {
  try {
    const p = await db('playlists').where({ id: req.params.id }).first();
    if (!p) return res.status(404).json(fail('节目单不存在'));
    const issues = await db('device_playlist').where({ playlist_id: p.id });
    const schedules = await db('schedules').where({ playlist_id: p.id });
    await db('playlist_items').where({ playlist_id: p.id }).del();
    await db('device_playlist').where({ playlist_id: p.id }).del();
    await db('schedules').where({ playlist_id: p.id }).del();
    await db('playlists').where({ id: p.id }).del();
    audit(req, '删除节目单', `playlist:${p.name}`,
      `级联清理下发记录 ${issues.length} 条, 排期 ${schedules.length} 条`);
    return res.json(ok(null, `已删除, 同时清理 ${issues.length} 条下发记录 / ${schedules.length} 条关联排期`));
  } catch (e) { next(e); }
});

// ===== 下发节目单 (设备 / 分组 / 全部, 需求 5.1.5) =====
router.post('/:id/issue', requireRoles('super_admin', 'operator'), async (req, res, next) => {
  try {
    const p = await db('playlists').where({ id: req.params.id }).first();
    if (!p) return res.status(404).json(fail('节目单不存在'));
    const { targetType, targetId } = req.body || {};
    if (!['device', 'group', 'all'].includes(targetType)) return res.status(400).json(fail('下发目标不合法'));
    if (targetType !== 'all' && !targetId) return res.status(400).json(fail('请选择下发目标'));
    if (targetType === 'device') {
      const d = await db('devices').where({ id: targetId }).whereNull('deleted_at').first();
      if (!d) return res.status(400).json(fail('设备不存在'));
    }
    if (targetType === 'group') {
      const g = await db('groups').where({ id: targetId }).first();
      if (!g) return res.status(400).json(fail('分组不存在'));
    }
    await db('device_playlist').insert({
      playlist_id: p.id, target_type: targetType, target_id: targetType === 'all' ? null : Number(targetId), issued_by: req.auth.id,
    });
    audit(req, '下发节目单', `playlist:${p.name}`, `target=${targetType}:${targetId || '全部'}`);
    return res.json(ok(null, '下发成功, 设备将在下次拉取时生效'));
  } catch (e) { next(e); }
});

// ===== 下发记录 =====
router.get('/:id/issues', async (req, res, next) => {
  try {
    const rows = await db('device_playlist as dp')
      .where('dp.playlist_id', req.params.id)
      .orderBy('dp.issued_at', 'desc')
      .select('dp.*');
    return res.json(ok(rows));
  } catch (e) { next(e); }
});

module.exports = router;
