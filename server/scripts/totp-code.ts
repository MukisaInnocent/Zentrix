// TEST MODE helper: prints the current sign-in code for a seeded staff account, read from
// .data/seed-credentials.txt, so testers need no authenticator app. Refuses to run in live mode.
// Usage: npm run totp -- zx_admin
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../src/lib/paths.js';
import { totpCodeAt } from '../src/modules/auth/totp.js';

if (process.env.APP_MODE === 'live') {
  console.error('totp-code is a test-mode helper and does not run in live mode.');
  process.exit(1);
}
const username = process.argv[2] ?? 'zx_admin';
const file = readFileSync(path.join(DATA_DIR, 'seed-credentials.txt'), 'utf8');
const secret = new RegExp(`^${username} \\[.*\\] TOTP secret ([A-Z2-7]+)$`, 'm').exec(file)?.[1];
if (!secret) {
  console.error(`No seeded staff account named ${username} in .data/seed-credentials.txt.`);
  process.exit(1);
}
const now = new Date();
const left = 30 - (Math.floor(now.getTime() / 1000) % 30);
console.log(`${username} code: ${totpCodeAt(secret, now)} (valid for ${left} more seconds)`);
