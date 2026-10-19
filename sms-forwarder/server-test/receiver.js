// Minimal reference receiver for testing the app. No dependencies: node receiver.js
// Usage: SECRET=your-secret node receiver.js   (then expose with an https tunnel for the phone)
const http = require("http"), crypto = require("crypto");
const SECRET = process.env.SECRET || "change-me-to-a-long-random-secret";
const seen = new Set();

http.createServer((req, res) => {
  if (req.method !== "POST" || req.url !== "/sms") { res.writeHead(404); return res.end(); }
  let raw = "";
  req.on("data", c => { raw += c; if (raw.length > 20000) req.destroy(); });
  req.on("end", () => {
    const ts = req.headers["x-timestamp"] || "", sig = req.headers["x-signature"] || "";
    const want = crypto.createHmac("sha256", SECRET).update(`${ts}.${raw}`).digest("hex");
    const ok = sig.length === want.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want));
    const fresh = Math.abs(Date.now() - Number(ts)) < 5 * 60 * 1000;
    if (!ok || !fresh) { res.writeHead(401); return res.end('{"ok":false}'); }
    let m; try { m = JSON.parse(raw); } catch { res.writeHead(400); return res.end('{"ok":false}'); }
    if (m.type === "test") { console.log("TEST ping from", m.device); res.writeHead(200); return res.end('{"ok":true,"test":true}'); }
    if (seen.has(m.id)) { res.writeHead(200); return res.end('{"ok":true,"duplicate":true}'); }
    seen.add(m.id);
    console.log("SMS from", m.sender, "->", m.body);   // here you would parse, store and match the payment
    res.writeHead(200); res.end('{"ok":true}');
  });
}).listen(3000, () => console.log("listening on :3000"));
