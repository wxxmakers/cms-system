package com.itemp.cmsplayer

import android.os.Bundle
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.itemp.cmsplayer.data.DeviceStore
import com.itemp.cmsplayer.heart.HeartbeatService
import com.itemp.cmsplayer.player.PlaylistEngine
import com.itemp.cmsplayer.util.AppLog

/**
 * 隐藏设置页 (需求 5.2.7): 播放页长按 5 秒 + 密码进入
 * 修改服务器地址 / 查看日志 / 手动刷新 / 退出登录
 */
class SettingsActivity : ComponentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            MaterialTheme {
                SettingsScreen()
            }
        }
    }

    @Composable
    private fun SettingsScreen() {
        val context = LocalContext.current
        var server by remember { mutableStateOf(DeviceStore.server) }
        var settingsPwd by remember { mutableStateOf(DeviceStore.settingsPassword) }
        var wifiOnly by remember { mutableStateOf(DeviceStore.wifiOnlyDownload) }
        var logs by remember { mutableStateOf(AppLog.dump()) }
        var refreshing by remember { mutableStateOf(false) }

        Column(
            Modifier.fillMaxSize().padding(20.dp).verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(14.dp)
        ) {
            Text("隐藏设置", fontSize = 22.sp, fontWeight = FontWeight.Bold)

            Card {
                Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Text("服务器配置", fontWeight = FontWeight.SemiBold)
                    OutlinedTextField(
                        value = server, onValueChange = { server = it },
                        label = { Text("服务器地址") }, singleLine = true,
                        modifier = Modifier.fillMaxWidth()
                    )
                    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        Button(onClick = {
                            DeviceStore.server = server
                            Toast.makeText(context, "服务器地址已保存", Toast.LENGTH_SHORT).show()
                        }) { Text("保存") }
                        OutlinedButton(onClick = {
                            refreshing = true
                            Thread {
                                val changed = try { PlaylistEngine.refresh(context, force = true) } catch (e: Exception) { false }
                                runOnUiThread {
                                    refreshing = false
                                    Toast.makeText(context, if (changed) "节目单已刷新" else "无变化或刷新失败", Toast.LENGTH_SHORT).show()
                                }
                            }.start()
                        }, enabled = !refreshing) { Text(if (refreshing) "刷新中..." else "手动刷新节目单") }
                    }
                    Row(verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
                        Switch(checked = wifiOnly, onCheckedChange = {
                            wifiOnly = it
                            DeviceStore.wifiOnlyDownload = it
                        })
                        Spacer(Modifier.width(8.dp))
                        Text("仅 WiFi 下载素材")
                    }
                    OutlinedTextField(
                        value = settingsPwd, onValueChange = { settingsPwd = it },
                        label = { Text("本页访问密码") }, singleLine = true,
                        modifier = Modifier.fillMaxWidth()
                    )
                    TextButton(onClick = {
                        DeviceStore.settingsPassword = settingsPwd
                        Toast.makeText(context, "密码已更新", Toast.LENGTH_SHORT).show()
                    }) { Text("更新访问密码") }
                }
            }

            Card {
                Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text("运行日志", fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
                        TextButton(onClick = {
                            AppLog.clear()
                            logs = ""
                        }) { Text("清空") }
                    }
                    Text(
                        logs.ifEmpty { "暂无日志" },
                        fontSize = 11.sp,
                        fontFamily = androidx.compose.ui.text.font.FontFamily.Monospace,
                        modifier = Modifier.height(260.dp).verticalScroll(rememberScrollState())
                    )
                }
            }

            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Button(
                    onClick = {
                        DeviceStore.clearCredentials()
                        stopService(android.content.Intent(context, HeartbeatService::class.java))
                        val intent = android.content.Intent(context, MainActivity::class.java)
                            .addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK or android.content.Intent.FLAG_ACTIVITY_CLEAR_TASK)
                        startActivity(intent)
                        finish()
                    },
                    colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.error),
                    modifier = Modifier.weight(1f)
                ) { Text("退出登录") }

                OutlinedButton(onClick = { finish() }, modifier = Modifier.weight(1f)) { Text("返回播放") }
            }

            Text(
                "设备: ${DeviceStore.deviceName} (#${DeviceStore.deviceId})\n账号: ${DeviceStore.username}",
                fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
    }
}
