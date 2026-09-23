package com.itemp.cmsplayer.data

import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.TimeUnit

/**
 * HTTP 客户端: 统一携带 token, 统一解析 {code, msg, data} 响应
 */
object ApiClient {

    const val RELOGIN_OK = 0        // 重登成功
    const val RELOGIN_REJECTED = 1  // 凭据被服务器明确拒绝 (账号已删/密码已改)
    const val RELOGIN_ERROR = 2     // 网络异常, 保持退避重试

    private val JSON_MEDIA = "application/json; charset=utf-8".toMediaType()

    val http: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .writeTimeout(60, TimeUnit.SECONDS)
        .build()

    fun url(path: String): String = "${DeviceStore.server}$path"

    class ApiResult(val ok: Boolean, val code: Int, val msg: String, val data: JSONObject?) {
        fun int(name: String, def: Int = 0): Int = data?.optInt(name, def) ?: def
        fun str(name: String, def: String = ""): String = data?.optString(name, def) ?: def
        fun long(name: String, def: Long = 0L): Long = data?.optLong(name, def) ?: def
    }

    private fun parse(body: String): ApiResult {
        val json = JSONObject(body)
        val code = json.optInt("code", -1)
        return ApiResult(code == 0, code, json.optString("msg", ""), json.optJSONObject("data"))
    }

    private fun execute(request: Request): ApiResult {
        http.newCall(request).execute().use { resp ->
            return if (resp.isSuccessful) parse(resp.body?.string() ?: "{}")
            else ApiResult(false, resp.code, "HTTP ${resp.code}", null)
        }
    }

    fun get(path: String): ApiResult = execute(
        Request.Builder().url(url(path))
            .addHeader("Authorization", "Bearer ${DeviceStore.token}")
            .get().build()
    )

    fun post(path: String, body: JSONObject): ApiResult {
        val rb: RequestBody = body.toString().toRequestBody(JSON_MEDIA)
        return execute(
            Request.Builder().url(url(path))
                .addHeader("Authorization", "Bearer ${DeviceStore.token}")
                .post(rb).build()
        )
    }

    fun postForm(path: String, form: okhttp3.MultipartBody): ApiResult = execute(
        Request.Builder().url(url(path))
            .addHeader("Authorization", "Bearer ${DeviceStore.token}")
            .post(form).build()
    )

    /**
     * 指纹免密登录 (方案一): 返回 status = ok / pending / error
     * @param deviceName 设备端输入的自定义名称, 用于自动注册时的命名
     */
    fun autoLogin(server: String, deviceName: String = ""): JSONObject? {
        val fp = DeviceStore.fingerprint
        if (fp.isBlank()) return null
        val rb: RequestBody = JSONObject()
            .put("fingerprint", fp)
            .put("hwInfo", JSONObject()
                .put("model", android.os.Build.MODEL)
                .put("androidVersion", android.os.Build.VERSION.RELEASE)
                .put("deviceName", deviceName))
            .toString().toRequestBody(JSON_MEDIA)
        return try {
            http.newCall(
                Request.Builder().url("${server.trimEnd('/')}/api/device/auto-login").post(rb).build()
            ).execute().use { resp ->
                if (resp.isSuccessful) JSONObject(resp.body?.string() ?: "{}") else null
            }
        } catch (e: Exception) {
            null
        }
    }

    /** 设备登录 (不携带 token) */
    fun login(server: String, username: String, password: String): ApiResult {
        val rb: RequestBody = JSONObject()
            .put("username", username)
            .put("password", password)
            .toString().toRequestBody(JSON_MEDIA)
        http.newCall(
            Request.Builder().url("${server.trimEnd('/')}/api/device/login").post(rb).build()
        ).execute().use { resp ->
            return if (resp.isSuccessful) parse(resp.body?.string() ?: "{}")
            else ApiResult(false, resp.code, resp.body?.string()?.take(120) ?: "HTTP ${resp.code}", null)
        }
    }

    /** token 过期自动重新登录 (需求 5.2.6); 返回值区分失败原因 */
    @Throws(IOException::class)
    fun relogin(): Int {
        // 凭据不完整 (指纹登录模式无密码 / 旧版残留) → 只能注销后走指纹/手动重新登录
        if (DeviceStore.username.isBlank() || DeviceStore.password.isBlank()) {
            return RELOGIN_REJECTED
        }
        return try {
            val r = login(DeviceStore.server, DeviceStore.username, DeviceStore.password)
            if (r.ok && r.data != null) {
                DeviceStore.token = r.str("token")
                DeviceStore.deviceId = r.int("deviceId", -1)
                RELOGIN_OK
            } else if (r.code == 401 || r.code == 423) {
                // 账号密码被拒: 设备可能已被删除/密码已重置 → 需强制注销
                RELOGIN_REJECTED
            } else {
                RELOGIN_ERROR
            }
        } catch (e: Exception) {
            RELOGIN_ERROR // 网络故障, 不应注销
        }
    }
}
