package com.itemp.cmsplayer.util

import android.util.Log
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * 应用内环形日志缓冲: 供隐藏设置页查看 (需求 5.2.7 查看日志)
 */
object AppLog {

    private val buffer = ArrayDeque<String>(500)
    private val fmt = SimpleDateFormat("MM-dd HH:mm:ss.SSS", Locale.CHINA)

    @Synchronized
    fun i(tag: String, msg: String) = append("I", tag, msg)

    @Synchronized
    fun w(tag: String, msg: String) = append("W", tag, msg)

    @Synchronized
    fun e(tag: String, msg: String, tr: Throwable? = null) =
        append("E", tag, msg + (tr?.let { " | ${it.message}" } ?: ""))

    private fun append(level: String, tag: String, msg: String) {
        val line = "${fmt.format(Date())} $level/$tag: $msg"
        if (buffer.size >= 500) buffer.removeFirst()
        buffer.addLast(line)
        if (level == "E") Log.e(tag, msg) else Log.i(tag, msg)
    }

    @Synchronized
    fun dump(): String = buffer.joinToString("\n")

    @Synchronized
    fun clear() = buffer.clear()
}
