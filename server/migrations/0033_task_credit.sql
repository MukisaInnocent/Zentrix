-- Owner, 2026-11-05 (later): task and ad money is not real money yet. An admin sets any task budget directly; it no
-- longer has to come from a funded promotions budget. The budget is issued from task_credit (one per currency,
-- debit-normal: it grows by what has been issued and not returned) into the task's own account. Task earnings stay
-- non-withdrawable (withdrawal.task_balance), so this money never leaves the platform, and the balance check no
-- longer counts task balances as money owed to members.

-- Up Migration

ALTER TABLE accounts DROP CONSTRAINT accounts_kind_check;
ALTER TABLE accounts ADD CONSTRAINT accounts_kind_check CHECK (kind IN ('member_main', 'member_deposit', 'member_task', 'member_withdrawal_hold',
  'member_debt', 'payment_clearing', 'platform_revenue', 'fees', 'referral_budget', 'promotions_budget', 'owner_capital', 'suspense',
  'voucher_liability', 'fx_clearing', 'campaign_escrow', 'task_credit'));
ALTER TABLE accounts ALTER COLUMN normal_side SET EXPRESSION AS (CASE WHEN kind IN ('payment_clearing', 'member_debt', 'task_credit') THEN 'debit' ELSE 'credit' END);

-- Down Migration

ALTER TABLE accounts ALTER COLUMN normal_side SET EXPRESSION AS (CASE WHEN kind IN ('payment_clearing', 'member_debt') THEN 'debit' ELSE 'credit' END);
ALTER TABLE accounts DROP CONSTRAINT accounts_kind_check;
ALTER TABLE accounts ADD CONSTRAINT accounts_kind_check CHECK (kind IN ('member_main', 'member_deposit', 'member_task', 'member_withdrawal_hold',
  'member_debt', 'payment_clearing', 'platform_revenue', 'fees', 'referral_budget', 'promotions_budget', 'owner_capital', 'suspense',
  'voucher_liability', 'fx_clearing', 'campaign_escrow'));
