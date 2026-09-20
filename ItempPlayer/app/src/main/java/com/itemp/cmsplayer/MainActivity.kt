package com.itemp.cmsplayer

import android.os.Bundle
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

/**
 * 设备登录页: 首次输入服务器地址 + 账号密码, 之后免登录自动进入播放 (需求 5.2.1)
 */
class MainActivity : ComponentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        DeviceStore.init(applicationContext)

        // 免登录模式: 已有有效凭据直接进播放页
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
        startActivity(android.content.Intent(this, PlayerActivity::class.java))
        finish()
    }
}

@Composable
fun LoginScreen(onSuccess: () -> Unit) {
    val context = LocalContext.current
    var server by remember { mutableStateOf(DeviceStore.server) }
    var username by remember { mutableStateOf(DeviceStore.username) }
    var password by remember { mutableStateOf("") }
    var loading by remember { mutableStateOf(false) }

    Box(
        Modifier.fillMaxSize().padding(32.dp),
        contentAlignment = Alignment.Center
    ) {
        Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(14.dp)) {
            Text("CMS 广告播放器", fontSize = 26.sp, fontWeight = FontWeight.Bold)
            Text("设备终端登录", fontSize = 14.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)

            OutlinedTextField(
                value = server,
                onValueChange = { server = it },
                label = { Text("服务器地址") },
                placeholder = { Text("http://192.168.1.100:3000") },
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
                modifier = Modifier.fillMaxWidth(), singleLine = true,
            )
            OutlinedTextField(
                value = username,
                onValueChange = { username = it },
                label = { Text("设备账号") },
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

            Button(
                onClick = {
                    if (loading) return@Button
                    if (server.isBlank() || username.isBlank() || password.isBlank()) {
                        Toast.makeText(context, "请填写完整", Toast.LENGTH_SHORT).show()
                        return@Button
                    }
                    loading = true
                    Thread {
                        try {
                            val r = ApiClient.login(server, username, password)
                            if (r.ok && r.data != null) {
                                DeviceStore.server = server
                                DeviceStore.username = username
                                DeviceStore.password = password
                                DeviceStore.token = r.str("token")
                                DeviceStore.deviceId = r.int("deviceId", -1)
                                DeviceStore.deviceName = r.str("deviceName")
                                val serverTime = r.long("serverTime")
                                if (serverTime > 0) {
                                    DeviceStore.serverTimeOffset = serverTime - System.currentTimeMillis()
                                }
                                AppLog.i("Login", "设备登录成功: ${DeviceStore.deviceName}")
                                (context as? ComponentActivity)?.runOnUiThread { onSuccess() }
                            } else {
                                AppLog.e("Login", "登录失败: ${r.msg}")
                                (context as? ComponentActivity)?.runOnUiThread {
                                    Toast.makeText(context, "登录失败: ${r.msg}", Toast.LENGTH_LONG).show()
                                    loading = false
                                }
                            }
                        } catch (e: Exception) {
                            AppLog.e("Login", "登录异常", e)
                            (context as? ComponentActivity)?.runOnUiThread {
                                Toast.makeText(context, "无法连接服务器: ${e.message}", Toast.LENGTH_LONG).show()
                                loading = false
                            }
                        }
                    }.start()
                },
                enabled = !loading,
                modifier = Modifier.fillMaxWidth().height(52.dp)
            ) {
                Text(if (loading) "登录中..." else "登 录", fontSize = 16.sp)
            }

            Text(
                "登录后自动进入全屏播放, 账号将被记住",
                fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
    }
}
