import type { Config } from '../config/env.js';
import type { Pool } from '../db/pool.js';

// Outbound SMS (verification codes). The owner chose provider APIs (decision log, 2026-10-21); a real
// adapter is added once a provider is picked. Test mode stores messages in the dev outbox.
export interface SmsSender {
  send(to: string, text: string): Promise<void>;
}

export class OutboxSms implements SmsSender {
  constructor(private readonly pool: Pool) {}
  async send(to: string, text: string): Promise<void> {
    await this.pool.query(`INSERT INTO dev_outbox (channel, recipient, body) VALUES ('sms', $1, $2)`, [to, text]);
  }
}

// Live mode has no SMS provider yet (TODO(owner): choose one). Owner, 2026-11-01: until then a paid LivePay prompt to
// the registered number verifies the phone (payments/provider.ts), and sending a code fails (callers log it).
export class UnavailableSms implements SmsSender {
  send(): Promise<void> {
    return Promise.reject(new Error('No SMS provider is set up for live mode.'));
  }
}

export function createSmsSender(config: Config, pool: Pool): SmsSender {
  if (config.appMode === 'test') return new OutboxSms(pool);
  return new UnavailableSms();
}
