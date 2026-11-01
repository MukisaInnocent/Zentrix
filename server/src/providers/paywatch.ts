import type { ProviderCommand, ProviderName, ProviderOutcome } from './livepay.js';

// Watching open LivePay requests without the database (owner, 2026-11-01: the database wakes for a transaction
// only). On AWS every command the API or a job sends also leaves a watch marker under paygate/watch/. The paygate
// function (no database) reads the status of each marked request on its own schedule and hands an outcome to the
// database (paygate/results/, the `payresults` handler) only when it can change something: paid, failed, an
// unknown status word, no record after MISSING_FAIL_MINUTES, or still pending after REVIEW_AFTER_HOURS. The
// `payresults` handler deletes the marker once the request is closed or sent to review.

export const PAYGATE_WATCH = 'paygate/watch/';
// A request LivePay has no record of is failed (collection) or sent to review (payout) after this long.
export const MISSING_FAIL_MINUTES = 15;
// A request still open after this long goes to staff review.
export const REVIEW_AFTER_HOURS = 24;
// Status reads per paygate run (one run a minute): 30 per 15 minutes, inside LivePay's 50 with room for collections.
export const WATCH_READS_PER_RUN = 2;
// After handing an outcome over, read again only if the marker is still there this much later.
const AFTER_FORWARD_MINUTES = 30;

export interface WatchMarker {
  reference: string;
  provider: ProviderName;
  currency: string;
  // When the request was made (its age decides "missing" and "review").
  createdAt: string;
  nextCheckAt: string;
}

export function watchKey(reference: string): string {
  return `${PAYGATE_WATCH}${reference}.json`;
}

export function markerFor(command: ProviderCommand, now: Date): WatchMarker {
  return {
    reference: command.reference, provider: command.provider, currency: command.currency,
    createdAt: command.createdAt ?? now.toISOString(),
    // The command itself brings an answer first; the first status read follows a minute later.
    nextCheckAt: new Date(now.getTime() + 60_000).toISOString(),
  };
}

// Every minute for the first half hour (a prompt or payout usually settles in a few minutes), then every 10 minutes
// up to 6 hours, then hourly.
function nextInterval(ageMinutes: number): number {
  if (ageMinutes < 30) return 1;
  if (ageMinutes < 360) return 10;
  return 60;
}

export function decideWatch(marker: WatchMarker, outcome: ProviderOutcome | undefined, now: Date): { forward: boolean; marker: WatchMarker } {
  const ageMinutes = (now.getTime() - new Date(marker.createdAt).getTime()) / 60_000;
  let forward: boolean;
  switch (outcome?.status) {
    case 'succeeded':
    case 'failed':
      forward = true;
      break;
    case 'missing':
      forward = ageMinutes > MISSING_FAIL_MINUTES;
      break;
    case 'pending':
      forward = ageMinutes > REVIEW_AFTER_HOURS * 60;
      break;
    default:
      // A status word we do not know goes to staff; a failed call is read again later (to review after a day).
      forward = Boolean(outcome?.rawStatus) || ageMinutes > REVIEW_AFTER_HOURS * 60;
  }
  const minutes = forward ? AFTER_FORWARD_MINUTES : nextInterval(ageMinutes);
  return { forward, marker: { ...marker, nextCheckAt: new Date(now.getTime() + minutes * 60_000).toISOString() } };
}
