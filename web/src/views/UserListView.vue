<template>
  <div class="page-card">
    <div class="table-toolbar">
      <el-button type="primary" @click="openCreate">新增用户</el-button>
      <el-button @click="openTenantMgmt">租户管理</el-button>
    </div>

    <el-table :data="users" v-loading="loading" stripe>
      <el-table-column type="index" label="#" width="60" />
      <el-table-column prop="username" label="账号" width="140" />
      <el-table-column prop="displayName" label="姓名" width="130" />
      <el-table-column label="角色" width="120">
        <template #default="{ row }">
          <el-tag size="small" :type="roleTags[row.role] || 'info'">{{ roleNames[row.role] || row.role }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="tenantName" label="所属租户" width="120">
        <template #default="{ row }">
          <el-tag v-if="row.tenantName" type="success" size="small" effect="plain">{{ row.tenantName }}</el-tag>
          <span v-else style="color:#999">—</span>
        </template>
      </el-table-column>
      <el-table-column label="状态" width="90">
        <template #default="{ row }">
          <el-tag size="small" :type="row.status === 'active' ? 'success' : 'info'">{{ row.status === 'active' ? '正常' : '停用' }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="创建时间" width="170">
        <template #default="{ row }">{{ fmtTime(row.createdAt) }}</template>
      </el-table-column>
      <el-table-column label="操作" width="300" fixed="right">
        <template #default="{ row }">
          <el-button link type="primary" @click="openEdit(row)">编辑</el-button>
          <el-button link type="warning" @click="resetPwd(row)">重置密码</el-button>
          <el-button link :type="row.status === 'active' ? 'info' : 'success'" @click="toggleStatus(row)">
            {{ row.status === 'active' ? '停用' : '启用' }}
          </el-button>
          <el-button link type="danger" @click="removeUser(row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>

    <!-- 用户表单 (新增/编辑) -->
    <el-dialog v-model="formVisible" :title="editing ? '编辑用户' : '新增用户'" width="440">
      <el-form :model="form" label-width="80px">
        <el-form-item label="账号"><el-input v-model="form.username" :disabled="!!editing" /></el-form-item>
        <el-form-item v-if="!editing" label="密码"><el-input v-model="form.password" type="password" placeholder="至少 6 位" show-password /></el-form-item>
        <el-form-item label="姓名"><el-input v-model="form.displayName" /></el-form-item>
        <el-form-item label="角色">
          <el-select v-model="form.role" style="width:100%" :disabled="isSelf(editing)">
            <el-option v-for="(n, v) in roleNames" :key="v" :label="n" :value="v" />
          </el-select>
          <div v-if="isSelf(editing)" style="font-size:12px;color:#909399">不能修改自己的角色</div>
        </el-form-item>
        <el-form-item v-if="form.role === 'tenant_admin'" label="所属租户">
          <el-select v-model="form.tenantId" style="width:100%" placeholder="选择租户">
            <el-option v-for="t in tenants" :key="t.id" :label="t.name" :value="t.id" />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="formVisible = false">取消</el-button>
        <el-button type="primary" @click="save">保存</el-button>
      </template>
    </el-dialog>

    <!-- 租户管理 -->
    <el-dialog v-model="tenantVisible" title="租户管理" width="740">
      <div style="display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap">
        <el-input v-model="newTenant.name" placeholder="租户名称" style="width:180px" />
        <el-input-number v-model="newTenant.deviceQuota" :min="1" controls-position="right" placeholder="设备配额" style="width:120px" />
        <el-input-number v-model="newTenant.accountQuota" :min="0" controls-position="right" placeholder="子账号配额" style="width:120px" />
        <el-button type="primary" @click="addTenant">新建租户</el-button>
      </div>
      <el-table :data="tenants" size="small" border>
        <el-table-column type="index" label="#" width="50" />
        <el-table-column prop="name" label="租户名称" min-width="110" />
        <el-table-column label="设备用量" width="100">
          <template #default="{ row }">{{ row.deviceUsed }} / {{ row.device_quota }}</template>
        </el-table-column>
        <el-table-column label="子账号用量" width="100">
          <template #default="{ row }">{{ row.accountUsed }} / {{ row.account_quota }}</template>
        </el-table-column>
        <el-table-column prop="adminName" label="管理员" width="110" />
        <el-table-column label="状态" width="70">
          <template #default="{ row }">
            <el-tag size="small" :type="row.status === 'active' ? 'success' : 'danger'">{{ row.status === 'active' ? '正常' : '停用' }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="160">
          <template #default="{ row }">
            <el-button link type="primary" @click="editTenant(row)">改配额/改名</el-button>
            <el-button link :type="row.status === 'active' ? 'danger' : 'success'" @click="toggleTenant(row)">
              {{ row.status === 'active' ? '停用' : '启用' }}
            </el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-dialog>
  </div>
</template>

<script setup>
import { onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import http from '../api'
import { formatTime as fmtTime } from '../utils'

const roleNames = { super_admin: '超级管理员', operator: '广告运营', advertiser: '广告主', customer: '子账号', tenant_admin: '租户管理员' }
const roleTags = { super_admin: 'danger', operator: '', advertiser: 'info', customer: 'success', tenant_admin: 'warning' }

const me = JSON.parse(localStorage.getItem('cms_user') || '{}')
const loading = ref(false)
const users = ref([])
const formVisible = ref(false)
const editing = ref(null)
const form = reactive({ username: '', password: '', displayName: '', role: 'operator', tenantId: null })

// ===== 租户管理 =====
const tenantVisible = ref(false)
const tenants = ref([])
const newTenant = reactive({ name: '', deviceQuota: 50, accountQuota: 5 })

function isSelf(row) { return !!row && row.id === me.id }

async function load() {
  loading.value = true
  try {
    users.value = await http.get('/admin/users')
  } finally { loading.value = false }
}

async function loadTenants() {
  try { tenants.value = await http.get('/admin/tenants') } catch { tenants.value = [] }
}

function openTenantMgmt() {
  loadTenants()
  tenantVisible.value = true
}

function openCreate() {
  editing.value = null
  Object.assign(form, { username: '', password: '', displayName: '', role: 'operator', tenantId: null })
  loadTenants()
  formVisible.value = true
}

function openEdit(row) {
  editing.value = row
  Object.assign(form, { username: row.username, password: '', displayName: row.displayName, role: row.role, tenantId: row.tenantId || null })
  loadTenants()
  formVisible.value = true
}

async function save() {
  if (editing.value) {
    const body = { displayName: form.displayName, role: form.role }
    if (form.role === 'tenant_admin') {
      if (!form.tenantId) return ElMessage.warning('租户管理员必须选择所属租户')
      body.tenantId = form.tenantId
    } else {
      body.tenantId = null // 角色调离租户管理员时解除租户绑定
    }
    await http.put(`/admin/users/${editing.value.id}`, body)
  } else {
    if (!form.username || !form.password || form.password.length < 6) return ElMessage.warning('请填写账号和至少 6 位密码')
    if (form.role === 'tenant_admin' && !form.tenantId) return ElMessage.warning('租户管理员必须选择所属租户')
    await http.post('/admin/users', form)
  }
  ElMessage.success('已保存')
  formVisible.value = false
  load()
}

async function resetPwd(row) {
  const { value } = await ElMessageBox.prompt('请输入新密码', `重置密码 - ${row.username}`, {
    inputValue: '',
    inputPlaceholder: '至少 6 位, 留空则自动生成',
    inputValidator: (v) => !v || v.trim().length >= 6 || '密码长度至少 6 位 (留空则自动生成)',
  })
  const data = await http.post(`/admin/users/${row.id}/reset-password`, { password: value?.trim() || undefined })
  ElMessageBox.alert(`新密码: ${data.password}`, '密码已重置')
}

async function toggleStatus(row) {
  if (isSelf(row)) return ElMessage.warning('不能停用自己')
  await http.put(`/admin/users/${row.id}`, { status: row.status === 'active' ? 'disabled' : 'active' })
  load()
}

// 删除账号 (误建账号清理; 其租户内容不受影响)
async function removeUser(row) {
  const tips = [`确认删除账号「${row.username}」?`]
  if (row.role === 'tenant_admin') tips.push('该账号是租户管理员, 删除后其租户下的设备/素材/节目单保留, 可再指定新管理员')
  tips.push('此操作不可恢复')
  await ElMessageBox.confirm(tips.join(' '), '删除账号', { type: 'warning', confirmButtonText: '删除' })
  await http.delete(`/admin/users/${row.id}`)
  ElMessage.success('已删除')
  load()
}

async function addTenant() {
  if (!newTenant.name) return ElMessage.warning('请输入租户名称')
  await http.post('/admin/tenants', newTenant)
  newTenant.name = ''
  ElMessage.success('租户已创建, 可在新增用户时创建该租户的管理员账号')
  loadTenants()
}

async function editTenant(row) {
  const { value } = await ElMessageBox.prompt(
    `名称 / 新配额 (当前: 设备 ${row.device_quota}, 子账号 ${row.account_quota})`,
    `编辑「${row.name}」`, { inputPlaceholder: '格式: 名称,设备数,子账号数 如 客户A,100,10' }
  )
  const parts = String(value || '').split(',').map((x) => x.trim())
  const body = {}
  if (parts[0]) body.name = parts[0]
  const dq = parseInt(parts[1], 10), aq = parseInt(parts[2], 10)
  if (Number.isFinite(dq)) body.deviceQuota = dq
  if (Number.isFinite(aq)) body.accountQuota = aq
  await http.put(`/admin/tenants/${row.id}`, body)
  ElMessage.success('已更新')
  loadTenants()
}

async function toggleTenant(row) {
  await http.put(`/admin/tenants/${row.id}`, { status: row.status === 'active' ? 'disabled' : 'active' })
  loadTenants()
}

onMounted(load)
</script>
