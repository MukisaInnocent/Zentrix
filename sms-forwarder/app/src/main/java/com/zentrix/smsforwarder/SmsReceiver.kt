package com.zentrix.smsforwarder

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.provider.Telephony

class SmsReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Telephony.Sms.Intents.SMS_RECEIVED_ACTION) return
        val s = AppSettings(context)
        if (!s.enabled || s.url.isBlank()) return

        val parts = Telephony.Sms.Intents.getMessagesFromIntent(intent) ?: return
        // Long messages arrive in parts; join the parts that share a sender.
        for ((sender, list) in parts.groupBy { it.originatingAddress ?: "" }) {
            if (!s.allowed(sender)) continue          // personal messages are never forwarded
            val body = list.joinToString("") { it.messageBody ?: "" }
            Forwarder.enqueue(context, "sms", sender, body, list.first().timestampMillis)
        }
    }
}
