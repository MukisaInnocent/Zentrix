-- Owner, 2026-11-05 (later): task and ad money is not real money yet. An admin sets any task budget directly; it no
-- longer has to come from a funded promotions budget. The budget is issued from task_credit (one per currency,
-- debit-normal: it grows by what has been issued and not returned) into the task's own account. Task earnings stay
-- non-withdrawable (withdrawal.task_balance), so this money never leaves the platform, and the balance check no
-- longer counts task balances as money owed to members.
-- Owner, 2026-11-06: chatting with foreigners earns a virtual reward the member claims (chat_reward_claims), issued
-- from task_credit into a new task balance, 'chat', which cannot be withdrawn either.

-- Up Migration

ALTER TABLE accounts DROP CONSTRAINT accounts_kind_check;
ALTER TABLE accounts ADD CONSTRAINT accounts_kind_check CHECK (kind IN ('member_main', 'member_deposit', 'member_task', 'member_withdrawal_hold',
  'member_debt', 'payment_clearing', 'platform_revenue', 'fees', 'referral_budget', 'promotions_budget', 'owner_capital', 'suspense',
  'voucher_liability', 'fx_clearing', 'campaign_escrow', 'task_credit'));
ALTER TABLE accounts ALTER COLUMN normal_side SET EXPRESSION AS (CASE WHEN kind IN ('payment_clearing', 'member_debt', 'task_credit') THEN 'debit' ELSE 'credit' END);

ALTER TABLE accounts DROP CONSTRAINT accounts_module_check;
ALTER TABLE accounts ADD CONSTRAINT accounts_module_check CHECK (module IN ('youtube', 'tiktok', 'ads', 'trivia', 'fixtap', 'music', 'chat'));

CREATE TABLE chat_reward_claims (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  conversation_id bigint NOT NULL REFERENCES chat_conversations (id),
  user_id bigint NOT NULL REFERENCES users (id),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency_code char(3) NOT NULL REFERENCES currencies (code),
  ledger_transaction_id bigint NOT NULL REFERENCES ledger_transactions (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (conversation_id, user_id)
);
CREATE INDEX chat_reward_claims_user_idx ON chat_reward_claims (user_id, created_at);

-- Down Migration

DROP TABLE chat_reward_claims;
ALTER TABLE accounts DROP CONSTRAINT accounts_module_check;
ALTER TABLE accounts ADD CONSTRAINT accounts_module_check CHECK (module IN ('youtube', 'tiktok', 'ads', 'trivia', 'fixtap', 'music'));
ALTER TABLE accounts ALTER COLUMN normal_side SET EXPRESSION AS (CASE WHEN kind IN ('payment_clearing', 'member_debt') THEN 'debit' ELSE 'credit' END);
ALTER TABLE accounts DROP CONSTRAINT accounts_kind_check;
ALTER TABLE accounts ADD CONSTRAINT accounts_kind_check CHECK (kind IN ('member_main', 'member_deposit', 'member_task', 'member_withdrawal_hold',
  'member_debt', 'payment_clearing', 'platform_revenue', 'fees', 'referral_budget', 'promotions_budget', 'owner_capital', 'suspense',
  'voucher_liability', 'fx_clearing', 'campaign_escrow'));
