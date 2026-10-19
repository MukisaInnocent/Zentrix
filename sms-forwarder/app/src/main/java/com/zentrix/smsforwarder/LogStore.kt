package com.zentrix.smsforwarder

import android.content.Context
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/** Small activity log. Never stores message text, only sender, a short id and the status. */
object LogStore {
    private const val FILE = "log.txt"
    private const val MAX = 60

    @Synchronized
    fun add(ctx: Context, status: String, detail: String) {
        val f = File(ctx.filesDir, FILE)
        val time = SimpleDateFormat("MM-dd HH:mm:ss", Locale.US).format(Date())
        val line = time + "  " + status.padEnd(9) + detail.replace('\n', ' ')
        val old: List<String> = if (f.exists()) f.readLines() else emptyList()
        f.writeText((old + line).takeLast(MAX).joinToString("\n"))
    }

    @Synchronized
    fun read(ctx: Context): List<String> {
        val f = File(ctx.filesDir, FILE)
        return if (f.exists()) f.readLines().reversed() else emptyList()
    }
}
