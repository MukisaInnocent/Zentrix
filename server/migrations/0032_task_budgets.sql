-- Owner, 2026-11-05: each task has its own budget. An admin sets the budget (for example UGX 200,000) and the reward
-- per member; setting it moves that money from the promotions budget into the task's own account (campaign_escrow,
-- one per task). Completed tasks pay from that account. When what is left is less than one reward, members no longer
-- see the task. Lowering the budget returns the unspent part to the promotions budget.

-- Up Migration

ALTER TABLE accounts ADD COLUMN task_id bigint REFERENCES tasks (id);

DO $$
DECLARE c text;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid = 'accounts'::regclass AND contype = 'u' LOOP
    EXECUTE format('ALTER TABLE accounts DROP CONSTRAINT %I', c);
  END LOOP;
END
$$;
ALTER TABLE accounts ADD CONSTRAINT accounts_identity_key UNIQUE NULLS NOT DISTINCT (kind, user_id, module, channel_id, task_id, currency_code);

ALTER TABLE accounts DROP CONSTRAINT accounts_kind_check;
ALTER TABLE accounts ADD CONSTRAINT accounts_kind_check CHECK (kind IN ('member_main', 'member_deposit', 'member_task', 'member_withdrawal_hold',
  'member_debt', 'payment_clearing', 'platform_revenue', 'fees', 'referral_budget', 'promotions_budget', 'owner_capital', 'suspense',
  'voucher_liability', 'fx_clearing', 'campaign_escrow'));
ALTER TABLE accounts ADD CONSTRAINT accounts_task_check CHECK ((kind = 'campaign_escrow') = (task_id IS NOT NULL));

CREATE OR REPLACE FUNCTION zx_accounts_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.balance_minor := 0;
    RETURN NEW;
  END IF;
  IF pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'zentrix: account balances change only through ledger entries' USING ERRCODE = 'ZX001';
  END IF;
  IF NEW.id <> OLD.id OR NEW.kind <> OLD.kind OR NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.module IS DISTINCT FROM OLD.module
     OR NEW.channel_id IS DISTINCT FROM OLD.channel_id OR NEW.task_id IS DISTINCT FROM OLD.task_id
     OR NEW.currency_code <> OLD.currency_code OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'zentrix: account identity columns are immutable' USING ERRCODE = 'ZX002';
  END IF;
  RETURN NEW;
END
$$;

-- The total budget the admin set, in the task's currency. What is left is the balance of the task's account.
ALTER TABLE tasks ADD COLUMN budget_minor bigint NOT NULL DEFAULT 0 CHECK (budget_minor >= 0);
COMMENT ON COLUMN tasks.budget_minor IS 'Total budget set by an admin (task currency). Remaining = balance of the task''s campaign_escrow account.';

-- Down Migration

ALTER TABLE tasks DROP COLUMN budget_minor;
CREATE OR REPLACE FUNCTION zx_accounts_guard() RETURNS trigger LANGUAGE plpgsql AS $$
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
ALTER TABLE accounts DROP CONSTRAINT accounts_task_check;
ALTER TABLE accounts DROP CONSTRAINT accounts_kind_check;
ALTER TABLE accounts ADD CONSTRAINT accounts_kind_check CHECK (kind IN ('member_main', 'member_deposit', 'member_task', 'member_withdrawal_hold',
  'member_debt', 'payment_clearing', 'platform_revenue', 'fees', 'referral_budget', 'promotions_budget', 'owner_capital', 'suspense',
  'voucher_liability', 'fx_clearing'));
ALTER TABLE accounts DROP CONSTRAINT accounts_identity_key;
ALTER TABLE accounts ADD UNIQUE NULLS NOT DISTINCT (kind, user_id, module, channel_id, currency_code);
ALTER TABLE accounts DROP COLUMN task_id;
