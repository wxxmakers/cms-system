package com.itemp.cmsplayer

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.media.AudioManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.PixelCopy
import android.view.View
import android.view.WindowManager
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.AspectRatioFrameLayout
import androidx.media3.ui.PlayerView
import com.itemp.cmsplayer.data.ApiClient
import com.itemp.cmsplayer.data.DeviceStore
import com.itemp.cmsplayer.heart.HeartbeatService
import com.itemp.cmsplayer.player.DownloadProgress
import com.itemp.cmsplayer.player.PlaylistEngine
import com.itemp.cmsplayer.player.PlaylistItem
import com.itemp.cmsplayer.util.AppLog
import kotlinx.coroutines.delay
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.RequestBody.Companion.asRequestBody
import java.io.File
import java.io.FileOutputStream
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * 全屏播放页 (需求 5.2.2):
 * - 无操作栏全屏循环播放, 按节目单顺序
 * - 断网继续播放已下载素材; 无可播内容显示兜底画面 (P3)
 * - 播放异常自动跳过并删除损坏文件
 * - 长按屏幕 5 秒 + 密码进入隐藏设置 (需求 5.2.7)
 * - 远程截图 (PixelCopy), 分时段自动音量
 */
class PlayerActivity : ComponentActivity() {

    private val mainHandler = Handler(Looper.getMainLooper())

    // 播放状态 (Compose 观察)
    private val itemsState = mutableStateOf<List<PlaylistItem>>(emptyList())
    private val indexState = mutableIntStateOf(0)
    // 播放代次: 每次切歌 +1。单素材循环时 index 不变, 依赖 epoch 变化驱动播放器重新加载
    private val playEpoch = mutableIntStateOf(0)
    private val showPwdDialog = mutableStateOf(false)

    // 播放日志记录
    private var currentItem: PlaylistItem? = null
    private var currentItemStartTs = 0L

    // 音量控制: 分时段自动音量 与 手动/远程调音 的冲突处理
    // 手动(设备音量键)或远程调音后标记覆盖, 自动音量让位; 仅在进出静音时段时恢复自动策略
    @Volatile
    private var volumeOverridden = false
    private var lastQuietBucket: Boolean? = null

    private var refreshThread: Thread? = null
    @Volatile
    private var destroyed = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // 广告机模式: 拦截返回键, 播放页不允许被退出 (需求: 7x24 无人值守播放)
        // 退出请通过 长按5秒 → 隐藏设置 → 退出登录
        onBackPressedDispatcher.addCallback(this, object : androidx.activity.OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                AppLog.i("Player", "返回键已被拦截 (广告机模式)")
            }
        })
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        applyBrightness(80)
        enterImmersive()

        // 注册指令回调 (截图 / 亮度 / 远程调音覆盖标记)
        HeartbeatService.screenshotTaker = { file -> takeScreenshot(file) }
        HeartbeatService.brightnessApplier = { b -> runOnUiThread { applyBrightness(b) } }
        HeartbeatService.onVolumeOverride = { volumeOverridden = true }

        // 节目单变化 → 主线程刷新播放队列
        PlaylistEngine.onPlaylistChanged = {
            mainHandler.post { applyPlaylistToState() }
        }

        // 初始加载 + 周期刷新 (60s), 后台执行不阻塞播放
        refreshThread = Thread {
            while (!destroyed) {
                try {
                    PlaylistEngine.refresh(this)
                    mainHandler.post { ensurePlaying() }
                } catch (e: Exception) {
                    AppLog.e("Player", "节目单刷新异常", e)
                }
                try { Thread.sleep(60_000) } catch (_: InterruptedException) { break }
            }
        }.apply { isDaemon = true; start() }

        setContent {
            MaterialTheme {
                PlayerRoot()
            }
        }
    }

    override fun onDestroy() {
        destroyed = true
        refreshThread?.interrupt()
        PlaylistEngine.onPlaylistChanged = null
        HeartbeatService.screenshotTaker = null
        HeartbeatService.brightnessApplier = null
        HeartbeatService.onVolumeOverride = null
        flushCurrentPlayLog()
        super.onDestroy()
    }

    // 设备物理音量键调音同样视为用户覆盖, 自动音量不再回写
    override fun onKeyDown(keyCode: Int, event: android.view.KeyEvent?): Boolean {
        if (keyCode == android.view.KeyEvent.KEYCODE_VOLUME_UP ||
            keyCode == android.view.KeyEvent.KEYCODE_VOLUME_DOWN
        ) {
            volumeOverridden = true
        }
        return super.onKeyDown(keyCode, event)
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) enterImmersive()
    }

    override fun onResume() {
        super.onResume()
        // 凭据已被清除 (账号删除/远程注销) → 退回登录页
        if (!DeviceStore.isLoggedIn()) {
            startActivity(android.content.Intent(this, MainActivity::class.java)
                .addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK or android.content.Intent.FLAG_ACTIVITY_CLEAR_TASK))
            finish()
        }
    }

    private fun enterImmersive() {
        @Suppress("DEPRECATION")
        window.decorView.systemUiVisibility = (
            View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                or View.SYSTEM_UI_FLAG_FULLSCREEN
                or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                or View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
            )
    }

    private fun applyBrightness(percent: Int) {
        val lp = window.attributes
        lp.screenBrightness = percent / 100f
        window.attributes = lp
    }

    // ===== 播放队列管理 =====

    private fun applyPlaylistToState() {
        val oldIds = itemsState.value.joinToString(",") { "${it.videoId}:${it.md5}" }
        val newIds = PlaylistEngine.items.joinToString(",") { "${it.videoId}:${it.md5}" }
        itemsState.value = PlaylistEngine.items
        if (oldIds != newIds) {
            AppLog.i("Player", "播放队列更新: ${PlaylistEngine.items.size} 条素材")
            indexState.value = 0
            playEpoch.intValue++
        }
    }

    /** 若当前无可播内容则立即开始播放队列 */
    private fun ensurePlaying() {
        if (itemsState.value.isEmpty() && PlaylistEngine.items.isNotEmpty()) {
            applyPlaylistToState()
        }
    }

    /** 切到下一条; 上报上一条的播放记录; 损坏素材移出队列避免黑屏循环 */
    private fun advance(skipBad: PlaylistItem? = null) {
        flushCurrentPlayLog()
        if (skipBad != null) {
            // 播放异常: 删除损坏文件并从播放队列移除 (下个刷新周期会重新下载), 避免黑屏死循环 (需求 5.2.6)
            skipBad.localFile?.delete()
            itemsState.value = itemsState.value
                .filterNot { it.videoId == skipBad.videoId && it.md5 == skipBad.md5 }
            indexState.value = 0
            AppLog.e("Player", "素材播放异常, 已从队列移除待重新下载: ${skipBad.name}")
        }
        val list = itemsState.value
        if (list.isEmpty()) return
        indexState.value = (indexState.value + 1) % list.size
        // 关键: 单素材循环时 index 保持 0 不变, epoch 必须 +1 才能触发重新加载播放
        playEpoch.intValue++
    }

    private fun onItemStarted(item: PlaylistItem) {
        currentItem = item
        currentItemStartTs = System.currentTimeMillis()
        HeartbeatService.currentVideoId = item.videoId
        AppLog.i("Player", "开始播放: ${item.name}")
        applyTimeVolume()
    }

    private fun flushCurrentPlayLog() {
        val item = currentItem ?: return
        val end = System.currentTimeMillis()
        if (end > currentItemStartTs) {
            Thread { PlaylistEngine.logPlay(item, currentItemStartTs, end) }.start()
        }
        currentItem = null
    }

    /**
     * 分时段自动音量: 22:00-07:00 静音时段降为 30% (需求 5.2.2)
     * 手动(音量键)或远程调音后自动让位, 仅在进出静音时段的边界恢复自动策略
     */
    private fun applyTimeVolume() {
        val hour = java.util.Calendar.getInstance().get(java.util.Calendar.HOUR_OF_DAY)
        val quiet = hour >= 22 || hour < 7
        // 跨越静音时段边界 → 恢复自动音量策略
        if (lastQuietBucket != null && lastQuietBucket != quiet) {
            volumeOverridden = false
        }
        lastQuietBucket = quiet
        if (volumeOverridden) {
            AppLog.i("Player", "音量由用户/远程设置, 跳过自动音量")
            return
        }
        val am = getSystemService(AUDIO_SERVICE) as AudioManager
        val max = am.getStreamMaxVolume(AudioManager.STREAM_MUSIC)
        val target = max * (if (quiet) 30 else 100) / 100
        if (am.getStreamVolume(AudioManager.STREAM_MUSIC) != target) {
            am.setStreamVolume(AudioManager.STREAM_MUSIC, target, 0)
            AppLog.i("Player", "自动音量: ${if (quiet) "静音时段 30%" else "白天 100%"}")
        }
    }

    // ===== 远程截图 (需求 5.1.7 / 附录A.15) =====

    private fun takeScreenshot(target: File) {
        try {
            val bitmap = Bitmap.createBitmap(
                window.decorView.width, window.decorView.height, Bitmap.Config.ARGB_8888
            )
            PixelCopy.request(window, bitmap, { result ->
                if (result == PixelCopy.SUCCESS) {
                    try {
                        FileOutputStream(target).use { out -> bitmap.compress(Bitmap.CompressFormat.JPEG, 80, out) }
                        uploadScreenshot(target)
                    } catch (e: Exception) {
                        AppLog.e("Player", "截图保存失败", e)
                    }
                } else {
                    AppLog.e("Player", "PixelCopy 失败: $result")
                }
            }, mainHandler)
        } catch (e: Exception) {
            // PixelCopy 不可用时退化为 View 绘制 (SurfaceView 内容可能缺失)
            try {
                val bitmap = Bitmap.createBitmap(
                    window.decorView.width, window.decorView.height, Bitmap.Config.ARGB_8888
                )
                window.decorView.draw(android.graphics.Canvas(bitmap))
                FileOutputStream(target).use { out -> bitmap.compress(Bitmap.CompressFormat.JPEG, 80, out) }
                uploadScreenshot(target)
            } catch (e2: Exception) {
                AppLog.e("Player", "截图完全失败", e2)
            }
        }
    }

    private fun uploadScreenshot(file: File) {
        Thread {
            try {
                val form = MultipartBody.Builder()
                    .setType(MultipartBody.FORM)
                    .addFormDataPart("file", file.name, file.asRequestBody("image/jpeg".toMediaType()))
                    .build()
                val r = ApiClient.postForm("/api/device/screenshot", form)
                AppLog.i("Player", "截图上传: ${if (r.ok) "成功" else r.msg}")
            } catch (e: Exception) {
                AppLog.e("Player", "截图上传异常", e)
            } finally {
                file.delete()
            }
        }.start()
    }

    // ===== Compose UI =====

    @Composable
    private fun PlayerRoot() {
        val items by itemsState
        val index by indexState
        val showPwd by showPwdDialog

        Box(
            Modifier.fillMaxSize().background(Color.Black)
                .pointerInput(Unit) {
                    // 长按 5 秒弹出隐藏设置密码框 (需求 5.2.7)
                    awaitEachGesture {
                        awaitFirstDown()
                        val start = System.currentTimeMillis()
                        loop@ while (true) {
                            val event = awaitPointerEvent()
                            val pressed = event.changes.any { it.pressed }
                            if (!pressed) break@loop
                            if (System.currentTimeMillis() - start >= 5000) {
                                showPwdDialog.value = true
                                break@loop
                            }
                        }
                    }
                }
        ) {
            if (items.isEmpty()) {
                FallbackScreen()
            } else {
                val item = items[index % items.size]
                val epoch by playEpoch
                if (item.type == "video") {
                    VideoSurface(item = item, epoch = epoch,
                        onEnded = { advance() },
                        onError = { advance(item) },
                        onStarted = { onItemStarted(item) })
                } else {
                    ImageSurface(item = item, epoch = epoch,
                        onAdvance = { advance() },
                        onStarted = { onItemStarted(item) })
                }
            }

            // 播放中: 右上角悬浮下载进度提示
            val progress by PlaylistEngine.downloadProgressState
            if (items.isNotEmpty() && progress != null) {
                Surface(
                    color = Color(0xCC1B2A44), shape = androidx.compose.foundation.shape.RoundedCornerShape(10.dp),
                    modifier = Modifier.align(Alignment.TopEnd).padding(16.dp)
                ) {
                    Column(Modifier.padding(horizontal = 14.dp, vertical = 10.dp)) {
                        Text(
                            "素材更新中 ${progress!!.fileIndex}/${progress!!.fileCount}" +
                                (if (progress!!.percent >= 0) " · ${progress!!.percent}%" else ""),
                            color = Color.White, fontSize = 13.sp
                        )
                        if (progress!!.totalBytes > 0) {
                            Text(
                                "${fmtBytes(progress!!.downloadedBytes)} / ${fmtBytes(progress!!.totalBytes)} · ${fmtSpeed(progress!!.speedBytesPerSec)}",
                                color = Color(0xFF9FB3D1), fontSize = 11.sp
                            )
                        }
                    }
                }
            }
        }

        if (showPwd) {
            PasswordDialog(
                onConfirm = { pwd ->
                    if (pwd == DeviceStore.settingsPassword) {
                        showPwdDialog.value = false
                        startActivity(android.content.Intent(this, SettingsActivity::class.java))
                    } else {
                        Toast.makeText(this, "密码错误", Toast.LENGTH_SHORT).show()
                    }
                },
                onDismiss = { showPwdDialog.value = false }
            )
        }
    }

    /** 兜底画面 (P3): 无网络/无可播内容时显示 (需求 6.2), 下载时展示进度卡片 */
    @Composable
    private fun FallbackScreen() {
        var now by remember { mutableStateOf(System.currentTimeMillis()) }
        val progress by PlaylistEngine.downloadProgressState
        LaunchedEffect(Unit) {
            while (true) {
                now = System.currentTimeMillis()
                delay(1000)
            }
        }
        Column(
            Modifier.fillMaxSize().background(Color(0xFF0B1B3A)),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center
        ) {
            Text("CMS 广告播放器", color = Color.White, fontSize = 30.sp, fontWeight = FontWeight.Bold)
            Spacer(Modifier.height(16.dp))
            Text(
                SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.CHINA).format(Date(now + DeviceStore.serverTimeOffset)),
                color = Color.White.copy(alpha = 0.9f), fontSize = 46.sp
            )
            Spacer(Modifier.height(28.dp))

            if (progress != null) {
                // 下载进度卡片: 文件序号 + 名称 + 百分比 + 大小/速度
                Surface(
                    color = Color(0x33FFFFFF), shape = androidx.compose.foundation.shape.RoundedCornerShape(12.dp),
                    modifier = Modifier.padding(horizontal = 48.dp).fillMaxWidth()
                ) {
                    Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        Text(
                            "正在下载广告素材 (${progress!!.fileIndex}/${progress!!.fileCount})",
                            color = Color.White, fontSize = 15.sp, fontWeight = FontWeight.SemiBold
                        )
                        Text(
                            progress!!.itemName,
                            color = Color(0xFF9FB3D1), fontSize = 13.sp,
                            maxLines = 1, overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis
                        )
                        if (progress!!.percent >= 0) {
                            LinearProgressIndicator(
                                progress = progress!!.percent / 100f,
                                modifier = Modifier.fillMaxWidth().height(8.dp),
                                color = Color(0xFF4C8BFF),
                                trackColor = Color(0x22FFFFFF)
                            )
                        } else {
                            LinearProgressIndicator(
                                modifier = Modifier.fillMaxWidth().height(8.dp),
                                color = Color(0xFF4C8BFF),
                                trackColor = Color(0x22FFFFFF)
                            )
                        }
                        Text(
                            "${fmtBytes(progress!!.downloadedBytes)} / ${fmtBytes(progress!!.totalBytes)}  ·  ${fmtSpeed(progress!!.speedBytesPerSec)}",
                            color = Color(0xFF9FB3D1), fontSize = 12.sp
                        )
                    }
                }
            } else {
                Text(
                    "暂无可播放内容 · 断网时将循环播放已缓存素材",
                    color = Color(0xFF9FB3D1), fontSize = 15.sp, textAlign = TextAlign.Center
                )
            }
        }
    }

    private fun fmtBytes(bytes: Long): String = when {
        bytes >= 1L shl 30 -> "%.2f GB".format(bytes.toDouble() / (1L shl 30))
        bytes >= 1L shl 20 -> "%.1f MB".format(bytes.toDouble() / (1L shl 20))
        bytes >= 1L shl 10 -> "%.0f KB".format(bytes.toDouble() / (1L shl 10))
        else -> "$bytes B"
    }

    private fun fmtSpeed(bytesPerSec: Long): String =
        if (bytesPerSec >= 1L shl 20) "%.1f MB/s".format(bytesPerSec.toDouble() / (1L shl 20))
        else "${bytesPerSec / (1L shl 10)} KB/s"

    /** 视频播放表面 (Media3 ExoPlayer, 硬解码); epoch 变化即重新加载 (支持单素材循环) */
    @Composable
    private fun VideoSurface(
        item: PlaylistItem,
        epoch: Int,
        onEnded: () -> Unit,
        onError: () -> Unit,
        onStarted: () -> Unit,
    ) {
        var errorMsg by remember(item.videoId, item.md5) { mutableStateOf<String?>(null) }
        errorMsg?.let {
            LaunchedEffect(it) { onError() }
            return
        }
        AndroidView(
            factory = { ctx ->
                val player = ExoPlayer.Builder(ctx).build()
                player.repeatMode = Player.REPEAT_MODE_OFF
                player.volume = 1f
                player.addListener(object : Player.Listener {
                    override fun onPlaybackStateChanged(state: Int) {
                        when (state) {
                            Player.STATE_READY -> onStarted()
                            Player.STATE_ENDED -> onEnded()
                            Player.STATE_IDLE -> {
                                val err = player.playerError
                                if (err != null) {
                                    AppLog.e("Player", "视频错误: ${err.message}")
                                    errorMsg = err.message
                                }
                            }
                        }
                    }
                })
                PlayerView(ctx).apply {
                    useController = false
                    this.player = player
                    setShutterBackgroundColor(android.graphics.Color.BLACK)
                    // 不同尺寸素材混合播放时铺满全屏(拉伸), 避免黑边 (需求 5.2.2 横竖屏自适应)
                    resizeMode = AspectRatioFrameLayout.RESIZE_MODE_FILL
                }
            },
            update = { view ->
                // 素材或播放代次变化 → 重新加载 (单素材循环靠 epoch 驱动)
                val player = view.player as? ExoPlayer ?: return@AndroidView
                val key = "${item.videoId}:$epoch"
                if (view.tag != key) {
                    view.tag = key
                    player.setMediaItem(MediaItem.fromUri(android.net.Uri.fromFile(item.localFile)))
                    player.prepare()
                    player.playWhenReady = true
                }
            },
            modifier = Modifier.fillMaxSize(),
            onRelease = { view ->
                (view.player as? ExoPlayer)?.release()
                view.player = null
            }
        )
    }

    /** 图片轮播表面; epoch 变化即重新计时 (支持单图循环) */
    @Composable
    private fun ImageSurface(item: PlaylistItem, epoch: Int, onAdvance: () -> Unit, onStarted: () -> Unit) {
        val bitmap = remember(item.videoId, item.md5) {
            item.localFile?.let { decodeSampled(it, 1920, 1080) }
        }
        LaunchedEffect(item.videoId, item.md5, epoch) {
            if (bitmap == null) { onAdvance(); return@LaunchedEffect }
            onStarted()
            delay(item.duration * 1000L)
            onAdvance()
        }
        if (bitmap != null) {
            Image(
                bitmap = bitmap.asImageBitmap(),
                contentDescription = item.name,
                contentScale = ContentScale.FillBounds, // 与视频一致: 拉伸铺满全屏
                modifier = Modifier.fillMaxSize().background(Color.Black)
            )
        }
    }

    private fun decodeSampled(file: File, maxW: Int, maxH: Int): Bitmap? {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(file.absolutePath, bounds)
        var sample = 1
        while (bounds.outWidth / (sample * 2) >= maxW && bounds.outHeight / (sample * 2) >= maxH) sample *= 2
        return BitmapFactory.decodeFile(file.absolutePath, BitmapFactory.Options().apply { inSampleSize = sample })
    }

    @Composable
    private fun PasswordDialog(onConfirm: (String) -> Unit, onDismiss: () -> Unit) {
        var pwd by remember { mutableStateOf("") }
        AlertDialog(
            onDismissRequest = onDismiss,
            title = { Text("维护入口") },
            text = {
                OutlinedTextField(
                    value = pwd, onValueChange = { pwd = it },
                    label = { Text("请输入管理密码") },
                    visualTransformation = androidx.compose.ui.text.input.PasswordVisualTransformation(),
                    singleLine = true
                )
            },
            confirmButton = { TextButton(onClick = { onConfirm(pwd) }) { Text("确定") } },
            dismissButton = { TextButton(onClick = onDismiss) { Text("取消") } }
        )
    }
}
