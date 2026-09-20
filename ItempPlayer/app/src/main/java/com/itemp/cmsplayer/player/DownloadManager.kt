package com.itemp.cmsplayer.player

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.StatFs
import com.itemp.cmsplayer.data.ApiClient
import com.itemp.cmsplayer.data.DeviceStore
import com.itemp.cmsplayer.util.AppLog
import okhttp3.Request
import java.io.File
import java.io.IOException
import java.io.RandomAccessFile

/** 下载进度信息 (供设备端 UI 展示) */
data class DownloadProgress(
    val itemName: String,
    val fileIndex: Int,          // 当前第几个文件 (1-based)
    val fileCount: Int,          // 本轮共需下载的文件数
    val downloadedBytes: Long,   // 已下载字节 (含续传部分)
    val totalBytes: Long,        // 总字节, -1 表示未知
    val speedBytesPerSec: Long,
) {
    val percent: Int get() = if (totalBytes > 0) (downloadedBytes * 100 / totalBytes).toInt().coerceIn(0, 100) else -1
}

/**
 * 素材下载器: 断点续传 + MD5 校验 + 失败重试 3 次 + 空间不足清理最旧 (需求 5.2.4)
 * 同步实现 (由 PlaylistEngine 在后台线程调用), 串行队列天然不阻塞播放页
 */
object DownloadManager {

    private const val MAX_RETRY = 3
    private const val FREE_SPACE_FACTOR = 2L
    private const val PROGRESS_REPORT_INTERVAL_MS = 300L

    fun isWifi(context: Context): Boolean {
        val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return false
        val caps = cm.getNetworkCapabilities(cm.activeNetwork) ?: return false
        return caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)
    }

    /**
     * 确保所有素材就绪, 返回本地文件列表 (与 items 顺序无关)
     * 下载过程中实时更新 [PlaylistEngine.downloadProgressState]
     */
    fun ensureDownloaded(context: Context, items: List<PlaylistItem>): List<File> {
        val dir = PlaylistEngine.mediaDir(context)
        val result = mutableListOf<File>()
        // 先统计需要下载的文件数, 用于进度分母
        val needDownload = items.filter { item ->
            val t = targetFile(dir, item)
            !(t.exists() && md5OfFile(t).equals(item.md5, ignoreCase = true))
        }
        val totalCount = needDownload.size
        var doneCount = 0

        for (item in items) {
            val target = targetFile(dir, item)
            if (target.exists() && md5OfFile(target).equals(item.md5, ignoreCase = true)) {
                result.add(target)
                continue
            }
            // 仅 WiFi 下载策略
            if (DeviceStore.wifiOnlyDownload && !isWifi(context)) {
                AppLog.i("DownloadManager", "非 WiFi 网络跳过下载: ${item.name}")
                continue
            }
            try {
                download(context, item, target, totalCount, doneCount)
                doneCount++
                result.add(target)
            } catch (e: Exception) {
                AppLog.e("DownloadManager", "下载失败(已重试 $MAX_RETRY 次): ${item.name}", e)
                // 单个素材失败不阻塞其他素材; 损坏文件删除以便下次重新下载 (需求 5.2.6 视频损坏)
                target.delete()
                File(target.absolutePath + ".part").delete()
                doneCount++
            }
        }
        // 全部结束, 清除进度
        PlaylistEngine.downloadProgressState.value = null
        return result
    }

    fun targetFile(dir: File, item: PlaylistItem): File {
        val ext = if (item.type == "image") ".img" else ".mp4"
        return File(dir, "${item.videoId}_${item.md5.take(8)}$ext")
    }

    /** 下载单个文件: Range 断点续传 + 边下边算 MD5 + 重试 */
    @Throws(IOException::class)
    private fun download(context: Context, item: PlaylistItem, target: File, totalCount: Int, doneCount: Int) {
        var attempt = 0
        while (true) {
            attempt++
            try {
                downloadOnce(context, item, target, totalCount, doneCount)
                return
            } catch (e: IOException) {
                if (attempt >= MAX_RETRY) throw e
                AppLog.w("DownloadManager", "第 $attempt 次下载失败, 重试: ${e.message}")
                Thread.sleep(2000L * attempt) // 退避
            }
        }
    }

    private fun downloadOnce(context: Context, item: PlaylistItem, target: File, totalCount: Int, doneCount: Int) {
        val part = File(target.absolutePath + ".part")
        ensureSpace(context, item.size)

        val downloaded = if (part.exists()) part.length() else 0L
        val rb = Request.Builder().url(item.url)
        if (downloaded > 0) rb.addHeader("Range", "bytes=$downloaded-")
        rb.addHeader("Authorization", "Bearer ${DeviceStore.token}")

        ApiClient.http.newCall(rb.build()).execute().use { resp ->
            if (!resp.isSuccessful) throw IOException("HTTP ${resp.code}")
            val appending = resp.code == 206 && downloaded > 0
            if (!appending && part.exists()) part.delete()

            val body = resp.body ?: throw IOException("空响应")
            val contentLength = body.contentLength()
            val totalBytes = if (contentLength > 0) downloaded + contentLength
                else if (item.size > 0 && appending) item.size
                else item.size

            val startMs = System.currentTimeMillis()
            var lastReport = 0L
            val streamMd5 = StreamMd5()
            RandomAccessFile(part, "rw").use { raf ->
                raf.seek(if (appending) downloaded else 0L)
                val buf = ByteArray(64 * 1024)
                val input = body.byteStream()
                var written = 0L
                while (true) {
                    val n = input.read(buf)
                    if (n < 0) break
                    raf.write(buf, 0, n)
                    streamMd5.update(buf, n)
                    written += n

                    // 节流上报进度
                    val now = System.currentTimeMillis()
                    if (now - lastReport >= PROGRESS_REPORT_INTERVAL_MS) {
                        lastReport = now
                        val elapsed = (now - startMs).coerceAtLeast(1)
                        PlaylistEngine.downloadProgressState.value = DownloadProgress(
                            itemName = item.name,
                            fileIndex = doneCount + 1,
                            fileCount = totalCount,
                            downloadedBytes = downloaded + written,
                            totalBytes = totalBytes,
                            speedBytesPerSec = written * 1000 / elapsed,
                        )
                    }
                }
                val fileSize = downloaded + written
                // 断点续传场景下 MD5 需要对完整文件计算
                val md5 = if (appending) md5OfFile(part) else streamMd5.hex()
                if (!md5.equals(item.md5, ignoreCase = true)) {
                    part.delete()
                    throw IOException("MD5 校验失败 (期望 ${item.md5.take(8)}…, 实际 ${md5.take(8)}…)")
                }
                if (part.renameTo(target)) {
                    AppLog.i("DownloadManager", "下载完成并通过 MD5 校验: ${item.name} ($fileSize B)")
                } else {
                    throw IOException("重命名失败")
                }
            }
        }
    }

    /** 空间不足时清理最旧的素材 (需求 5.2.4) */
    private fun ensureSpace(context: Context, needBytes: Long) {
        val dir = PlaylistEngine.mediaDir(context)
        val stat = StatFs(dir.absolutePath)
        var avail = stat.availableBytes
        if (avail >= needBytes * FREE_SPACE_FACTOR) return

        val files = dir.listFiles()?.filter { it.isFile }?.sortedBy { it.lastModified() } ?: return
        for (f in files) {
            if (avail >= needBytes * FREE_SPACE_FACTOR) break
            if (f.delete()) {
                avail += f.length()
                AppLog.i("DownloadManager", "空间不足, 已清理最旧素材: ${f.name}")
            }
        }
    }

    fun md5OfFile(file: File): String {
        val md = java.security.MessageDigest.getInstance("MD5")
        file.inputStream().use { input ->
            val buf = ByteArray(64 * 1024)
            while (true) {
                val n = input.read(buf)
                if (n < 0) break
                md.update(buf, 0, n)
            }
        }
        return md.digest().joinToString("") { "%02x".format(it) }
    }
}
