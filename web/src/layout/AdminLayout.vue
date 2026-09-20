<template>
  <el-container class="layout">
    <el-aside width="220px" class="aside">
      <div class="logo">
        <el-icon :size="22"><Monitor /></el-icon>
        <span>CMS 广告管理系统</span>
      </div>
      <el-menu :default-active="$route.path" router background-color="#001529" text-color="#a6adb4" active-text-color="#fff">
        <el-menu-item v-for="item in menus" :key="item.path" :index="item.path">
          <el-icon><component :is="item.icon" /></el-icon>
          <span>{{ item.title }}</span>
        </el-menu-item>
      </el-menu>
    </el-aside>
    <el-container>
      <el-header class="header">
        <div class="crumb">{{ $route.meta.title }}</div>
        <el-dropdown @command="onCommand">
          <span class="user">
            <el-icon><UserFilled /></el-icon>
            {{ user?.displayName || user?.username || '未知' }} ({{ roleNames[user?.role] || user?.role }})
          </span>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item command="password">修改密码</el-dropdown-item>
              <el-dropdown-item command="logout" divided>退出登录</el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
      </el-header>
      <el-main class="main">
        <router-view />
      </el-main>
    </el-container>

    <el-dialog v-model="pwdVisible" title="修改密码" width="420">
      <el-form :model="pwdForm" label-width="90px">
        <el-form-item label="原密码"><el-input v-model="pwdForm.oldPassword" type="password" show-password /></el-form-item>
        <el-form-item label="新密码"><el-input v-model="pwdForm.newPassword" type="password" show-password placeholder="至少 6 位" /></el-form-item>
        <el-form-item label="确认新密码"><el-input v-model="pwdForm.confirm" type="password" show-password /></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="pwdVisible = false">取消</el-button>
        <el-button type="primary" @click="changePassword">确定</el-button>
      </template>
    </el-dialog>
  </el-container>
</template>

<script setup>
import { computed, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import http from '../api'

const router = useRouter()
const user = computed(() => JSON.parse(localStorage.getItem('cms_user') || 'null'))
const roleNames = { super_admin: '超级管理员', operator: '广告运营', auditor: '审核员', advertiser: '广告主' }

const menus = [
  { path: '/dashboard', title: '仪表盘', icon: 'Odometer' },
  { path: '/devices', title: '设备管理', icon: 'Monitor' },
  { path: '/monitor', title: '在线监控', icon: 'DataLine' },
  { path: '/materials', title: '素材管理', icon: 'Film' },
  { path: '/playlists', title: '节目单管理', icon: 'List' },
  { path: '/schedules', title: '排期管理', icon: 'Calendar' },
  { path: '/control', title: '远程控制', icon: 'Setting' },
  { path: '/stats', title: '数据统计', icon: 'TrendCharts' },
  { path: '/settings/users', title: '用户与角色', icon: 'User' },
  { path: '/settings/logs', title: '审计与登录日志', icon: 'Document' },
]

const pwdVisible = ref(false)
const pwdForm = reactive({ oldPassword: '', newPassword: '', confirm: '' })

function onCommand(cmd) {
  if (cmd === 'logout') {
    localStorage.removeItem('cms_auth')
    localStorage.removeItem('cms_user')
    router.push('/login')
  } else if (cmd === 'password') {
    pwdForm.oldPassword = pwdForm.newPassword = pwdForm.confirm = ''
    pwdVisible.value = true
  }
}

async function changePassword() {
  if (!pwdForm.oldPassword || !pwdForm.newPassword) return ElMessage.warning('请填写完整')
  if (pwdForm.newPassword.length < 6) return ElMessage.warning('新密码至少 6 位')
  if (pwdForm.newPassword !== pwdForm.confirm) return ElMessage.warning('两次输入的新密码不一致')
  await http.post('/admin/change-password', { oldPassword: pwdForm.oldPassword, newPassword: pwdForm.newPassword })
  ElMessage.success('密码已修改, 请重新登录')
  pwdVisible.value = false
  ElMessageBox.alert('密码已修改, 即将跳转到登录页', '提示').then(() => {
    localStorage.removeItem('cms_auth')
    localStorage.removeItem('cms_user')
    router.push('/login')
  })
}
</script>

<style scoped>
.layout { height: 100vh; }
.aside { background: #001529; }
.logo { height: 56px; display: flex; align-items: center; justify-content: center; gap: 8px; color: #fff; font-weight: 600; font-size: 15px; }
.aside :deep(.el-menu) { border-right: none; }
.header { background: #fff; display: flex; align-items: center; justify-content: space-between; box-shadow: 0 1px 4px rgba(0,21,41,.08); }
.crumb { font-size: 15px; font-weight: 600; }
.user { cursor: pointer; display: flex; align-items: center; gap: 6px; }
.main { overflow: auto; }
</style>
