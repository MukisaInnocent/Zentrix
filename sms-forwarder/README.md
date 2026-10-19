# SMS Forwarder (Android)

Forwards mobile-money confirmation SMS from this phone to your server, signed with a secret key.
Only messages from the sender names you list are forwarded. Personal messages are never sent.

## Build the APK
1. Install Android Studio. Open this folder (File > Open). Let Gradle sync.
2. Build > Build Bundle(s) / APK(s) > Build APK(s). The file is `app/build/outputs/apk/debug/app-debug.apk`.
3. Copy it to the phone and install it (allow "Install unknown apps" for your file manager).
   On Android 13+, if SMS permission is greyed out: Settings > Apps > SMS Forwarder > ⋮ > "Allow restricted settings".

## Set up on the phone
- Server URL: your HTTPS endpoint, for example https://api.example.com/sms
- Secret key: at least 16 random characters, identical on the server
- Allowed senders: the exact sender names shown in your SMS app for the MTN/Airtel confirmation messages (comma separated)
- Grant SMS permission, then turn Forwarding on. Tap "Battery settings" and allow background use so Android does not stop the app.
- Tap "Send test", then Refresh. You should see SENT.

## What the server receives
`POST` with JSON `{type, id, sender, body, receivedAt, device}` and headers:
- `X-Timestamp`: time of the attempt, in milliseconds
- `X-Signature`: hex HMAC-SHA256 of `timestamp + "." + rawBody` using the secret

The server must: verify the signature, reject timestamps more than 5 minutes old, ignore repeated `id`s,
and reply 2xx. Replying 4xx stops retries; 5xx or no connection retries with backoff (up to 20 tries).
`type: "test"` is only a connectivity check and must not credit anything.
`server-test/receiver.js` is a tiny reference implementation.

## Notes
- Messages are queued on the phone, so nothing is lost while it is offline.
- The phone must be Android, powered, and have signal and data.
- Google Play restricts SMS permissions, so use this as a private sideloaded app.
