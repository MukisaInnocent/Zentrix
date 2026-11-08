-- Owner, 2026-11-08: Chat with foreigners pays a daily reward. Once per East Africa Time day a member opens the live
-- chat link (recorded here) and then claims the reward with the Claim reward button. Virtual money, as before: issued
-- from task_credit into the member's 'chat' task balance, which cannot be withdrawn. chat_reward_claims stays as the
-- history of the older per-chat rewards.

-- Up Migration

CREATE TABLE chat_daily_rewards (
  user_id bigint NOT NULL REFERENCES users (id),
  day date NOT NULL,
  opened_at timestamptz NOT NULL DEFAULT now(),
  claimed_at timestamptz,
  amount_minor bigint CHECK (amount_minor > 0),
  currency_code char(3) REFERENCES currencies (code),
  ledger_transaction_id bigint REFERENCES ledger_transactions (id),
  PRIMARY KEY (user_id, day),
  CHECK ((claimed_at IS NULL AND amount_minor IS NULL AND currency_code IS NULL AND ledger_transaction_id IS NULL)
      OR (claimed_at IS NOT NULL AND amount_minor IS NOT NULL AND currency_code IS NOT NULL AND ledger_transaction_id IS NOT NULL))
);

-- Down Migration

DROP TABLE chat_daily_rewards;
