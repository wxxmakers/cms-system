<template>
  <div>
    <el-row :gutter="16">
      <el-col :span="6" v-for="card in cards" :key="card.label">
        <el-card shadow="hover">
          <div class="stat-card">
            <el-icon :size="34" :color="card.color"><component :is="card.icon" /></el-icon>
            <div>
              <div class="num">{{ card.value }}</div>
              <div class="label">{{ card.label }}</div>
            </div>
          </div>
        </el-card>
      </el-col>
    </el-row>

    <el-row :gutter="16" style="margin-top:16px">
      <el-col :span="14">
        <el-card shadow="never">
          <template #header>设备在线率趋势 (近 7 天)</template>
          <div ref="trendRef" style="height:300px"></div>
        </el-card>
      </el-col>
      <el-col :span="10">
        <el-card shadow="never">
          <template #header>广告播放次数排行 (近 7 天)</template>
          <div ref="rankRef" style="height:300px"></div>
        </el-card>
      </el-col>
    </el-row>
  </div>
</template>

<script setup>
import { onMounted, reactive, ref, nextTick } from 'vue'
import * as echarts from 'echarts'
import http from '../api'

const cards = reactive([
  { label: '在线设备', value: '-', icon: 'CircleCheck', color: '#67c23a' },
  { label: '离线设备', value: '-', icon: 'CircleClose', color: '#f56c6c' },
  { label: '今日播放次数', value: '-', icon: 'VideoPlay', color: '#409eff' },
  { label: '今日播放时长', value: '-', icon: 'Timer', color: '#e6a23c' },
])

const trendRef = ref()
const rankRef = ref()

function fmt(sec) {
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  return h > 0 ? `${h}小时${m}分` : `${m}分钟`
}

onMounted(async () => {
  const summary = await http.get('/admin/stats/summary')
  cards[0].value = `${summary.deviceOnline} / ${summary.deviceTotal}`
  cards[1].value = `${summary.deviceOffline} / ${summary.deviceTotal}`
  cards[2].value = summary.todayPlays
  cards[3].value = fmt(summary.todayPlayDuration || 0)

  await nextTick()
  const trend = await http.get('/admin/stats/online-trend?days=7')
  echarts.init(trendRef.value).setOption({
    tooltip: { trigger: 'axis' },
    grid: { left: 50, right: 20, top: 30, bottom: 30 },
    xAxis: { type: 'category', data: trend.map((x) => x.date.slice(5)) },
    yAxis: { type: 'value', max: 100, axisLabel: { formatter: '{value}%' } },
    series: [{ name: '在线率', type: 'line', smooth: true, areaStyle: {}, data: trend.map((x) => x.onlineRate), itemStyle: { color: '#409eff' } }],
  })

  const rank = await http.get('/admin/stats/play-ranking?days=7&limit=8')
  echarts.init(rankRef.value).setOption({
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
    grid: { left: 140, right: 30, top: 20, bottom: 30 },
    xAxis: { type: 'value' },
    yAxis: { type: 'category', data: rank.map((x) => x.name).reverse() },
    series: [{ name: '播放次数', type: 'bar', data: rank.map((x) => x.plays).reverse(), itemStyle: { color: '#67c23a' } }],
  })
})
</script>

<style scoped>
.stat-card { display: flex; align-items: center; gap: 16px; }
.num { font-size: 24px; font-weight: 700; }
.label { color: #909399; font-size: 13px; margin-top: 2px; }
</style>
