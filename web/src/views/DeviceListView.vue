<template>
  <div class="page-card">
    <div class="table-toolbar">
      <el-input v-model="query.keyword" placeholder="设备名称 / 账号 / 序列号" clearable style="width:220px" @keyup.enter="load" />
      <el-select v-model="query.groupId" placeholder="全部分组" clearable style="width:160px" @change="load">
        <el-option v-for="g in groups" :key="g.id" :label="g.name" :value="g.id" />
      </el-select>
      <el-button type="primary" @click="load">查询</el-button>
      <el-button type="success" @click="openCreate">新增设备</el-button>
      <el-tag v-if="quota" type="info" effect="plain" style="margin-left:4px">设备配额: {{ quota.deviceUsed }} / {{ quota.deviceQuota }}</el-tag>
      <template v-if="isPlatform">
        <el-button @click="importVisible = true">批量导入</el-button>
        <el-button @click="downloadTemplate">导入模板</el-button>
        <el-button @click="groupVisible = true">分组管理</el-button>
      </template>
    </div>

    <el-table :data="list" v-loading="loading" stripe>
      <el-table-column type="index" label="#" width="60" :index="seqIndex" />
      <el-table-column prop="device_name" label="设备名称" min-width="140" show-overflow-tooltip />
      <el-table-column prop="username" label="设备账号" width="130" class-name="mono" />
      <el-table-column label="序列号" width="150" class-name="mono">
        <template #default="{ row }">
          <span v-if="row.fingerprint">{{ row.fingerprint }}</span>
          <span v-else style="color:#999">—</span>
        </template>
      </el-table-column>
      <el-table-column prop="groupName" label="分组" width="110" />
      <el-table-column prop="tenantName" label="所属租户" width="110">
        <template #default="{ row }">
          <el-tag v-if="row.tenantName" type="success" size="small" effect="plain">{{ row.tenantName }}</el-tag>
          <span v-else style="color:#999">—</span>
        </template>
      </el-table-column>
      <el-table-column label="状态" width="100">
        <template #default="{ row }">
          <el-tag v-if="row.approved === 0" type="warning" effect="dark" size="small">待批准</el-tag>
          <el-tag v-else :type="row.online ? 'success' : 'danger'" effect="dark" size="small">
            {{ row.online ? '在线' : '离线' }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="最后在线" width="160">
        <template #default="{ row }">{{ fmtTime(row.last_online) }}</template>
      </el-table-column>
      <el-table-column prop="app_version" label="版本" width="70" />
      <el-table-column prop="ip" label="IP" width="120" show-overflow-tooltip />
      <el-table-column prop="remark" label="备注" min-width="100" show-overflow-tooltip />
      <el-table-column label="操作" width="230" fixed="right">
        <template #default="{ row }">
          <el-button v-if="row.approved === 0 && isPlatform" link type="success" @click="approve(row)">批准</el-button>
          <el-button link type="primary" @click="openDetail(row)">详情</el-button>
          <el-button v-if="isPlatform" link type="primary" @click="openEdit(row)">编辑</el-button>
          <el-button v-if="isPlatform" link type="warning" @click="resetPwd(row)">重置密码</el-button>
        </template>
      </el-table-column>
    </el-table>
    <div class="pager">
      <el-pagination background layout="total, prev, pager, next, sizes" :total="total"
        v-model:current-page="query.page" v-model:page-size="query.pageSize" :page-sizes="[10, 20, 50]"
        @current-change="load" @size-change="load" />
    </div>

    <!-- 新增/编辑 -->
    <el-dialog v-model="formVisible" :title="editing ? '编辑设备' : '新增设备'" width="460">
      <el-form :model="form" label-width="80px">
        <el-form-item v-if="isTenantAdmin" label="序列号">
          <el-input v-model="form.serial" class="mono-input" placeholder="机身标签 / adb devices 可查" />
          <div style="font-size:12px;color:#909399;line-height:1.6">设备端连接服务器后按序列号自动绑定到您的租户</div>
        </el-form-item>
        <el-form-item label="设备名称"><el-input v-model="form.deviceName" placeholder="如: 门店01-收银台大屏" /></el-form-item>
        <el-form-item v-if="isPlatform" label="分组">
          <el-select v-model="form.groupId" clearable style="width:100%">
            <el-option v-for="g in groups" :key="g.id" :label="g.name" :value="g.id" />
          </el-select>
        </el-form-item>
        <el-form-item v-if="isPlatform" label="所属租户">
          <el-select v-model="form.tenantId" clearable placeholder="不归属任何租户 (仅平台管理)" style="width:100%">
            <el-option v-for="t in tenantsLite" :key="t.id" :label="t.name" :value="t.id" />
          </el-select>
          <div style="font-size:12px;color:#909399;line-height:1.6">归属后该租户的管理员/子账号只能看到此设备及其内容</div>
        </el-form-item>
        <el-form-item label="备注"><el-input v-model="form.remark" type="textarea" :rows="2" /></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="formVisible = false">取消</el-button>
        <el-button type="primary" @click="save">保存</el-button>
      </template>
    </el-dialog>

    <!-- 新增成功展示账号密码 -->
    <el-dialog v-model="credVisible" title="设备账号已生成" width="440">
      <el-alert type="warning" :closable="false" title="初始密码仅此一次展示, 请妥善保存" show-icon style="margin-bottom:12px" />
      <el-descriptions :column="1" border>
        <el-descriptions-item label="设备账号"><span class="mono">{{ cred.username }}</span></el-descriptions-item>
        <el-descriptions-item label="初始密码"><span class="mono">{{ cred.password }}</span></el-descriptions-item>
      </el-descriptions>
      <template #footer>
        <el-button @click="copyCred">复制</el-button>
        <el-button type="primary" @click="credVisible = false">我已保存</el-button>
      </template>
    </el-dialog>

    <!-- 批量导入 -->
    <el-dialog v-model="importVisible" title="批量导入设备" width="520">
      <el-alert type="info" :closable="false" style="margin-bottom:12px"
        title="CSV 格式: 设备名称,分组名称,备注 (首行为表头, UTF-8)" show-icon />
      <input type="file" accept=".csv" @change="onCsvChange" />
      <el-table v-if="importRows.length" :data="importRows" height="220" style="margin-top:12px" border>
        <el-table-column prop="deviceName" label="设备名称" />
        <el-table-column prop="groupName" label="分组" />
        <el-table-column prop="remark" label="备注" />
      </el-table>
      <template #footer>
        <el-button @click="importVisible = false">取消</el-button>
        <el-button type="primary" :disabled="!importRows.length" @click="doImport">导入 ({{ importRows.length }})</el-button>
      </template>
    </el-dialog>

    <!-- 分组管理 -->
    <el-dialog v-model="groupVisible" title="设备分组管理" width="560">
      <div style="display:flex;gap:8px;margin-bottom:12px">
        <el-input v-model="newGroup" placeholder="新分组名称" style="width:220px" @keyup.enter="addGroup" />
        <el-button type="primary" @click="addGroup">新增分组</el-button>
      </div>
      <el-table :data="groups" size="small" border>
        <el-table-column type="index" label="#" width="60" />
        <el-table-column prop="name" label="分组名称" />
        <el-table-column prop="deviceCount" label="设备数" width="80" />
        <el-table-column prop="remark" label="备注" />
        <el-table-column label="操作" width="130">
          <template #default="{ row }">
            <el-button link type="primary" @click="renameGroup(row)">重命名</el-button>
            <el-button link type="danger" @click="removeGroup(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-dialog>

    <!-- 设备详情抽屉 -->
    <el-drawer v-model="detailVisible" :title="`设备详情 - ${detail?.device_name || ''}`" size="560px">
      <template v-if="detail">
        <el-descriptions :column="2" border size="small">
          <el-descriptions-item label="账号">{{ detail.username }}</el-descriptions-item>
          <el-descriptions-item label="状态">
            <el-tag :type="detail.online ? 'success' : 'danger'" size="small">{{ detail.online ? '在线' : '离线' }}</el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="最后在线">{{ fmtTime(detail.last_online) }}</el-descriptions-item>
          <el-descriptions-item label="IP">{{ detail.ip || '-' }}</el-descriptions-item>
          <el-descriptions-item label="机型">{{ detail.model || '-' }}</el-descriptions-item>
          <el-descriptions-item label="Android">{{ detail.android_version || '-' }}</el-descriptions-item>
          <el-descriptions-item label="分辨率">{{ detail.resolution || '-' }}</el-descriptions-item>
          <el-descriptions-item label="网络">{{ detail.network_type || '-' }}</el-descriptions-item>
          <el-descriptions-item label="APK 版本">{{ detail.app_version || '-' }}</el-descriptions-item>
          <el-descriptions-item label="序列号"><span class="mono">{{ detail.fingerprint || '未绑定' }}</span></el-descriptions-item>
          <el-descriptions-item label="所属租户">{{ detail.tenantName || '-' }}</el-descriptions-item>
          <el-descriptions-item label="剩余存储">{{ fmtSize(detail.storage_free) }} / {{ fmtSize(detail.storage_total) }}</el-descriptions-item>
          <el-descriptions-item label="今日播放" :span="2">{{ detail.todayPlays }} 次</el-descriptions-item>
        </el-descriptions>

        <h4 style="margin:18px 0 8px">最近指令</h4>
        <el-table :data="detail.commands || []" size="small" border>
          <el-table-column prop="type" label="指令" width="120" />
          <el-table-column prop="value" label="参数" width="80" />
          <el-table-column label="状态" width="80">
            <template #default="{ row }">
              <el-tag size="small" :type="row.status === 'done' ? 'success' : row.status === 'failed' ? 'danger' : 'warning'">{{ row.status }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="时间" width="150">
            <template #default="{ row }">{{ fmtTime(row.created_at) }}</template>
          </el-table-column>
        </el-table>
      </template>
    </el-drawer>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import http from '../api'
import { formatBytes as fmtSize, formatTime as fmtTime } from '../utils'

const loading = ref(false)
const list = ref([])
const total = ref(0)
const groups = ref([])
const query = reactive({ keyword: '', groupId: null, page: 1, pageSize: 10 })

const formVisible = ref(false)
const editing = ref(null)
const form = reactive({ deviceName: '', groupId: null, tenantId: null, serial: '', remark: '' })

// 租户列表 (设备归属选择)
const tenantsLite = ref([])

const isCustomer = computed(() => JSON.parse(localStorage.getItem('cms_user') || '{}')?.role === 'customer')
const isTenantAdmin = computed(() => JSON.parse(localStorage.getItem('cms_user') || '{}')?.role === 'tenant_admin')
const isPlatform = computed(() => {
  const role = JSON.parse(localStorage.getItem('cms_user') || '{}')?.role
  return role !== 'customer' && role !== 'tenant_admin'
})
const quota = ref(null)

async function loadQuota() {
  if (!isTenantAdmin.value) return
  try { quota.value = await http.get('/admin/tenants/my') } catch { quota.value = null }
}

const credVisible = ref(false)
const cred = reactive({ username: '', password: '' })

const importVisible = ref(false)
const importRows = ref([])

const detailVisible = ref(false)
const detail = ref(null)

// 分页连续序号 (第2页从 11 开始而不是重新从 1)
function seqIndex(i) {
  return (query.page - 1) * query.pageSize + i + 1
}

// ===== 分组管理 =====
const groupVisible = ref(false)
const newGroup = ref('')

async function addGroup() {
  if (!newGroup.value) return ElMessage.warning('请输入分组名称')
  await http.post('/admin/groups', { name: newGroup.value })
  newGroup.value = ''
  ElMessage.success('已新增')
  loadGroups()
}

async function renameGroup(row) {
  const { value } = await ElMessageBox.prompt('新的分组名称', '重命名', { inputValue: row.name })
  await http.put(`/admin/groups/${row.id}`, { name: value })
  ElMessage.success('已重命名')
  loadGroups()
  load()
}

async function removeGroup(row) {
  await ElMessageBox.confirm(`确认删除分组「${row.name}」?`, '提示', { type: 'warning' })
  await http.delete(`/admin/groups/${row.id}`)
  ElMessage.success('已删除')
  loadGroups()
  load()
}

async function load() {
  loading.value = true
  try {
    const data = await http.get('/admin/devices', { params: { ...query, groupId: query.groupId || undefined } })
    list.value = data.list
    total.value = data.total
  } finally { loading.value = false }
}

async function loadGroups() {
  groups.value = await http.get('/admin/groups')
}

async function loadCustomers() {
  try { tenantsLite.value = await http.get('/admin/devices/tenants-lite') } catch { tenantsLite.value = [] }
}

function openCreate() {
  editing.value = null
  Object.assign(form, { deviceName: '', groupId: null, tenantId: null, serial: '', remark: '' })
  formVisible.value = true
}

function openEdit(row) {
  editing.value = row
  Object.assign(form, { deviceName: row.device_name, groupId: row.group_id, tenantId: row.tenant_id || null, remark: row.remark })
  formVisible.value = true
}

async function save() {
  if (!form.deviceName) return ElMessage.warning('请输入设备名称')
  if (editing.value) {
    await http.put(`/admin/devices/${editing.value.id}`, form)
    ElMessage.success('已保存')
  } else if (isTenantAdmin.value) {
    if (!form.serial || form.serial.trim().length < 6) return ElMessage.warning('请输入设备序列号')
    const data = await http.post('/admin/devices', form)
    ElMessage.success(data?.msg || '登记成功')
  } else {
    const data = await http.post('/admin/devices', form)
    Object.assign(cred, data)
    credVisible.value = true
  }
  formVisible.value = false
  load()
}

async function resetPwd(row) {
  await ElMessageBox.confirm(`确认重置设备「${row.device_name}」的密码?`, '提示', { type: 'warning' })
  const data = await http.post(`/admin/devices/${row.id}/reset-password`)
  Object.assign(cred, data)
  credVisible.value = true
}

function copyCred() {
  navigator.clipboard.writeText(`账号: ${cred.username}\n密码: ${cred.password}`)
  ElMessage.success('已复制到剪贴板')
}

// 批准指纹自动注册的设备 (批准后设备 10 秒内自动上线)
async function approve(row) {
  await http.put(`/admin/devices/${row.id}/approve`)
  ElMessage.success('已批准, 设备将自动上线')
  load()
}

function downloadTemplate() {
  const csv = '\uFEFF设备名称,分组名称,备注\n门店01-大屏,华东区,收银台\n门店02-大屏,华东区,入口'
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
  a.download = '设备导入模板.csv'
  a.click()
}

function onCsvChange(e) {
  const file = e.target.files?.[0]
  if (!file) return
  const reader = new FileReader()
  reader.onload = () => {
    const lines = String(reader.result).split(/\r?\n/).filter(Boolean)
    importRows.value = lines.slice(1).map((line) => {
      const [deviceName, groupName, remark] = line.split(',').map((s) => (s || '').trim())
      return { deviceName, groupName, remark }
    }).filter((r) => r.deviceName)
  }
  reader.readAsText(file, 'utf-8')
}

async function doImport() {
  const data = await http.post('/admin/devices/import', { rows: importRows.value })
  ElMessage.success(`成功导入 ${data.created} 台设备`)
  importVisible.value = false
  importRows.value = []
  if (data.accounts?.length) {
    const text = data.accounts.map((a) => `${a.deviceName}: ${a.username} / ${a.password}`).join('\n')
    ElMessageBox.alert(`<pre style="white-space:pre-wrap">${text}</pre>`, '生成的设备账号 (仅此一次展示)', { dangerouslyUseHTMLString: true })
  }
  load()
}

async function openDetail(row) {
  detail.value = await http.get(`/admin/devices/${row.id}`)
  detailVisible.value = true
}

onMounted(() => { load(); loadGroups(); loadCustomers(); loadQuota() })
</script>
