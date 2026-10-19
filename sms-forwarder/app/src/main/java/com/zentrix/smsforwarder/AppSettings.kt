package com.zentrix.smsforwarder

import android.content.Context

/** Private, on-device settings. */
class AppSettings(ctx: Context) {
    private val p = ctx.getSharedPreferences("settings", Context.MODE_PRIVATE)

    var url: String
        get() = p.getString("url", "") ?: ""
        set(v) = p.edit().putString("url", v).apply()

    var secret: String
        get() = p.getString("secret", "") ?: ""
        set(v) = p.edit().putString("secret", v).apply()

    var senders: String
        get() = p.getString("senders", "") ?: ""
        set(v) = p.edit().putString("senders", v).apply()

    var enabled: Boolean
        get() = p.getBoolean("enabled", false)
        set(v) = p.edit().putBoolean("enabled", v).apply()

    /** Only messages from an allow-listed sender name are ever forwarded. */
    fun allowed(sender: String?): Boolean {
        if (sender.isNullOrBlank()) return false
        val list = senders.split(",").map { it.trim() }.filter { it.isNotEmpty() }
        return list.any { it.equals(sender.trim(), ignoreCase = true) }
    }
}
