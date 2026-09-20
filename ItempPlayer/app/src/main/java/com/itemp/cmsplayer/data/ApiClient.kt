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

    /** token 过期自动重新登录 (需求 5.2.6) */
    @Throws(IOException::class)
    fun relogin(): Boolean {
        val r = login(DeviceStore.server, DeviceStore.username, DeviceStore.password)
        if (r.ok && r.data != null) {
            DeviceStore.token = r.str("token")
            DeviceStore.deviceId = r.int("deviceId", -1)
            return true
        }
        return false
    }
}
