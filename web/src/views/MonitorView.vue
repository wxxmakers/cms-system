<template>
  <div class="page-card">
    <div class="table-toolbar">
      <el-radio-group v-model="statusFilter" @change="load">
        <el-radio-button value="">全部 ({{ total }})</el-radio-button>
        <el-radio-button value="online">在线</el-radio-button>
        <el-radio-button value="offline">离线</el-radio-button>
      </el-radio-group>
      <span class="hint">每 10 秒自动刷新 · 判定规则: 90 秒无心跳 = 离线</span>
      <el-button style="margin-left:auto" @click="load" :loading="loading">立即刷新</el-button>
    </div>

    <el-alert v-if="offlineNew.length" type="error" :closable="false" style="margin-bottom:12px" show-icon
      :title="`离线告警: ${offlineNew.map((d) => d.device_name).join('、')} 已失联 (可扩展邮件/企业微信通知)`" />

    <el-table :data="list" v-loading="loading" stripe>
      <el-table-column prop="id" label="ID" width="60" />
      <el-table-column prop="device_name" label="设备名称" min-width="150" />
      <el-table-column prop="groupName" label="分组" width="110" />
      <el-table-column label="状态" width="90">
        <template #default="{ row }">
          <el-tag :type="row.online ? 'success' : 'danger'" effect="dark" size="small">{{ row.online ? '在线' : '离线' }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="最后心跳" width="170">
        <template #default="{ row }">{{ fmtTime(row.last_online) }}</template>
      </el-table-column>
      <el-table-column prop="resolution" label="分辨率" width="100" />
      <el-table-column prop="network_type" label="网络" width="80" />
      <el-table-column label="剩余存储" width="150">
        <template #default="{ row }">
          <el-progress v-if="row.storage_total" :percentage="pct(row)" :color="pct(row) < 15 ? '#f56c6c' : '#67c23a'" :stroke-width="12" />
          <span v-else>-</span>
        </template>
      </el-table-column>
      <el-table-column prop="app_version" label="版本" width="70" />
      <el-table-column label="操作" width="100" fixed="right">
        <template #default="{ row }">
          <el-button link type="primary" @click="$router.push('/devices')">去管理</el-button>
        </template>
      </el-table-column>
    </el-table>
    <div class="pager">
      <el-pagination background layout="total, prev, pager, next" :total="total"
        v-model:current-page="query.page" :page-size="query.pageSize" @current-change="load" />
    </div>
  </div>
</template>

<script setup>
import { onMounted, onUnmounted, reactive, ref } from 'vue'
import http from '../api'
import { formatBytes, formatTime as fmtTime } from '../utils'

const loading = ref(false)
const list = ref([])
const total = ref(0)
const statusFilter = ref('')
const offlineNew = ref([])
const query = reactive({ page: 1, pageSize: 20 })
let timer = null
let lastOfflineIds = new Set()

async function load(silent) {
  if (!silent) loading.value = true
  try {
    const data = await http.get('/admin/devices', { params: { ...query, status: statusFilter.value || undefined, pageSize: 100 } })
    list.value = data.list
    total.value = data.total
    const curOffline = new Set(data.list.filter((d) => !d.online).map((d) => d.id))
    // 简单的离线告警: 与上次对比新增的离线设备
    offlineNew.value = data.list.filter((d) => !d.online && !lastOfflineIds.has(d.id))
    lastOfflineIds = curOffline
  } finally { if (!silent) loading.value = false }
}

function pct(row) {
  if (!row.storage_total) return 0
  return Math.round((Number(row.storage_free) / Number(row.storage_total)) * 100)
}

onMounted(() => {
  load()
  timer = setInterval(() => load(true), 10000)
})
onUnmounted(() => clearInterval(timer))
</script>

<style scoped>
.hint { color: #909399; font-size: 13px; }
</style>
