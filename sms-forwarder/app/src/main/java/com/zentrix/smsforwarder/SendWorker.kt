package com.zentrix.smsforwarder

import android.content.Context
import android.os.Build
import androidx.work.Worker
import androidx.work.WorkerParameters
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/**
 * Sends one message to the server. Each attempt is signed with a fresh timestamp, so retries
 * hours later are still accepted. The "id" lets the server ignore duplicates.
 */
class SendWorker(ctx: Context, params: WorkerParameters) : Worker(ctx, params) {

    override fun doWork(): Result {
        val s = AppSettings(applicationContext)
        val id = inputData.getString("id") ?: return Result.failure()
        val short = id.take(8)

        val payload = JSONObject().apply {
            put("type", inputData.getString("kind") ?: "sms")
            put("id", id)
            put("sender", inputData.getString("sender") ?: "")
            put("body", inputData.getString("body") ?: "")
            put("receivedAt", inputData.getLong("receivedAt", 0L))
            put("device", Build.MODEL)
        }.toString()

        return try {
            val code = post(s.url, s.secret, payload)
            when {
                code in 200..299 -> {
                    LogStore.add(applicationContext, "SENT", "$short  HTTP $code")
                    Result.success()
                }
                code in 400..499 && code != 408 && code != 429 -> {
                    LogStore.add(applicationContext, "REJECTED", "$short  HTTP $code")
                    Result.failure()
                }
                else -> retryOrFail(short, "HTTP $code")
            }
        } catch (e: Exception) {
            retryOrFail(short, e.javaClass.simpleName)
        }
    }

    private fun retryOrFail(short: String, why: String): Result {
        return if (runAttemptCount >= 20) {
            LogStore.add(applicationContext, "FAILED", "$short  $why")
            Result.failure()
        } else {
            LogStore.add(applicationContext, "RETRY", "$short  $why (try ${runAttemptCount + 1})")
            Result.retry()
        }
    }

    private fun post(url: String, secret: String, body: String): Int {
        require(url.startsWith("https://")) { "URL must be https" }
        require(secret.isNotEmpty()) { "Missing secret" }
        val ts = System.currentTimeMillis().toString()
        val sig = hmacHex(secret, "$ts.$body")
        val conn = URL(url).openConnection() as HttpURLConnection
        try {
            conn.requestMethod = "POST"
            conn.connectTimeout = 15000
            conn.readTimeout = 15000
            conn.doOutput = true
            conn.setRequestProperty("Content-Type", "application/json")
            conn.setRequestProperty("X-Timestamp", ts)
            conn.setRequestProperty("X-Signature", sig)
            conn.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
            return conn.responseCode
        } finally {
            conn.disconnect()
        }
    }

    private fun hmacHex(secret: String, data: String): String {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(secret.toByteArray(Charsets.UTF_8), "HmacSHA256"))
        return mac.doFinal(data.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
    }
}
