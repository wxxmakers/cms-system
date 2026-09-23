package com.itemp.cmsplayer.heart

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.AudioManager
import android.os.Build
import android.os.Environment
import android.os.Handler
import android.os.HandlerThread
import android.os.IBinder
import android.os.StatFs
import android.util.DisplayMetrics
import android.view.WindowManager
import com.itemp.cmsplayer.BuildConfig
import com.itemp.cmsplayer.MainActivity
import com.itemp.cmsplayer.PlayerActivity
import com.itemp.cmsplayer.data.ApiClient
import com.itemp.cmsplayer.data.DeviceStore
import com.itemp.cmsplayer.player.PlaylistEngine
import com.itemp.cmsplayer.util.AppLog
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * 心跳前台服务: 每 30 秒上报状态 + 接收远程指令 (需求 5.2.3 / 5.1.7)
 * - START_STICKY 被杀自动拉起
 * - 服务器不可达指数退避 (需求 5.2.6)
 * - token 过期自动重新登录 (需求 5.2.6)
 */
class HeartbeatService : Service() {

    companion object {
        const val CHANNEL_ID = "cms_heartbeat"
        const val NOTIFICATION_ID = 1001
        const val HEARTBEAT_INTERVAL_MS = 30_000L
        const val MAX_BACKOFF_MS = 5 * 60_000L

        /** 当前正在播放的素材 ID, 心跳上报用 */
        @Volatile
        var currentVideoId: Int = 0

        /**
         * 服务与播放页之间的指令总线:
         * 播放页注册回调以执行截图 / 刷新等需要在 Activity 上下文执行的动作
         */
        @Volatile
        var screenshotTaker: ((File) -> Unit)? = null
        @Volatile
        var brightnessApplier: ((Int) -> Unit)? = null

        /** 远程调音后通知播放页: 停止分时段自动音量的自动覆盖 */
        @Volatile
        var onVolumeOverride: (() -> Unit)? = null

        /** RK 定时开关机星期编码: 0=每天, 1=周日, 2=周一 … 7=周六 */
        val WEEK_NAMES_RK = mapOf(
            "0" to "每天", "1" to "周日", "2" to "周一", "3" to "周二",
            "4" to "周三", "5" to "周四", "6" to "周五", "7" to "周六",
        )

        fun start(context: Context) {
            val intent = Intent(context, HeartbeatService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }
    }

    private lateinit var handler: Handler
    private lateinit var thread: HandlerThread
    // 节目单刷新专用线程: 避免长时间下载阻塞心跳 (心跳线程绝不能被下载卡住)
    private val refreshExecutor = java.util.concurrent.Executors.newSingleThreadExecutor { r ->
        Thread(r, "playlist-refresh").apply { isDaemon = true }
    }
    private var backoffMs = HEARTBEAT_INTERVAL_MS
    private var running = false

    private val tick = object : Runnable {
        override fun run() {
            if (!running) return
            val ok = heartbeat()
            // 指数退避: 失败翻倍, 成功恢复 30s
            backoffMs = if (ok) HEARTBEAT_INTERVAL_MS else (backoffMs * 2).coerceAtMost(MAX_BACKOFF_MS)
            handler.postDelayed(this, backoffMs)
        }
    }

    override fun onCreate() {
        super.onCreate()
        thread = HandlerThread("heartbeat").apply { start() }
        handler = Handler(thread.looper)
        startForegroundWithNotification()
        AppLog.i("Heartbeat", "心跳服务已创建")
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (!DeviceStore.isLoggedIn()) {
            stopSelf()
            return START_NOT_STICKY
        }
        if (!running) {
            running = true
            handler.post(tick)
        }
        // 常驻内存, 被杀后系统重建 (需求: 应用被杀自动拉起)
        return START_STICKY
    }

    override fun onDestroy() {
        running = false
        handler.removeCallbacks(tick)
        thread.quitSafely()
        refreshExecutor.shutdownNow()
        AppLog.i("Heartbeat", "心跳服务已销毁")
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    // ===== 心跳 + 指令处理 =====

    private fun heartbeat(): Boolean {
        if (!DeviceStore.isLoggedIn()) return false
        val body = JSONObject()
            .put("fingerprint", DeviceStore.fingerprint) // 指纹与账号绑定, 避免重复身份
            .put("appVersion", BuildConfig.VERSION_NAME)
            .put("model", Build.MODEL)
            .put("androidVersion", Build.VERSION.RELEASE)
            .put("resolution", resolution())
            .put("networkType", networkType())
            .put("storageTotal", StatFs(filesDir.absolutePath).totalBytes) // 原始字节, Web 端统一格式化
            .put("storageFree", StatFs(filesDir.absolutePath).availableBytes)
            .put("currentVideoId", Companion.currentVideoId)

        return try {
            var r = ApiClient.post("/api/device/heartbeat", body)
            if (r.code == 401) {
                // token 过期自动重登; 凭据被服务器明确拒绝 (账号已删/密码已重置) → 强制注销退回登录页
                when (ApiClient.relogin()) {
                    ApiClient.RELOGIN_OK -> r = ApiClient.post("/api/device/heartbeat", body)
                    ApiClient.RELOGIN_REJECTED -> {
                        forceLogout("设备账号已被删除或密码已重置")
                        return false
                    }
                    // 网络异常: 保持退避重试, 不注销
                }
            }
            if (!r.ok) {
                AppLog.w("Heartbeat", "心跳失败(${backoffMs}ms 后重试): ${r.msg}")
                return false
            }
            // 服务器对时
            val serverTime = r.long("serverTime")
            if (serverTime > 0) DeviceStore.serverTimeOffset = serverTime - System.currentTimeMillis()

            // 版本变化 → 后台刷新节目单 (增量, 不阻塞播放)
            val playlistVersion = r.long("playlistVersion")
            if (playlistVersion != PlaylistEngine.version) {
                AppLog.i("Heartbeat", "检测到节目单版本变化: ${PlaylistEngine.version} -> $playlistVersion")
                handler.post { refreshPlaylist() }
            }

            // 处理远程指令 (需求 5.1.7)
            val cmds = r.data?.optJSONArray("commands") ?: JSONArray()
            for (i in 0 until cmds.length()) {
                val cmd = cmds.getJSONObject(i)
                handleCommand(cmd.optInt("id"), cmd.optString("type"), cmd.optString("value"))
            }
            true
        } catch (e: Exception) {
            AppLog.e("Heartbeat", "心跳异常", e)
            false
        }
    }

    private fun handleCommand(id: Int, type: String, value: String) {
        AppLog.i("Heartbeat", "收到指令 #$id: $type = $value")
        var result = "success"
        var message = ""
        try {
            when (type) {
                "restart_app" -> {
                    // 重启播放页 + 服务自拉起
                    startActivitySafely(Intent(this, PlayerActivity::class.java)
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK))
                    message = "已重启播放页"
                }
                "refresh_playlist" -> {
                    refreshPlaylist(force = true)
                    message = "节目单已刷新"
                }
                "clear_cache" -> {
                    PlaylistEngine.mediaDir(this).listFiles()?.forEach { it.delete() }
                    refreshPlaylist(force = true)
                    message = "本地缓存已清空"
                }
                "screenshot" -> {
                    val taker = screenshotTaker
                    if (taker != null) {
                        val file = File(filesDir, "screenshot_${System.currentTimeMillis()}.jpg")
                        taker(file)
                        message = "截图任务已提交"
                        // 截图完成后由 PlayerActivity 上传并回执
                        ackAsync(id, "success", "已上传")
                        return
                    } else {
                        // 播放页未运行: 自动拉起播放页, 指令保持待下发, 下一次心跳自动重试截图
                        startActivitySafely(Intent(this, PlayerActivity::class.java)
                            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK))
                        AppLog.w("Heartbeat", "播放页未运行, 已拉起播放页, 截图指令将在下次心跳重试")
                        return // 不回执, 指令保持 pending 待重试
                    }
                }
                "set_volume" -> {
                    val vol = value.toIntOrNull()?.coerceIn(0, 100) ?: 50
                    // 先标记用户覆盖, 防止播放页下一次开播时被分时段自动音量写回
                    onVolumeOverride?.invoke()
                    val am = getSystemService(Context.AUDIO_SERVICE) as AudioManager
                    val max = am.getStreamMaxVolume(AudioManager.STREAM_MUSIC)
                    am.setStreamVolume(AudioManager.STREAM_MUSIC, max * vol / 100, 0)
                    message = "音量已设为 $vol%"
                }
                "set_brightness" -> {
                    val b = value.toIntOrNull()?.coerceIn(0, 100) ?: 80
                    brightnessApplier?.invoke(b)
                    message = "亮度指令已提交 ($b%)"
                }
                "set_power_schedule" -> {
                    // RK 平台定时开关机 (由 system/app/shuttime.apk 接收系统广播实现)
                    // value JSON: {onHour, onMin, offHour, offMin, week(0=每天,1=周日..7=周六), enable}
                    val v = JSONObject(value.ifBlank { "{}" })
                    val week = v.optString("week", "0")
                    val enable = v.optBoolean("enable", true)
                    val onH = v.optString("onHour", "08"); val onM = v.optString("onMin", "00")
                    val offH = v.optString("offHour", "22"); val offM = v.optString("offMin", "30")
                    sendBroadcast(Intent("rk.android.turnontime.action").apply {
                        putExtra("onHour", onH); putExtra("onMin", onM)
                        putExtra("onWeek", week); putExtra("enable", enable)
                    })
                    sendBroadcast(Intent("rk.android.turnofftime.action").apply {
                        putExtra("offHour", offH); putExtra("offMin", offM)
                        putExtra("offWeek", week); putExtra("enable", enable)
                    })
                    val weekName = WEEK_NAMES_RK[week] ?: week
                    message = if (enable) "定时开关机已设置: $onH:$onM 开机 / $offH:$offM 关机 ($weekName)"
                              else "定时开关机已取消 ($weekName)"
                    AppLog.i("Heartbeat", message ?: "")
                }
                "logout" -> {
                    // 远程强制注销 (方案四): 清空凭据, 设备退回登录页
                    AppLog.i("Heartbeat", "收到远程注销指令, 设备即将退出登录")
                    ackAsync(id, "success", "设备已注销").join(2000)
                    forceLogout("远程注销指令")
                    return
                }
                "reboot", "shutdown", "sleep", "wakeup" -> {
                    // RK 平台系统级广播 (ads.android.* / rk.android.*)
                    // 危险指令: 先回执再执行, 避免设备断电后指令永远停在 pending
                    val (action, desc) = when (type) {
                        "reboot" -> "ads.android.setreboot.action" to "重启广播已发送"
                        "shutdown" -> "ads.android.setpoweroff.action" to "关机广播已发送"
                        "sleep" -> "rk.android.realsleepmode.action" to "休眠广播已发送"
                        else -> "rk.android.wakeupmode.action" to "唤醒广播已发送"
                    }
                    if (type == "wakeup") {
                        // 唤醒无副作用, 常规回执即可
                        sendBroadcast(Intent(action))
                        message = desc
                    } else {
                        AppLog.i("Heartbeat", "$desc ($action), 指令 #$id 已回执")
                        ackAsync(id, "success", desc).join(3000) // 等回执发出再断电
                        sendBroadcast(Intent(action))
                        return // 已回执, 不走统一回执
                    }
                }
                else -> {
                    result = "failed"
                    message = "未知指令类型: $type"
                }
            }
        } catch (e: Exception) {
            result = "failed"
            message = e.message ?: "执行异常"
        }
        ackAsync(id, result, message)
    }

    /**
     * 强制注销: 清空本地凭据, 停止服务, 退回登录页
     * 触发场景: 账号被删除/密码被重置(心跳401且重登被拒) 或 远程注销指令
     */
    private fun forceLogout(reason: String) {
        AppLog.w("Heartbeat", "强制注销: $reason")
        DeviceStore.clearCredentials()
        // 停止播放并回到登录页 (登录页检测到未登录会显示账号输入)
        startActivitySafely(Intent(this, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK))
        stopSelf()
    }

    /** 在独立线程刷新节目单 (下载可能耗时数分钟, 不能阻塞心跳) */
    private fun refreshPlaylist(force: Boolean = false) {
        refreshExecutor.execute {
            try {
                PlaylistEngine.refresh(this, force)
            } catch (e: Exception) {
                AppLog.e("Heartbeat", "节目单刷新异常", e)
            }
        }
    }

    private fun ackAsync(id: Int, result: String, message: String): Thread {
        val t = Thread {
            try {
                ApiClient.post("/api/device/command/ack", JSONObject()
                    .put("id", id).put("result", result).put("message", message))
            } catch (e: Exception) {
                AppLog.e("Heartbeat", "指令回执失败 #$id", e)
            }
        }
        t.start()
        return t
    }

    // ===== 硬件信息 (需求 5.2.8) =====

    private fun resolution(): String {
        val wm = getSystemService(Context.WINDOW_SERVICE) as WindowManager
        val dm = DisplayMetrics()
        @Suppress("DEPRECATION")
        wm.defaultDisplay.getRealMetrics(dm)
        return "${dm.widthPixels}x${dm.heightPixels}"
    }

    private fun networkType(): String {
        val cm = getSystemService(Context.CONNECTIVITY_SERVICE) as? android.net.ConnectivityManager
            ?: return "unknown"
        val caps = cm.getNetworkCapabilities(cm.activeNetwork) ?: return "none"
        return when {
            caps.hasTransport(android.net.NetworkCapabilities.TRANSPORT_WIFI) -> "wifi"
            caps.hasTransport(android.net.NetworkCapabilities.TRANSPORT_ETHERNET) -> "ethernet"
            caps.hasTransport(android.net.NetworkCapabilities.TRANSPORT_CELLULAR) -> "cellular"
            else -> "other"
        }
    }

    private fun startActivitySafely(intent: Intent) {
        try {
            startActivity(intent)
        } catch (e: Exception) {
            AppLog.w("Heartbeat", "后台启动 Activity 受限: ${e.message}")
        }
    }

    // ===== 前台通知 (需求 5.2.3 常驻通知) =====

    private fun startForegroundWithNotification() {
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID, "播放保活", NotificationManager.IMPORTANCE_LOW
            ).apply { description = "CMS广告播放器心跳保活" ; setShowBadge(false) }
            nm.createNotificationChannel(channel)
        }
        val notification: Notification = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, CHANNEL_ID)
                .setContentTitle("CMS广告播放器")
                .setContentText("正在运行 · 心跳保活中")
                .setSmallIcon(android.R.drawable.ic_media_play)
                .setOngoing(true)
                .build()
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this)
                .setContentTitle("CMS广告播放器")
                .setContentText("正在运行 · 心跳保活中")
                .setSmallIcon(android.R.drawable.ic_media_play)
                .setOngoing(true)
                .build()
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }
}
