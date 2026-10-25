# AGENTS.md: Zentrix

Loaded at the start of every session. Requirements come from the owner's Zentrix master prompt. The delivery plan, decisions (D1 to D28), risks and open questions live in `docs/PLAN.md`. If anything here conflicts with the master prompt, the master prompt wins, and its section 3 rules (below) always win.

## Current status

- 2026-10-21: the owner answered the plan's questions; their answers count as approval with changes. Phase 1 (foundation) is in progress on branch `rebuild/phase-1-foundation`.
- Owner decisions are logged in `docs/PLAN.md` section 12. Unanswered items use the defaults in section 10, marked `TODO(owner)` in code and settings.
- 2026-10-21 (later): the owner asked that referral levels stop at level 3 (UGX 10,000 / 5,000 / 2,000). The code now caps at `MAX_REFERRAL_LEVEL = 3` (service, migration 0006, UI, tests). It is still multi-level, so rules 3.1 and 3.2 remain unresolved and need the owner's decision before launch.
- The owner asked for multi-level referral payouts (UGX 10,000 / 5,000 / 2,000 "and so on"). That breaks rules 3.1 and 3.2 and was declined. Build single-level only. The reward amount is still `TODO(owner)` and must stay within the 10% cap.

## How to operate

1. Plan before code. Update `docs/PLAN.md` and this file whenever a decision changes.
2. Work in small verified steps: migration, code, tests; run tests and lint; fix failures; commit with a clear message. Report real command output, never assumptions.
3. Real Postgres only: `embedded-postgres` locally (no Docker on the owner's machine), `infra/docker-compose.yml` where Docker exists, a service container in CI. Migrations must apply from scratch on a clean database. Seed data is clearly fake.
4. Money code (ledger, deposits, withdrawals, referrals, vouchers, transfers, FX): write the failing test first (balance, race, idempotency, immutability), then the code. Do a second review pass before every commit. Run an independent security review (subagent) at the end of each money phase.
5. Do not start a phase until the previous phase's tests pass. End each phase with a short report: what works, how to run it, what is untested, the next step. Update the docs.
6. Decide routine choices yourself (naming, minor libraries, layout). Ask the owner only about the open decisions, anything touching the non-negotiable rules, or destructive and irreversible actions.
7. Never commit secrets, real phone numbers or real SMS content.
8. One branch per phase. Never push or deploy unless the owner asks (`main` may auto-deploy on Render).

## Delivery modes (`APP_MODE`)

- `test` (default, current stage): every country selectable except the sanctions blocklist, no real money, simulators (a fake mobile-money provider for collections and payouts) behind the same provider interfaces as production, a persistent "TEST MODE: no real money" banner, fake seed data. Real provider keys are never loaded; the server refuses to start if they are present.
- `live`: refuses to start unless every `GO_LIVE_CHECKLIST` item is signed off by an admin, the database is stamped `live`, and `NODE_ENV=production`. The owner removed legal sign-off, so the checklist is operational (provider keys, backups, security review, public legal pages, sanctions list, KYC rules). Countries stay off until an admin switches them on. Real keys load only here. Seeds refuse to run.
- Keep code paths identical between modes. The non-negotiable rules apply in both.

## Non-negotiable rules (stop and ask the owner if a request would break one)

1. No payouts funded by other members' deposits. Membership fees are platform revenue. Member earnings come only from funded advertiser campaign budgets, the flat referral reward, and platform promotions budgeted in advance.
2. No multi-level commissions. Referral rewards are single-level (direct referrer only), flat, and never a share of anyone's deposit.
3. No rewards, contests or leaderboards ranked by recruiting. Leaderboards rank task activity only.
4. No gambling or lending: no Fixed Bets, Aviator, cash-prize spin wheels, loans ("Request Loan"), Trixcoin or any coin or investment product. "Chat With Foreigners" is out of scope until the owner supplies a written spec.
5. No income promises. Show real task rates and real balances only. Keep Terms, Risk and Refund pages, and show what the membership fee buys.
6. Solvency, per currency: member withdrawable balances plus pending withdrawals must never exceed funds actually held. A reconciliation job and admin alarm enforce it, and withdrawals pause automatically when it fails.
7. Every balance change goes through the double-entry ledger. No code path changes a balance directly.
8. Never store mobile-money PINs, card numbers or secrets in the database or logs.

The reference screenshots from another platform are visual inspiration only. Never copy their name, logo, text or assets, and never build their excluded features (see `docs/PLAN.md` section 2).

## Stack and layout

- Backend: strict TypeScript on Node (Node 24 LTS in Docker, CI and Render; keep it Node 20 compatible for the owner's machine), Express 5, Zod on every endpoint, `pg` with a thin query helper (no ORM), `node-pg-migrate` with plain SQL files, `@node-rs/argon2` for argon2id (the `argon2` package crashes on the owner's Windows machine), helmet, rate limits stored in Postgres, pino, and a separate worker process for scheduled jobs.
- Database: PostgreSQL 17. Hostinger shared plans do not run Postgres, so use Render managed Postgres first and RDS later.
- Frontend: vanilla HTML, CSS and JS only. No frameworks and no build step. Multi-page, small ES modules, `fetch` against the JSON API, event delegation, skeleton loaders, toasts, light and dark themes, responsive at 360, 768 and 1280 px, accessible. Strings in `web/locales/en.json`, CSS logical properties for right-to-left support. Lucide-style inline SVG icons. No emojis anywhere in the UI. Never calculate money in the browser.
- Layout: `/web` (frontend), `/server` (API, worker, migrations, seeds), `/docs`, `/infra` (Dockerfile, docker-compose, AWS notes). `render.yaml` stays at the repository root. `/android-forwarder` exists only if the owner asks to restore it.
- 12-factor: configuration from environment variables, a stateless web process, structured logs to stdout, `/healthz` and `/readyz`, graceful shutdown.

## Ledger rules

- Append-only double-entry ledger: `accounts`, `ledger_transactions`, `ledger_entries`. Only `server/src/modules/ledger` writes ledger rows.
- Each member has a main balance, one balance per task module (YouTube, TikTok, ads, trivia, Fix Tap, music) and a withdrawal-hold account. Every balance is withdrawable with its own limits. Withdrawal fee: 0.5% of the amount, minimum withdrawal UGX 1,000, admin approval from UGX 200,000.
- Each ledger transaction balances per currency, checked at commit by a deferred constraint trigger. An entry may only touch an account of its own currency.
- Ledger rows are immutable: triggers reject UPDATE, DELETE and TRUNCATE. Corrections are new reversing transactions.
- Amounts are BIGINT minor units, always greater than zero, with a currency code. Exponents come from the `currencies` table (UGX 0, USD 2, KWD 3). No floats anywhere. APIs return `amountMinor` as a string.
- Cached balances are maintained only by the entry trigger. A CHECK keeps every account except `fx_clearing` at zero or above. A nightly job recomputes balances from entries to detect drift.
- System accounts per currency: `platform_revenue`, `campaign_escrow` (per campaign), `payment_clearing` (per payment rail), `fees`, `referral_budget`, `promotions_budget`, `suspense`, `fx_clearing`, `voucher_liability`, `owner_capital`.
- No implicit currency conversion. FX is an explicit two-leg transaction through `fx_clearing`, using a stored rate (source, timestamp, spread) and a quote locked for a short window.
- Every money-moving POST requires an `Idempotency-Key`. The stored response is written in the same transaction as the money change, and replays return it.
- Money operations run SERIALIZABLE, lock accounts with `SELECT ... FOR UPDATE` in ascending id order, and retry on 40001 and 40P01.
- Withdrawals follow `requested -> approved -> processing -> paid | failed | cancelled`, enforced by trigger. Funds move to a hold on request and are paid out or returned at the end.
- Task rewards come only from a funded campaign escrow, only for verified submissions. A campaign at zero budget stops paying.
- Referral rewards: single level, a flat per-currency amount from `referral_budget`, paid after a hold period (default 7 days), capped per day and per month, withheld on fraud flags or refunds. A database CHECK keeps the reward at or below MAX_REFERRAL_PCT (at most 10%) of the membership fee.
- Nightly reconciliation compares cached and recomputed balances, the ledger and provider statements, and per-currency solvency. It writes a report, alerts admins and pauses withdrawals on failure.

## Security rules

- argon2id passwords. Login throttling, lockout and generic error messages. TOTP is optional for members and mandatory for staff.
- Sessions: a random token in a `__Host-` cookie (HttpOnly, Secure, SameSite), stored hashed, rotated, revocable on the server. A CSRF token on every state-changing route, an Origin check, and no CORS.
- Zod `.strict()` validation on every endpoint, parameterized SQL only, output encoding, helmet with a strict CSP (no inline scripts or styles), rate limits per IP and per account, request size limits.
- Role-based access plus an ownership check on every record (no IDOR). Every staff action writes `audit_log` (who, what, before and after, IP, time). Maker-checker on money actions: the approver can never be the requester.
- Secrets only in environment variables or a secrets manager, different per environment. The SMS HMAC secret rotates, with the current and previous secret accepted during rotation. TOTP secrets are encrypted at rest.
- Never log passwords, tokens, SMS bodies or personal data beyond what is required.
- Fraud controls: one account per verified phone and email, device and IP velocity checks, task proof checks, duplicate detection, automatic freezes with admin review.
- Members cannot change their phone number. Only an admin can, after identity verification, with an audit entry and a 48-hour withdrawal lock. Payouts go only to the verified phone.
- Dependency audit in CI, lockfile committed, no secrets in git.

## Payments

- Deposits and payouts go through payment-provider APIs (collect, payout, verifyWebhook, getStatus) with signed webhooks. The provider is not chosen yet, so a simulated provider stands in, in test mode.
- No SMS forwarding, by owner decision. The deleted Android forwarder's source is in commit `237980b` if it is ever needed.
- Exchange rates come from an exchange-rate API behind the FX source interface, with a simulator for tests.

## Commands

Filled in during Phase 1.
