// 通用工具
export function formatBytes(n) {
  if (n == null) return '-'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let v = Number(n)
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`
}

export function formatDuration(sec) {
  if (sec == null) return '-'
  const s = Math.round(Number(sec))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = s % 60
  if (h > 0) return `${h}时${m}分${r}秒`
  if (m > 0) return `${m}分${r}秒`
  return `${r}秒`
}

export function formatTime(ts) {
  if (!ts) return '-'
  const d = new Date(ts)
  const p = (x) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

// 导出 CSV (Excel 可直接打开, 需求 5.1.8)
export function exportCsv(filename, rows) {
  if (!rows?.length) return
  const headers = Object.keys(rows[0])
  const escape = (v) => {
    const s = v == null ? '' : String(v)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const csv = '\uFEFF' + [headers.join(','), ...rows.map((r) => headers.map((h) => escape(r[h])).join(','))].join('\n')
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = filename
  a.click()
  URL.revokeObjectURL(a.href)
}

// 读取视频元数据: 时长/分辨率 + 封面缩略图 (免 ffmpeg 方案)
export function readVideoMeta(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file)
    const video = document.createElement('video')
    video.preload = 'metadata'
    video.muted = true
    video.src = url
    const done = (meta) => { URL.revokeObjectURL(url); resolve(meta) }
    video.onloadedmetadata = () => {
      const meta = {
        duration: Math.round(video.duration) || 0,
        width: video.videoWidth || 0,
        height: video.videoHeight || 0,
        cover: null,
      }
      // 拖到 0.5 秒处截一帧做封面
      video.currentTime = Math.min(0.5, (video.duration || 1) / 2)
      video.onseeked = () => {
        try {
          const canvas = document.createElement('canvas')
          const scale = Math.min(1, 480 / (video.videoWidth || 480))
          canvas.width = Math.max(1, (video.videoWidth || 480) * scale)
          canvas.height = Math.max(1, (video.videoHeight || 270) * scale)
          canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height)
          meta.cover = canvas.toDataURL('image/jpeg', 0.7)
        } catch { /* 截图失败忽略 */ }
        done(meta)
      }
      setTimeout(() => done(meta), 3000) // 截帧超时兜底
    }
    video.onerror = () => done({ duration: 0, width: 0, height: 0, cover: null })
  })
}

export function readImageMeta(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => { URL.revokeObjectURL(url); resolve({ duration: 10, width: img.width, height: img.height, cover: null }) }
    img.onerror = () => { URL.revokeObjectURL(url); resolve({ duration: 10, width: 0, height: 0, cover: null }) }
    img.src = url
  })
}
