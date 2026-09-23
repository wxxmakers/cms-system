<template>
  <div class="page-card">
    <div class="table-toolbar">
      <el-select v-model="selectedDevice" filterable placeholder="选择设备" style="width:280px"
        @change="loadCommands(); loadScreenshot()">
        <el-option v-for="d in devices" :key="d.id" :label="`${d.device_name} (${d.online ? '在线' : '离线'})`" :value="d.id" />
      </el-select>
      <el-button type="primary" :disabled="!selectedDevice" @click="sendCmd('refresh_playlist')">强制刷新节目单</el-button>
      <el-button type="warning" :disabled="!selectedDevice" @click="sendCmd('restart_app')">重启 APK</el-button>
      <el-button type="info" :disabled="!selectedDevice" @click="sendCmd('clear_cache')">清空本地缓存</el-button>
      <el-button :disabled="!selectedDevice" @click="sendCmd('screenshot')">远程截图</el-button>
      <el-button type="danger" plain :disabled="!selectedDevice" @click="sendCmd('reboot')">重启设备</el-button>
      <el-button type="danger" :disabled="!selectedDevice" @click="sendCmd('shutdown')">关机</el-button>
      <el-button type="warning" plain :disabled="!selectedDevice" @click="sendCmd('sleep')">休眠</el-button>
      <el-button type="success" plain :disabled="!selectedDevice" @click="sendCmd('wakeup')">唤醒</el-button>
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

    <!-- 定时开关机 (RK 平台 system/shuttime.apk) -->
    <el-row :gutter="16" style="margin-top:16px">
      <el-col :span="24">
        <el-card shadow="never">
          <template #header>
            <span>定时开关机</span>
            <el-tag size="small" type="info" style="margin-left:8px">RK 平台系统级方案</el-tag>
          </template>
          <el-form inline>
            <el-form-item label="定时开机">
              <el-time-picker v-model="powerOn" format="HH:mm" value-format="HH:mm" placeholder="08:00" />
            </el-form-item>
            <el-form-item label="定时关机">
              <el-time-picker v-model="powerOff" format="HH:mm" value-format="HH:mm" placeholder="22:30" />
            </el-form-item>
            <el-form-item label="重复">
              <el-select v-model="powerWeek" style="width:110px">
                <el-option label="每天" value="0" />
                <el-option label="周日" value="1" />
                <el-option label="周一" value="2" />
                <el-option label="周二" value="3" />
                <el-option label="周三" value="4" />
                <el-option label="周四" value="5" />
                <el-option label="周五" value="6" />
                <el-option label="周六" value="7" />
              </el-select>
            </el-form-item>
            <el-form-item>
              <el-button type="primary" :disabled="!selectedDevice" @click="setPowerSchedule(true)">
                启用定时开关机
              </el-button>
              <el-button :disabled="!selectedDevice" @click="setPowerSchedule(false)">取消定时</el-button>
            </el-form-item>
          </el-form>
          <el-alert type="info" :closable="false" show-icon
            title="设置后由设备端系统级定时器在关机时段断电、开机时段自动唤醒 (依赖 RK 平台 shuttime 系统组件)" />
        </el-card>
      </el-col>
    </el-row>

    <el-card shadow="never" style="margin-top:16px">
      <template #header>
        <span>指令历史 ({{ selectedDevice ? '当前设备' : '全部设备' }})</span>
        <el-button size="small" type="danger" plain style="float:right" :disabled="!selectedDevice" @click="clearCommands">清空</el-button>
        <el-button size="small" style="float:right; margin-right:8px" @click="loadCommands">刷新</el-button>
      </template>
      <el-table :data="commands" size="small" border>
        <el-table-column type="index" label="#" width="60" />
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

// 定时开关机
const powerOn = ref('08:00')
const powerOff = ref('22:30')
const powerWeek = ref('0')

const cmdNames = {
  restart_app: '重启 APK', refresh_playlist: '强制刷新节目单', clear_cache: '清空本地缓存',
  screenshot: '远程截图', set_volume: '调节音量', set_brightness: '调节亮度',
  set_power_schedule: '定时开关机', reboot: '重启设备', shutdown: '关机', sleep: '休眠', wakeup: '唤醒',
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
  // 高危指令二次确认
  if (type === 'reboot') {
    await ElMessageBox.confirm('确认远程重启该设备? 系统级重启, 约 1 分钟后自动恢复上线', '高危操作', { type: 'error', confirmButtonText: '立即重启' })
  } else if (type === 'shutdown') {
    await ElMessageBox.confirm('确认远程关机该设备? 关机后设备离线, 需定时开机/人工上电/物理开机才能恢复!', '高危操作', { type: 'error', confirmButtonText: '立即关机' })
  } else if (type === 'sleep') {
    await ElMessageBox.confirm('确认让该设备进入休眠? 休眠期间设备离线、无法远程唤醒, 需触摸屏幕或物理唤醒!', '高危操作', { type: 'warning', confirmButtonText: '立即休眠' })
  }
  await http.post(`/admin/devices/${selectedDevice.value}/command`, { type, value: value != null ? String(value) : null })
  ElMessage.success(`「${cmdNames[type]}」指令已下发, 设备将在下次心跳 (30 秒内) 执行`)
  loadCommands()
}

function setVolume(v) { if (selectedDevice.value) sendCmd('set_volume', v) }
function setBrightness(v) { if (selectedDevice.value) sendCmd('set_brightness', v) }

// 定时开关机: week 编码与 RK 系统组件一致 (0=每天, 1=周日..7=周六)
async function setPowerSchedule(enable) {
  if (!selectedDevice.value) return
  if (enable && (!powerOn.value || !powerOff.value)) return ElMessage.warning('请选择开关机时间')
  const [onH, onM] = (powerOn.value || '08:00').split(':')
  const [offH, offM] = (powerOff.value || '22:30').split(':')
  const value = JSON.stringify({ onHour: onH, onMin: onM, offHour: offH, offMin: offM, week: powerWeek.value, enable })
  await http.post(`/admin/devices/${selectedDevice.value}/command`, { type: 'set_power_schedule', value })
  ElMessage.success(enable ? '定时开关机指令已下发, 设备将在下次心跳 (30 秒内) 生效' : '取消定时指令已下发')
  loadCommands()
}

// 清空当前设备指令历史 (系统自动保留每设备最新 10 条)
async function clearCommands() {
  if (!selectedDevice.value) return
  await ElMessageBox.confirm('确认清空该设备的全部指令历史?', '提示', { type: 'warning' })
  const data = await http.delete(`/admin/devices/${selectedDevice.value}/commands`)
  ElMessage.success(data?.msg || '指令历史已清空')
  loadCommands()
}

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
