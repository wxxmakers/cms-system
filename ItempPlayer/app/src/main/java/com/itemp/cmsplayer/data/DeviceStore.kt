package com.itemp.cmsplayer.data

import android.content.Context
import android.content.SharedPreferences

/**
 * 设备本地存储: 服务器地址 / 登录凭据 / token / 服务器时间偏移 / 隐藏设置密码
 */
object DeviceStore {

    private const val PREFS = "cms_device"

    private lateinit var prefs: SharedPreferences

    var server: String
        get() = prefs.getString("server", "") ?: ""
        set(v) = prefs.edit().putString("server", v.trimEnd('/')).apply()

    var username: String
        get() = prefs.getString("username", "") ?: ""
        set(v) = prefs.edit().putString("username", v).apply()

    var password: String
        get() = prefs.getString("password", "") ?: ""
        set(v) = prefs.edit().putString("password", v).apply()

    var token: String
        get() = prefs.getString("token", "") ?: ""
        set(v) = prefs.edit().putString("token", v).apply()

    var deviceId: Int
        get() = prefs.getInt("deviceId", -1)
        set(v) = prefs.edit().putInt("deviceId", v).apply()

    var deviceName: String
        get() = prefs.getString("deviceName", "") ?: ""
        set(v) = prefs.edit().putString("deviceName", v).apply()

    /** 服务器时间 - 本地时间 的偏移(ms), 用于排期对时 (需求 5.2.6 时间不同步以服务器为准) */
    var serverTimeOffset: Long
        get() = prefs.getLong("serverTimeOffset", 0L)
        set(v) = prefs.edit().putLong("serverTimeOffset", v).apply()

    /** 隐藏设置页密码, 默认 123456 */
    var settingsPassword: String
        get() = prefs.getString("settingsPassword", "123456") ?: "123456"
        set(v) = prefs.edit().putString("settingsPassword", v).apply()

    /** 仅 WiFi 下载 (需求 5.2.4) */
    var wifiOnlyDownload: Boolean
        get() = prefs.getBoolean("wifiOnly", false)
        set(v) = prefs.edit().putBoolean("wifiOnly", v).apply()

    /** 设备唯一标识 (序列号): 与 adb devices / 机身标签一致, 重启、重装、恢复出厂均不变 */
    var fingerprint: String
        get() = prefs.getString("fingerprint", "") ?: ""
        private set(v) = prefs.edit().putString("fingerprint", v).apply()

    /** 指纹已在服务器登记过 (登录页据此决定是否自动尝试免密登录) */
    var fingerprintRegistered: Boolean
        get() = prefs.getBoolean("fpRegistered", false)
        set(v) = prefs.edit().putBoolean("fpRegistered", v).apply()

    /** 设备端输入的自定义名称 (自动注册时上报, 等待批准期间重试保持一致) */
    var pendingDeviceName: String
        get() = prefs.getString("pendingDeviceName", "") ?: ""
        set(v) = prefs.edit().putString("pendingDeviceName", v).apply()

    fun init(context: Context) {
        prefs = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        // 序列号每次启动重新读取并同步: 若升级前后标识来源切换 (如 ANDROID_ID→序列号) 自动更正
        val sn = readSerialNumber()
        if (sn.isNotBlank() && sn != fingerprint) fingerprint = sn
        if (fingerprint.isBlank()) {
            // 兜底: 无序列号设备用 ANDROID_ID (部分固件重启会变, 仅作最后手段)
            fingerprint = android.provider.Settings.Secure.getString(
                context.contentResolver, android.provider.Settings.Secure.ANDROID_ID
            ) ?: ""
        }
    }

    /**
     * 读取设备序列号 (多级降级策略):
     * 1. getprop ro.serialno —— RK/展锐等工规板稳定可用, 无需权限
     * 2. getprop ro.boot.serialno
     * 3. Build.getSerial() —— 高版本需系统权限, 多数普通应用拿不到
     * 实测 MS68(RK3566): ANDROID_ID 每次开机会随机变化, 不能作唯一标识; 序列号恒定
     */
    private fun readSerialNumber(): String {
        for (prop in listOf("ro.serialno", "ro.boot.serialno")) {
            try {
                val p = Runtime.getRuntime().exec(arrayOf("getprop", prop))
                val v = p.inputStream.readBytes().toString(Charsets.UTF_8).trim()
                p.waitFor()
                if (v.length >= 6 && !v.equals("unknown", ignoreCase = true)) return v
            } catch (_: Exception) { /* 尝试下一来源 */ }
        }
        return try {
            val v = if (android.os.Build.VERSION.SDK_INT >= 26) android.os.Build.getSerial()
                    else @Suppress("DEPRECATION") android.os.Build.SERIAL
            if (v.length >= 6 && !v.equals("unknown", ignoreCase = true)) v else ""
        } catch (_: Exception) { "" }
    }

    fun isLoggedIn(): Boolean = token.isNotEmpty() && username.isNotEmpty()

    fun clearCredentials() {
        prefs.edit().remove("token").remove("username").remove("password").remove("deviceId").remove("deviceName").apply()
    }
}
