package com.itemp.cmsplayer

import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.itemp.cmsplayer.heart.HeartbeatService
import com.itemp.cmsplayer.data.ApiClient
import com.itemp.cmsplayer.data.DeviceStore
import com.itemp.cmsplayer.util.AppLog
import kotlinx.coroutines.delay
import org.json.JSONObject
import android.content.Context
import android.content.Intent

private val MAIN = Handler(Looper.getMainLooper())

/**
 * 设备登录页:
 * - 指纹免密登录 (方案一): 已登记指纹的设备输入服务器地址即可自动上线; 新指纹自动注册待 Web 批准
 * - 账号密码登录: 后备通道 (换主板/指纹异常时使用)
 */
class MainActivity : ComponentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        DeviceStore.init(applicationContext)

        // 已有有效登录 (凭据完整) → 直接进入播放, 心跳负责过期自愈
        if (DeviceStore.isLoggedIn()) {
            enterPlayer()
            return
        }

        setContent {
            MaterialTheme {
                LoginScreen(onSuccess = { enterPlayer() })
            }
        }
    }

    private fun enterPlayer() {
        HeartbeatService.start(this)
        startActivity(Intent(this, PlayerActivity::class.java))
        finish()
    }
}

@Composable
fun LoginScreen(onSuccess: () -> Unit) {
    val context = LocalContext.current
    var server by remember { mutableStateOf(DeviceStore.server) }
    var deviceName by remember { mutableStateOf(DeviceStore.pendingDeviceName) }
    var username by remember { mutableStateOf(DeviceStore.username) }
    var password by remember { mutableStateOf("") }
    var loading by remember { mutableStateOf(false) }
    var waitApproval by remember { mutableStateOf(false) }
    var showManual by remember { mutableStateOf(false) }

    fun doAutoLogin() {
        tryAutoLogin(server.trim(), deviceName.trim(),
            onOk = { MAIN.post { onSuccess() } },
            onPending = { MAIN.post { loading = false; waitApproval = true } },
            onError = { msg -> MAIN.post {
                loading = false
                showManual = true
                if (msg != null) Toast.makeText(context, "指纹未识别: $msg", Toast.LENGTH_SHORT).show()
            }},
        )
    }

    // 服务器地址已配置且指纹已登记过 → 自动尝试免密登录
    LaunchedEffect(Unit) {
        if (DeviceStore.server.isNotBlank() && DeviceStore.fingerprintRegistered) {
            loading = true
            doAutoLogin()
        }
    }

    // 等待批准: 每 10 秒自动重试
    LaunchedEffect(waitApproval) {
        while (waitApproval) {
            delay(10_000)
            tryAutoLogin(server.trim(), deviceName.trim(),
                onOk = { MAIN.post { onSuccess() } },
                onPending = { },
                onError = { },
            )
        }
    }

    Box(
        Modifier.fillMaxSize().padding(32.dp),
        contentAlignment = Alignment.Center
    ) {
        Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(14.dp)) {
            Text("CMS 广告播放器", fontSize = 26.sp, fontWeight = FontWeight.Bold)
            Text("设备终端登录", fontSize = 14.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)

            if (waitApproval) {
                // 等待管理员批准界面
                Text("⏳", fontSize = 44.sp)
                Text("设备已登记，等待管理员批准", fontSize = 18.sp, fontWeight = FontWeight.SemiBold)
                Text(
                    "设备名称: ${deviceName.ifBlank { "未命名" }}\n指纹: ...${DeviceStore.fingerprint.takeLast(8)}\n请在 Web 管理端「设备管理」中批准本设备\n批准后将自动上线，无需任何操作",
                    fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurfaceVariant,
                    textAlign = androidx.compose.ui.text.style.TextAlign.Center
                )
                OutlinedButton(onClick = { waitApproval = false; showManual = true }) {
                    Text("使用账号密码登录 →")
                }
            } else {
                OutlinedTextField(
                    value = server,
                    onValueChange = { server = it },
                    label = { Text("服务器地址") },
                    placeholder = { Text("http://192.168.1.100:3000") },
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
                    modifier = Modifier.fillMaxWidth(), singleLine = true,
                )

                if (showManual) {
                    OutlinedTextField(
                        value = username,
                        onValueChange = { username = it },
                        label = { Text("设备账号 (后备通道)") },
                        placeholder = { Text("dev_xxxxxx") },
                        modifier = Modifier.fillMaxWidth(), singleLine = true,
                    )
                    OutlinedTextField(
                        value = password,
                        onValueChange = { password = it },
                        label = { Text("密码") },
                        visualTransformation = PasswordVisualTransformation(),
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
                        modifier = Modifier.fillMaxWidth(), singleLine = true,
                    )
                } else {
                    OutlinedTextField(
                        value = deviceName,
                        onValueChange = { deviceName = it },
                        label = { Text("设备名称") },
                        placeholder = { Text("如: 前台大屏 (网页端将显示此名称)") },
                        modifier = Modifier.fillMaxWidth(), singleLine = true,
                    )
                }

                Button(
                    onClick = {
                        if (loading) return@Button
                        if (server.isBlank()) {
                            Toast.makeText(context, "请填写服务器地址", Toast.LENGTH_SHORT).show()
                            return@Button
                        }
                        loading = true
                        if (showManual && username.isNotBlank() && password.isNotBlank()) {
                            Thread {
                                manualLogin(server.trim(), username, password,
                                    ok = { MAIN.post { onSuccess() } },
                                    fail = { msg -> MAIN.post {
                                        loading = false
                                        Toast.makeText(context, "登录失败: $msg", Toast.LENGTH_LONG).show()
                                    }})
                            }.start()
                        } else {
                            doAutoLogin()
                        }
                    },
                    enabled = !loading,
                    modifier = Modifier.fillMaxWidth().height(52.dp)
                ) {
                    Text(
                        when {
                            loading -> "连接中..."
                            showManual -> "账号密码登录"
                            else -> "自动识别设备并登录"
                        }, fontSize = 16.sp
                    )
                }

                if (!showManual) {
                    TextButton(onClick = { showManual = true }) { Text("使用账号密码登录 →") }
                }
                Text(
                    if (showManual) "后备通道: 换主板/指纹异常时使用"
                    else "输入地址与设备名称后登录; 新设备将登记待网页批准",
                    fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
        }
    }
}

/** 尝试指纹免密登录 (网络在后台线程, 回调统一切回主线程) */
private fun tryAutoLogin(server: String, deviceName: String, onOk: () -> Unit, onPending: () -> Unit, onError: (String?) -> Unit) {
    Thread {
        if (server.isBlank()) {
            MAIN.post { onError(null) }
            return@Thread
        }
        // 记住名称, 供等待批准重试使用
        if (deviceName.isNotBlank()) DeviceStore.pendingDeviceName = deviceName
        val resp = try { ApiClient.autoLogin(server, deviceName) } catch (e: Exception) { null }
        if (resp == null) {
            MAIN.post { onError(null) }
            return@Thread
        }
        val data = resp.optJSONObject("data")
        when (data?.optString("status")) {
            "ok" -> {
                DeviceStore.server = server
                DeviceStore.fingerprintRegistered = true
                DeviceStore.token = data.optString("token")
                DeviceStore.deviceId = data.optInt("deviceId", -1)
                DeviceStore.deviceName = data.optString("deviceName")
                DeviceStore.username = data.optString("username", data.optString("deviceName"))
                MAIN.post { onOk() }
            }
            "pending" -> {
                DeviceStore.server = server
                DeviceStore.fingerprintRegistered = true
                MAIN.post { onPending() }
            }
            else -> {
                val msg = resp.optString("msg", "未识别")
                MAIN.post { onError(msg) }
            }
        }
    }.start()
}

/** 账号密码登录 (同步, 需在后台线程调用) */
private fun manualLogin(server: String, username: String, password: String, ok: () -> Unit, fail: (String) -> Unit) {
    try {
        val r = ApiClient.login(server, username, password)
        if (r.ok && r.data != null) {
            DeviceStore.server = server
            DeviceStore.username = username
            DeviceStore.password = password
            DeviceStore.token = r.str("token")
            DeviceStore.deviceId = r.int("deviceId", -1)
            DeviceStore.deviceName = r.str("deviceName")
            // 账号登录成功 → 心跳将自动把本机指纹绑定到该账号, 此后指纹登录直达同一身份
            DeviceStore.fingerprintRegistered = true
            val serverTime = r.long("serverTime")
            if (serverTime > 0) DeviceStore.serverTimeOffset = serverTime - System.currentTimeMillis()
            AppLog.i("Login", "账号密码登录成功: ${DeviceStore.deviceName}")
            ok()
        } else {
            AppLog.e("Login", "登录失败: ${r.msg}")
            fail(r.msg)
        }
    } catch (e: Exception) {
        AppLog.e("Login", "登录异常", e)
        fail(e.message ?: "网络错误")
    }
}
