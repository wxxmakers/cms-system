package com.itemp.cmsplayer.data

import android.content.Context
import android.content.SharedPreferences

/**
 * 设备本地存储: 服务器地址 / 登录凭据 / token / 服务器时间偏移 / 隐藏设置密码
 */
object DeviceStore {

    private const val PREFS = "cms_device"

    private lateinit var prefs: SharedPreferences

    fun init(context: Context) {
        prefs = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    }

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

    fun isLoggedIn(): Boolean = token.isNotEmpty() && username.isNotEmpty()

    fun clearCredentials() {
        prefs.edit().remove("token").remove("username").remove("password").remove("deviceId").remove("deviceName").apply()
    }
}
