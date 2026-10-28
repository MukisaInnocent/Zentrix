# Pexerearn delivery plan

| | |
|---|---|
| Status | **Owner answered on 2026-10-21; treated as approval with the changes in section 12. Phase 1 in progress.** |
| Date | Drafted and updated 2026-10-21 |
| Next step | Phase 1. The owner still needs to choose a single-level referral reward (section 12). |

This plan explains how the Pexerearn master prompt (sections 0 to 17) will be delivered. The master prompt is the requirement. Where this plan and the master prompt disagree, the master prompt wins, and its section 3 rules always win. Questions the owner leaves unanswered use the defaults in section 10 and are marked `TODO(owner)` in code and settings.

The plan was written before any application code. The owner's answers of 2026-10-21, and how they change this plan, are recorded in section 12.

## Contents

1. Repository and machine today
2. The reference screenshots
3. Key decisions
4. Architecture
5. Ledger design
6. Target file tree
7. Phases and acceptance criteria
8. Testing strategy
9. Risks
10. Owner decisions needed
11. How the work is run and reported
12. Owner decisions log

---

## 1. Repository and machine today

**Repository** (branch `main`, remote `github.com/MukisaInnocent/Pexerearn`):

- The static demo sits at the repository root, not in a `zentrix-site/` folder. It has 25 HTML pages (24 committed, plus the uncommitted `payment.html`), `css/style.css`, `css/landing.css`, `js/app.js` (drawer navigation, inline SVG icons) and `js/landing.js`.
- An uncommitted backend prototype exists: `server.js`, `db/schema.sql`, `js/backend.js`, `payment.html`, `scripts/migrate.js`, `test/server.test.js`, `render.yaml` and `.env.example`. It changes balances with direct `UPDATE` statements, has no ledger, and its tests run on `pg-mem`. It will be replaced, not extended. Phase 1 first commits it unchanged so it stays in history.
- The Android SMS forwarder (`sms-forwarder/`) was deleted in commit `6a0a279` ("sms app deleted."). Its contract, read from commit `237980b`, matches the master prompt:
  - `POST` with JSON `{type, id, sender, body, receivedAt, device}`.
  - `X-Timestamp` is the send time in milliseconds. `X-Signature` is the hex HMAC-SHA256 of `timestamp + "." + rawBody`.
  - `id` is the first 32 hex characters of SHA-256 of `sender|receivedAt|body`, so one SMS always has the same `id`.
  - Every retry is signed again with a fresh timestamp. A 2xx reply ends delivery. A 4xx reply stops retries. A 5xx reply or no connection retries with backoff, up to 20 times.
  - `type: "test"` is a connectivity ping. The phone forwards only allow-listed sender names.
- Demo pages that break section 3: `spin.html` (cash-prize wheel), `bets.html` (Fixed Bets) and the multi-level "Commissions" tab in `team.html`. Pages outside the spec: `movies.html`, `articles.html`, `whatsapp.html` and `followers.html` (see question Q12).

**This machine** (checked 2026-10-21):

| Item | Finding | Consequence |
|---|---|---|
| Tools | Windows 11, Git, nvm-windows. No Docker, no PostgreSQL, no Visual Studio C++ build tools. | Local Postgres comes from npm (next rows). Docker files are exercised in CI. |
| Node | 20.20.2, which reached end of life on 2026-04-30. | Code stays Node 20 compatible. Docker, CI and Render use Node 24 LTS. Upgrading locally is one command: `nvm install 24`. |
| Real Postgres without Docker | `embedded-postgres@17.10.0-beta.17` started PostgreSQL 17.10 from npm, without admin rights. | Used for local development and all database tests. |
| Ledger spike | A deferred trigger rejected an unbalanced transaction at commit. A CHECK blocked an overdraft. A trigger blocked UPDATE on ledger rows. 20 concurrent withdrawals against a balance worth 4 produced exactly 4 successes and a zero ledger sum, using SERIALIZABLE, FOR UPDATE and retries. | The core ledger design works on this machine. |
| Password hashing | The `argon2` npm package crashes Node 20 here (segmentation fault on load). Its Windows binary is labelled for glibc, and a source build needs C++ tools. `@node-rs/argon2` hashed and verified argon2id correctly. | Use `@node-rs/argon2` (decision D3). |

---

## 2. The reference screenshots

The screenshots show another earning platform. Section 1 of the master prompt allows its look to inspire ours ("similar in spirit") but forbids copying its logo, text or assets. Pexerearn gets its own name, logo, copy and illustrations.

**Adopted as visual patterns**

| Pattern in the screenshots | How it appears in Pexerearn |
|---|---|
| Dark teal headers and cards on a light grey page | Our own teal palette (around `#0E5C63`) on `#F4F7F9`, plus a dark theme |
| Pastel stat cards with a white round icon badge and a round "notch" action button in the corner | Available balance, total earned, total withdrawn, pending withdrawals and referral rewards cards |
| Task earnings list with colored round icons and teal amount pills | Per-module earnings on the dashboard |
| Top bar with menu button, country indicator, theme toggle and notification bell with an unread dot | Same functions. The country shows as a code and currency pill, because the UI must not use emoji flags. |
| Slide-in drawer with expandable groups, the open group shown as a filled teal pill | Drawer navigation, plus a bottom quick-navigation bar on phones (decision D27) |
| Info card with a teal header and icon rows, and a weekly task timetable | Profile "About me" card and the per-country timetable |
| Withdraw form with a currency prefix on the amount, a fee box before submit, and a "confirm your payout number" notice | Withdraw page. The fee comes from the server and the phone number is read-only. |
| Deposit instructions per mobile-money operator | Deposit page built from the admin-configured payment methods |
| Floating back-to-top button | Same |
| A separate balance per task module, each with its own withdrawal | Adopted at the owner's request (section 12). The CWF balance stays out. |

**Seen in the screenshots but not built**

| Item | Reason |
|---|---|
| Level 1, 2 and 3 downlines, "Team Earnings" | Rule 3.2: single-level referral only. The Team page lists direct referrals. |
| "Referral Contest" and the "you brought in N downlines today, reach the Top 5 for a weekly bonus" banner | Rule 3.3: no rewards ranked by recruiting |
| Spins, Trixcoin, Request Loan | Rule 3.4: no gambling, coin or investment products, or lending |
| Chat With Foreigners "CWF" earnings | Out of scope (rule 3.4). The chat itself is built to the owner's spec of 2026-10-26 (section 12) |
| A "Profits" figure and "grow your income effortlessly" copy | Rule 3.5: no income claims |
| "Activate User" (paying another member's fee from your balance) | Not in the spec. Vouchers already let a member pay for someone else's membership. |
| Claim Cashback, Welcome Bonus, TikTok Pay | Not in the spec. A cashback or welcome bonus could later run as a pre-budgeted promotion under rule 3.1(c). |

---

## 3. Key decisions

These are defaults. Any of them can change before or during Phase 1.

| # | Decision | Reason |
|---|---|---|
| D1 | The server is written in strict TypeScript, compiled with `tsc`, and run with `tsx` in development and tests. | The spec prefers TypeScript, and types catch mistakes in money code. Plain JavaScript is possible if you prefer it (Q10). |
| D2 | Express 5, Zod, `pg` with a small typed query helper, and `node-pg-migrate` with plain SQL migration files. | Triggers and constraints are SQL. No ORM hides transactions. |
| D3 | `@node-rs/argon2` for argon2id password hashing (memory 19 MiB, 2 iterations, parallelism 1). | Same algorithm as `argon2`, which crashes on this machine. |
| D4 | Real PostgreSQL 17 everywhere: `embedded-postgres` for local development and tests, `docker-compose` where Docker exists, and a Postgres service container in CI. `pg-mem` is removed. | `pg-mem` lacks triggers, deferred constraints and serializable isolation, which the money tests depend on. |
| D5 | One root `package.json` and one lockfile. `/server` and `/web` are folders, not separate packages. | One install, one audit and a simple Dockerfile. |
| D6 | One service serves `/api` and the static `/web` files from the same origin. A separate worker process runs scheduled jobs under Postgres advisory locks. | Same-origin cookies, CSRF and a strict Content-Security-Policy stay simple. The web process stays stateless. |
| D7 | Each member has a main balance plus one earnings balance per task module (YouTube, TikTok, ads, trivia, Fix Tap, music), all in their country's currency, and one withdrawal-hold account. Each balance can be withdrawn with its own limits. | Owner decision of 2026-10-21 (Q11). It matches "per-balance limits" in section 6 of the master prompt. |
| D8 | The membership fee is paid from the main balance after a deposit, by an explicit "Activate membership" action that issues a receipt. | Nothing is credited or charged on browser input alone, and the member sees exactly what they pay. |
| D9 | APIs return money as `{ "amountMinor": "19000", "currency": "UGX" }` with the amount as a string. Clients send decimal strings, and the server converts them using the currency exponent. | No floating-point money anywhere. The browser only formats server values with `Intl.NumberFormat`. |
| D10 | Ledger protection in depth: a deferred per-currency balance trigger, immutability triggers on UPDATE, DELETE and TRUNCATE, cached balances maintained only by a SECURITY DEFINER trigger, and an application database role with no UPDATE right on balance columns or ledger tables. | A bug in application code cannot move money. If the host refuses a second database role, the triggers still enforce the rules (risk R9). |
| D11 | Money operations run in SERIALIZABLE transactions, lock accounts with `FOR UPDATE` in ascending id order, and retry on serialization failures and deadlocks. The idempotency key and stored response are written in the same transaction as the money change. | Proven in the spike. A replay returns the original response, and a crash cannot leave a half-recorded result. |
| D12 | Sessions use a random token in a `__Host-` cookie (HttpOnly, Secure, SameSite=Lax), stored hashed in the database, rotated at login and step-up, and revocable. A CSRF token bound to the session travels in a header, and the Origin header is checked. | Section 11. JWTs are rejected because they are hard to revoke. |
| D13 | TOTP uses a maintained library. TOTP secrets are encrypted at rest with AES-256-GCM using a key from the environment. | Rule 3.8 forbids plaintext secrets in the database. |
| D14 | Rate limits and login lockouts are stored in Postgres. | Keeps the web process stateless without adding Redis. |
| D15 | The frontend has no build step: ES modules, CSS custom properties, CSS logical properties for right-to-left support, and strings in `web/locales/en.json`. The CSP allows no inline scripts or styles, so the demo's inline `style=` attributes move into CSS. | Sections 4, 5 and 5b. |
| D16 | FX rates are stored as NUMERIC. Conversions use BigInt arithmetic and round down on the leg paid to the member. Quotes are locked for 60 seconds. | No floats, and FX is an explicit two-leg transaction. |
| D17 | Uploads (task proofs, KYC files, ebooks) go through a storage interface: local disk in development, small files in Postgres for Render test deployments, and S3 later. | Render's local disk is wiped on every deploy. |
| D18 | In test mode without SMTP, outgoing email and SMS (verification codes, notices) land in a dev outbox shown in the admin panel. `docker-compose` uses Mailpit. | Every flow can be tested on this machine without Docker. |
| D19 | Each database is stamped `test` or `live` when it is created. A live server refuses a test database, and seed scripts refuse to run in live mode. | Fake balances can never be promoted to live. |
| D20 | Live mode refuses to start until every GO_LIVE_CHECKLIST item is signed off. The owner removed legal sign-off, so the items are operational: real provider keys, verified backups, a completed security review, published Terms, Privacy, Risk and Refund pages, a loaded sanctions list and configured KYC rules. Admins sign off through a command-line tool that requires their password and TOTP code. | "Refuses to start" means the admin UI is not available in live mode before sign-off. |
| D21 | The referral cap is a database CHECK: reward <= MAX_REFERRAL_PCT x membership fee, per currency, with MAX_REFERRAL_PCT limited to at most 10%. | Section 8. Raising the ceiling would need a migration and your explicit decision. |
| D22 | No SMS forwarding. Deposits and withdrawals are manual for now (owner, 2026-10-24): members send money to a business channel and claim it with the transaction ID, staff confirm against the channel statement; staff send payouts by hand and record the payout transaction ID. A payment-provider API can replace this later behind the same deposit and withdrawal records. | Owner decisions of 2026-10-21 and 2026-10-24. The forwarder contract remains in commit `237980b` if it is ever needed. |
| D23 | `render.yaml` stays at the repository root, where Render looks for it by default. All other infrastructure files live in `/infra`. | Avoids a manual setting in Render. |
| D24 | Work happens on one branch per phase with local commits. Nothing is pushed until you ask. | `main` may auto-deploy on Render. |
| D25 | The sanctioned and restricted country blocklist is enforced in both modes. In live mode an admin switches countries on, and the change is audited. | The owner removed the legal-review gate (section 12). The blocking path still gets tested. |
| D26 | Task types that pay for likes, follows, subscribes or views on third-party platforms sit behind a per-country switch. It is on in test mode and off by default in live mode. | Those platforms ban paid engagement (risk R2). You decide at go-live (Q13). |
| D27 | Navigation on phones is the left slide-in drawer from the demo and screenshots, plus a bottom bar for the main destinations with a "Menu" button that opens the drawer. | My reading of "bottom-aligned mobile drawer navigation". |
| D28 | Seed and test phone numbers use obvious placeholder patterns, and nothing is ever sent to them because test mode only simulates SMS and payouts. | Item 8 of "How to operate" in the master prompt. |

---

## 4. Architecture

### Components

```
Browser: vanilla HTML/CSS/JS (untrusted)
   |  HTTPS, same origin, session cookie + CSRF header
   v
API service: Node 24, Express 5, TypeScript ---- also serves /web as static files
   ^
   +-- POST /api/payments/webhooks/:provider  (signed by the provider; simulator in test mode)
   |
   v
PostgreSQL 17  <---  Worker process (scheduled jobs, one runner per job via advisory locks)

Interfaces with a test-mode simulator behind each:
payments (collect, payout, verifyWebhook, getStatus), mail, outbound SMS (OTP),
storage, FX rate source, GeoIP, sanctions screening
```

### Trust boundaries

| Boundary | Treatment |
|---|---|
| Browser | Untrusted. Every input is validated with Zod. No balance is ever credited from browser input. |
| Payment providers | Each webhook is verified by the provider adapter (signature, replay window, event-id dedupe) and checked against the pending request. Large credits and all payout results are confirmed by a status lookup. |
| Staff users | Trusted but limited by role, TOTP, a full audit log and maker-checker on money actions. |
| Database | Enforces money invariants on its own (triggers, CHECKs, privileges), whatever the application code does. |

### Modes

| | `test` (default now) | `live` |
|---|---|---|
| Countries | All selectable, except the sanctions blocklist (D25) | Countries an admin has switched on (D25) |
| Payments | A simulated mobile-money provider for collections and payouts, behind the production interface | Real providers. Real keys are loaded only in this mode. |
| Banner | "TEST MODE: no real money" on every page | None |
| Seed data | Fake members, advertisers, campaigns and simulated payments | Seed scripts refuse to run |
| Start-up checks | Refuses to start if live provider keys are present | Refuses to start unless GO_LIVE_CHECKLIST is signed off, the database is stamped `live`, and `NODE_ENV=production` |
| Section 3 rules | Apply | Apply |

### Scheduled jobs (worker)

| Job | Default schedule | Purpose |
|---|---|---|
| Reconciliation | Nightly at 02:00 UTC, and on demand | Recompute balances from entries and compare with cached balances, compare ledger cash with provider and statement balances, check solvency per currency, write a report, alert admins, pause withdrawals on failure |
| Solvency check | Every 5 minutes | Fast per-currency check on cached balances, pausing withdrawals on failure |
| Referral release | Hourly | Pay referral rewards whose hold period has ended, if every check passes |
| Payouts | Every minute | Send approved withdrawals to the provider and re-check those in processing |
| FX refresh | Hourly | Refresh rates (simulated source in test mode) |
| Expiries | Every 15 minutes | Expire deposit intents, FX quotes, abandoned task starts and vouchers (refunding the buyer) |
| Cleanup | Daily | Remove expired sessions, old idempotency keys and rate-limit rows |
| Secret rotation reminder | Daily | Alert admins when a webhook signing secret is older than the rotation period |

### API surface (overview)

| Area | Main endpoints |
|---|---|
| Health | `GET /healthz`, `GET /readyz` |
| Auth | register, login, logout, email and phone verification, forgot and reset password, TOTP enrol and verify, session list and revoke, `GET /api/me` |
| Reference | countries, currencies, public per-country configuration, payment methods |
| Wallet | summary, statement, per-module earnings |
| Deposits | create intent, claim by transaction ID, list |
| Payments in | `POST /api/payments/webhooks/:provider` |
| Membership | status, purchase, receipt |
| Tasks | catalogue, start, submit, timetable, leaderboard |
| Withdrawals | quote (fee and limits), request, list, cancel |
| Team, vouchers, transfers | direct referrals, buy, redeem, list, Pay For Client |
| Advertisers | top up, campaigns, spend report |
| Learning, messages, notifications | courses, progress, announcements, inbox, threads, abuse reports, tickets |
| Admin | members, queues, approvals, ledger explorer, reconciliation, settings, fraud flags, audit log, financial summary |

Every money-moving `POST` requires an `Idempotency-Key` header.

---

## 5. Ledger design

**Tables.** `accounts` holds one row per account, with a currency, a normal side and a cached balance. `ledger_transactions` holds one row per business event, with its kind, metadata and actor. `ledger_entries` holds the debit and credit lines, each a positive BIGINT amount in minor units.

**Account kinds.** System accounts exist once per currency.

| Kind | Owner | Normal side | May go negative |
|---|---|---|---|
| `member_main` (main balance) | member | credit | no |
| `member_task` (one per task module) | member | credit | no |
| `member_withdrawal_hold` | member | credit | no |
| `advertiser_wallet` | advertiser | credit | no |
| `campaign_escrow` | campaign | credit | no |
| `voucher_liability` | system | credit | no |
| `suspense` (unmatched money) | system | credit | no |
| `payment_clearing` (cash held, one per payment rail) | system | debit | no |
| `platform_revenue` | system | credit | no |
| `fees` | system | credit | no |
| `referral_budget` | system | credit | no |
| `promotions_budget` | system | credit | no |
| `owner_capital` (money the owner puts in) | system | credit | no |
| `fx_clearing` (currency position) | system | credit | yes, the only one |

**Rules enforced by the database**

1. Every ledger transaction balances per currency (deferred constraint trigger, checked at commit).
2. Entries and transactions cannot be updated, deleted or truncated. Corrections are new reversing transactions.
3. An entry's currency must equal its account's currency.
4. Cached balances change only through the entry trigger. The non-negative CHECK applies to every account except `fx_clearing`.
5. A nightly job recomputes every balance from its entries and reports any drift.

**Money flows**

| Event | Debit | Credit |
|---|---|---|
| Deposit confirmed by the provider | `payment_clearing` | `member_main` |
| Deposit unmatched | `payment_clearing` | `suspense` |
| Suspense resolved by a claim or an admin | `suspense` | `member_main` |
| Membership fee | `member_main` | `platform_revenue` |
| Membership refund | `platform_revenue` | `member_main` |
| Advertiser top-up | `payment_clearing` | `advertiser_wallet` |
| Campaign funded | `advertiser_wallet` | `campaign_escrow` |
| Campaign remainder returned | `campaign_escrow` | `advertiser_wallet` |
| Task reward, same currency | `campaign_escrow` | the member's `member_task` balance for that module |
| Task reward, other currency (USD campaign, UGX member) | `campaign_escrow` (USD), `fx_clearing` (UGX) | `fx_clearing` (USD), `member_task` (UGX) |
| Referral budget funded | `platform_revenue` or `owner_capital` | `referral_budget` |
| Referral reward | `referral_budget` | referrer's `member_main` |
| Promotion grant | `promotions_budget` | `member_main` |
| Withdrawal requested (amount + fee) | the chosen `member_main` or `member_task` balance | `member_withdrawal_hold` |
| Withdrawal paid | `member_withdrawal_hold` | `payment_clearing` (amount), `fees` (fee) |
| Withdrawal failed or cancelled | `member_withdrawal_hold` | the balance it came from |
| Voucher bought | buyer's `member_main` | `voucher_liability` |
| Voucher redeemed | `voucher_liability` | redeemer's `member_main` |
| Voucher expired | `voucher_liability` | buyer's `member_main` |
| Pay For Client | payer's `member_main` | payee's `member_main`, `fees` |

**Solvency (rule 6), per currency.** The hard rule: all member balances (main and task modules) plus withdrawal holds must not exceed the funds actually held. Funds held come from the latest external balance of each payment rail: the provider API or an imported statement. When the hard rule fails, withdrawals in that currency pause automatically and admins get an alarm. A stricter check also counts advertiser money, escrow, suspense and unredeemed vouchers, and raises a high-severity alert when it fails.

**Concurrency.** See decision D11. Accounts are always locked in ascending id order, which prevents deadlocks between opposite transfers.

---

## 6. Target file tree

The tree after Phase 1. Modules fill in phase by phase.

```
/
  CLAUDE.md                   rules and decisions loaded in every session
  README.md                   quick start
  package.json, package-lock.json
  render.yaml                 Render blueprint (repository root, see D23)
  .env.example                every variable, documented, no secrets
  .github/workflows/ci.yml    lint, typecheck, migrate from scratch, tests, audit, image build
  docs/
    PLAN.md                   this file
    ARCHITECTURE.md  DATABASE.md  SECURITY.md  THREAT_MODEL.md
    API.md (plus openapi.json generated from the Zod schemas)
    DEPLOYMENT.md  RUNBOOK.md  TESTING.md  LEGAL_CHECKLIST.md
  infra/
    Dockerfile                multi-stage, non-root, Node 24
    docker-compose.yml        Postgres 17, Mailpit, API, worker
    aws/README.md             ECS Fargate or Elastic Beanstalk, RDS, ALB and ACM, S3, Secrets Manager, CloudWatch
    backup/                   backup and restore drill scripts
  server/
    tsconfig.json  vitest.config.ts
    migrations/               numbered plain-SQL migrations (up and down)
    seeds/                    test-mode fake data only
    scripts/                  dev runner (embedded Postgres), payment simulator CLI, go-live sign-off CLI, admin bootstrap
    src/
      main.ts  worker.ts  app.ts
      config/                 environment schema, APP_MODE, start-up gates
      db/                     pool, transaction helper with SERIALIZABLE retry, query helper
      http/                   auth, CSRF, rate limits, idempotency, validation, errors
      lib/                    money (BigInt minor units), crypto, ids, logger, i18n for emails
      providers/              payments, mail, sms-out, storage, fx-source, geoip, sanctions (each with a simulator)
      jobs/                   job definitions and schedules
      modules/
        auth/ users/ countries/ settings/ audit/
        ledger/               the only code that writes ledger rows
        wallet/ deposits/ payments/ (provider adapters, webhooks)
        membership/ fx/ advertisers/ campaigns/ tasks/
        withdrawals/ referrals/ vouchers/ transfers/ promotions/
        learning/ messaging/ compliance/ reconciliation/ admin/
    test/
      unit/ integration/ property/ e2e/
      helpers/                Postgres harness (a template database cloned per test file), factories
  web/
    *.html                    member pages (moved from the root)
    admin/*.html  advertiser/*.html
    css/                      tokens.css, base.css, layout.css, components.css, pages/
    js/
      app.js                  shell: drawer, top bar, banner, theme, auth guard
      core/                   api.js, i18n.js, money.js, dom.js, toast.js, forms.js, icons.js, svg-chart.js
      pages/                  one module per page
    locales/en.json
    img/                      Pexerearn logo and illustrations (SVG, our own)
```

---

## 7. Phases and acceptance criteria

Each phase ends only when its tests pass. Money phases (2, 3 and 4) are written test-first. Every money change gets a second review pass before it is committed, and an independent security review runs at the end of each of those phases. Each phase ends with a short report: what works, how to run it, what is untested, and the next step.

### Phase 1: Foundation

1. Commit the current working tree unchanged on branch `rebuild/phase-1-foundation` as a baseline, excluding `node_modules/` and `.vscode/`.
2. Restructure with `git mv`. The demo moves into `/web`. The prototype server, `db/`, `scripts/`, `test/` and `pg-mem` are removed, and remain in history. `/server`, `/docs` and `/infra` are created.
3. Tooling: TypeScript, ESLint (with browser rules for `/web/js`), Prettier, Vitest and tsx. Scripts: `dev`, `build`, `start`, `worker`, `migrate`, `seed`, `test`, `lint`, `typecheck`.
4. Database: a migration runner, and `npm run dev`, which starts embedded Postgres with a git-ignored data folder, migrates, seeds, and runs the API and worker. `infra/docker-compose.yml` starts everything with one command where Docker exists. The database mode stamp (D19). Separate owner and application database roles where the host allows it.
5. Configuration: a Zod-validated environment, `APP_MODE`, the test-mode refusal of live keys, and the live-mode gate with its sign-off tool (D20).
6. Reference data: ISO 4217 currencies with exponents, and ISO 3166 countries with their currency (plus the override list), dial code, default locale and time zone. A placeholder sanctions blocklist (`TODO(owner)`). Versioned per-country configuration with typed money columns and CHECKs.
7. Auth: registration with country search, phone input with dial code and libphonenumber validation, date of birth for the 18+ check, an optional referral code locked at sign-up, and versioned Terms and Privacy consent. Email verification, phone verification (code sent to the dev outbox in test mode), login with throttling, lockout and generic errors, logout, session rotation and revocation, forgot and reset password. Optional TOTP for members and mandatory TOTP for staff. Flags for IP-country and phone-country mismatches.
8. Roles (member, advertiser, support, reviewer, finance, compliance, admin) with permission and ownership checks on every record. An append-only audit log of every staff action: who, what, before and after, IP and time.
9. HTTP hardening: helmet with a strict CSP, CSRF, an Origin check, no CORS, rate limits per IP and per account, body size limits, strict Zod schemas on every endpoint, request IDs, pino logs with redaction, `/healthz`, `/readyz` and graceful shutdown.
10. Frontend shell in the new design: test-mode banner, top bar (currency pill, theme toggle, notification bell), drawer with expandable groups, bottom bar on phones, toasts, skeleton loaders, empty and error states, an i18n loader, and an API client that adds CSRF and idempotency headers and sends a 401 back to login with a return path. Pages wired in this phase: landing, login, register, forgot and reset password, verify, dashboard (profile data only), profile (phone read-only with "Contact admin to change your phone number"), Terms, Privacy, Risk, Refund, "What membership includes" and Contact. Admin shell: member search (read-only), audit log viewer, settings and country configuration.
11. The CI workflow file. It runs once the branch is pushed.
12. First versions of ARCHITECTURE, DATABASE, TESTING and DEPLOYMENT (local), and the commands section of CLAUDE.md.

**Tests.** Unit: configuration parsing, settings and country-config validation, phone validation, password policy, and TOTP against the RFC 6238 test vectors. Integration on real Postgres: migrations from scratch; register, verify, login and logout; lockout; session revocation; single-use reset tokens; CSRF and Origin rejection; role and ownership checks; staff TOTP enforcement; the append-only audit log; the live-mode start refusal; the test-mode refusal of live keys. Smoke: every page returns 200 with the CSP header, no inline scripts or styles, a title and a `main` landmark.

**Accepted when** lint, typecheck and all tests pass on real Postgres; `npm run dev` starts a working test-mode app with seed data; register, verify, login, dashboard and logout work at 360, 768 and 1280 px; and staff cannot reach admin APIs without TOTP.

### Phase 2: Ledger and wallet

1. Tables: `accounts`, `ledger_transactions`, `ledger_entries`, `idempotency_keys`, `payment_methods`, `deposits`, `payment_events`, `reconciliation_runs`, `reconciliation_findings`, `alerts` and `system_flags`. The `fraud_flags` table already arrives in Phase 1.
2. Triggers for the five ledger rules in section 5, plus append-only protection for `audit_log`.
3. The ledger service: the only module that writes ledger rows, through one `post()` function that handles lock order, retries and idempotency.
4. System accounts per currency, created when a currency is enabled.
5. Wallet API and pages: the main balance and every task-module balance, a filtered and paginated statement, and per-module earnings.
6. Deposits through the provider API: "Deposit now" (amount, paying phone number, method) sends a collection request that the member approves on their own phone, so their PIN never touches Pexerearn. The provider's signed webhook, or a status lookup, confirms the payment, and the credit happens in one transaction. "Claim deposit" by transaction ID covers payments made outside a request. States: pending, confirmed, failed, expired and unmatched.
7. Webhook receiver `POST /api/payments/webhooks/:provider`: signature verification per provider, a replay window, dedupe by provider event id, the raw payload stored but never logged, and checks of amount, currency and reference against the pending request before any credit. Unmatched payments are held in suspense.
8. Payment provider interface (`collect`, `payout`, `verifyWebhook`, `getStatus`) with a simulated mobile-money provider whose webhooks pass through the same verification path as real ones.
9. Test-mode payment simulator: an admin page and a CLI that approve or fail simulated collections, and send duplicate, tampered or unmatched webhooks.
10. Admin: unmatched payments queue, suspense resolution with maker-checker, a read-only ledger explorer, reconciliation reports and alerts.
11. The reconciliation job, the 5-minute solvency check and the automatic withdrawal pause.

**Tests, written first.** Double-entry balance. Immutability. Negative-balance prevention. Currency mismatch rejection. Idempotent replays returning the original response. Race tests with concurrent deposits and concurrent debits on one account. Webhook signature rejection, replays, duplicate events and amount mismatches. Unmatched and expired payments. A property test that runs random operation sequences and checks after each one that entries sum to zero per currency, cached balances equal recomputed ones, and solvency holds. An end-to-end deposit through the simulated provider.

**Accepted when** the race and balance tests pass (the master prompt's criterion), the property and end-to-end tests pass, and a freshly seeded database reconciles with zero findings.

### Phase 3: Membership and tasks

1. Membership: the fee per country from configuration, "Activate membership" from the wallet, a numbered receipt, refunds within the refund window by an admin with maker-checker, and gating of tasks and learning.
2. FX: a rates table (source, timestamp, spread), a simulated source, quotes locked for 60 seconds, and two-leg conversion through `fx_clearing`.
3. Advertisers (the "Meta ADS" and "Social Promotions" areas): advertiser accounts and wallets, top-up through the provider interface, campaigns (task type, reward, budget, dates, target countries, proof rules, daily caps), an approval queue, escrow funding with the remainder returned, and a spend report.
4. Tasks: YouTube, TikTok, ad clicking, trivia, Fix Tap micro-tasks and music streaming. Each type has proof rules and anti-abuse checks: server-side timers, trivia answers never sent to the browser, one submission per member per task per period, proof-file hashing to catch reuse, and velocity limits. A review queue for the reviewer role, and optional auto-approval with random audits.
5. Rewards: paid from escrow to the member wallet when a submission is verified, with an FX step when currencies differ. A campaign at zero budget stops paying and the UI says so.
6. A per-country timetable shown in the member's time zone, and a weekly leaderboard ranked by task activity only.

**Tests.** Escrow never goes negative. A submission pays at most once, even under concurrent approvals. Budget exhaustion. Daily caps. Trivia answers absent from every response. FX legs balance per currency, with deterministic rounding. Membership refund reversal.

**Accepted when** all tests pass and the security review findings are fixed or recorded.

### Phase 4: Withdrawals, referrals, vouchers and Pay For Client

1. Withdrawals from the main balance or any task-module balance: minimum, maximum, daily and monthly limits per country, currency, balance and KYC tier; a fee of 0.5% of the amount, previewed by the server; a hold on request; the state machine `requested -> approved -> processing -> paid | failed | cancelled`, enforced by trigger with a status history; approval rules for new accounts and large amounts with maker-checker; payouts only to the verified phone number; a 48-hour lock after an admin phone change; a payout worker using the provider interface, with re-checks; a status timeline in the UI; and the automatic pause when solvency fails.
2. Admin phone change, recording the identity verification and writing an audit entry.
3. Referrals, single level only: a reward record when the referred member's membership payment is confirmed, the hold period (default 7 days), the release worker, withholding on a fraud flag or refund, daily and monthly caps per referrer, payment from `referral_budget`, budget funding by an admin with maker-checker, and the Team page listing direct referrals only.
4. KYC tiers (document upload and review) linked to withdrawal limits.
5. Vouchers: buy, list, reveal and redeem. Codes are single-use and expiring, stored encrypted with an HMAC lookup key, and refunded to the buyer on expiry.
6. Pay For Client: wallet-to-wallet payment to a verified member, with a fee, limits and an FX quote when currencies differ.
7. Promotions: admin-defined promotions with a fixed budget, paid from `promotions_budget`.

**Tests.** Concurrent withdrawal races. Every allowed and forbidden state transition. Maker-checker. Limits and fees. The referral cap CHECK. Hold period, withholding and caps. A test proving that no reward path pays anyone beyond the direct referrer. A voucher double-redeem race. A transfer race.

**Accepted when** all tests pass and the security review findings are fixed or recorded.

### Phase 5: Learning, messaging and polish

1. Learning: Skills Development, Free E-books and Forex Classes (education only, with a risk notice), structured as courses with lessons and progress tracking. Placeholder content is clearly marked until you supply real material.
2. Notifications (in-app bell, plus email for key events), announcements by country, and an inbox.
3. "Chat Upline" as support-style messaging with the member's direct referrer and with support, with abuse reports, blocking and a moderation queue. Contact page and support tickets.
4. Data protection: the consent log, data export as JSON, account deletion by anonymisation that keeps the ledger intact, and retention jobs.
5. Polish: accessibility (keyboard, focus, ARIA, contrast), performance, i18n completeness and right-to-left checks, the manual checklist at 360, 768 and 1280 px, and automated smoke tests. Optional Playwright screenshots need a browser download of about 150 MB, so they run only with your OK.

### Phase 6: Hardening and deploy

1. A security review against the threat model, fixes, and residual risks recorded.
2. The full documentation set from section 14 of the master prompt.
3. Render: `render.yaml` with the web service, worker, managed Postgres, `/healthz` checks, `APP_MODE=test` and trusted-proxy settings. Deployment happens only when you ask, from your Render account.
4. AWS preparation: Dockerfile, ECS Fargate or Elastic Beanstalk notes, RDS Multi-AZ, an ALB with ACM certificates, the S3 storage driver, Secrets Manager, CloudWatch alarms and a private database subnet.
5. A backup and restore drill run against a local database, with timings recorded in RUNBOOK.md.
6. A written migration and rollback procedure, and an end-to-end test of the go-live gate.

---

## 8. Testing strategy

| Layer | Tool | Database | Covers |
|---|---|---|---|
| Unit | Vitest | none | Webhook signature checks, money helpers, validation, TOTP, fee and limit maths |
| Integration | Vitest and `pg` | Real Postgres 17: embedded locally, a service container in CI. Each test file gets a fresh database cloned from a migrated template. | Triggers, constraints, flows, races |
| Property | fast-check | Real Postgres | Random operation sequences against the ledger and solvency invariants |
| End-to-end API | Vitest and a real HTTP server | Real Postgres | The forwarder-contract deposit flow, auth flows |
| Frontend smoke | Vitest, HTTP and an HTML parser | Real Postgres | Pages, CSP, landmarks, no inline code |
| Manual | A checklist in TESTING.md | n/a | 360, 768 and 1280 px, keyboard, screen-reader basics |

CI runs lint, typecheck, migrations from scratch, all tests, `npm audit` and the Docker image build. Docker cannot run on this machine, so CI is where the image is proven.

---

## 9. Risks

| # | Risk | Impact | Mitigation |
|---|---|---|---|
| R1 | Regulation. Membership fees plus paid tasks plus referral rewards resemble schemes that regulators have warned about. Holding customer money may need a payment or e-money licence (in Uganda, under the National Payment Systems Act 2020, supervised by the Bank of Uganda). Data-protection registration and tax obligations also apply. | Live launch blocked, personal liability | The owner removed the legal sign-off gate (section 12), so the owner carries this risk. The design still excludes multi-level, gambling and lending features, and LEGAL_CHECKLIST.md stays as advice. |
| R2 | Platform terms. Paying people to like, follow, subscribe or view on YouTube, TikTok or Meta breaks those platforms' fake-engagement policies. | Banned advertiser and member accounts, reputational and legal exposure | Decision D26. Prefer task types that don't inflate metrics: watch-and-answer quizzes, surveys, app and website testing, and ads shown inside Pexerearn. |
| R3 | Forged or replayed payment webhooks | False credits | Signature checks, a replay window, event-id dedupe, amount and reference checks against the pending request, status lookups before large credits, and daily reconciliation against provider statements |
| R4 | Provider outages or late webhooks | Deposits and payouts stuck pending | Status polling, expiry, clear member messages and a runbook entry |
| R5 | No payment provider chosen yet (Q6) | The real integration cannot be built or tested | The provider interface and simulator now, and an adapter once you choose |
| R6 | FX treasury. Paying UGX rewards from USD escrow creates UGX liabilities without UGX cash. | Solvency alarm, paused withdrawals | Per-currency solvency, cross-currency rewards off by default in live, and admin-recorded treasury conversions |
| R7 | Multi-accounting to farm referral rewards and tasks | Losses | One account per verified phone and email, device and IP velocity checks, the hold period, caps, fraud flags, automatic freezes with review |
| R8 | No funded tasks in live without real advertisers | Members cannot earn | An honest "no funded tasks right now" state and no income claims. Seeded campaigns exist only in test mode. |
| R9 | A managed Postgres host may refuse a second database role | The privilege layer of D10 is lost | Triggers still block ledger edits and direct balance updates, and tests cover both set-ups |
| R10 | Node 20 on this machine is end-of-life | No security fixes locally | Node 20 compatible code, with Node 24 in Docker, CI and Render |
| R11 | `embedded-postgres` downloads about 100 MB of binaries, and its npm versions are tagged beta | Disk and tooling risk | Exact version pinned, development only, and CI uses the official Postgres image |
| R12 | Stored webhook payloads contain payers' names and numbers | Data-protection exposure | Finance role only, never logged, redacted after a retention period, encrypted backups |
| R13 | Large scope | Long timeline | Phase-by-phase delivery, each phase usable and tested on its own |
| R14 | Forex classes can be read as investment advice | Regulatory exposure | Education-only framing, risk notices, no signals or return claims, and a capital-markets check in LEGAL_CHECKLIST |
| R15 | Render free instances sleep, and Render disks are wiped on deploy | Missed webhooks, lost uploads | A paid instance before relying on webhooks, and the storage interface (D17) |
| R16 | Pressure for multi-level or oversized referral payouts | Pyramid-scheme economics: members paid from other members' fees | Declined under rules 3.1 and 3.2 (section 12). Single-level schema, and a database CHECK on the reward cap. |

---

## 10. Owner decisions needed

Section 17 of the master prompt, plus questions raised by the inspection. Each row shows the default used if you don't answer. Defaults appear in settings and code as `TODO(owner)`. Answers received on 2026-10-21 are in section 12 and override these defaults.

| # | Question | Default if unanswered |
|---|---|---|
| Q1 | Membership fee per country and currency, and exactly what it buys | Uganda: UGX 19,000. Other currencies get test-only placeholder fees. It buys task access, the learning library and support. |
| Q2 | The flat referral reward per currency, and its caps | UGX 1,000, which is 5.3% of the fee (the 10% ceiling is UGX 1,900). At most 5 rewards per referrer per day and 30 per month. 7-day hold. |
| Q3 | Who funds task budgets, and the expected task rates | Test mode: seeded fake advertisers. Placeholder rates: video watch UGX 50, ad view UGX 30, trivia UGX 20 per correct answer, Fix Tap task UGX 100, music stream UGX 20. |
| Q4 | The exact MTN and Airtel sender names, and 2 to 3 confirmation SMS from each with personal details removed | Synthetic formats. Sender names stay `TODO(owner)`. |
| Q5 | Withdrawal limits and fees per country and currency | UGX: minimum 5,000; maximum 1,000,000 per request; 2,000,000 per day; 10,000,000 per month; flat fee UGX 1,000. Admin approval for accounts younger than 14 days or amounts of UGX 200,000 and above. |
| Q6 | Which payment provider replaces SMS matching later | Interface plus simulator only. Candidates: Flutterwave, Pesapal, MTN MoMo API, Airtel Money API. |
| Q7 | Legal sign-off, launch countries, sanctions list and launch currencies | Not needed for testing. Tracked in LEGAL_CHECKLIST.md and the go-live gate. |
| Q8 | FX rate source and spread, and the reporting currency | Test mode: seeded rates refreshed by a simulator, a 2% spread, reports consolidated in USD |
| Q9 | Restore the Android forwarder into `/android-forwarder`? | No (D22) |
| Q10 | TypeScript for the server? | Yes (D1) |
| Q11 | One wallet, or a separate balance per task module as in the screenshots? | One wallet (D7) |
| Q12 | What happens to the demo pages outside the spec? | Movies removed. Articles become Learning content. WhatsApp sharing and Claim Followers become advertiser campaign types behind the engagement switch (D26). Spin & Win and Fixed Bets removed (rule 3.4). |
| Q13 | Engagement task types (paid likes, follows, views) in live mode? | Off by default in live, on in test (D26) |

---

## 11. How the work is run and reported

- One branch per phase (`rebuild/phase-N-name`) with small commits. Nothing is pushed or deployed until you ask.
- Money changes follow this order: failing test, code, passing tests, second review pass, commit.
- An independent security review runs at the end of phases 2, 3 and 4, and on the whole system in phase 6. A documentation pass runs in phase 6.
- Reports quote real command output. Anything untested is called out as untested.
- Without your instruction I will not push, deploy, restore the deleted forwarder, sign up or pay for services, or change anything that touches section 3.

---

## 12. Owner decisions log

Answers received on 2026-10-21, and what they change. Questions not listed here use the defaults in section 10.

| Question | Owner's answer | Effect on the build |
|---|---|---|
| Q2 Referral reward | UGX 10,000 to the referrer; then UGX 5,000 to the same person when their referral refers someone; then UGX 2,000 at the next level, "and so on" | **Not built as asked.** Levels 2 and deeper are multi-level commissions, which rule 3.2 forbids. The first three levels alone would pay UGX 17,000 of every UGX 19,000 fee up the chain, which rule 3.1 rules out. The single-level design stays. UGX 10,000 even for the direct referrer is above the section 8 cap of 10% of the fee, which is UGX 1,900 today. The amount stays `TODO(owner)` until the owner picks a single-level value within the cap. |
| Q5 Withdrawals | Fee 0.5% of the amount withdrawn; "limit is UGX1000"; large amounts start at UGX 200,000 | Fee of 50 basis points, rounded half up to the currency's minor unit. Minimum withdrawal UGX 1,000, reading "limit" as the minimum. Admin approval with maker-checker from UGX 200,000. The per-request, daily and monthly maximums and the new-account rule keep their defaults. |
| Q4 and Q6 SMS | "for sms we are going to use APIs" | Deposits and payouts go through payment-provider APIs with signed webhooks. SMS forwarding, operator parsers and the forwarder simulator are dropped (D22). The provider is still open (Q6), so Phase 2 builds the interface and the simulated provider. Outbound SMS such as verification codes also goes through an SMS-provider API interface. |
| Q7 Legal sign-off | "No legal sign off needed anywhere" | Legal-review items leave the go-live gate (D20), and an admin switches countries on in live mode (D25). LEGAL_CHECKLIST.md is still written, as advice. Risk R1 stays with the owner. |
| Q8 Exchange rates | "Exchange rates use API" | An exchange-rate API adapter behind the FX source interface, with the simulator for tests. The API choice, the spread (default 2%) and the reporting currency (default USD) remain `TODO(owner)`. |
| Q11 Balances | A separate balance per task module, like the screenshots | A main balance plus one balance per task module, each withdrawable with its own limits (D7). |

| Payments (2026-10-24) | "we are going to make deposit and withdraws manual" | Manual deposits and payouts with a staff console (D22). Built in Phase 2: ledger (migration 0007), deposit claims confirmed by finance with the amount actually received, withdrawals held on request and paid by staff with the state machine and maker-checker from the approval threshold, member payment issues, a 5-minute balance check that pauses withdrawals on failure, and treasury requests approved by a second admin. |
| Q1 Membership fee (2026-10-24) | "The membership fee is 19000" | UGX 19,000 confirmed. Migration 0007 ships it as Uganda's config. It is charged from the main balance to platform revenue on activation. The per-request, daily and monthly withdrawal maximums are still defaults. |
| Admin dashboard (2026-10-24) | Audit all deposits and withdrawals, handle deposit and withdrawal issues, view data in real time, handle system issues, mobile responsive | Staff console under `/admin`: live overview (polls every 5 s), deposit and withdrawal queues with detail sheets, payment issues, balance check with channel statements, pause switches and treasury, ledger explorer, members and audit log. Responsive from 360 px; tables stack as cards on phones. |

| Member side (2026-10-25) | Activation fee paid first; balance only from referrals; dashboard with expenses, profit, balance, total and net earnings, pending withdrawals, details and refer-and-earn; Referrals menu (Level 1 overview, active, inactive; Level 2; Level 3) in tables; no date of birth; referral by username; country codes on every phone; every country supported with country-based currency and payment methods; users change password, email and phone only after contacting the admin | Built in Phase 2 (migrations 0009 to 0011). Dashboard figures: balance = main balance (referral money); total earnings = referral rewards + task rewards; expenses = activation fee paid; net earnings = total earnings - expenses. Open for the owner: the "30 referrals earns 4000" bonus (one-time or repeating, on top of the per-referral rewards, and whether it conflicts with rule 3.3), and whether net earnings should be defined differently. |
| Rename and vouchers (2026-10-26) | The site is renamed Pexerearn; register shows "Invited by" (locked, filled from the invite link); vouchers activate other members instead of going into a wallet; vouchers are worth at least the activation fee; tables stay tables on every screen size; an internal chat | Built: visible name changed everywhere (internal identifiers such as database, package and service names stay `zentrix`). Voucher activation: fee voucher_liability -> platform_revenue, any value above the fee to the activated member's main balance, referral rewards as for a paid activation. Redeem-to-wallet removed. Open for the owner: what "internal chat" means (member to support, staff only, or member to member, which touches rule 3.4). |
| Withdrawals, deposit balance, referral pages (2026-10-26) | Charge table (UGX 15,000 to 5,000,000, charges 1,500 to 26,500) plus 0.5% tax on every withdrawal; deposited money under Deposit, not Balance; Balance from referrals only; total earnings and net profit include every income; dashboard ends at My details; referral data in tables, the word username, overview shows stats only, each level's overview its own data | Built (migration 0014). A boundary amount pays the lower band (UGX 50,000 pays 1,500). The tax goes to the fees account with the charge. Vouchers and Pay For Client spend the deposit first, then the balance; money received goes to the deposit. Open for the owner: whether deposit money can be withdrawn, the daily maximum (set to 5,000,000; the owner removed the monthly limit), and charges for other currencies (they pay their minimum fee plus 0.5%). Existing test-stage wallet deposits stay in the balance. |
| Chat (2026-10-26) | "Work on the internal chat member which are connected by invites. Then also chat with foreigners." Spec from the owner's answers: invite chat with direct invites only; foreigners found by random match; free, no money attached; hide phone and email, block a member, report a chat to staff | Built (migration 0015, `server/src/modules/chat`, `web/chat.html`, `web/admin/chats.html`). Only activated, non-staff members can chat. Messages are append-only, up to 1,000 characters, 30 a minute; 20 random matches an hour. Messages arrive by polling every 5 seconds. Staff (support, compliance) read a chat only through a report, and each read writes `chat.report_viewed` to the audit log. |
| No monthly limit (2026-10-26) | "There are no monthly limits" | The monthly withdrawal maximum is removed everywhere (migration 0015 drops the column); the per-withdrawal maximum (UGX 5,000,000) and the daily maximum stay. |
| Staff console (2026-10-26) | "Admin section should be well connected. Admin should be able to edit most of the variables in the system." | Built: staff pages Countries and fees, Settings and Vouchers; the charge table editor (migration 0016 lets the app rewrite `withdrawal_charges`); referral amounts and voucher values moved from code into settings (fallbacks are the owner's amounts); member details show the deposit balance; the staff home counts open chat reports. Still fixed in code: task rewards and campaigns, chat rate limits, the fraud flag queue page. |
| Inviter change (2026-10-26) | "The admin should be able to change the person who invited a user by a username ... the reward system go to the new line." Asked about rewards already paid: "move paid rewards too; if the money has been used leave a negative balance." | Built (migration 0017, `server/src/modules/referrals/reassign.ts`). Rewards for the member and up to two levels below are realigned to the new chain; the amount moved is the amount originally paid. A shortfall is a `member_debt` ledger account (the non-negative CHECK on accounts stays), shown as a negative Balance and repaid from the next referral earnings; while it lasts the balance cannot be spent or withdrawn. Old and new inviters are not emailed. |
| Payment methods, password reset, landing (2026-10-26) | "The activation page should have payment methods based on the country; admin can add, edit and remove them. The forgot password system should be activated. Use this info for the landing page." (pasted reference page from another platform) | Built. Removing a method archives it (migration 0018). Reset pages added; delivery needs `RESEND_API_KEY` on Render, otherwise the staff Email outbox shows the link in test mode. Landing: structure kept, own text; left out betting tips, Aviator predictor, binary/forex bots (rule 3.4), fake testimonials, team, blog posts and the USD 5 price (rule 3.5: the real fee per country is shown), chess and draughts games and mobile apps (not built). |
| Passwords, Pay For Client, referral report (2026-10-26) | "Deposit after pending withdrawals; phone numbers in referral tables; in admin, the leaderboard should consider referrals, superadmin not included, only staff; member passwords 6 characters and easy; staff passwords strong; check Pay For Client; use your balance to activate another user in the same country." | Built. Read "superadmin not included" as: the leaderboard leaves out superadmin and every staff account. Built as a staff-only report because rule 3.3 forbids member-facing leaderboards ranked by recruiting; the member leaderboard is unchanged. A member promoted to staff keeps their old password until they next change it (TODO: force a strong password on promotion). |
| Rule 3.3 changed (2026-10-26) | "Change the rule stopping you" (members should see a referral ranking) | Rule 3.3 now allows leaderboards ranked by referrals; the ban on rewards or contests ranked by recruiting stays (no prize or bonus for rank). The member Leaderboard ranks activated direct invites (all time, 30 days, 7 days) with usernames, countries and counts only, plus the member's own place; staff and system accounts are left out. Risk noted to the owner: public recruiting rankings are a pyramid-scheme warning sign for regulators. |
| AWS hosting (2026-10-26) | Owner's AWS prompt: eu-west-1, profile Pexerearn, S3+CloudFront frontend, Lambda behind an HTTP API, Aurora Serverless v2 (0 ACU if possible), no NAT, SQS with DLQ and a worker, EventBridge Scheduler, Secrets Manager, 14-day logs, alarms, budgets, GitHub OIDC, test mode only, no apply without approval. Decided by the owner: no paid VPC endpoints (deploy-time secrets, S3 email handoff), CloudTrail and GuardDuty on. | Written and validated; plans: global 20 resources, staging 75. Aurora PostgreSQL 17.11 supports 0 ACU in eu-west-1. The master prompt file and COSTS.md did not exist; COSTS.md and DEPLOYMENT.md were created. The SMS forwarder HMAC secret is not created (SMS forwarding was removed). Balance check runs hourly on staging so Aurora can pause. Staff pages are served through the API to keep the session check. |
| Domain (2026-10-27) | Owner's prompt: connect pexerearn.com (Cloudflare DNS) to staging as staging.pexerearn.com and api-staging.pexerearn.com; ACM certificates (us-east-1 for CloudFront, eu-west-1 for the API) validated by DNS; no Route 53; two applies; update CORS origins, cookie domain and SMS forwarder URLs. | Built, planned, not applied. No CORS or cookie domain: the browser stays on one origin (__Host- cookies cannot have a domain), so the API domain is for direct clients only; `EXTRA_ORIGINS` (new setting) keeps the CloudFront link accepted. No SMS forwarder exists (removed earlier), so nothing to repoint. Records recommended DNS only (grey cloud); Cloudflare SSL/TLS Full (strict). No added cost. |
| Referrals across countries, email sender (2026-10-28) | Owner: a member who refers someone in another country receives the referral reward converted into their own currency at the latest exchange rate, from an API; emails to clients go out from info@pexerearn.com. | Built. Rates from open.er-api.com (free, no key, updated daily) every 6 hours into `fx_rates` (migration 0019, append-only); on AWS a `fxfetch` function outside the VPC fetches them into S3 and the `fxrates` job stores them. The reward is computed in the invited member's currency, converted (rounded down, no spread) and posted through `fx_clearing` in both currencies. With no rate younger than 72 hours it waits as pending and is paid after the next refresh. An inviter change reverses a converted reward through `fx_clearing`. `MAIL_FROM` is `Pexerearn <info@pexerearn.com>` everywhere; pexerearn.com must be verified in Resend (docs/DOMAIN.md). Rule 6 still applies per currency: rewards converted into a currency raise what members are owed there, so that currency's channels must hold the money. |
| Exchange rates every 5 minutes, no waiting (2026-10-28) | Owner: refresh the rates every 5 minutes and pay a cross-country referral reward at the rate in the table at that moment, so nobody waits. Built: the 72-hour age limit is removed; the source asks open.er-api.com again only after its announced daily update (it blocks callers that ask too often); on AWS `fxfetch` runs every 5 minutes outside the VPC and a new snapshot starts `fxrates` through an S3 notification, so Aurora still pauses. |
| Email system (2026-10-28) | Owner: make email fully working; build branded emails, more notifications, delivery tracking and member email settings. | Built (migration 0020). Every email goes through `sendEmail` (modules/email): recorded in `email_messages`, branded HTML plus plain text, sent once per (kind, ref), never to test addresses (.test etc.) or blocked ones. Resend's signed webhook (`/api/webhooks/resend`, Svix HMAC, 5-minute window, replay-safe) updates delivery status; a permanent bounce, spam report or Resend suppression blocks the address until an admin removes it (audited). New emails: welcome on activation (replaces "Account activated"), referral reward received (with the conversion when paid across currencies), new sign-in alert (device or network not seen for 90 days; not on the first sign-in). Members turn referral and sign-in emails off on Profile; security and payment emails always go. Staff console Emails page: log, 7-day summary, blocked list, test email. The email log is kept 180 days. Receiving: info@pexerearn.com forwards to the owner's Gmail through Cloudflare Email Routing. |

Unanswered questions use their defaults: Q3, Q10, Q12 and Q13. Q9 no longer applies. Referral rewards (owner, 2026-10-24): keep the existing multi-level logic, levels 1 to 3 at UGX 10,000 / 5,000 / 2,000, paid at sign-up and at membership activation. Rewards now move through the ledger from platform revenue.
