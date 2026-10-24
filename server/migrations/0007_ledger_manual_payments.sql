-- Phase 2: the double-entry ledger and manual payments (owner decision of 2026-10-24: members send money to
-- a business mobile-money number and staff confirm it; staff send payouts by hand and record them).
-- Replaces the 0005 wallet tables, which changed balances outside a ledger (rule 7). Those tables held test
-- data only, so they are dropped rather than migrated; reseed after migrating.

-- Up Migration

DROP TRIGGER IF EXISTS users_create_wallet ON users;
DROP FUNCTION IF EXISTS zx_create_user_wallet();
DROP TABLE wallet_transactions;
DROP TABLE money_requests;
DROP TABLE client_payments;
DROP TABLE wallets;
-- Vouchers bought under the old tables have no liability behind them in the ledger.
UPDATE vouchers SET status = 'cancelled' WHERE status = 'active';

-- Uganda's membership fee is UGX 19,000 (owner, 2026-10-24). Fresh databases get this config so payments work
-- before the seed runs; per-request, daily and monthly maximums are still the plan's defaults (TODO(owner)).
INSERT INTO country_configs (country_code, version, currency_code, membership_fee_minor, withdrawal_min_minor, withdrawal_max_minor,
  withdrawal_daily_max_minor, withdrawal_monthly_max_minor, withdrawal_fee_bp, withdrawal_fee_min_minor,
  withdrawal_approval_threshold_minor, terms_version, privacy_version, is_placeholder, note)
SELECT 'UG', 1, 'UGX', 19000, 1000, 1000000, 2000000, 10000000, 50, 0, 200000, '2026-10-v1', '2026-10-v1', true,
  'Fee UGX 19,000 (owner, 2026-10-24); 0.5% withdrawal fee, UGX 1,000 minimum, approval from UGX 200,000 (owner, 2026-10-21). Maximums: TODO(owner).'
WHERE NOT EXISTS (SELECT 1 FROM country_configs WHERE country_code = 'UG');

-- Business mobile-money numbers (or bank accounts) members pay into and staff pay out from.
CREATE TABLE payment_channels (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code text NOT NULL UNIQUE CHECK (code ~ '^[a-z0-9_]{2,40}$'),
  name text NOT NULL CHECK (length(name) BETWEEN 2 AND 60),
  country_code char(2) NOT NULL REFERENCES countries (code),
  currency_code char(3) NOT NULL REFERENCES currencies (code),
  account_name text NOT NULL CHECK (length(account_name) BETWEEN 2 AND 80),
  account_number text NOT NULL CHECK (length(account_number) BETWEEN 3 AND 40),
  instructions text CHECK (length(instructions) <= 600),
  deposits_enabled boolean NOT NULL DEFAULT true,
  payouts_enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER payment_channels_touch BEFORE UPDATE ON payment_channels FOR EACH ROW EXECUTE FUNCTION zx_touch_updated_at();
CREATE FUNCTION zx_payment_channel_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.code IS DISTINCT FROM OLD.code OR NEW.currency_code IS DISTINCT FROM OLD.currency_code OR NEW.country_code IS DISTINCT FROM OLD.country_code THEN
    RAISE EXCEPTION 'zentrix: a payment channel keeps its code, country and currency' USING ERRCODE = 'ZX002';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER payment_channels_guard BEFORE UPDATE ON payment_channels FOR EACH ROW EXECUTE FUNCTION zx_payment_channel_guard();

-- Ledger (section 5). Balances are stored on the account's normal side: credit-normal accounts hold
-- credits minus debits, debit-normal accounts (cash held on a channel) hold debits minus credits.
CREATE TABLE accounts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('member_main', 'member_task', 'member_withdrawal_hold', 'payment_clearing', 'platform_revenue',
    'fees', 'referral_budget', 'promotions_budget', 'owner_capital', 'suspense', 'voucher_liability', 'fx_clearing')),
  user_id bigint REFERENCES users (id),
  module text CHECK (module IN ('youtube', 'tiktok', 'ads', 'trivia', 'fixtap', 'music')),
  channel_id bigint REFERENCES payment_channels (id),
  currency_code char(3) NOT NULL REFERENCES currencies (code),
  normal_side text NOT NULL GENERATED ALWAYS AS (CASE WHEN kind = 'payment_clearing' THEN 'debit' ELSE 'credit' END) STORED,
  balance_minor bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT accounts_non_negative CHECK (kind = 'fx_clearing' OR balance_minor >= 0),
  CHECK ((kind IN ('member_main', 'member_task', 'member_withdrawal_hold')) = (user_id IS NOT NULL)),
  CHECK ((kind = 'member_task') = (module IS NOT NULL)),
  CHECK ((kind = 'payment_clearing') = (channel_id IS NOT NULL)),
  UNIQUE NULLS NOT DISTINCT (kind, user_id, module, channel_id, currency_code)
);
CREATE INDEX accounts_user_idx ON accounts (user_id) WHERE user_id IS NOT NULL;

-- New accounts always open at zero; afterwards only the entry trigger (nested, depth 2) may change the balance.
CREATE FUNCTION zx_accounts_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.balance_minor := 0;
    RETURN NEW;
  END IF;
  IF pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'zentrix: account balances change only through ledger entries' USING ERRCODE = 'ZX001';
  END IF;
  IF NEW.id <> OLD.id OR NEW.kind <> OLD.kind OR NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.module IS DISTINCT FROM OLD.module
     OR NEW.channel_id IS DISTINCT FROM OLD.channel_id OR NEW.currency_code <> OLD.currency_code OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'zentrix: account identity columns are immutable' USING ERRCODE = 'ZX002';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER accounts_guard BEFORE INSERT OR UPDATE ON accounts FOR EACH ROW EXECUTE FUNCTION zx_accounts_guard();
CREATE TRIGGER accounts_no_delete BEFORE DELETE ON accounts FOR EACH ROW EXECUTE FUNCTION zx_forbid_mutation();
CREATE TRIGGER accounts_no_truncate BEFORE TRUNCATE ON accounts FOR EACH STATEMENT EXECUTE FUNCTION zx_forbid_mutation();

CREATE TABLE ledger_transactions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind text NOT NULL CHECK (kind ~ '^[a-z_]{3,40}$'),
  memo text NOT NULL CHECK (length(memo) BETWEEN 1 AND 300),
  ref_type text CHECK (ref_type ~ '^[a-z_]{3,40}$'),
  ref_id text CHECK (length(ref_id) <= 80),
  actor_user_id bigint REFERENCES users (id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ledger_transactions_ref_idx ON ledger_transactions (ref_type, ref_id);
CREATE INDEX ledger_transactions_created_idx ON ledger_transactions (created_at DESC);

CREATE TABLE ledger_entries (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  transaction_id bigint NOT NULL REFERENCES ledger_transactions (id),
  account_id bigint NOT NULL REFERENCES accounts (id),
  side text NOT NULL CHECK (side IN ('debit', 'credit')),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency_code char(3) NOT NULL REFERENCES currencies (code),
  balance_after_minor bigint,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ledger_entries_account_idx ON ledger_entries (account_id, id DESC);
CREATE INDEX ledger_entries_transaction_idx ON ledger_entries (transaction_id);

-- Applies an entry to its account's cached balance. SECURITY DEFINER because the application role has no
-- UPDATE right on accounts (decision D10). The non-negative CHECK on accounts rejects overdrafts.
CREATE FUNCTION zx_ledger_entry_apply() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  acc_currency char(3);
  acc_side text;
BEGIN
  SELECT currency_code, normal_side INTO acc_currency, acc_side FROM accounts WHERE id = NEW.account_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'zentrix: account % does not exist', NEW.account_id USING ERRCODE = 'ZX010';
  END IF;
  IF acc_currency <> NEW.currency_code THEN
    RAISE EXCEPTION 'zentrix: entry currency % does not match account currency %', NEW.currency_code, acc_currency USING ERRCODE = 'ZX010';
  END IF;
  UPDATE accounts
     SET balance_minor = balance_minor + CASE WHEN NEW.side = acc_side THEN NEW.amount_minor ELSE -NEW.amount_minor END
   WHERE id = NEW.account_id
  RETURNING balance_minor INTO NEW.balance_after_minor;
  RETURN NEW;
END
$$;
CREATE TRIGGER ledger_entries_apply BEFORE INSERT ON ledger_entries FOR EACH ROW EXECUTE FUNCTION zx_ledger_entry_apply();

-- Every transaction balances per currency, checked at commit (rule 1 of section 5).
CREATE FUNCTION zx_ledger_assert_balanced(txn bigint) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM ledger_entries WHERE transaction_id = txn) THEN
    RAISE EXCEPTION 'zentrix: ledger transaction % has no entries', txn USING ERRCODE = 'ZX011';
  END IF;
  IF EXISTS (
    SELECT 1 FROM ledger_entries WHERE transaction_id = txn GROUP BY currency_code
    HAVING sum(CASE side WHEN 'debit' THEN amount_minor ELSE -amount_minor END) <> 0
  ) THEN
    RAISE EXCEPTION 'zentrix: ledger transaction % does not balance', txn USING ERRCODE = 'ZX011';
  END IF;
END
$$;
CREATE FUNCTION zx_ledger_entry_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM zx_ledger_assert_balanced(NEW.transaction_id);
  RETURN NULL;
END
$$;
CREATE FUNCTION zx_ledger_transaction_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM zx_ledger_assert_balanced(NEW.id);
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER ledger_entries_balanced AFTER INSERT ON ledger_entries DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION zx_ledger_entry_balanced();
CREATE CONSTRAINT TRIGGER ledger_transactions_have_entries AFTER INSERT ON ledger_transactions DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION zx_ledger_transaction_balanced();

CREATE TRIGGER ledger_transactions_append_only BEFORE UPDATE OR DELETE ON ledger_transactions FOR EACH ROW EXECUTE FUNCTION zx_forbid_mutation();
CREATE TRIGGER ledger_transactions_no_truncate BEFORE TRUNCATE ON ledger_transactions FOR EACH STATEMENT EXECUTE FUNCTION zx_forbid_mutation();
CREATE TRIGGER ledger_entries_append_only BEFORE UPDATE OR DELETE ON ledger_entries FOR EACH ROW EXECUTE FUNCTION zx_forbid_mutation();
CREATE TRIGGER ledger_entries_no_truncate BEFORE TRUNCATE ON ledger_entries FOR EACH STATEMENT EXECUTE FUNCTION zx_forbid_mutation();

-- Stored responses for money-moving POSTs, written in the same transaction as the money change (D11).
CREATE TABLE idempotency_keys (
  user_id bigint NOT NULL REFERENCES users (id),
  key text NOT NULL CHECK (key ~ '^[A-Za-z0-9_-]{16,80}$'),
  scope text NOT NULL,
  request_hash text NOT NULL,
  response_status smallint NOT NULL,
  response_body jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key)
);
CREATE INDEX idempotency_keys_created_idx ON idempotency_keys (created_at);

CREATE TABLE memberships (
  user_id bigint PRIMARY KEY REFERENCES users (id),
  receipt_no text NOT NULL UNIQUE CHECK (receipt_no ~ '^MB-[A-Z0-9]{8}$'),
  fee_minor bigint NOT NULL CHECK (fee_minor > 0),
  currency_code char(3) NOT NULL REFERENCES currencies (code),
  ledger_transaction_id bigint NOT NULL REFERENCES ledger_transactions (id),
  activated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER memberships_append_only BEFORE UPDATE OR DELETE ON memberships FOR EACH ROW EXECUTE FUNCTION zx_forbid_mutation();

-- A member's claim that they sent money to a channel. Staff check it against the channel's statement.
CREATE TABLE deposits (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  public_id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  reference text NOT NULL UNIQUE CHECK (reference ~ '^DP-[A-Z0-9]{8}$'),
  user_id bigint NOT NULL REFERENCES users (id),
  channel_id bigint NOT NULL REFERENCES payment_channels (id),
  claimed_amount_minor bigint NOT NULL CHECK (claimed_amount_minor > 0),
  credited_amount_minor bigint CHECK (credited_amount_minor > 0),
  currency_code char(3) NOT NULL REFERENCES currencies (code),
  sender_phone text NOT NULL CHECK (sender_phone ~ '^\+[1-9][0-9]{6,14}$'),
  provider_txn_id text NOT NULL CHECK (provider_txn_id ~ '^[A-Z0-9.-]{4,40}$'),
  member_note text CHECK (length(member_note) <= 300),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'rejected', 'cancelled')),
  reviewed_by bigint REFERENCES users (id),
  reviewed_at timestamptz,
  review_note text CHECK (length(review_note) <= 500),
  ledger_transaction_id bigint REFERENCES ledger_transactions (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (reviewed_by IS NULL OR reviewed_by <> user_id),
  CHECK ((status = 'confirmed') = (ledger_transaction_id IS NOT NULL AND credited_amount_minor IS NOT NULL)),
  CHECK (status IN ('pending', 'cancelled') OR (reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL))
);
-- One mobile-money transaction can back at most one live claim.
CREATE UNIQUE INDEX deposits_provider_txn_unique ON deposits (channel_id, provider_txn_id) WHERE status IN ('pending', 'confirmed');
CREATE INDEX deposits_status_idx ON deposits (status, created_at);
CREATE INDEX deposits_user_idx ON deposits (user_id, created_at DESC);
CREATE INDEX deposits_sender_idx ON deposits (sender_phone);
CREATE TRIGGER deposits_touch BEFORE UPDATE ON deposits FOR EACH ROW EXECUTE FUNCTION zx_touch_updated_at();

CREATE TABLE withdrawals (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  public_id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  reference text NOT NULL UNIQUE CHECK (reference ~ '^WD-[A-Z0-9]{8}$'),
  user_id bigint NOT NULL REFERENCES users (id),
  source text NOT NULL CHECK (source IN ('main', 'youtube', 'tiktok', 'ads', 'trivia', 'fixtap', 'music')),
  source_account_id bigint NOT NULL REFERENCES accounts (id),
  channel_id bigint NOT NULL REFERENCES payment_channels (id),
  payout_phone text NOT NULL CHECK (payout_phone ~ '^\+[1-9][0-9]{6,14}$'),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  fee_minor bigint NOT NULL CHECK (fee_minor >= 0),
  currency_code char(3) NOT NULL REFERENCES currencies (code),
  needs_two_people boolean NOT NULL,
  status text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'approved', 'processing', 'paid', 'failed', 'cancelled')),
  hold_transaction_id bigint NOT NULL REFERENCES ledger_transactions (id),
  final_transaction_id bigint REFERENCES ledger_transactions (id),
  approved_by bigint REFERENCES users (id),
  approved_at timestamptz,
  processing_by bigint REFERENCES users (id),
  processing_at timestamptz,
  paid_by bigint REFERENCES users (id),
  paid_at timestamptz,
  payout_txn_id text CHECK (payout_txn_id ~ '^[A-Z0-9.-]{4,40}$'),
  closed_by bigint REFERENCES users (id),
  closed_reason text CHECK (length(closed_reason) <= 500),
  closed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (approved_by IS NULL OR approved_by <> user_id),
  CHECK (processing_by IS NULL OR processing_by <> user_id),
  CHECK (paid_by IS NULL OR paid_by <> user_id),
  -- Maker-checker from the approval threshold: whoever approved cannot also record the payout.
  CHECK (NOT needs_two_people OR paid_by IS NULL OR paid_by <> approved_by),
  CHECK ((status = 'paid') = (payout_txn_id IS NOT NULL AND paid_by IS NOT NULL)),
  CHECK ((status IN ('requested', 'approved', 'processing')) = (final_transaction_id IS NULL))
);
CREATE UNIQUE INDEX withdrawals_payout_txn_unique ON withdrawals (channel_id, payout_txn_id) WHERE payout_txn_id IS NOT NULL;
CREATE INDEX withdrawals_status_idx ON withdrawals (status, created_at);
CREATE INDEX withdrawals_user_idx ON withdrawals (user_id, created_at DESC);
CREATE TRIGGER withdrawals_touch BEFORE UPDATE ON withdrawals FOR EACH ROW EXECUTE FUNCTION zx_touch_updated_at();

-- Status machines, enforced in the database: deposits pending -> confirmed | rejected | cancelled; withdrawals
-- requested -> approved -> processing -> paid | failed, and cancelled before processing. The claim itself
-- (who, how much, which transaction) never changes after it is made.
CREATE FUNCTION zx_deposit_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.reference <> OLD.reference OR NEW.user_id <> OLD.user_id OR NEW.channel_id <> OLD.channel_id
     OR NEW.claimed_amount_minor <> OLD.claimed_amount_minor OR NEW.currency_code <> OLD.currency_code
     OR NEW.sender_phone <> OLD.sender_phone OR NEW.provider_txn_id <> OLD.provider_txn_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'zentrix: a deposit claim cannot be edited' USING ERRCODE = 'ZX002';
  END IF;
  IF NEW.status <> OLD.status AND NOT (OLD.status = 'pending' AND NEW.status IN ('confirmed', 'rejected', 'cancelled')) THEN
    RAISE EXCEPTION 'zentrix: deposit cannot move from % to %', OLD.status, NEW.status USING ERRCODE = 'ZX012';
  END IF;
  IF OLD.status <> 'pending' AND (NEW.credited_amount_minor IS DISTINCT FROM OLD.credited_amount_minor
     OR NEW.ledger_transaction_id IS DISTINCT FROM OLD.ledger_transaction_id OR NEW.reviewed_by IS DISTINCT FROM OLD.reviewed_by) THEN
    RAISE EXCEPTION 'zentrix: a closed deposit cannot be changed' USING ERRCODE = 'ZX012';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER deposits_transition BEFORE UPDATE ON deposits FOR EACH ROW EXECUTE FUNCTION zx_deposit_transition();

CREATE FUNCTION zx_withdrawal_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.reference <> OLD.reference OR NEW.user_id <> OLD.user_id OR NEW.source_account_id <> OLD.source_account_id
     OR NEW.channel_id <> OLD.channel_id OR NEW.payout_phone <> OLD.payout_phone OR NEW.amount_minor <> OLD.amount_minor
     OR NEW.fee_minor <> OLD.fee_minor OR NEW.currency_code <> OLD.currency_code OR NEW.needs_two_people <> OLD.needs_two_people
     OR NEW.hold_transaction_id <> OLD.hold_transaction_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'zentrix: a withdrawal request cannot be edited' USING ERRCODE = 'ZX002';
  END IF;
  IF OLD.status IN ('paid', 'failed', 'cancelled') THEN
    RAISE EXCEPTION 'zentrix: withdrawal % is closed', OLD.reference USING ERRCODE = 'ZX012';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'requested' AND NEW.status IN ('approved', 'cancelled'))
    OR (OLD.status = 'approved' AND NEW.status IN ('processing', 'cancelled'))
    OR (OLD.status = 'processing' AND NEW.status IN ('paid', 'failed'))
  ) THEN
    RAISE EXCEPTION 'zentrix: withdrawal cannot move from % to %', OLD.status, NEW.status USING ERRCODE = 'ZX012';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER withdrawals_transition BEFORE UPDATE ON withdrawals FOR EACH ROW EXECUTE FUNCTION zx_withdrawal_transition();

-- Status history for both, written by trigger so no code path can skip it. The service names the actor and
-- the note with set_config('zentrix.actor_id' / 'zentrix.status_note', ..., true) inside its transaction.
CREATE TABLE payment_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  subject_type text NOT NULL CHECK (subject_type IN ('deposit', 'withdrawal')),
  subject_id bigint NOT NULL,
  user_id bigint NOT NULL REFERENCES users (id),
  from_status text,
  to_status text NOT NULL,
  actor_user_id bigint REFERENCES users (id),
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX payment_events_subject_idx ON payment_events (subject_type, subject_id, id);
CREATE INDEX payment_events_created_idx ON payment_events (id DESC);
CREATE TRIGGER payment_events_append_only BEFORE UPDATE OR DELETE ON payment_events FOR EACH ROW EXECUTE FUNCTION zx_forbid_mutation();
CREATE TRIGGER payment_events_no_truncate BEFORE TRUNCATE ON payment_events FOR EACH STATEMENT EXECUTE FUNCTION zx_forbid_mutation();

CREATE FUNCTION zx_payment_event() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.status = OLD.status THEN
    RETURN NULL;
  END IF;
  INSERT INTO payment_events (subject_type, subject_id, user_id, from_status, to_status, actor_user_id, note)
  VALUES (TG_ARGV[0], NEW.id, NEW.user_id, CASE WHEN TG_OP = 'UPDATE' THEN OLD.status END, NEW.status,
          nullif(current_setting('zentrix.actor_id', true), '')::bigint,
          nullif(current_setting('zentrix.status_note', true), ''));
  RETURN NULL;
END
$$;
CREATE TRIGGER deposits_event AFTER INSERT OR UPDATE OF status ON deposits FOR EACH ROW EXECUTE FUNCTION zx_payment_event('deposit');
CREATE TRIGGER withdrawals_event AFTER INSERT OR UPDATE OF status ON withdrawals FOR EACH ROW EXECUTE FUNCTION zx_payment_event('withdrawal');

-- Problems members report about a deposit or withdrawal, and the conversation with staff.
CREATE TABLE payment_issues (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  public_id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  user_id bigint NOT NULL REFERENCES users (id),
  subject_type text NOT NULL CHECK (subject_type IN ('deposit', 'withdrawal', 'other')),
  deposit_id bigint REFERENCES deposits (id),
  withdrawal_id bigint REFERENCES withdrawals (id),
  category text NOT NULL CHECK (category IN ('not_credited', 'wrong_amount', 'not_received', 'delayed', 'other')),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'resolved')),
  assigned_to bigint REFERENCES users (id),
  resolution text CHECK (length(resolution) <= 1000),
  resolved_by bigint REFERENCES users (id),
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((subject_type = 'deposit') = (deposit_id IS NOT NULL)),
  CHECK ((subject_type = 'withdrawal') = (withdrawal_id IS NOT NULL)),
  CHECK ((status = 'resolved') = (resolved_at IS NOT NULL))
);
CREATE INDEX payment_issues_status_idx ON payment_issues (status, created_at);
CREATE INDEX payment_issues_user_idx ON payment_issues (user_id, created_at DESC);
CREATE TRIGGER payment_issues_touch BEFORE UPDATE ON payment_issues FOR EACH ROW EXECUTE FUNCTION zx_touch_updated_at();

CREATE TABLE payment_issue_messages (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  issue_id bigint NOT NULL REFERENCES payment_issues (id),
  author_user_id bigint NOT NULL REFERENCES users (id),
  from_staff boolean NOT NULL,
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 2000),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX payment_issue_messages_issue_idx ON payment_issue_messages (issue_id, id);
CREATE TRIGGER payment_issue_messages_append_only BEFORE UPDATE OR DELETE ON payment_issue_messages FOR EACH ROW EXECUTE FUNCTION zx_forbid_mutation();

-- Per-currency switches. The balance check sets withdrawals_paused automatically when solvency fails (rule 6).
CREATE TABLE system_flags (
  key text NOT NULL CHECK (key IN ('deposits_paused', 'withdrawals_paused')),
  currency_code char(3) NOT NULL REFERENCES currencies (code),
  active boolean NOT NULL DEFAULT false,
  automatic boolean NOT NULL DEFAULT false,
  reason text CHECK (length(reason) <= 500),
  changed_by bigint REFERENCES users (id),
  changed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (key, currency_code)
);

CREATE TABLE alerts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind text NOT NULL CHECK (kind ~ '^[a-z_.]{3,60}$'),
  severity text NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  currency_code char(3) REFERENCES currencies (code),
  message text NOT NULL CHECK (length(message) <= 500),
  details jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'acknowledged', 'resolved')),
  occurrences integer NOT NULL DEFAULT 1,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  acknowledged_by bigint REFERENCES users (id),
  resolved_by bigint REFERENCES users (id),
  resolved_at timestamptz,
  resolution_note text CHECK (length(resolution_note) <= 500)
);
CREATE UNIQUE INDEX alerts_one_unresolved ON alerts (kind, currency_code) NULLS NOT DISTINCT WHERE status <> 'resolved';
CREATE INDEX alerts_status_idx ON alerts (status, last_seen_at DESC);

-- The real balance staff read off each channel's statement, compared with what the ledger says is held.
CREATE TABLE float_snapshots (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  channel_id bigint NOT NULL REFERENCES payment_channels (id),
  balance_minor bigint NOT NULL CHECK (balance_minor >= 0),
  currency_code char(3) NOT NULL REFERENCES currencies (code),
  note text CHECK (length(note) <= 300),
  recorded_by bigint NOT NULL REFERENCES users (id),
  recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX float_snapshots_channel_idx ON float_snapshots (channel_id, id DESC);
CREATE TRIGGER float_snapshots_append_only BEFORE UPDATE OR DELETE ON float_snapshots FOR EACH ROW EXECUTE FUNCTION zx_forbid_mutation();

CREATE TABLE reconciliation_runs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ok boolean NOT NULL,
  report jsonb NOT NULL,
  triggered_by bigint REFERENCES users (id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX reconciliation_runs_created_idx ON reconciliation_runs (created_at DESC);
CREATE TRIGGER reconciliation_runs_append_only BEFORE UPDATE OR DELETE ON reconciliation_runs FOR EACH ROW EXECUTE FUNCTION zx_forbid_mutation();

-- Platform money moves (owner capital in or out, budget funding, moving float between channels). One staff
-- member requests, a different admin approves, and only then does the ledger move (maker-checker).
CREATE TABLE treasury_requests (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  public_id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('capital_in', 'owner_withdrawal', 'fund_budget', 'channel_transfer')),
  currency_code char(3) NOT NULL REFERENCES currencies (code),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  from_account_id bigint NOT NULL REFERENCES accounts (id),
  to_account_id bigint NOT NULL REFERENCES accounts (id),
  external_ref text CHECK (external_ref ~ '^[A-Z0-9.-]{4,40}$'),
  note text NOT NULL CHECK (length(note) BETWEEN 5 AND 500),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  requested_by bigint NOT NULL REFERENCES users (id),
  decided_by bigint REFERENCES users (id),
  decided_at timestamptz,
  decision_note text CHECK (length(decision_note) <= 500),
  ledger_transaction_id bigint REFERENCES ledger_transactions (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (from_account_id <> to_account_id),
  CHECK (decided_by IS NULL OR decided_by <> requested_by),
  CHECK ((status = 'approved') = (ledger_transaction_id IS NOT NULL)),
  CHECK ((status = 'pending') = (decided_by IS NULL))
);
CREATE INDEX treasury_requests_status_idx ON treasury_requests (status, created_at DESC);
CREATE FUNCTION zx_treasury_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'zentrix: treasury request % is already decided', OLD.id USING ERRCODE = 'ZX012';
  END IF;
  IF NEW.kind <> OLD.kind OR NEW.amount_minor <> OLD.amount_minor OR NEW.from_account_id <> OLD.from_account_id
     OR NEW.to_account_id <> OLD.to_account_id OR NEW.requested_by <> OLD.requested_by OR NEW.currency_code <> OLD.currency_code THEN
    RAISE EXCEPTION 'zentrix: a treasury request cannot be edited' USING ERRCODE = 'ZX002';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER treasury_requests_transition BEFORE UPDATE ON treasury_requests FOR EACH ROW EXECUTE FUNCTION zx_treasury_transition();

-- Wallet-to-wallet payments between verified members (replaces client_payments).
CREATE TABLE member_transfers (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  reference text NOT NULL UNIQUE CHECK (reference ~ '^PT-[A-Z0-9]{8}$'),
  payer_user_id bigint NOT NULL REFERENCES users (id),
  payee_user_id bigint NOT NULL REFERENCES users (id),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency_code char(3) NOT NULL REFERENCES currencies (code),
  note text CHECK (length(note) <= 200),
  ledger_transaction_id bigint NOT NULL REFERENCES ledger_transactions (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (payer_user_id <> payee_user_id)
);
CREATE INDEX member_transfers_payer_idx ON member_transfers (payer_user_id, created_at DESC);
CREATE INDEX member_transfers_payee_idx ON member_transfers (payee_user_id, created_at DESC);
CREATE TRIGGER member_transfers_append_only BEFORE UPDATE OR DELETE ON member_transfers FOR EACH ROW EXECUTE FUNCTION zx_forbid_mutation();

ALTER TABLE vouchers ADD COLUMN ledger_transaction_id bigint REFERENCES ledger_transactions (id);
ALTER TABLE task_submissions ADD COLUMN ledger_transaction_id bigint REFERENCES ledger_transactions (id);

DO $$
BEGIN
  IF zx_app_role_exists() THEN
    REVOKE UPDATE, DELETE, TRUNCATE ON accounts, ledger_transactions, ledger_entries, memberships, payment_events,
      payment_issue_messages, float_snapshots, reconciliation_runs, member_transfers FROM zentrix_app;
    REVOKE DELETE, TRUNCATE ON payment_channels, deposits, withdrawals, payment_issues, system_flags, alerts, treasury_requests FROM zentrix_app;
    -- SELECT ... FOR UPDATE needs an UPDATE right on some column. The accounts guard trigger still rejects
    -- every direct UPDATE, so this only lets the ledger service lock accounts in id order.
    GRANT UPDATE (created_at) ON accounts TO zentrix_app;
  END IF;
END
$$;

-- Down Migration

ALTER TABLE task_submissions DROP COLUMN ledger_transaction_id;
ALTER TABLE vouchers DROP COLUMN ledger_transaction_id;
DROP TABLE member_transfers;
DROP TABLE treasury_requests;
DROP FUNCTION zx_treasury_transition();
DROP TABLE reconciliation_runs;
DROP TABLE float_snapshots;
DROP TABLE alerts;
DROP TABLE system_flags;
DROP TABLE payment_issue_messages;
DROP TABLE payment_issues;
DROP TABLE payment_events;
DROP TABLE withdrawals;
DROP TABLE deposits;
DROP FUNCTION zx_payment_event();
DROP FUNCTION zx_withdrawal_transition();
DROP FUNCTION zx_deposit_transition();
DROP TABLE memberships;
DROP TABLE idempotency_keys;
DROP TABLE ledger_entries;
DROP TABLE ledger_transactions;
DROP FUNCTION zx_ledger_transaction_balanced();
DROP FUNCTION zx_ledger_entry_balanced();
DROP FUNCTION zx_ledger_assert_balanced(bigint);
DROP FUNCTION zx_ledger_entry_apply();
DROP TABLE accounts;
DROP FUNCTION zx_accounts_guard();
DROP TABLE payment_channels;
DROP FUNCTION zx_payment_channel_guard();
-- The 0005 wallet tables are not recreated; roll back to before 0005 and reapply it if they are needed.
