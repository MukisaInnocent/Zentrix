import type { Db } from '../../db/sql.js';

export type FlagKind = 'ip_country_mismatch' | 'phone_country_mismatch' | 'signup_velocity' | 'referrer_same_ip';
export type Severity = 'low' | 'medium' | 'high';

// Records something a reviewer should look at. Flags never block on their own in Phase 1; later phases
// withhold rewards and payouts while serious flags are open.
export async function raiseFlag(db: Db, userId: number, kind: FlagKind, severity: Severity, details: Record<string, unknown>): Promise<void> {
  await db.query(`INSERT INTO fraud_flags (user_id, kind, severity, details) VALUES ($1, $2, $3, $4)`, [
    userId,
    kind,
    severity,
    JSON.stringify(details),
  ]);
}
