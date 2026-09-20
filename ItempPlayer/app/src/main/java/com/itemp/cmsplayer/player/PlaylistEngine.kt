package com.itemp.cmsplayer.player

import android.content.Context
import androidx.compose.runtime.mutableStateOf
import com.itemp.cmsplayer.data.ApiClient
import com.itemp.cmsplayer.data.DeviceStore
import com.itemp.cmsplayer.util.AppLog
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.security.MessageDigest

/** 节目单条目 (服务端下发) */
data class PlaylistItem(
    val videoId: Int,
    val name: String,
    val type: String,        // video | image
    val duration: Int,       // 秒
    val md5: String,
    val size: Long,
    val url: String,
    val localFile: File?,    // 已就绪的本地文件
)

/**
 * 节目单引擎: 拉取节目单 → 版本比对 → 下载/清理 → 供播放页消费 (需求 5.2.4 / 5.1.5)
 * 单例, PlayerActivity 与 HeartbeatService 共享
 */
object PlaylistEngine {

    const val MEDIA_DIR = "media"

    var version: Long = 0
        private set
    var source: String = "none"
        private set
    var playlistName: String = ""
        private set
    var items: List<PlaylistItem> = emptyList()
        private set

    /** 节目单发生变化时的监听 (播放页刷新播放队列) */
    var onPlaylistChanged: (() -> Unit)? = null

    /** 下载实时进度 (Compose 可观察), null = 当前无下载 */
    val downloadProgressState = mutableStateOf<DownloadProgress?>(null)

    fun mediaDir(context: Context): File =
        File(context.filesDir, MEDIA_DIR).apply { mkdirs() }

    /**
     * 拉取并应用最新节目单; 返回是否发生变化
     * @param force 强制刷新 (忽略版本比对)
     */
    @Synchronized
    fun refresh(context: Context, force: Boolean = false): Boolean {
        val r = ApiClient.get("/api/device/playlist")
        if (!r.ok) {
            AppLog.e("PlaylistEngine", "拉取节目单失败: ${r.msg}")
            // 401 时尝试自动重登一次
            if (r.code == 401) {
                try { ApiClient.relogin() } catch (_: Exception) { }
            }
            return false
        }
        val data = r.data ?: return false

        // 服务器对时 (需求 5.2.6)
        val serverTime = data.optLong("serverTime", 0L)
        if (serverTime > 0) DeviceStore.serverTimeOffset = serverTime - System.currentTimeMillis()

        val newVersion = data.optLong("version", 0L)
        val arr: JSONArray = data.optJSONArray("items") ?: JSONArray()
        val newItems = (0 until arr.length()).map { i ->
            val o: JSONObject = arr.getJSONObject(i)
            PlaylistItem(
                videoId = o.optInt("videoId"),
                name = o.optString("name"),
                type = if (o.optString("type") == "image") "image" else "video",
                duration = o.optInt("duration", 10).coerceAtLeast(1),
                md5 = o.optString("md5"),
                size = o.optLong("size"),
                url = o.optString("url"),
                localFile = null,
            )
        }

        if (!force && newVersion == version) {
            // 版本未变仍需确认本地文件齐全 (可能被清缓存/空间清理删除过), 缺失则继续走下载
            val dir = mediaDir(context)
            val allPresent = newItems.all { DownloadManager.targetFile(dir, it).exists() }
            if (allPresent) return false
        }

        try {
            // 1. 下载缺失素材 (含 MD5 校验/重试/空间清理, 实时上报进度)
            val files = DownloadManager.ensureDownloaded(context, newItems)

            // 2. 清理不再被引用的旧素材 (空间不足时也会在下载器内清理最旧的, 需求 5.2.4)
            val keep = files.map { it.absolutePath }.toSet()
            mediaDir(context).listFiles()?.forEach { f ->
                if (f.isFile && f.absolutePath !in keep) {
                    if (f.delete()) AppLog.i("PlaylistEngine", "清理过期素材: ${f.name}")
                }
            }

            version = newVersion
            source = data.optString("source", "none")
            playlistName = data.optString("playlistName", "")
            items = newItems.map { it.copy(localFile = files.firstOrNull { f -> f.name.startsWith("${it.videoId}_") }) }
                .filter { it.localFile != null }
            AppLog.i("PlaylistEngine", "节目单已更新: v$newVersion 来源=$source 素材=${items.size}")
            onPlaylistChanged?.invoke()
            return true
        } finally {
            downloadProgressState.value = null
        }
    }

    /** 上报队列: 播放记录暂存, 批量上报 (需求 5.2.5) */
    private val pendingLogs = mutableListOf<JSONObject>()

    @Synchronized
    fun logPlay(item: PlaylistItem, startTs: Long, endTs: Long) {
        pendingLogs.add(
            JSONObject()
                .put("videoId", item.videoId)
                .put("startTs", startTs)
                .put("endTs", endTs)
                .put("duration", ((endTs - startTs) / 1000).toInt())
        )
        flushLogs()
    }

    @Synchronized
    fun flushLogs() {
        if (pendingLogs.isEmpty()) return
        val logs = JSONArray()
        pendingLogs.toList().forEach { logs.put(it) }
        pendingLogs.clear()
        try {
            val r = ApiClient.post("/api/device/report", JSONObject().put("logs", logs))
            if (!r.ok) {
                AppLog.e("PlaylistEngine", "播放日志上报失败: ${r.msg}")
                // 失败放回队列, 下次重试
                if (r.code != 401) { pendingLogs.addAll(0, (0 until logs.length()).map { logs.getJSONObject(it) }) }
            }
        } catch (e: Exception) {
            AppLog.e("PlaylistEngine", "播放日志上报异常", e)
            pendingLogs.addAll(0, (0 until logs.length()).map { logs.getJSONObject(it) })
        }
    }
}

/** 流式 MD5 (下载时边下边算) */
class StreamMd5 {
    private val md = MessageDigest.getInstance("MD5")
    fun update(buf: ByteArray, len: Int) = md.update(buf, 0, len)
    fun hex(): String = md.digest().joinToString("") { "%02x".format(it) }
}
