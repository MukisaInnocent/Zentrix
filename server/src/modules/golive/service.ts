import type { Db } from '../../db/sql.js';
import { rows } from '../../db/sql.js';

export interface GoLiveItem {
  key: string;
  label: string;
  signed: boolean;
}

export async function goLiveStatus(db: Db): Promise<GoLiveItem[]> {
  return (await rows<{ key: string; label: string; signed: boolean | null }>(db, 'SELECT key, label, signed FROM go_live_status ORDER BY sort')).map(
    r => ({ key: r.key, label: r.label, signed: r.signed === true }),
  );
}

export async function recordSignoff(db: Db, itemKey: string, actorUserId: number, action: 'sign' | 'revoke', note: string | null): Promise<void> {
  await db.query('INSERT INTO go_live_signoffs (item_key, action, actor_user_id, note) VALUES ($1, $2, $3, $4)', [itemKey, action, actorUserId, note]);
}
