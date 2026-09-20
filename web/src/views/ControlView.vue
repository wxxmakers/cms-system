<template>
  <div class="page-card">
    <div class="table-toolbar">
      <el-select v-model="selectedDevice" filterable placeholder="选择设备" style="width:280px">
        <el-option v-for="d in devices" :key="d.id" :label="`${d.device_name} (${d.online ? '在线' : '离线'})`" :value="d.id" />
      </el-select>
      <el-button type="primary" :disabled="!selectedDevice" @click="sendCmd('refresh_playlist')">强制刷新节目单</el-button>
      <el-button type="warning" :disabled="!selectedDevice" @click="sendCmd('restart_app')">重启 APK</el-button>
      <el-button type="info" :disabled="!selectedDevice" @click="sendCmd('clear_cache')">清空本地缓存</el-button>
      <el-button :disabled="!selectedDevice" @click="sendCmd('screenshot')">远程截图</el-button>
      <el-button type="danger" plain :disabled="!selectedDevice" @click="sendCmd('reboot')">重启设备</el-button>
    </div>

    <el-row :gutter="16" style="margin-top:6px">
      <el-col :span="12">
        <el-card shadow="never">
          <template #header>音量调节</template>
          <el-slider v-model="volume" :min="0" :max="100" show-input @change="setVolume" />
        </el-card>
      </el-col>
      <el-col :span="12">
        <el-card shadow="never">
          <template #header>屏幕亮度</template>
          <el-slider v-model="brightness" :min="0" :max="100" show-input @change="setBrightness" />
        </el-card>
      </el-col>
    </el-row>

    <el-card shadow="never" style="margin-top:16px">
      <template #header>
        <span>指令历史 ({{ selectedDevice ? '当前设备' : '全部设备' })</span>
        <el-button size="small" style="float:right" @click="loadCommands">刷新</el-button>
      </template>
      <el-table :data="commands" size="small" border>
        <el-table-column prop="id" label="#" width="60" />
        <el-table-column prop="device_id" label="设备ID" width="75" />
        <el-table-column prop="type" label="指令" width="130" />
        <el-table-column prop="value" label="参数" width="90" />
        <el-table-column label="状态" width="90">
          <template #default="{ row }">
            <el-tag size="small" :type="row.status === 'done' ? 'success' : row.status === 'failed' ? 'danger' : 'warning'">
              {{ { pending: '待执行', done: '已完成', failed: '失败' }[row.status] }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="result" label="结果" min-width="140" show-overflow-tooltip />
        <el-table-column label="下发时间" width="160">
          <template #default="{ row }">{{ fmtTime(row.created_at) }}</template>
        </el-table-column>
        <el-table-column label="完成时间" width="160">
          <template #default="{ row }">{{ fmtTime(row.done_at) }}</template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-card shadow="never" style="margin-top:16px">
      <template #header>远程截图 (设备执行截图指令后自动回传)</template>
      <el-image v-if="screenshotUrl" :src="screenshotUrl" fit="contain"
        style="width:100%;max-height:360px;border:1px solid #eee;border-radius:6px" :preview-src-list="[screenshotUrl]" />
      <el-empty v-else description="选择设备并发起截图指令" :image-size="80" />
    </el-card>
  </div>
</template>

<script setup>
import { onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import http from '../api'
import { formatTime as fmtTime } from '../utils'

const devices = ref([])
const selectedDevice = ref(null)
const commands = ref([])
const volume = ref(50)
const brightness = ref(80)
const screenshotUrl = ref('')

const cmdNames = {
  restart_app: '重启 APK', refresh_playlist: '强制刷新节目单', clear_cache: '清空本地缓存',
  screenshot: '远程截图', set_volume: '调节音量', set_brightness: '调节亮度', reboot: '重启设备', shutdown: '关机',
}

async function loadDevices() {
  const d = await http.get('/admin/devices', { params: { pageSize: 100 } })
  devices.value = d.list
}

async function loadCommands() {
  const id = selectedDevice.value
  commands.value = id ? await http.get(`/admin/devices/${id}/commands`) : []
}

async function sendCmd(type, value) {
  if (!selectedDevice.value) return
  if (type === 'reboot') {
    await ElMessageBox.confirm('确认远程重启该设备? (需设备具备系统权限, 普通设备将尝试重启 APK)', '高危操作', { type: 'error' })
  }
  await http.post(`/admin/devices/${selectedDevice.value}/command`, { type, value: value != null ? String(value) : null })
  ElMessage.success(`「${cmdNames[type]}」指令已下发, 设备将在下次心跳 (30 秒内) 执行`)
  loadCommands()
}

function setVolume(v) { if (selectedDevice.value) sendCmd('set_volume', v) }
function setBrightness(v) { if (selectedDevice.value) sendCmd('set_brightness', v) }

async function loadScreenshot() {
  if (!selectedDevice.value) return
  const d = await http.get(`/admin/devices/${selectedDevice.value}`)
  screenshotUrl.value = d.screenshotUrl || ''
}

onMounted(async () => {
  await loadDevices()
  // 截图指令发起后 35 秒自动查看结果
  setInterval(loadScreenshot, 35000)
})
</script>
