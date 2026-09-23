import { createRouter, createWebHistory } from 'vue-router'

const routes = [
  { path: '/login', name: 'login', component: () => import('../views/LoginView.vue'), meta: { title: '登录' } },
  {
    path: '/',
    component: () => import('../layout/AdminLayout.vue'),
    redirect: '/dashboard',
    children: [
      { path: 'dashboard', name: 'dashboard', component: () => import('../views/DashboardView.vue'), meta: { title: '仪表盘', icon: 'Odometer' } },
      { path: 'devices', name: 'devices', component: () => import('../views/DeviceListView.vue'), meta: { title: '设备管理', icon: 'Monitor' } },
      { path: 'monitor', name: 'monitor', component: () => import('../views/MonitorView.vue'), meta: { title: '在线监控', icon: 'DataLine' } },
      { path: 'materials', name: 'materials', component: () => import('../views/MaterialListView.vue'), meta: { title: '素材管理', icon: 'Film' } },
      { path: 'playlists', name: 'playlists', component: () => import('../views/PlaylistListView.vue'), meta: { title: '节目单管理', icon: 'List' } },
      { path: 'schedules', name: 'schedules', component: () => import('../views/ScheduleListView.vue'), meta: { title: '排期管理', icon: 'Calendar' } },
      { path: 'control', name: 'control', component: () => import('../views/ControlView.vue'), meta: { title: '远程控制', icon: 'Setting' } },
      { path: 'stats', name: 'stats', component: () => import('../views/StatsView.vue'), meta: { title: '数据统计', icon: 'TrendCharts' } },
      { path: 'members', name: 'members', component: () => import('../views/MembersView.vue'), meta: { title: '成员管理', icon: 'UserFilled' } },
      { path: 'settings/users', name: 'users', component: () => import('../views/UserListView.vue'), meta: { title: '用户与角色', icon: 'User' } },
      { path: 'settings/logs', name: 'logs', component: () => import('../views/LogView.vue'), meta: { title: '审计与登录日志', icon: 'Document' } },
    ],
  },
  { path: '/:pathMatch(.*)*', redirect: '/dashboard' },
]

const router = createRouter({ history: createWebHistory(), routes })

router.beforeEach((to) => {
  document.title = to.meta.title ? `${to.meta.title} - CMS广告管理系统` : 'CMS广告管理系统'
  const auth = JSON.parse(localStorage.getItem('cms_auth') || 'null')
  if (to.path !== '/login' && !auth?.access) return '/login'
  if (to.path === '/login' && auth?.access) return '/dashboard'
  return true
})

export default router
