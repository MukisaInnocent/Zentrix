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

export function createSmsSender(config: Config, pool: Pool): SmsSender {
  if (config.appMode === 'test') return new OutboxSms(pool);
  throw new Error('No SMS provider adapter is configured for live mode yet (TODO(owner): choose a provider).');
}
