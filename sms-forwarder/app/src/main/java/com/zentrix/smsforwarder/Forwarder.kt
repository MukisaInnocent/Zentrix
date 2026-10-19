package com.zentrix.smsforwarder

import android.content.Context
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.workDataOf
import java.security.MessageDigest
import java.util.concurrent.TimeUnit

object Forwarder {
    /** Queues a message for delivery. WorkManager keeps it and retries until the server accepts it. */
    fun enqueue(ctx: Context, kind: String, sender: String, body: String, receivedAt: Long) {
        val id = sha256("$sender|$receivedAt|$body").take(32)
        val data = workDataOf(
            "kind" to kind,
            "id" to id,
            "sender" to sender,
            "body" to body,
            "receivedAt" to receivedAt
        )
        val request = OneTimeWorkRequestBuilder<SendWorker>()
            .setInputData(data)
            .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
            .build()
        WorkManager.getInstance(ctx).enqueueUniqueWork("sms-$id", ExistingWorkPolicy.KEEP, request)
        LogStore.add(ctx, "QUEUED", "$sender  ${id.take(8)}")
    }

    private fun sha256(s: String): String =
        MessageDigest.getInstance("SHA-256").digest(s.toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it) }
}
