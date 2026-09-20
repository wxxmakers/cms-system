package com.itemp.cmsplayer

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.itemp.cmsplayer.data.DeviceStore
import com.itemp.cmsplayer.heart.HeartbeatService
import com.itemp.cmsplayer.util.AppLog

/**
 * 开机自启 (需求 5.2.3): 断电重启后自动上线播放
 * 注: Android 10+ 普通应用后台启动 Activity 受限, 依赖前台服务保活;
 *     Kiosk/Device Owner 场景下可完全自启
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.action ?: return
        if (action != Intent.ACTION_BOOT_COMPLETED && action != "android.intent.action.QUICKBOOT_POWERON") return

        DeviceStore.init(context.applicationContext)
        if (!DeviceStore.isLoggedIn()) {
            AppLog.i("BootReceiver", "开机完成, 未登录, 等待手动登录")
            return
        }
        AppLog.i("BootReceiver", "开机完成, 自动上线")
        HeartbeatService.start(context)
        try {
            context.startActivity(
                Intent(context, PlayerActivity::class.java)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            )
        } catch (e: Exception) {
            AppLog.w("BootReceiver", "开机自启播放页受限: ${e.message}")
        }
    }
}
