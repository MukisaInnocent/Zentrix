package com.zentrix.smsforwarder

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import android.widget.Button
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import com.google.android.material.materialswitch.MaterialSwitch
import com.google.android.material.textfield.TextInputEditText

class MainActivity : AppCompatActivity() {
    private lateinit var s: AppSettings
    private lateinit var url: TextInputEditText
    private lateinit var secret: TextInputEditText
    private lateinit var senders: TextInputEditText
    private lateinit var enabled: MaterialSwitch
    private lateinit var status: TextView
    private lateinit var log: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        s = AppSettings(this)

        url = findViewById(R.id.url)
        secret = findViewById(R.id.secret)
        senders = findViewById(R.id.senders)
        enabled = findViewById(R.id.enabled)
        status = findViewById(R.id.status)
        log = findViewById(R.id.log)

        url.setText(s.url)
        secret.setText(s.secret)
        senders.setText(s.senders)
        enabled.isChecked = s.enabled

        findViewById<Button>(R.id.save).setOnClickListener { if (save()) toast("Saved") }
        findViewById<Button>(R.id.test).setOnClickListener {
            if (save()) {
                Forwarder.enqueue(this, "test", "TEST", "Test message", System.currentTimeMillis())
                toast("Test queued. Tap Refresh in a few seconds.")
                refresh()
            }
        }
        findViewById<Button>(R.id.perm).setOnClickListener {
            ActivityCompat.requestPermissions(this, arrayOf(Manifest.permission.RECEIVE_SMS), 1)
        }
        findViewById<Button>(R.id.battery).setOnClickListener {
            startActivity(Intent(android.provider.Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
        }
        findViewById<Button>(R.id.refresh).setOnClickListener { refresh() }

        enabled.setOnCheckedChangeListener { _, on ->
            if (on && !(save() && hasPerm())) {
                if (!hasPerm()) toast("Grant SMS permission first")
                enabled.isChecked = false
            } else {
                s.enabled = on
                refresh()
            }
        }
    }

    override fun onResume() {
        super.onResume()
        refresh()
    }

    override fun onRequestPermissionsResult(
        requestCode: Int, permissions: Array<out String>, grantResults: IntArray
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        refresh()
    }

    private fun hasPerm() =
        ContextCompat.checkSelfPermission(this, Manifest.permission.RECEIVE_SMS) == PackageManager.PERMISSION_GRANTED

    private fun save(): Boolean {
        val u = url.text.toString().trim()
        val k = secret.text.toString().trim()
        val n = senders.text.toString().trim()
        if (!u.startsWith("https://")) { toast("Server URL must start with https://"); return false }
        if (k.length < 16) { toast("Secret key must be at least 16 characters"); return false }
        if (n.isEmpty()) { toast("Add at least one allowed sender name"); return false }
        s.url = u; s.secret = k; s.senders = n
        return true
    }

    private fun refresh() {
        status.text = "SMS permission: " + (if (hasPerm()) "granted" else "missing") +
            "  |  Forwarding: " + (if (s.enabled) "ON" else "OFF")
        log.text = LogStore.read(this).joinToString("\n").ifEmpty { "No activity yet" }
    }

    private fun toast(m: String) = Toast.makeText(this, m, Toast.LENGTH_SHORT).show()
}
