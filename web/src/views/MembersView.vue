<template>
  <div class="page-card">
    <div class="table-toolbar">
      <el-button type="primary" @click="openCreate">新增子账号</el-button>
      <el-tag v-if="quota" type="info" effect="plain" style="margin-left:8px">
        子账号配额: {{ quota.accountUsed }} / {{ quota.accountQuota }}
      </el-tag>
    </div>

    <el-table :data="members" v-loading="loading" stripe>
      <el-table-column type="index" label="#" width="60" />
      <el-table-column prop="username" label="账号" width="160" class-name="mono" />
      <el-table-column prop="displayName" label="姓名" width="140" />
      <el-table-column label="角色" width="110">
        <template #default="{ row }">
          <el-tag size="small" :type="row.role === 'tenant_admin' ? 'warning' : ''">
            {{ row.role === 'tenant_admin' ? '租户管理员' : '子账号' }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="权限" min-width="220">
        <template #default="{ row }">
          <template v-if="row.role === 'tenant_admin'">
            <el-tag size="small" type="warning" effect="plain">全部权限</el-tag>
          </template>
          <template v-else>
            <el-tag v-for="p in row.permissions" :key="p" size="small" effect="plain" style="margin-right:4px">
              {{ permNames[p] || p }}
            </el-tag>
          </template>
        </template>
      </el-table-column>
      <el-table-column label="状态" width="90">
        <template #default="{ row }">
          <el-tag :type="row.status === 'active' ? 'success' : 'danger'" size="small">{{ row.status === 'active' ? '正常' : '停用' }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="220">
        <template #default="{ row }">
          <el-button v-if="row.role !== 'tenant_admin'" link type="primary" @click="openEdit(row)">编辑</el-button>
          <el-button v-if="row.role !== 'tenant_admin'" link type="warning" @click="resetPwd(row)">重置密码</el-button>
          <el-button v-if="row.role !== 'tenant_admin'" link :type="row.status === 'active' ? 'danger' : 'success'" @click="toggle(row)">
            {{ row.status === 'active' ? '停用' : '启用' }}
          </el-button>
        </template>
      </el-table-column>
    </el-table>

    <!-- 新建/编辑 -->
    <el-dialog v-model="formVisible" :title="editing ? '编辑子账号' : '新增子账号'" width="480">
      <el-form :model="form" label-width="90px">
        <el-form-item label="账号">
          <el-input v-model="form.username" :disabled="!!editing" placeholder="登录账号, 如 zhangsan" />
        </el-form-item>
        <el-form-item v-if="!editing" label="密码"><el-input v-model="form.password" placeholder="至少 6 位" /></el-form-item>
        <el-form-item label="姓名"><el-input v-model="form.displayName" placeholder="员工姓名" /></el-form-item>
        <el-form-item label="权限">
          <el-checkbox-group v-model="form.permissions">
            <el-checkbox v-for="(n, k) in permNames" :key="k" :value="k">{{ n }}</el-checkbox>
          </el-checkbox-group>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="formVisible = false">取消</el-button>
        <el-button type="primary" @click="save">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import http from '../api'

const permNames = { devices: '设备查看', materials: '素材管理', playlists: '节目单管理', schedules: '排期管理', control: '远程控制', stats: '数据统计' }

const loading = ref(false)
const members = ref([])
const quota = ref(null)
const formVisible = ref(false)
const editing = ref(null)
const form = reactive({ username: '', password: '', displayName: '', permissions: ['devices', 'materials', 'playlists', 'schedules', 'stats'] })

async function load() {
  loading.value = true
  try {
    members.value = await http.get('/admin/tenants/members')
    quota.value = await http.get('/admin/tenants/my')
  } finally { loading.value = false }
}

function openCreate() {
  editing.value = null
  Object.assign(form, { username: '', password: '', displayName: '', permissions: ['devices', 'materials', 'playlists', 'schedules', 'stats'] })
  formVisible.value = true
}

function openEdit(row) {
  editing.value = row
  Object.assign(form, { username: row.username, password: '', displayName: row.displayName, permissions: [...(row.permissions || [])] })
  formVisible.value = true
}

async function save() {
  if (editing.value) {
    await http.put(`/admin/tenants/members/${editing.value.id}`, { displayName: form.displayName, permissions: form.permissions })
  } else {
    if (!form.username || !form.password || form.password.length < 6) return ElMessage.warning('请填写账号和至少 6 位密码')
    await http.post('/admin/tenants/members', form)
  }
  ElMessage.success('已保存')
  formVisible.value = false
  load()
}

async function resetPwd(row) {
  const { value } = await ElMessageBox.prompt('新密码 (留空自动生成)', '重置密码', { inputPlaceholder: '至少 6 位' })
  const data = await http.post(`/admin/tenants/members/${row.id}/reset-password`, { password: value || undefined })
  ElMessageBox.alert(`新密码: ${data.password || '(已按您输入的设置)'}`, '密码已重置')
}

async function toggle(row) {
  await http.put(`/admin/tenants/members/${row.id}`, { status: row.status === 'active' ? 'disabled' : 'active' })
  load()
}

onMounted(load)
</script>
