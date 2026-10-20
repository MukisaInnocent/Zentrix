const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { newDb } = require("pg-mem");
const { createApp, finalizeVerifiedInitialDeposit, initializeDatabase } = require("../server");

let pool;
let server;
let baseUrl;

before(async () => {
  process.env.NODE_ENV = "test";
  const database = newDb();
  const { Pool: MemoryPool } = database.adapters.createPg();
  pool = new MemoryPool();
  await initializeDatabase(pool);
  server = createApp({ pool, demoPaymentsEnabled: true }).listen(0);
  await new Promise(resolve => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  await pool.end();
});

async function request(path, options = {}) {
  return fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) }
  });
}

function sessionCookie(response) {
  return response.headers.get("set-cookie").split(";")[0];
}

test("health check requires a working database", async () => {
  const response = await request("/api/health");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "ok" });
});

test("registration, authenticated account flows, and session revocation work", async () => {
  const registration = await request("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({
      username: "test_member",
      email: "member@example.com",
      phone: "+256700000000",
      password: "correct-horse-42"
    })
  });
  assert.equal(registration.status, 202);
  const pendingCookie = sessionCookie(registration);
  const registrationResult = await registration.json();
  const user = registrationResult.user;
  assert.equal(user.username, "test_member");
  assert.equal(user.email, "member@example.com");
  assert.equal(user.accountStatus, "pending_payment");
  assert.equal(registrationResult.initialDeposit.amount, 20000);
  assert.equal(registrationResult.initialDeposit.status, "pending");
  assert.equal(registrationResult.initialDeposit.paymentStatus, "not_configured");
  assert.match(registrationResult.message, /no money has been taken/);

  const pendingLogin = await request("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ identifier: "test_member", password: "correct-horse-42" })
  });
  assert.equal(pendingLogin.status, 403);
  assert.equal((await pendingLogin.json()).accountStatus, "pending_payment");

  const pendingPage = await request("/dashboard.html", {
    headers: { Cookie: pendingCookie },
    redirect: "manual"
  });
  assert.equal(pendingPage.status, 302);
  assert.equal(pendingPage.headers.get("location"), "/payment.html");
  const paymentPage = await request("/payment.html", { headers: { Cookie: pendingCookie } });
  assert.equal(paymentPage.status, 200);

  const paymentStatus = await request("/api/payment/initial-deposit", {
    headers: { Cookie: pendingCookie }
  });
  assert.deepEqual(await paymentStatus.json(), {
    amount: 20000,
    reference: registrationResult.initialDeposit.reference,
    status: "pending",
    accountStatus: "pending_payment",
    demoEnabled: true
  });

  const walletBeforePayment = await pool.query("SELECT balance_ugx FROM wallets WHERE user_id = $1", [user.id]);
  assert.equal(Number(walletBeforePayment.rows[0].balance_ugx), 0);

  const demoPayment = await request("/api/demo/initial-deposit/complete", {
    method: "POST",
    headers: { Cookie: pendingCookie },
    body: "{}"
  });
  assert.equal(demoPayment.status, 200);
  assert.match((await demoPayment.json()).message, /demo funds/);
  const cookie = sessionCookie(demoPayment);
  assert.notEqual(cookie, pendingCookie);
  assert.equal(Number((await pool.query("SELECT balance_ugx FROM wallets WHERE user_id = $1", [user.id])).rows[0].balance_ugx), 20000);
  const repeatDemoPayment = await request("/api/demo/initial-deposit/complete", {
    method: "POST",
    headers: { Cookie: pendingCookie },
    body: "{}"
  });
  assert.equal(repeatDemoPayment.status, 401);

  const activatedLogin = await request("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ identifier: "test_member", password: "correct-horse-42" })
  });
  assert.equal(activatedLogin.status, 200);
  const activeCookie = sessionCookie(activatedLogin);

  const protectedPage = await request("/dashboard.html", { headers: { Cookie: activeCookie } });
  assert.equal(protectedPage.status, 200);
  assert.match(await protectedPage.text(), /data-money="availableBalance"/);

  const profile = await request("/api/account/profile", { headers: { Cookie: activeCookie } });
  assert.equal(profile.status, 200);
  assert.equal((await profile.json()).user.phone, "+256700000000");

  const changedProfile = await request("/api/account/profile", {
    method: "PATCH",
    headers: { Cookie: activeCookie },
    body: JSON.stringify({ phone: "+256711111111", currentPassword: "wrong", newPassword: "new-password-42" })
  });
  assert.equal(changedProfile.status, 403);

  const secondLogin = await request("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ identifier: "test_member", password: "correct-horse-42" })
  });
  const secondCookie = sessionCookie(secondLogin);
  const passwordUpdate = await request("/api/account/profile", {
    method: "PATCH",
    headers: { Cookie: activeCookie },
    body: JSON.stringify({
      phone: "+256711111111",
      currentPassword: "correct-horse-42",
      newPassword: "new-password-42"
    })
  });
  assert.equal(passwordUpdate.status, 200);
  assert.equal((await passwordUpdate.json()).user.phone, "+256711111111");
  const revokedSession = await request("/api/account/summary", { headers: { Cookie: secondCookie } });
  assert.equal(revokedSession.status, 401);

  const deposit = await request("/api/wallet/deposits", {
    method: "POST",
    headers: { Cookie: activeCookie },
    body: JSON.stringify({ amount: 10000, method: "mobile_money", destination: "+256700000000" })
  });
  assert.equal(deposit.status, 201);
  const depositResult = await deposit.json();
  assert.equal(depositResult.transaction.status, "pending");
  assert.match(depositResult.message, /No payment was sent/);

  const beforeFunds = await request("/api/account/summary", { headers: { Cookie: activeCookie } });
  assert.equal((await beforeFunds.json()).availableBalance, 20000);

  const shortWithdrawal = await request("/api/wallet/withdrawals", {
    method: "POST",
    headers: { Cookie: activeCookie },
    body: JSON.stringify({ amount: 4999, method: "mobile_money", destination: "+256700000000" })
  });
  assert.equal(shortWithdrawal.status, 400);

  const withdrawal = await request("/api/wallet/withdrawals", {
    method: "POST",
    headers: { Cookie: activeCookie },
    body: JSON.stringify({ amount: 6000, method: "mobile_money", destination: "+256700000000" })
  });
  assert.equal(withdrawal.status, 201);
  assert.equal((await withdrawal.json()).transaction.status, "pending");

  const overdraw = await request("/api/wallet/withdrawals", {
    method: "POST",
    headers: { Cookie: activeCookie },
    body: JSON.stringify({ amount: 15000, method: "mobile_money", destination: "+256700000000" })
  });
  assert.equal(overdraw.status, 409);

  const summaryResponse = await request("/api/account/summary", { headers: { Cookie: activeCookie } });
  const summary = await summaryResponse.json();
  assert.equal(summary.availableBalance, 14000);
  assert.equal(summary.reservedBalance, 6000);
  assert.equal(summary.totalDeposited, 20000);
  assert.equal(summary.recentTransactions.length, 3);

  const logout = await request("/api/auth/logout", {
    method: "POST",
    headers: { Cookie: activeCookie },
    body: "{}"
  });
  assert.equal(logout.status, 200);
  const afterLogout = await request("/api/account/summary", { headers: { Cookie: activeCookie } });
  assert.equal(afterLogout.status, 401);
});

test("registration validates input and login uses the stored password hash", async () => {
  const invalid = await request("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ username: "x", email: "bad", password: "tiny" })
  });
  assert.equal(invalid.status, 400);

  const duplicate = await request("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({
      username: "test_member",
      email: "member@example.com",
      phone: "+256700000000",
      password: "correct-horse-42"
    })
  });
  assert.equal(duplicate.status, 409);

  const login = await request("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ identifier: "member@example.com", password: "new-password-42" })
  });
  assert.equal(login.status, 200);
  assert.ok(sessionCookie(login).startsWith("zentrix_session="));

  const invalidLogin = await request("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ identifier: "member@example.com", password: "correct-horse-42" })
  });
  assert.equal(invalidLogin.status, 401);

  const missingBody = await request("/api/auth/login", { method: "POST" });
  assert.equal(missingBody.status, 400);
});

test("demo payment cannot be completed when demo payments are disabled", async () => {
  const registration = await request("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({
      username: "locked_member",
      email: "locked@example.com",
      phone: "+256722222222",
      password: "correct-horse-42"
    })
  });
  assert.equal(registration.status, 202);
  const cookie = sessionCookie(registration);
  const user = (await registration.json()).user;
  const previousEnvironment = process.env.NODE_ENV;
  let disabledServer;
  try {
    process.env.NODE_ENV = "production";
    disabledServer = createApp({ pool, demoPaymentsEnabled: true }).listen(0);
  } finally {
    process.env.NODE_ENV = previousEnvironment;
  }
  await new Promise(resolve => disabledServer.once("listening", resolve));
  try {
    const base = `http://127.0.0.1:${disabledServer.address().port}`;
    const status = await fetch(`${base}/api/payment/initial-deposit`, {
      headers: { Cookie: cookie }
    });
    assert.equal((await status.json()).demoEnabled, false);
    const completion = await fetch(`${base}/api/demo/initial-deposit/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: "{}"
    });
    assert.equal(completion.status, 404);
    const wallet = await pool.query("SELECT balance_ugx FROM wallets WHERE user_id = $1", [user.id]);
    assert.equal(Number(wallet.rows[0].balance_ugx), 0);
  } finally {
    await new Promise((resolve, reject) => disabledServer.close(error => error ? reject(error) : resolve()));
  }
});

test("verified provider settlement credits and activates the initial deposit only once", async () => {
  const registration = await request("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({
      username: "provider_member",
      email: "provider@example.com",
      phone: "+256733333333",
      password: "correct-horse-42"
    })
  });
  const result = await registration.json();
  const first = await finalizeVerifiedInitialDeposit(pool, {
    reference: result.initialDeposit.reference,
    providerReference: "verified-provider-ref-1"
  });
  const second = await finalizeVerifiedInitialDeposit(pool, {
    reference: result.initialDeposit.reference,
    providerReference: "verified-provider-ref-1"
  });
  assert.equal(first.alreadyCompleted, false);
  assert.equal(second.alreadyCompleted, true);
  const user = await pool.query("SELECT account_status FROM users WHERE id = $1", [result.user.id]);
  const wallet = await pool.query("SELECT balance_ugx FROM wallets WHERE user_id = $1", [result.user.id]);
  assert.equal(user.rows[0].account_status, "active");
  assert.equal(Number(wallet.rows[0].balance_ugx), 20000);
});
