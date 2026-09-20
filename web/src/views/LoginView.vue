<template>
  <div class="login-bg">
    <el-card class="login-card">
      <h2 class="title">CMS 广告视频播放管理系统</h2>
      <p class="sub">云端集中管控 · 终端无人值守播放</p>
      <el-form :model="form" @keyup.enter="login">
        <el-form-item>
          <el-input v-model="form.username" placeholder="账号" size="large" :prefix-icon="User" />
        </el-form-item>
        <el-form-item>
          <el-input v-model="form.password" type="password" placeholder="密码" size="large" :prefix-icon="Lock" show-password />
        </el-form-item>
        <el-form-item>
          <div class="captcha-row">
            <el-input v-model="form.captchaCode" placeholder="验证码" size="large" maxlength="4" @keyup.enter="login" />
            <img v-if="captchaSvg" :src="captchaImg" class="captcha-img" title="点击刷新" @click="loadCaptcha" />
          </div>
        </el-form-item>
        <el-button type="primary" size="large" style="width:100%" :loading="loading" @click="login">登 录</el-button>
      </el-form>
      <p class="tip">默认管理员: admin / Admin@123</p>
    </el-card>
  </div>
</template>

<script setup>
import { onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { User, Lock } from '@element-plus/icons-vue'
import axios from 'axios'

const router = useRouter()
const form = reactive({ username: '', password: '', captchaCode: '' })
const captchaSvg = ref('')
const captchaId = ref('')
const loading = ref(false)

const captchaImg = ref('')

async function loadCaptcha() {
  const { data } = await axios.get('/api/admin/captcha')
  captchaId.value = data.data.captchaId
  captchaSvg.value = data.data.svg
  captchaImg.value = `data:image/svg+xml;utf8,${encodeURIComponent(data.data.svg)}`
}

async function login() {
  if (!form.username || !form.password || !form.captchaCode) return ElMessage.warning('请填写账号、密码和验证码')
  loading.value = true
  try {
    const { data } = await axios.post('/api/admin/login', {
      username: form.username, password: form.password,
      captchaId: captchaId.value, captchaCode: form.captchaCode,
    })
    if (data.code !== 0) {
      ElMessage.error(data.msg || '登录失败')
      form.captchaCode = ''
      loadCaptcha()
      return
    }
    localStorage.setItem('cms_auth', JSON.stringify({ access: data.data.access, refresh: data.data.refresh }))
    localStorage.setItem('cms_user', JSON.stringify(data.data.user))
    ElMessage.success(`欢迎, ${data.data.user.displayName || data.data.user.username}`)
    router.push('/dashboard')
  } catch (e) {
    const msg = e?.response?.data?.msg
    ElMessage.error(msg || '登录失败')
    form.captchaCode = ''
    loadCaptcha()
  } finally {
    loading.value = false
  }
}

onMounted(loadCaptcha)
</script>

<style scoped>
.login-bg {
  height: 100vh;
  display: flex; align-items: center; justify-content: center;
  background: linear-gradient(135deg, #1c3faa 0%, #0f1f4b 60%, #091226 100%);
}
.login-card { width: 400px; padding: 8px 12px; }
.title { text-align: center; margin: 8px 0 4px; font-size: 20px; }
.sub { text-align: center; color: #909399; font-size: 13px; margin-bottom: 22px; }
.captcha-row { display: flex; gap: 10px; width: 100%; }
.captcha-img { height: 40px; width: 120px; cursor: pointer; border-radius: 4px; border: 1px solid #dcdfe6; }
.tip { text-align: center; color: #c0c4cc; font-size: 12px; margin-top: 12px; }
</style>
