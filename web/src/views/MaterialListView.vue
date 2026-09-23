<template>
  <div class="page-card">
    <div class="table-toolbar">
      <el-input v-model="query.keyword" placeholder="素材名称" clearable style="width:200px" @keyup.enter="load" />
      <el-select v-model="query.type" placeholder="全部类型" clearable style="width:120px" @change="load">
        <el-option label="视频" value="video" /><el-option label="图片" value="image" />
      </el-select>
      <el-button type="primary" @click="load">查询</el-button>
      <el-upload :show-file-list="false" :before-upload="onUpload" accept=".mp4,.avi,.mov,.jpg,.jpeg,.png" style="display:inline-block">
        <el-button type="success" :loading="uploading">上传素材 {{ uploading ? `(${uploadProgress}%)` : '' }}</el-button>
      </el-upload>
      <el-button type="danger" plain :disabled="!selection.length" @click="batchRemove">批量删除 ({{ selection.length }})</el-button>
    </div>

    <el-table :data="list" v-loading="loading" stripe @selection-change="(s) => (selection = s)">
      <el-table-column type="selection" width="46" />
      <el-table-column label="封面" width="110">
        <template #default="{ row }">
          <el-image v-if="row.coverUrl" :src="row.coverUrl" fit="cover" style="width:84px;height:48px;border-radius:4px"
            :preview-src-list="row.type === 'image' ? [fileUrl(row)] : [row.coverUrl]" preview-teleported />
          <div v-else style="width:84px;height:48px;background:#f0f2f5;border-radius:4px;display:flex;align-items:center;justify-content:center">
            <el-icon><Film /></el-icon>
          </div>
        </template>
      </el-table-column>
      <el-table-column prop="name" label="名称" min-width="180" show-overflow-tooltip />
      <el-table-column label="类型" width="70">
        <template #default="{ row }">
          <el-tag size="small" :type="row.type === 'video' ? '' : 'warning'">{{ row.type === 'video' ? '视频' : '图片' }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="大小" width="90">
        <template #default="{ row }">{{ fmtSize(row.size) }}</template>
      </el-table-column>
      <el-table-column label="时长/分辨率" width="140">
        <template #default="{ row }">
          {{ row.type === 'video' ? fmtDur(row.duration) : '-' }}
          <span v-if="row.width" style="color:#909399"> {{ row.width }}x{{ row.height }}</span>
        </template>
      </el-table-column>
      <el-table-column prop="md5" label="MD5" width="130" class-name="mono" show-overflow-tooltip />
      <el-table-column label="过期时间" width="110">
        <template #default="{ row }">{{ row.expire_at ? String(row.expire_at).slice(0, 10) : '永不' }}</template>
      </el-table-column>
      <el-table-column label="上传时间" width="160">
        <template #default="{ row }">{{ fmtTime(row.created_at) }}</template>
      </el-table-column>
      <el-table-column label="操作" width="180" fixed="right">
        <template #default="{ row }">
          <el-button link type="primary" @click="preview(row)">预览</el-button>
          <el-button link type="primary" @click="rename(row)">重命名</el-button>
          <el-button link type="danger" @click="remove(row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>
    <div class="pager">
      <el-pagination background layout="total, prev, pager, next" :total="total"
        v-model:current-page="query.page" v-model:page-size="query.pageSize" @current-change="load" @size-change="load" />
    </div>

    <el-dialog v-model="previewVisible" :title="`预览 - ${previewRow?.name || ''}`" width="720" destroy-on-close>
      <video v-if="previewRow?.type === 'video'" :src="fileUrl(previewRow)" controls autoplay style="width:100%;max-height:60vh;background:#000" />
      <el-image v-else :src="fileUrl(previewRow)" fit="contain" style="width:100%;max-height:60vh" />
    </el-dialog>
  </div>
</template>

<script setup>
import { onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import http from '../api'
import { formatBytes as fmtSize, formatDuration as fmtDur, formatTime as fmtTime, readVideoMeta, readImageMeta } from '../utils'

const loading = ref(false)
const uploading = ref(false)
const uploadProgress = ref(0)
const list = ref([])
const total = ref(0)
const selection = ref([])
const query = reactive({ keyword: '', type: '', page: 1, pageSize: 10 })
const previewVisible = ref(false)
const previewRow = ref(null)

function fileUrl(row) {
  return `/files/${row.file_path}`
}

async function load() {
  loading.value = true
  try {
    const data = await http.get('/admin/videos', { params: { ...query, type: query.type || undefined } })
    list.value = data.list
    total.value = data.total
  } finally { loading.value = false }
}

async function onUpload(file) {
  const ext = file.name.split('.').pop().toLowerCase()
  const isVideo = ['mp4', 'avi', 'mov'].includes(ext)
  const isImage = ['jpg', 'jpeg', 'png'].includes(ext)
  if (!isVideo && !isImage) {
    ElMessage.error('仅支持 mp4/avi/mov 视频与 jpg/png 图片')
    return false
  }
  uploading.value = true
  uploadProgress.value = 0
  try {
    // 前端读取元数据 (时长/分辨率/封面), 免服务端 ffmpeg
    const meta = isVideo ? await readVideoMeta(file) : await readImageMeta(file)
    const form = new FormData()
    form.append('file', file)
    form.append('name', file.name.replace(/\.[^.]+$/, ''))
    form.append('duration', meta.duration)
    form.append('width', meta.width)
    form.append('height', meta.height)
    if (meta.cover) form.append('cover', meta.cover)
    await http.post('/admin/videos/upload', form, {
      headers: { 'Content-Type': 'multipart/form-data' },
      onUploadProgress: (e) => { if (e.total) uploadProgress.value = Math.round((e.loaded / e.total) * 100) },
    })
    ElMessage.success(`「${file.name}」上传成功 (MD5 已计算)`)
    load()
  } finally {
    uploading.value = false
  }
  return false // 阻止 el-upload 默认上传
}

async function rename(row) {
  const { value } = await ElMessageBox.prompt('新的素材名称', '重命名', { inputValue: row.name })
  await http.put(`/admin/videos/${row.id}`, { name: value })
  ElMessage.success('已重命名')
  load()
}

async function remove(row) {
  await ElMessageBox.confirm(`确认删除素材「${row.name}」?`, '提示', { type: 'warning' })
  await http.delete(`/admin/videos/${row.id}`)
  ElMessage.success('已删除')
  load()
}

async function batchRemove() {
  await ElMessageBox.confirm(`确认删除选中的 ${selection.value.length} 个素材?`, '提示', { type: 'warning' })
  const data = await http.post('/admin/videos/batch-delete', { ids: selection.value.map((v) => v.id) })
  ElMessage.success(`已删除 ${data.deleted} 个, 跳过(被节目单引用) ${data.skipped} 个`)
  load()
}

function preview(row) {
  previewRow.value = row
  previewVisible.value = true
}

onMounted(load)
</script>
