<template>
  <div>
    <el-tabs v-model="tab">
      <el-tab-pane label="操作审计日志" name="audit">
        <div class="table-toolbar">
          <el-input v-model="auditQuery.keyword" placeholder="操作人" clearable style="width:200px" @keyup.enter="loadAudit" />
          <el-button type="primary" @click="loadAudit">查询</el-button>
        </div>
        <el-table :data="auditList" v-loading="auditLoading" stripe border>
          <el-table-column type="index" label="#" width="70" :index="(i) => (auditQuery.page - 1) * auditQuery.pageSize + i + 1" />
          <el-table-column prop="username" label="操作人" width="110" />
          <el-table-column prop="action" label="操作" width="130" />
          <el-table-column prop="target" label="对象" min-width="160" show-overflow-tooltip />
          <el-table-column prop="detail" label="详情" min-width="200" show-overflow-tooltip />
          <el-table-column prop="ip" label="IP" width="130" />
          <el-table-column label="时间" width="165">
            <template #default="{ row }">{{ fmtTime(row.ts) }}</template>
          </el-table-column>
        </el-table>
        <div class="pager">
          <el-pagination background layout="total, prev, pager, next" :total="auditTotal"
            v-model:current-page="auditQuery.page" :page-size="auditQuery.pageSize" @current-change="loadAudit" />
        </div>
      </el-tab-pane>

      <el-tab-pane label="登录日志" name="login">
        <div class="table-toolbar">
          <el-radio-group v-model="loginQuery.type" @change="loadLogin">
            <el-radio-button value="">全部</el-radio-button>
            <el-radio-button value="admin">管理端</el-radio-button>
            <el-radio-button value="device">设备端</el-radio-button>
          </el-radio-group>
        </div>
        <el-table :data="loginList" v-loading="loginLoading" stripe border>
          <el-table-column type="index" label="#" width="70" :index="(i) => (loginQuery.page - 1) * loginQuery.pageSize + i + 1" />
          <el-table-column prop="username" label="账号" width="150" />
          <el-table-column label="类型" width="90">
            <template #default="{ row }">
              <el-tag size="small" :type="row.type === 'admin' ? '' : 'warning'">{{ row.type === 'admin' ? '管理端' : '设备端' }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="结果" width="90">
            <template #default="{ row }">
              <el-tag size="small" :type="row.success ? 'success' : 'danger'">{{ row.success ? '成功' : '失败' }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="msg" label="说明" min-width="140" />
          <el-table-column prop="ip" label="IP" width="130" />
          <el-table-column prop="ua" label="UA" min-width="200" show-overflow-tooltip />
          <el-table-column label="时间" width="165">
            <template #default="{ row }">{{ fmtTime(row.ts) }}</template>
          </el-table-column>
        </el-table>
        <div class="pager">
          <el-pagination background layout="total, prev, pager, next" :total="loginTotal"
            v-model:current-page="loginQuery.page" :page-size="loginQuery.pageSize" @current-change="loadLogin" />
        </div>
      </el-tab-pane>
    </el-tabs>
  </div>
</template>

<script setup>
import { onMounted, reactive, ref } from 'vue'
import http from '../api'
import { formatTime as fmtTime } from '../utils'

const tab = ref('audit')
const auditList = ref([])
const auditTotal = ref(0)
const auditLoading = ref(false)
const auditQuery = reactive({ keyword: '', page: 1, pageSize: 20 })
const loginList = ref([])
const loginTotal = ref(0)
const loginLoading = ref(false)
const loginQuery = reactive({ type: '', page: 1, pageSize: 20 })

async function loadAudit() {
  auditLoading.value = true
  try {
    const d = await http.get('/admin/logs/audit', { params: { ...auditQuery, keyword: auditQuery.keyword || undefined } })
    auditList.value = d.list
    auditTotal.value = d.total
  } finally { auditLoading.value = false }
}

async function loadLogin() {
  loginLoading.value = true
  try {
    const d = await http.get('/admin/logs/login', { params: { ...loginQuery, type: loginQuery.type || undefined } })
    loginList.value = d.list
    loginTotal.value = d.total
  } finally { loginLoading.value = false }
}

onMounted(() => { loadAudit(); loadLogin() })
</script>
