<template>
  <div class="page-card">
    <div class="table-toolbar">
      <el-button type="primary" @click="openEdit(null)">创建节目单</el-button>
      <span class="hint">版本号自动递增, 设备按版本增量拉取; 下发后目标设备在下次拉取时生效 (约 1 分钟内)</span>
    </div>

    <el-table :data="list" v-loading="loading" stripe>
      <el-table-column prop="id" label="ID" width="60" />
      <el-table-column prop="name" label="节目单名称" min-width="160" />
      <el-table-column prop="itemCount" label="素材数" width="80" />
      <el-table-column prop="version" label="版本" width="70" />
      <el-table-column prop="issueCount" label="下发次数" width="85" />
      <el-table-column prop="remark" label="备注" min-width="120" show-overflow-tooltip />
      <el-table-column label="创建时间" width="160">
        <template #default="{ row }">{{ fmtTime(row.created_at) }}</template>
      </el-table-column>
      <el-table-column label="操作" width="280" fixed="right">
        <template #default="{ row }">
          <el-button link type="primary" @click="openEdit(row)">编辑</el-button>
          <el-button link type="success" @click="openIssue(row)">下发</el-button>
          <el-button link type="info" @click="viewItems(row)">查看</el-button>
          <el-button link type="danger" @click="remove(row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>

    <!-- 编辑器 -->
    <el-dialog v-model="editVisible" :title="editing ? '编辑节目单' : '创建节目单'" width="860" top="4vh">
      <el-form inline>
        <el-form-item label="名称"><el-input v-model="editForm.name" placeholder="节目单名称" style="width:240px" /></el-form-item>
        <el-form-item label="备注"><el-input v-model="editForm.remark" placeholder="备注" style="width:280px" /></el-form-item>
      </el-form>
      <el-row :gutter="16">
        <el-col :span="10">
          <h4>已过审素材库 (双击添加)</h4>
          <el-table :data="selectable" height="380" size="small" border @row-dblclick="addItem">
            <el-table-column label="封面" width="90">
              <template #default="{ row }">
                <el-image v-if="row.coverUrl" :src="row.coverUrl" fit="cover" style="width:64px;height:38px;border-radius:3px" />
              </template>
            </el-table-column>
            <el-table-column prop="name" label="名称" show-overflow-tooltip />
            <el-table-column label="时长" width="70">
              <template #default="{ row }">{{ row.type === 'video' ? fmtDur(row.duration) : '图片' }}</template>
            </el-table-column>
            <el-table-column width="60">
              <template #default="{ row }">
                <el-button link type="primary" @click="addItem(row)">添加</el-button>
              </template>
            </el-table-column>
          </el-table>
        </el-col>
        <el-col :span="14">
          <h4>播放列表 (拖拽排序)</h4>
          <VueDraggable v-model="editForm.items" :animation="150" item-key="uid" class="drag-list" handle=".drag-handle">
            <div v-for="(item, idx) in editForm.items" :key="item.uid" class="drag-item">
              <el-icon class="drag-handle"><Rank /></el-icon>
              <span class="idx">{{ idx + 1 }}</span>
              <span class="name">{{ item.name }}</span>
              <el-tag size="small" :type="item.type === 'video' ? '' : 'warning'">{{ item.type === 'video' ? '视频' : '图片' }}</el-tag>
              <el-input-number v-model="item.duration" :min="1" :max="600" size="small" style="width:110px" />
              <span style="color:#909399;font-size:12px">秒</span>
              <el-button link type="danger" @click="editForm.items.splice(idx, 1)">移除</el-button>
            </div>
          </VueDraggable>
          <el-empty v-if="!editForm.items.length" description="从左侧素材库添加素材" :image-size="60" />
        </el-col>
      </el-row>
      <template #footer>
        <el-button @click="editVisible = false">取消</el-button>
        <el-button type="primary" @click="save">{{ editing ? '保存 (版本+1)' : '创建' }}</el-button>
      </template>
    </el-dialog>

    <!-- 下发 -->
    <el-dialog v-model="issueVisible" title="下发节目单" width="440">
      <p style="margin-top:0">将「{{ issueTarget?.name }}」下发到:</p>
      <el-radio-group v-model="issueForm.targetType">
        <el-radio value="all">全部设备</el-radio>
        <el-radio value="group">指定分组</el-radio>
        <el-radio value="device">指定设备</el-radio>
      </el-radio-group>
      <div style="margin-top:14px">
        <el-select v-if="issueForm.targetType === 'group'" v-model="issueForm.targetId" placeholder="选择分组" style="width:100%">
          <el-option v-for="g in groups" :key="g.id" :label="g.name" :value="g.id" />
        </el-select>
        <el-select v-if="issueForm.targetType === 'device'" v-model="issueForm.targetId" filterable placeholder="选择设备" style="width:100%">
          <el-option v-for="d in devices" :key="d.id" :label="`${d.device_name} (${d.username})`" :value="d.id" />
        </el-select>
      </div>
      <template #footer>
        <el-button @click="issueVisible = false">取消</el-button>
        <el-button type="primary" @click="doIssue">立即下发</el-button>
      </template>
    </el-dialog>

    <!-- 查看 -->
    <el-dialog v-model="viewVisible" :title="`节目单内容 - ${viewRow?.name || ''}`" width="640">
      <el-table :data="viewItemsData" size="small" border>
        <el-table-column type="index" label="#" width="50" />
        <el-table-column prop="name" label="素材" />
        <el-table-column label="类型" width="70">
          <template #default="{ row }">{{ row.type === 'video' ? '视频' : '图片' }}</template>
        </el-table-column>
        <el-table-column label="时长" width="90">
          <template #default="{ row }">{{ fmtDur(row.duration) }}</template>
        </el-table-column>
        <el-table-column label="状态" width="80">
          <template #default="{ row }">
            <el-tag size="small" :type="row.status === 'approved' ? 'success' : 'info'">{{ { approved: '已审', pending: '待审', rejected: '被拒' }[row.status] }}</el-tag>
          </template>
        </el-table-column>
      </el-table>
    </el-dialog>
  </div>
</template>

<script setup>
import { onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { VueDraggable } from 'vue-draggable-plus'
import http from '../api'
import { formatDuration as fmtDur, formatTime as fmtTime } from '../utils'

let uidSeq = 1
const loading = ref(false)
const list = ref([])
const selectable = ref([])
const groups = ref([])
const devices = ref([])

const editVisible = ref(false)
const editing = ref(null)
const editForm = reactive({ name: '', remark: '', items: [] })

const issueVisible = ref(false)
const issueTarget = ref(null)
const issueForm = reactive({ targetType: 'all', targetId: null })

const viewVisible = ref(false)
const viewRow = ref(null)
const viewItemsData = ref([])

async function load() {
  loading.value = true
  try {
    list.value = await http.get('/admin/playlists')
    selectable.value = await http.get('/admin/videos/selectable/all')
    groups.value = await http.get('/admin/groups')
    devices.value = await http.get('/admin/devices', { params: { pageSize: 100 } }).then((d) => d.list)
  } finally { loading.value = false }
}

function openEdit(row) {
  editing.value = row
  editForm.name = row?.name || ''
  editForm.remark = row?.remark || ''
  editForm.items = []
  if (row) {
    http.get(`/admin/playlists/${row.id}`).then((d) => {
      editForm.items = d.items.map((it) => ({ uid: uidSeq++, videoId: it.videoId, name: it.name, type: it.type, duration: it.duration }))
    })
  }
  editVisible.value = true
}

function addItem(v) {
  editForm.items.push({ uid: uidSeq++, videoId: v.id, name: v.name, type: v.type, duration: Math.max(1, Math.round(v.duration) || 10) })
}

async function save() {
  if (!editForm.name) return ElMessage.warning('请输入节目单名称')
  if (!editForm.items.length) return ElMessage.warning('请至少添加一个素材')
  const body = {
    name: editForm.name, remark: editForm.remark,
    items: editForm.items.map((it, idx) => ({ videoId: it.videoId, duration: it.duration, sortOrder: idx })),
  }
  if (editing.value) await http.put(`/admin/playlists/${editing.value.id}`, body)
  else await http.post('/admin/playlists', body)
  ElMessage.success('已保存')
  editVisible.value = false
  load()
}

function openIssue(row) {
  issueTarget.value = row
  issueForm.targetType = 'all'
  issueForm.targetId = null
  issueVisible.value = true
}

async function doIssue() {
  if (issueForm.targetType !== 'all' && !issueForm.targetId) return ElMessage.warning('请选择下发目标')
  await http.post(`/admin/playlists/${issueTarget.value.id}/issue`, issueForm)
  ElMessage.success('下发成功')
  issueVisible.value = false
  load()
}

async function viewItems(row) {
  viewRow.value = row
  const d = await http.get(`/admin/playlists/${row.id}`)
  viewItemsData.value = d.items
  viewVisible.value = true
}

async function remove(row) {
  await ElMessageBox.confirm(`确认删除节目单「${row.name}」?`, '提示', { type: 'warning' })
  await http.delete(`/admin/playlists/${row.id}`)
  ElMessage.success('已删除')
  load()
}

onMounted(load)
</script>

<style scoped>
.hint { color: #909399; font-size: 13px; }
.drag-list { min-height: 120px; border: 1px dashed #dcdfe6; border-radius: 6px; padding: 4px; }
.drag-item { display: flex; align-items: center; gap: 10px; padding: 8px 10px; background: #fafafa; border-radius: 4px; margin-bottom: 6px; }
.drag-handle { cursor: move; color: #909399; }
.idx { width: 20px; color: #909399; }
.name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
