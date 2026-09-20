import axios from 'axios'
import { ElMessage } from 'element-plus'
import router from '../router'

const http = axios.create({ baseURL: '/api', timeout: 60000 })

// 请求带上 access token
http.interceptors.request.use((config) => {
  const auth = JSON.parse(localStorage.getItem('cms_auth') || 'null')
  if (auth?.access) config.headers.Authorization = `Bearer ${auth.access}`
  return config
})

let refreshing = null

// 响应: token 过期自动刷新重试 (需求 5.2.6 思想在 Web 端同样适用)
http.interceptors.response.use(
  (res) => {
    const data = res.data
    if (data && data.code !== 0) {
      ElMessage.error(data.msg || '请求失败')
      return Promise.reject(data)
    }
    return data?.data
  },
  async (err) => {
    const { response, config } = err
    if (response?.status === 401 && !config._retried) {
      const auth = JSON.parse(localStorage.getItem('cms_auth') || 'null')
      if (auth?.refresh && !config._refreshing) {
        config._refreshing = true
        try {
          refreshing = refreshing || axios.post('/api/admin/refresh', { refreshToken: auth.refresh })
          const { data } = await refreshing
          if (data?.code !== 0) throw new Error('refresh failed')
          localStorage.setItem('cms_auth', JSON.stringify({ ...auth, ...data.data }))
          config._retried = true
          config.headers.Authorization = `Bearer ${data.data.access}`
          return http(config)
        } catch (e) {
          localStorage.removeItem('cms_auth')
          router.push('/login')
          ElMessage.error('登录已过期, 请重新登录')
        } finally {
          refreshing = null
        }
      }
    } else if (response?.data?.msg) {
      ElMessage.error(response.data.msg)
    } else {
      ElMessage.error('网络错误或服务不可用')
    }
    return Promise.reject(err)
  },
)

export default http
