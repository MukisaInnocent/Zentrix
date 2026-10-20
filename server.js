const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash, randomBytes } = require("node:crypto");
require("dotenv").config();
const bcrypt = require("bcryptjs");
const express = require("express");
const { rateLimit } = require("express-rate-limit");
const helmet = require("helmet");
const { Pool } = require("pg");

const ROOT = __dirname;
const SESSION_COOKIE = "zentrix_session";
const SESSION_DAYS = 7;
const WITHDRAWAL_MINIMUM_UGX = 5000;
const INITIAL_DEPOSIT_UGX = 20000;
const MAX_AMOUNT_UGX = 999_999_999_999;

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function validEmail(value) {
  return typeof value === "string" && value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function validPassword(value) {
  return typeof value === "string" && value.length >= 8 && Buffer.byteLength(value, "utf8") <= 72;
}

function readAmount(value) {
  const amount = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(amount) && amount > 0 && amount <= MAX_AMOUNT_UGX ? amount : null;
}

function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

function readSessionCookie(req) {
  const cookies = (req.headers.cookie || "").split(";");
  const cookie = cookies.map(value => value.trim()).find(value => value.startsWith(`${SESSION_COOKIE}=`));
  return cookie ? cookie.slice(SESSION_COOKIE.length + 1) : null;
}

function setSessionCookie(res, token) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE}=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${SESSION_DAYS * 24 * 60 * 60}${secure}`
  );
}

function clearSessionCookie(res) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0${secure}`);
}

async function withTransaction(pool, callback) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function createApp({ pool, demoPaymentsEnabled = process.env.NODE_ENV !== "production" && process.env.DEMO_PAYMENTS_ENABLED === "true" }) {
  if (!pool) {
    throw new Error("A PostgreSQL-compatible database pool is required.");
  }
  demoPaymentsEnabled = demoPaymentsEnabled && process.env.NODE_ENV !== "production";

  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        connectSrc: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        imgSrc: ["'self'", "data:"],
        objectSrc: ["'none'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"]
      }
    }
  }));
  app.use(express.json({ limit: "16kb" }));
  app.use((req, res, next) => {
    if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
      req.body = {};
    }
    next();
  });

  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 20,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message: { error: "Too many sign-in attempts. Try again later." }
  });

  const requireUser = asyncRoute(async (req, res, next) => {
    const token = readSessionCookie(req);
    if (!token || !/^[a-f0-9]{64}$/.test(token)) {
      return res.status(401).json({ error: "Please sign in to continue." });
    }

    const result = await pool.query(
      `SELECT u.id, u.username, u.email, u.phone, u.referral_code, u.account_status
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = $1 AND s.expires_at > NOW()`,
      [hashToken(token)]
    );
    if (!result.rowCount) {
      clearSessionCookie(res);
      return res.status(401).json({ error: "Please sign in to continue." });
    }
    req.user = result.rows[0];
    if (req.user.account_status !== "active") {
      return res.status(403).json({
        error: "Your account is awaiting verification of the UGX 20,000 initial deposit.",
        accountStatus: req.user.account_status
      });
    }
    next();
  });

  const requireSession = asyncRoute(async (req, res, next) => {
    const token = readSessionCookie(req);
    if (!token || !/^[a-f0-9]{64}$/.test(token)) {
      clearSessionCookie(res);
      return res.status(401).json({ error: "Your signup session has expired. Please sign up again." });
    }
    const result = await pool.query(
      `SELECT u.id, u.username, u.email, u.phone, u.referral_code, u.account_status
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = $1 AND s.expires_at > NOW()`,
      [hashToken(token)]
    );
    if (!result.rowCount) {
      clearSessionCookie(res);
      return res.status(401).json({ error: "Your signup session has expired. Please sign up again." });
    }
    req.user = result.rows[0];
    next();
  });

  app.use("/api", (req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    if (!["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) {
      return next();
    }
    const origin = req.get("origin");
    if (origin) {
      try {
        if (new URL(origin).host !== req.get("host")) {
          return res.status(403).json({ error: "Cross-origin request blocked." });
        }
      } catch {
        return res.status(403).json({ error: "Invalid request origin." });
      }
    } else if (req.get("sec-fetch-site") === "cross-site") {
      return res.status(403).json({ error: "Cross-origin request blocked." });
    }
    next();
  });

  app.get("/api/health", asyncRoute(async (req, res) => {
    await pool.query("SELECT 1");
    res.json({ status: "ok" });
  }));

  app.post("/api/auth/register", authLimiter, asyncRoute(async (req, res) => {
    const username = typeof req.body.username === "string" ? req.body.username.trim().toLowerCase() : "";
    const email = typeof req.body.email === "string" ? req.body.email.trim().toLowerCase() : "";
    const phone = typeof req.body.phone === "string" ? req.body.phone.trim() : "";
    const password = req.body.password;

    if (!/^[a-z0-9_]{3,30}$/.test(username)) {
      return res.status(400).json({ error: "Username must be 3–30 characters using letters, numbers, or underscores." });
    }
    if (!validEmail(email)) {
      return res.status(400).json({ error: "Enter a valid email address." });
    }
    if (!validPassword(password)) {
      return res.status(400).json({ error: "Password must be between 8 and 72 characters." });
    }
    if (!phone || !/^[+\d][\d\s()-]{4,28}$/.test(phone)) {
      return res.status(400).json({ error: "Enter a valid phone number." });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const sessionToken = randomBytes(32).toString("hex");
    try {
      const registration = await withTransaction(pool, async client => {
        const inserted = await client.query(
          `INSERT INTO users (username, email, phone, password_hash, referral_code, account_status)
           VALUES ($1, $2, $3, $4, $5, 'pending_payment')
           RETURNING id, username, email, phone, referral_code, account_status`,
          [username, email, phone || null, passwordHash, randomBytes(6).toString("hex")]
        );
        await client.query("INSERT INTO wallets (user_id) VALUES ($1)", [inserted.rows[0].id]);
        const deposit = await client.query(
          `INSERT INTO money_requests
             (user_id, kind, amount_ugx, method, destination, provider, request_type, reference)
           VALUES ($1, 'deposit', $2, 'mobile_money', $3, 'unconfigured', 'initial_deposit', $4)
           RETURNING reference, status, amount_ugx`,
          [inserted.rows[0].id, INITIAL_DEPOSIT_UGX, phone, requestReference("IP")]
        );
        await client.query(
          "INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, $3)",
          [inserted.rows[0].id, hashToken(sessionToken), new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000)]
        );
        return { user: inserted.rows[0], initialDeposit: deposit.rows[0] };
      });
      setSessionCookie(res, sessionToken);
      res.status(202).json({
        user: userResponse(registration.user),
        initialDeposit: {
          reference: registration.initialDeposit.reference,
          amount: Number(registration.initialDeposit.amount_ugx),
          status: registration.initialDeposit.status,
          paymentStatus: "not_configured"
        },
        message: "Your account has been created but is locked. The UGX 20,000 initial deposit is required. Payment collection is not connected yet, so no money has been taken and no wallet funds have been credited."
      });
    } catch (error) {
      if (error.code === "23505") {
        return res.status(409).json({ error: "That username or email is already registered." });
      }
      throw error;
    }
  }));

  app.get("/api/payment/initial-deposit", requireSession, asyncRoute(async (req, res) => {
    const result = await pool.query(
      `SELECT reference, amount_ugx, status FROM money_requests
       WHERE user_id = $1 AND request_type = 'initial_deposit'
       ORDER BY id DESC LIMIT 1`,
      [req.user.id]
    );
    if (!result.rowCount) {
      return res.status(404).json({ error: "No initial deposit request was found." });
    }
    res.json({
      amount: Number(result.rows[0].amount_ugx),
      reference: result.rows[0].reference,
      status: result.rows[0].status,
      accountStatus: req.user.account_status,
      demoEnabled: demoPaymentsEnabled
    });
  }));

  app.post("/api/demo/initial-deposit/complete", requireSession, asyncRoute(async (req, res) => {
    if (!demoPaymentsEnabled) {
      return res.status(404).json({ error: "Demo payments are disabled. Connect a payment provider to collect this deposit." });
    }
    if (req.user.account_status !== "pending_payment") {
      return res.status(409).json({ error: "This account does not have a pending initial deposit." });
    }
    const sessionToken = randomBytes(32).toString("hex");
    const result = await finalizeDemoInitialDeposit(pool, {
      userId: req.user.id,
      sessionHash: hashToken(readSessionCookie(req)),
      nextSessionHash: hashToken(sessionToken)
    });
    setSessionCookie(res, sessionToken);
    res.json({
      success: true,
      alreadyCompleted: result.alreadyCompleted,
      message: "Demo payment passed. UGX 20,000 demo funds were added to your wallet.",
      user: userResponse(result.user)
    });
  }));

  app.post("/api/auth/login", authLimiter, asyncRoute(async (req, res) => {
    const identifier = typeof req.body.identifier === "string" ? req.body.identifier.trim().toLowerCase() : "";
    const password = req.body.password;
    if (!identifier || typeof password !== "string" || Buffer.byteLength(password, "utf8") > 72) {
      return res.status(400).json({ error: "Enter your username or email and password." });
    }

    const result = await pool.query(
      `SELECT id, username, email, phone, referral_code, password_hash, account_status
       FROM users WHERE username = $1 OR email = $1`,
      [identifier]
    );
    const user = result.rows[0];
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ error: "Invalid username/email or password." });
    }
    if (user.account_status !== "active") {
      return res.status(403).json({
        error: "Your account is awaiting verification of the UGX 20,000 initial deposit. Payment collection is not connected yet.",
        accountStatus: user.account_status
      });
    }

    const token = randomBytes(32).toString("hex");
    await pool.query("DELETE FROM sessions WHERE expires_at <= NOW()");
    await pool.query(
      "INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, $3)",
      [user.id, hashToken(token), new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000)]
    );
    setSessionCookie(res, token);
    res.json({ user: userResponse(user) });
  }));

  app.post("/api/auth/logout", requireUser, asyncRoute(async (req, res) => {
    const token = readSessionCookie(req);
    await pool.query("DELETE FROM sessions WHERE token_hash = $1", [hashToken(token)]);
    clearSessionCookie(res);
    res.json({ success: true });
  }));

  app.get("/api/auth/me", requireUser, (req, res) => {
    res.json({ user: userResponse(req.user) });
  });

  app.get("/api/account/profile", requireUser, (req, res) => {
    res.json({ user: userResponse(req.user) });
  });

  app.patch("/api/account/profile", requireUser, asyncRoute(async (req, res) => {
    const phone = typeof req.body.phone === "string" ? req.body.phone.trim() : null;
    const newPassword = req.body.newPassword;
    if (phone === null && newPassword === undefined) {
      return res.status(400).json({ error: "Provide a phone number or a new password." });
    }
    if (phone !== null && phone && !/^[+\d][\d\s()-]{4,28}$/.test(phone)) {
      return res.status(400).json({ error: "Enter a valid phone number." });
    }
    if (newPassword !== undefined && !validPassword(newPassword)) {
      return res.status(400).json({ error: "New password must be between 8 and 72 characters." });
    }

    if (newPassword !== undefined) {
      const currentPassword = req.body.currentPassword;
      const stored = await pool.query("SELECT password_hash FROM users WHERE id = $1", [req.user.id]);
      if (typeof currentPassword !== "string" ||
          !(await bcrypt.compare(currentPassword, stored.rows[0].password_hash))) {
        return res.status(403).json({ error: "Current password is incorrect." });
      }
      const passwordHash = await bcrypt.hash(newPassword, 12);
      const token = readSessionCookie(req);
      await withTransaction(pool, async client => {
        await client.query(
          "UPDATE users SET phone = $1, password_hash = $2 WHERE id = $3",
          [phone || null, passwordHash, req.user.id]
        );
        await client.query(
          "DELETE FROM sessions WHERE user_id = $1 AND token_hash <> $2",
          [req.user.id, hashToken(token)]
        );
      });
    } else {
      await pool.query("UPDATE users SET phone = $1 WHERE id = $2", [phone || null, req.user.id]);
    }

    const updated = await pool.query(
      "SELECT id, username, email, phone, referral_code FROM users WHERE id = $1",
      [req.user.id]
    );
    res.json({ user: userResponse(updated.rows[0]) });
  }));

  app.get("/api/account/summary", requireUser, asyncRoute(async (req, res) => {
    const [walletResult, totalsResult, requestsResult] = await Promise.all([
      pool.query("SELECT balance_ugx, reserved_ugx FROM wallets WHERE user_id = $1", [req.user.id]),
      pool.query(
        `SELECT
           COALESCE(SUM(CASE WHEN kind = 'deposit' AND status = 'completed' THEN amount_ugx ELSE 0 END), 0) AS deposited,
           COALESCE(SUM(CASE WHEN kind = 'withdrawal' AND status = 'completed' THEN amount_ugx ELSE 0 END), 0) AS withdrawn
         FROM money_requests WHERE user_id = $1`,
        [req.user.id]
      ),
      pool.query(
        `SELECT kind, amount_ugx, method, status, reference, created_at
         FROM money_requests WHERE user_id = $1
         ORDER BY created_at DESC, id DESC LIMIT 10`,
        [req.user.id]
      )
    ]);
    const wallet = walletResult.rows[0];
    const reserved = Number(wallet.reserved_ugx);
    res.json({
      availableBalance: Number(wallet.balance_ugx) - reserved,
      reservedBalance: reserved,
      totalDeposited: Number(totalsResult.rows[0].deposited),
      totalWithdrawn: Number(totalsResult.rows[0].withdrawn),
      recentTransactions: requestsResult.rows.map(transactionResponse)
    });
  }));

  app.get("/api/wallet/transactions", requireUser, asyncRoute(async (req, res) => {
    const result = await pool.query(
      `SELECT kind, amount_ugx, method, status, reference, created_at
       FROM money_requests WHERE user_id = $1
       ORDER BY created_at DESC, id DESC LIMIT 100`,
      [req.user.id]
    );
    res.json({ transactions: result.rows.map(transactionResponse) });
  }));

  app.post("/api/wallet/deposits", requireUser, asyncRoute(async (req, res) => {
    const amount = readAmount(req.body.amount);
    const method = req.body.method;
    const destination = typeof req.body.destination === "string" ? req.body.destination.trim() : "";
    if (!amount) {
      return res.status(400).json({ error: "Enter a whole-number amount greater than zero." });
    }
    if (!["mobile_money", "bank_transfer"].includes(method)) {
      return res.status(400).json({ error: "Choose a supported payment method." });
    }
    if (destination.length < 5 || destination.length > 100) {
      return res.status(400).json({ error: "Enter a valid payment destination." });
    }

    const result = await pool.query(
      `INSERT INTO money_requests (user_id, kind, amount_ugx, method, destination, provider, reference)
       VALUES ($1, 'deposit', $2, $3, $4, 'mock', $5)
       RETURNING kind, amount_ugx, method, status, reference, created_at`,
      [req.user.id, amount, method, destination, requestReference("DP")]
    );
    res.status(201).json({
      transaction: transactionResponse(result.rows[0]),
      message: "Deposit request recorded. No payment was sent or credited."
    });
  }));

  app.post("/api/wallet/withdrawals", requireUser, asyncRoute(async (req, res) => {
    const amount = readAmount(req.body.amount);
    const method = req.body.method;
    const destination = typeof req.body.destination === "string" ? req.body.destination.trim() : "";
    if (!amount || amount < WITHDRAWAL_MINIMUM_UGX) {
      return res.status(400).json({ error: `Withdrawal amount must be at least UGX ${WITHDRAWAL_MINIMUM_UGX.toLocaleString("en-UG")}.` });
    }
    if (!["mobile_money", "bank_transfer"].includes(method)) {
      return res.status(400).json({ error: "Choose a supported payout method." });
    }
    if (destination.length < 5 || destination.length > 100) {
      return res.status(400).json({ error: "Enter a valid payout destination." });
    }

    const transaction = await withTransaction(pool, async client => {
      const walletResult = await client.query(
        "SELECT balance_ugx, reserved_ugx FROM wallets WHERE user_id = $1 FOR UPDATE",
        [req.user.id]
      );
      const available = Number(walletResult.rows[0].balance_ugx) - Number(walletResult.rows[0].reserved_ugx);
      if (amount > available) {
        return null;
      }
      await client.query(
        "UPDATE wallets SET reserved_ugx = reserved_ugx + $1, updated_at = NOW() WHERE user_id = $2",
        [amount, req.user.id]
      );
      const result = await client.query(
        `INSERT INTO money_requests (user_id, kind, amount_ugx, method, destination, provider, reference)
         VALUES ($1, 'withdrawal', $2, $3, $4, 'mock', $5)
         RETURNING kind, amount_ugx, method, status, reference, created_at`,
        [req.user.id, amount, method, destination, requestReference("WD")]
      );
      return result.rows[0];
    });

    if (!transaction) {
      return res.status(409).json({ error: "Insufficient available balance for this withdrawal request." });
    }
    res.status(201).json({
      transaction: transactionResponse(transaction),
      message: "Withdrawal request recorded as pending. No payout was sent."
    });
  }));

  app.use("/api", (req, res) => res.status(404).json({ error: "API endpoint not found." }));

  app.use("/css", express.static(path.join(ROOT, "css"), { index: false }));
  app.use("/js", express.static(path.join(ROOT, "js"), { index: false }));
  app.get("/", (req, res) => res.sendFile(path.join(ROOT, "index.html")));
  app.get("/:page.html", asyncRoute(async (req, res, next) => {
    if (!/^[a-z0-9-]+$/.test(req.params.page)) {
      return next();
    }
    const pagePath = path.join(ROOT, `${req.params.page}.html`);
    try {
      await fs.access(pagePath);
    } catch {
      return next();
    }
    if (req.params.page !== "login" && req.params.page !== "payment") {
      const token = readSessionCookie(req);
      if (!token || !/^[a-f0-9]{64}$/.test(token)) {
        return res.redirect("/login.html");
      }
      const session = await pool.query(
        `SELECT u.account_status FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = $1 AND s.expires_at > NOW()`,
        [hashToken(token)]
      );
      if (!session.rowCount) {
        clearSessionCookie(res);
        return res.redirect("/login.html");
      }
      if (session.rows[0].account_status !== "active") {
        return res.redirect("/payment.html");
      }
    }
    if (req.params.page === "payment") {
      const token = readSessionCookie(req);
      if (token && /^[a-f0-9]{64}$/.test(token)) {
        const session = await pool.query(
          `SELECT u.account_status FROM sessions s JOIN users u ON u.id = s.user_id
           WHERE s.token_hash = $1 AND s.expires_at > NOW()`,
          [hashToken(token)]
        );
        if (session.rowCount && session.rows[0].account_status === "active") {
          return res.redirect("/dashboard.html");
        }
      }
    }
    res.sendFile(pagePath);
  }));

  app.use((req, res) => {
    res.status(404).json({ error: "Page not found." });
  });
  app.use((error, req, res, next) => {
    console.error("Request failed:", error);
    if (res.headersSent) {
      return next(error);
    }
    if (error.type === "entity.parse.failed") {
      return res.status(400).json({ error: "Request body must contain valid JSON." });
    }
    if (error.type === "entity.too.large") {
      return res.status(413).json({ error: "Request body is too large." });
    }
    res.status(500).json({ error: "An unexpected server error occurred." });
  });

  return app;
}

function userResponse(user) {
  return {
    id: Number(user.id),
    username: user.username,
    email: user.email,
    phone: user.phone || "",
    referralCode: user.referral_code,
    accountStatus: user.account_status || "active"
  };
}

function transactionResponse(transaction) {
  return {
    kind: transaction.kind,
    amount: Number(transaction.amount_ugx),
    method: transaction.method,
    status: transaction.status,
    reference: transaction.reference,
    createdAt: transaction.created_at
  };
}

function requestReference(prefix) {
  return `${prefix}-${randomBytes(6).toString("hex").toUpperCase()}`;
}

async function initializeDatabase(pool) {
  const schema = await fs.readFile(path.join(ROOT, "db", "schema.sql"), "utf8");
  await pool.query(schema);
}

async function finalizeVerifiedInitialDeposit(pool, { reference, providerReference }) {
  if (typeof reference !== "string" || !reference ||
      typeof providerReference !== "string" || !providerReference) {
    throw new Error("A payment reference and verified provider reference are required.");
  }

  return withTransaction(pool, async client => {
    const result = await client.query(
      `SELECT id, user_id, amount_ugx, status, request_type, provider
       FROM money_requests WHERE reference = $1 FOR UPDATE`,
      [reference]
    );
    const request = result.rows[0];
    if (!request || request.request_type !== "initial_deposit" ||
        Number(request.amount_ugx) !== INITIAL_DEPOSIT_UGX) {
      throw new Error("No matching initial deposit request was found.");
    }
    if (request.status === "completed") {
      return { alreadyCompleted: true, userId: Number(request.user_id) };
    }
    if (request.status !== "pending" || request.provider !== "unconfigured") {
      throw new Error("The initial deposit request is not eligible for settlement.");
    }

    await client.query(
      `UPDATE money_requests
       SET status = 'completed', provider = $1, provider_reference = $2
       WHERE id = $3`,
      ["verified_provider", providerReference, request.id]
    );
    await client.query(
      "UPDATE wallets SET balance_ugx = balance_ugx + $1, updated_at = NOW() WHERE user_id = $2",
      [INITIAL_DEPOSIT_UGX, request.user_id]
    );
    await client.query(
      "UPDATE users SET account_status = 'active' WHERE id = $1 AND account_status = 'pending_payment'",
      [request.user_id]
    );
    return { alreadyCompleted: false, userId: Number(request.user_id) };
  });
}

async function finalizeDemoInitialDeposit(pool, { userId, sessionHash, nextSessionHash }) {
  return withTransaction(pool, async client => {
    const result = await client.query(
      `SELECT id, user_id, amount_ugx, status, request_type
       FROM money_requests
       WHERE user_id = $1 AND request_type = 'initial_deposit'
       ORDER BY id DESC LIMIT 1 FOR UPDATE`,
      [userId]
    );
    const request = result.rows[0];
    if (!request || Number(request.amount_ugx) !== INITIAL_DEPOSIT_UGX) {
      throw new Error("No matching initial deposit request was found.");
    }
    if (request.status !== "pending") {
      throw new Error("The initial deposit request is no longer pending.");
    }
    await client.query(
      `UPDATE money_requests SET status = 'completed', provider = 'demo', provider_reference = $1
       WHERE id = $2`,
      [`demo-${request.reference}`, request.id]
    );
    await client.query(
      "UPDATE wallets SET balance_ugx = balance_ugx + $1, updated_at = NOW() WHERE user_id = $2",
      [INITIAL_DEPOSIT_UGX, userId]
    );
    await client.query(
      "UPDATE users SET account_status = 'active' WHERE id = $1 AND account_status = 'pending_payment'",
      [userId]
    );
    await client.query(
      "DELETE FROM sessions WHERE user_id = $1 AND token_hash = $2",
      [userId, sessionHash]
    );
    await client.query(
      "INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, $3)",
      [userId, nextSessionHash, new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000)]
    );
    const user = await client.query(
      "SELECT id, username, email, phone, referral_code, account_status FROM users WHERE id = $1",
      [userId]
    );
    return { alreadyCompleted: false, user: user.rows[0] };
  });
}

async function start() {
  let pool;
  if (process.env.DATABASE_URL) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : undefined
    });
  } else if (process.env.NODE_ENV !== "production") {
    const { newDb } = require("pg-mem");
    const database = newDb();
    const { Pool: MemoryPool } = database.adapters.createPg();
    pool = new MemoryPool();
    console.warn("DATABASE_URL is not set; using a temporary in-memory database for local preview.");
  } else {
    throw new Error("DATABASE_URL is required in production.");
  }
  await initializeDatabase(pool);
  const demoPaymentsEnabled = process.env.NODE_ENV !== "production" &&
    (process.env.DEMO_PAYMENTS_ENABLED === "true" ||
      (!process.env.DATABASE_URL && process.env.DEMO_PAYMENTS_ENABLED !== "false"));
  if (demoPaymentsEnabled) {
    console.warn("Demo payments are enabled; simulated payments credit demo funds only.");
  }
  const app = createApp({ pool, demoPaymentsEnabled });
  const port = Number(process.env.PORT || 3000);
  const server = app.listen(port, () => console.log(`Zentrix listening on port ${port}`));
  const shutdown = async () => {
    server.close(async () => {
      await pool.end();
      process.exit(0);
    });
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  return { app, pool, server };
}

if (require.main === module) {
  start().catch(error => {
    console.error("Server startup failed:", error);
    process.exitCode = 1;
  });
}

module.exports = { createApp, finalizeDemoInitialDeposit, finalizeVerifiedInitialDeposit, initializeDatabase };
