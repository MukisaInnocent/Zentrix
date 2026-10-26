# Pexerearn

Pexerearn is a Node.js/Express web app backed by PostgreSQL. The existing HTML/CSS pages are served by the same-origin API server.

## Features in this backend release

- Account registration, sign-in, sign-out, and profile updates.
- Passwords hashed with bcrypt and opaque, expiring sessions stored as hashes in PostgreSQL.
- Protected member pages and account APIs.
- Wallet summary, transaction history, and deposit/withdrawal request records.
- Pending withdrawal amounts are reserved transactionally to prevent overspending.
- New accounts receive a pending UGX 20,000 mobile-money initial-deposit request and remain locked until a verified provider integration settles it. Existing accounts remain active.
- Demo signup payment: the local preview can simulate a successful UGX 20,000 initial deposit and credit demo funds. No payment network is contacted.
- Production payment routes do not simulate success. Deposits remain pending until a payment provider is integrated and its callback is verified.
- Health endpoint at `GET /api/health`.

During registration, the app requires a mobile-money phone number and creates a pending account with a fixed UGX 20,000 initial-deposit request. The browser proceeds to `payment.html`; member pages stay locked until the deposit is completed. In the local in-memory preview, the payment page offers a clearly labeled demo action that credits demo funds. This is not a real payment. Demo payment is always disabled in production, and Render explicitly sets `DEMO_PAYMENTS_ENABLED=false`. For local PostgreSQL, set `DEMO_PAYMENTS_ENABLED=true` to enable the simulation. A future provider adapter must verify the provider's callback signature, successful status, UGX currency, exact amount, and matching reference before calling `finalizeVerifiedInitialDeposit`; that operation credits the initial deposit exactly once and activates the account. Never expose that settlement function as an unauthenticated endpoint.

Product pages such as tasks, betting, rewards, and referrals remain presentation-only; their demo actions are not persisted or paid.

## Run locally

Requirements: Node.js 20+ and PostgreSQL 13+.

1. Create a local PostgreSQL database, for example `zentrix`. If PostgreSQL is not installed, `npm start` uses a temporary in-memory database for a local preview.
2. Copy `.env.example` to `.env` and set `DATABASE_URL` to your local PostgreSQL connection string. Keep `DATABASE_SSL=false` for a local database. Set `DEMO_PAYMENTS_ENABLED=true` only for local payment simulation.
3. Install dependencies and start the app:

   ```sh
   npm ci
   npm start
   ```

The server applies the idempotent schema in `db/schema.sql` on startup. Open `http://localhost:3000`. Select **Sign up**, complete registration, then use the demo payment page to pass the initial-deposit step. The in-memory preview resets when the server stops.

Run the API and account-flow tests without a separately installed PostgreSQL server:

```sh
npm test
```

Tests use `pg-mem`, an in-memory PostgreSQL-compatible test database. For local database integration, use `npm run db:migrate` with `DATABASE_URL` set.

## Deploy to Render

The `render.yaml` blueprint provisions a Node web service and PostgreSQL database, connects `DATABASE_URL`, sets production mode, and configures `/api/health` as the health check.

1. Push this repository to GitHub and create a new Render Blueprint from it.
2. Review the selected Render service/database plans and deploy.
3. Confirm the deployed service reports healthy and create the first account.

The app uses the PostgreSQL connection string injected by Render. `DATABASE_SSL=true` enables TLS for the database connection. Do not put database credentials in source control.

## API overview

- `POST /api/auth/register` — `{ username, email, phone, password }`; creates a locked account and pending UGX 20,000 initial deposit. Returns HTTP 202 and sets a short-lived signup session.
- `GET /api/payment/initial-deposit` — returns the pending user's amount, reference, and whether demo payments are enabled.
- `POST /api/demo/initial-deposit/complete` — completes the simulated payment only in non-production when demo payments are enabled; credits demo funds and activates the account.
- `POST /api/auth/login` — `{ identifier, password }`
- `POST /api/auth/logout`
- `GET /api/auth/me`
- `GET /api/account/profile`
- `PATCH /api/account/profile` — `{ phone?, currentPassword?, newPassword? }`
- `GET /api/account/summary`
- `GET /api/wallet/transactions`
- `POST /api/wallet/deposits` — `{ amount, method, destination }`
- `POST /api/wallet/withdrawals` — `{ amount, method, destination }`

Authentication uses an HTTP-only, same-site cookie. Existing accounts remain active. Amounts are whole UGX values. Withdrawal requests have a UGX 5,000 minimum, require sufficient credited funds, and remain pending with funds reserved until an operational settlement/review process is added.
