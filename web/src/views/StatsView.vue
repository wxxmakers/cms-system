<template>
  <div>
    <div class="table-toolbar">
      <el-radio-group v-model="days" @change="loadAll">
        <el-radio-button :value="1">今日</el-radio-button>
        <el-radio-button :value="7">近 7 天</el-radio-button>
        <el-radio-button :value="30">近 30 天</el-radio-button>
      </el-radio-group>
      <el-button style="margin-left:auto" @click="exportAll">导出 Excel(CSV)</el-button>
    </div>

    <el-row :gutter="16">
      <el-col :span="12">
        <el-card shadow="never">
          <template #header>各设备播放时长</template>
          <div ref="durationRef" style="height:320px"></div>
        </el-card>
      </el-col>
      <el-col :span="12">
        <el-card shadow="never">
          <template #header>分时段播放曲线 (触达分析)</template>
          <div ref="hourlyRef" style="height:320px"></div>
        </el-card>
      </el-col>
    </el-row>

    <el-card shadow="never" style="margin-top:16px">
      <template #header>
        <span>广告播放次数排行</span>
        <el-button size="small" style="float:right" @click="exportRank">导出排行</el-button>
      </template>
      <el-table :data="ranking" border>
        <el-table-column type="index" label="排名" width="70" />
        <el-table-column prop="name" label="广告素材" min-width="200" show-overflow-tooltip />
        <el-table-column prop="plays" label="播放次数" width="110" sortable />
        <el-table-column label="播放时长" width="130">
          <template #default="{ row }">{{ fmtDur(row.duration) }}</template>
        </el-table-column>
        <el-table-column prop="deviceCount" label="覆盖设备数" width="110" />
      </el-table>
    </el-card>

    <el-card shadow="never" style="margin-top:16px">
      <template #header>各设备播放明细</template>
      <el-table :data="durations" border>
        <el-table-column prop="deviceId" label="设备ID" width="80" />
        <el-table-column prop="deviceName" label="设备名称" min-width="160" />
        <el-table-column prop="plays" label="播放次数" width="110" sortable />
        <el-table-column label="播放时长" width="140">
          <template #default="{ row }">{{ fmtDur(row.duration) }}</template>
        </el-table-column>
      </el-table>
    </el-card>
  </div>
</template>

<script setup>
import { nextTick, onMounted, ref } from 'vue'
import * as echarts from 'echarts'
import http from '../api'
import { formatDuration as fmtDur, exportCsv } from '../utils'

const days = ref(7)
const ranking = ref([])
const durations = ref([])
const durationRef = ref()
const hourlyRef = ref()

async function loadAll() {
  const [rank, dur, hourly] = await Promise.all([
    http.get('/admin/stats/play-ranking', { params: { days: days.value, limit: 20 } }),
    http.get('/admin/stats/play-duration', { params: { days: days.value } }),
    http.get('/admin/stats/hourly-plays', { params: { days: days.value } }),
  ])
  ranking.value = rank
  durations.value = dur

  await nextTick()
  const top = dur.slice(0, 10)
  echarts.init(durationRef.value).setOption({
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
    grid: { left: 150, right: 30, top: 20, bottom: 40 },
    xAxis: { type: 'value', name: '秒' },
    yAxis: { type: 'category', data: top.map((x) => x.deviceName).reverse() },
    series: [{ name: '播放时长(秒)', type: 'bar', data: top.map((x) => x.duration).reverse(), itemStyle: { color: '#409eff' } }],
  })
  echarts.init(hourlyRef.value).setOption({
    tooltip: { trigger: 'axis' },
    grid: { left: 50, right: 20, top: 30, bottom: 40 },
    xAxis: { type: 'category', data: hourly.map((x) => x.hour) },
    yAxis: { type: 'value' },
    series: [{ name: '播放次数', type: 'line', smooth: true, areaStyle: {}, data: hourly.map((x) => x.plays), itemStyle: { color: '#e6a23c' } }],
  })
}

function exportRank() {
  exportCsv(`广告播放排行_${days.value}天.csv`, ranking.value.map((r, i) => ({ 排名: i + 1, 素材: r.name, 播放次数: r.plays, 播放时长秒: r.duration, 覆盖设备数: r.deviceCount })))
}

function exportAll() {
  exportCsv(`设备播放统计_${days.value}天.csv`, durations.value.map((d) => ({ 设备ID: d.deviceId, 设备名称: d.deviceName, 播放次数: d.plays, 播放时长秒: d.duration })))
}

onMounted(loadAll)
</script>
