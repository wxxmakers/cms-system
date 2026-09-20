<template>
  <div class="page-card">
    <div class="table-toolbar">
      <el-button type="primary" @click="openCreate">新增用户</el-button>
      <el-button @click="groupVisible = true">分组管理</el-button>
    </div>

    <el-table :data="users" v-loading="loading" stripe>
      <el-table-column type="index" label="#" width="60" />
      <el-table-column prop="username" label="账号" width="140" />
      <el-table-column prop="displayName" label="姓名" width="140" />
      <el-table-column label="角色" width="120">
        <template #default="{ row }">
          <el-tag size="small" :type="{ super_admin: 'danger', operator: '', auditor: 'warning', advertiser: 'info' }[row.role]">
            {{ roleNames[row.role] }}
          </el-tag>
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
      <el-table-column label="操作" width="260" fixed="right">
        <template #default="{ row }">
          <el-button link type="primary" @click="openEdit(row)">编辑</el-button>
          <el-button link type="warning" @click="resetPwd(row)">重置密码</el-button>
          <el-button link :type="row.status === 'active' ? 'info' : 'success'" @click="toggleStatus(row)">
            {{ row.status === 'active' ? '停用' : '启用' }}
          </el-button>
        </template>
      </el-table-column>
    </el-table>

    <!-- 用户表单 -->
    <el-dialog v-model="formVisible" :title="editing ? '编辑用户' : '新增用户'" width="440">
      <el-form :model="form" label-width="80px">
        <el-form-item label="账号"><el-input v-model="form.username" :disabled="!!editing" /></el-form-item>
        <el-form-item v-if="!editing" label="密码"><el-input v-model="form.password" type="password" placeholder="至少 6 位" show-password /></el-form-item>
        <el-form-item label="姓名"><el-input v-model="form.displayName" /></el-form-item>
        <el-form-item label="角色">
          <el-select v-model="form.role" style="width:100%">
            <el-option v-for="(n, v) in roleNames" :key="v" :label="n" :value="v" />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="formVisible = false">取消</el-button>
        <el-button type="primary" @click="save">保存</el-button>
      </template>
    </el-dialog>

    <!-- 分组管理 -->
    <el-dialog v-model="groupVisible" title="设备分组管理" width="560">
      <div style="display:flex;gap:8px;margin-bottom:12px">
        <el-input v-model="newGroup" placeholder="新分组名称" style="width:220px" />
        <el-button type="primary" @click="addGroup">新增分组</el-button>
      </div>
      <el-table :data="groups" size="small" border>
        <el-table-column prop="id" label="ID" width="60" />
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
  </div>
</template>

<script setup>
import { onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import http from '../api'
import { formatTime as fmtTime } from '../utils'

const roleNames = { super_admin: '超级管理员', operator: '广告运营', auditor: '审核员', advertiser: '广告主' }

const loading = ref(false)
const users = ref([])
const groups = ref([])
const formVisible = ref(false)
const editing = ref(null)
const form = reactive({ username: '', password: '', displayName: '', role: 'operator' })
const groupVisible = ref(false)
const newGroup = ref('')

async function load() {
  loading.value = true
  try {
    users.value = await http.get('/admin/users')
    groups.value = await http.get('/admin/groups')
  } finally { loading.value = false }
}

function openCreate() {
  editing.value = null
  Object.assign(form, { username: '', password: '', displayName: '', role: 'operator' })
  formVisible.value = true
}

function openEdit(row) {
  editing.value = row
  Object.assign(form, { username: row.username, password: '', displayName: row.displayName, role: row.role })
  formVisible.value = true
}

async function save() {
  if (editing.value) {
    await http.put(`/admin/users/${editing.value.id}`, { displayName: form.displayName, role: form.role })
  } else {
    if (!form.username || !form.password || form.password.length < 6) return ElMessage.warning('请填写账号和至少 6 位密码')
    await http.post('/admin/users', form)
  }
  ElMessage.success('已保存')
  formVisible.value = false
  load()
}

async function resetPwd(row) {
  const data = await http.post(`/admin/users/${row.id}/reset-password`)
  ElMessageBox.alert(`新密码: ${data.password}`, '密码已重置')
}

async function toggleStatus(row) {
  await http.put(`/admin/users/${row.id}`, { status: row.status === 'active' ? 'disabled' : 'active' })
  load()
}

async function addGroup() {
  if (!newGroup.value) return
  await http.post('/admin/groups', { name: newGroup.value })
  newGroup.value = ''
  ElMessage.success('已新增')
  load()
}

async function renameGroup(row) {
  const { value } = await ElMessageBox.prompt('新的分组名称', '重命名', { inputValue: row.name })
  await http.put(`/admin/groups/${row.id}`, { name: value })
  load()
}

async function removeGroup(row) {
  await ElMessageBox.confirm(`确认删除分组「${row.name}」?`, '提示', { type: 'warning' })
  await http.delete(`/admin/groups/${row.id}`)
  load()
}

onMounted(load)
</script>
