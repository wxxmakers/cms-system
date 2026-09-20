<template>
  <div class="page-card">
    <div class="table-toolbar">
      <el-button type="primary" @click="openEdit(null)">新建排期</el-button>
      <el-button type="danger" @click="emergencyVisible = true">紧急插播</el-button>
      <el-button type="warning" plain @click="loadConflicts">冲突检测</el-button>
      <span class="hint">优先级: P0 紧急插播 &gt; P1 定时排期 &gt; 默认下发节目单 (P2) &gt; 设备兜底素材 (P3)</span>
    </div>

    <el-alert v-if="conflicts.length" type="warning" :closable="false" style="margin-bottom:12px" show-icon
      :title="`检测到 ${conflicts.length} 组同优先级排期时间/目标重叠: ${conflicts.map((c) => `${c.a.name} ↔ ${c.b.name}`).join('; ')}`" />

    <el-table :data="list" v-loading="loading" stripe>
      <el-table-column type="index" label="#" width="55" />
      <el-table-column prop="name" label="排期名称" min-width="150" show-overflow-tooltip />
      <el-table-column label="优先级" width="90">
        <template #default="{ row }">
          <el-tag size="small" :type="row.priority === 'P0' ? 'danger' : ''" effect="dark">
            {{ row.priority === 'P0' ? 'P0 紧急' : 'P1 定时' }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="playlistName" label="节目单" min-width="130" show-overflow-tooltip />
      <el-table-column label="日期" width="190">
        <template #default="{ row }">
          {{ row.start_date ? `${String(row.start_date).slice(0, 10)} ~ ${String(row.end_date).slice(0, 10)}` : '不限' }}
        </template>
      </el-table-column>
      <el-table-column label="时段" width="110">
        <template #default="{ row }">{{ row.start_time }}-{{ row.end_time }}</template>
      </el-table-column>
      <el-table-column label="星期" width="100">
        <template #default="{ row }">{{ weekdaysText(row.weekdays) }}</template>
      </el-table-column>
      <el-table-column prop="targetName" label="目标" width="110" show-overflow-tooltip />
      <el-table-column label="冲突" width="70">
        <template #default="{ row }">
          <el-tag v-if="row.hasConflict" size="small" type="warning">冲突</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="状态" width="80">
        <template #default="{ row }">
          <el-switch :model-value="!!row.enabled" @change="toggle(row)" />
        </template>
      </el-table-column>
      <el-table-column label="操作" width="140" fixed="right">
        <template #default="{ row }">
          <el-button link type="primary" @click="openEdit(row)">编辑</el-button>
          <el-button link type="danger" @click="remove(row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>

    <!-- 排期日历 -->
    <el-divider content-position="left">本周排期日历</el-divider>
    <div class="calendar">
      <div v-for="day in week" :key="day.date" class="cal-col">
        <div class="cal-head" :class="{ today: day.isToday }">{{ day.label }}</div>
        <div class="cal-body">
          <div v-for="s in day.schedules" :key="s.id" class="cal-item" :class="s.priority === 'P0' ? 'p0' : 'p1'">
            <div class="cal-name">{{ s.name }}</div>
            <div class="cal-time">{{ s.start_time }}-{{ s.end_time }} · {{ s.targetName }}</div>
          </div>
          <div v-if="!day.schedules.length" class="cal-empty">—</div>
        </div>
      </div>
    </div>

    <!-- 新建/编辑 -->
    <el-dialog v-model="editVisible" :title="editing ? '编辑排期' : '新建排期'" width="560">
      <el-form :model="form" label-width="100px">
        <el-form-item label="排期名称"><el-input v-model="form.name" placeholder="如: 周末促销档" /></el-form-item>
        <el-form-item label="节目单">
          <el-select v-model="form.playlistId" style="width:100%" filterable>
            <el-option v-for="p in playlists" :key="p.id" :label="p.name" :value="p.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="优先级">
          <el-radio-group v-model="form.priority">
            <el-radio value="P1">P1 定时广告</el-radio>
            <el-radio value="P0">P0 紧急插播</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="投放周期">
          <el-date-picker v-model="dateRange" type="daterange" value-format="YYYY-MM-DD"
            start-placeholder="开始日期" end-placeholder="结束日期" style="width:100%" />
        </el-form-item>
        <el-form-item label="每日时段">
          <el-time-picker v-model="form.startTime" format="HH:mm" value-format="HH:mm" placeholder="开始" />
          <span style="margin:0 8px">至</span>
          <el-time-picker v-model="form.endTime" format="HH:mm" value-format="HH:mm" placeholder="结束" />
        </el-form-item>
        <el-form-item label="星期">
          <el-checkbox-group v-model="weekdayArr">
            <el-checkbox v-for="w in weekOptions" :key="w.v" :value="w.v">{{ w.t }}</el-checkbox>
          </el-checkbox-group>
          <div class="hint">不勾选 = 每天</div>
        </el-form-item>
        <el-form-item label="目标">
          <el-radio-group v-model="form.targetType">
            <el-radio value="all">全部设备</el-radio>
            <el-radio value="group">分组</el-radio>
            <el-radio value="device">设备</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item v-if="form.targetType !== 'all'" label="选择目标">
          <el-select v-if="form.targetType === 'group'" v-model="form.targetId" style="width:100%">
            <el-option v-for="g in groups" :key="g.id" :label="g.name" :value="g.id" />
          </el-select>
          <el-select v-else v-model="form.targetId" filterable style="width:100%">
            <el-option v-for="d in devices" :key="d.id" :label="d.device_name" :value="d.id" />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="editVisible = false">取消</el-button>
        <el-button type="primary" @click="save">保存</el-button>
      </template>
    </el-dialog>

    <!-- 紧急插播 -->
    <el-dialog v-model="emergencyVisible" title="紧急插播 (P0 立即生效)" width="480">
      <el-alert type="error" :closable="false" style="margin-bottom:14px" show-icon
        title="插播将立即覆盖目标设备当前播放, 结束后自动恢复原排期" />
      <el-form :model="emForm" label-width="100px">
        <el-form-item label="插播节目单">
          <el-select v-model="emForm.playlistId" style="width:100%" filterable>
            <el-option v-for="p in playlists" :key="p.id" :label="p.name" :value="p.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="目标">
          <el-radio-group v-model="emForm.targetType">
            <el-radio value="all">全部设备</el-radio>
            <el-radio value="group">分组</el-radio>
            <el-radio value="device">设备</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item v-if="emForm.targetType !== 'all'" label="选择目标">
          <el-select v-if="emForm.targetType === 'group'" v-model="emForm.targetId" style="width:100%">
            <el-option v-for="g in groups" :key="g.id" :label="g.name" :value="g.id" />
          </el-select>
          <el-select v-else v-model="emForm.targetId" filterable style="width:100%">
            <el-option v-for="d in devices" :key="d.id" :label="d.device_name" :value="d.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="持续时长">
          <el-input-number v-model="emForm.minutes" :min="1" :max="1440" /> 分钟
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="emergencyVisible = false">取消</el-button>
        <el-button type="danger" @click="doEmergency">立即插播</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import http from '../api'

const weekOptions = [
  { v: 1, t: '周一' }, { v: 2, t: '周二' }, { v: 3, t: '周三' }, { v: 4, t: '周四' },
  { v: 5, t: '周五' }, { v: 6, t: '周六' }, { v: 7, t: '周日' },
]

const loading = ref(false)
const list = ref([])
const conflicts = ref([])
const playlists = ref([])
const groups = ref([])
const devices = ref([])

const editVisible = ref(false)
const editing = ref(null)
const form = reactive({ name: '', playlistId: null, priority: 'P1', startDate: '', endDate: '', startTime: '09:00', endTime: '21:00', weekdays: '', targetType: 'all', targetId: null })
const dateRange = ref(null)
const weekdayArr = ref([])

const emergencyVisible = ref(false)
const emForm = reactive({ playlistId: null, targetType: 'all', targetId: null, minutes: 10 })

const week = computed(() => {
  const now = new Date()
  const monday = new Date(now)
  monday.setDate(now.getDate() - ((now.getDay() + 6) % 7))
  return weekOptions.map((w, i) => {
    const d = new Date(monday)
    d.setDate(monday.getDate() + i)
    const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    return {
      label: w.t, date: ymd, isToday: ymd === `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`,
      schedules: list.value.filter((s) => {
        if (!s.enabled) return false
        if (s.start_date && ymd < String(s.start_date).slice(0, 10)) return false
        if (s.end_date && ymd > String(s.end_date).slice(0, 10)) return false
        if (s.weekdays && !s.weekdays.split(',').includes(String(w.v))) return false
        return true
      }),
    }
  })
})

function weekdaysText(wd) {
  if (!wd) return '每天'
  const m = { 1: '一', 2: '二', 3: '三', 4: '四', 5: '五', 6: '六', 7: '日' }
  return '周' + wd.split(',').map((n) => m[n] || n).join('/')
}

async function load() {
  loading.value = true
  try {
    list.value = await http.get('/admin/schedules')
    playlists.value = await http.get('/admin/playlists')
    groups.value = await http.get('/admin/groups')
    devices.value = await http.get('/admin/devices', { params: { pageSize: 100 } }).then((d) => d.list)
  } finally { loading.value = false }
}

async function loadConflicts() {
  conflicts.value = await http.get('/admin/schedules/conflicts/list')
  ElMessage.success(conflicts.value.length ? `发现 ${conflicts.value.length} 组冲突` : '未发现排期冲突')
}

function openEdit(row) {
  editing.value = row
  Object.assign(form, {
    name: row?.name || '', playlistId: row?.playlist_id || null, priority: row?.priority || 'P1',
    startDate: row?.start_date ? String(row.start_date).slice(0, 10) : '',
    endDate: row?.end_date ? String(row.end_date).slice(0, 10) : '',
    startTime: row?.start_time || '09:00', endTime: row?.end_time || '21:00',
    weekdays: row?.weekdays || '', targetType: row?.target_type || 'all', targetId: row?.target_id || null,
  })
  dateRange.value = form.startDate ? [form.startDate, form.endDate] : null
  weekdayArr.value = form.weekdays ? form.weekdays.split(',').map(Number) : []
  editVisible.value = true
}

async function save() {
  if (!form.name || !form.playlistId) return ElMessage.warning('请填写名称并选择节目单')
  const body = {
    ...form,
    startDate: dateRange.value?.[0] || null,
    endDate: dateRange.value?.[1] || null,
    weekdays: weekdayArr.value.length ? weekdayArr.value.join(',') : '',
  }
  if (editing.value) await http.put(`/admin/schedules/${editing.value.id}`, body)
  else await http.post('/admin/schedules', body)
  ElMessage.success('已保存')
  editVisible.value = false
  load()
}

async function toggle(row) {
  await http.put(`/admin/schedules/${row.id}/toggle`)
  load()
}

async function remove(row) {
  await ElMessageBox.confirm(`确认删除排期「${row.name}」?`, '提示', { type: 'warning' })
  await http.delete(`/admin/schedules/${row.id}`)
  ElMessage.success('已删除')
  load()
}

async function doEmergency() {
  if (!emForm.playlistId) return ElMessage.warning('请选择插播节目单')
  if (emForm.targetType !== 'all' && !emForm.targetId) return ElMessage.warning('请选择目标')
  await ElMessageBox.confirm('确认立即对目标设备进行紧急插播?', '高危操作', { type: 'error', confirmButtonText: '立即插播' })
  await http.post('/admin/schedules/emergency', emForm)
  ElMessage.success('插播指令已生效')
  emergencyVisible.value = false
  load()
}

onMounted(load)
</script>

<style scoped>
.hint { color: #909399; font-size: 12px; }
.calendar { display: flex; gap: 8px; }
.cal-col { flex: 1; background: #fafbfc; border: 1px solid #ebeef5; border-radius: 6px; overflow: hidden; }
.cal-head { padding: 8px; text-align: center; font-weight: 600; background: #f0f2f5; }
.cal-head.today { background: #409eff; color: #fff; }
.cal-body { padding: 6px; min-height: 140px; }
.cal-item { border-radius: 4px; padding: 6px; margin-bottom: 6px; font-size: 12px; color: #fff; }
.cal-item.p0 { background: #f56c6c; }
.cal-item.p1 { background: #409eff; }
.cal-name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cal-time { opacity: .85; }
.cal-empty { text-align: center; color: #c0c4cc; padding-top: 40px; }
</style>
