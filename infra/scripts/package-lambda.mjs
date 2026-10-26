// Builds the folder Terraform zips into the Pexa Lambda package (one package, four handlers):
//   server/dist (compiled code), server/migrations, web (the API serves the protected /admin pages),
//   package.json and production dependencies installed for Linux ARM64.
// Run after `npm run build`:  node infra/scripts/package-lambda.mjs
// Works on Windows and Linux; npm picks the Linux ARM64 build of native modules (@node-rs/argon2).
import { execSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const out = path.join(root, '.lambda', 'package');

if (!existsSync(path.join(root, 'server', 'dist', 'src', 'lambda', 'api.js'))) {
  console.error('server/dist is missing. Run `npm run build` first.');
  process.exit(1);
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const item of ['package.json', 'package-lock.json', 'server/dist', 'server/migrations', 'web']) {
  cpSync(path.join(root, item), path.join(out, item), { recursive: true, filter: src => !src.endsWith('.map') });
}

execSync('npm ci --omit=dev --os=linux --cpu=arm64 --libc=glibc --ignore-scripts --no-audit --no-fund', { cwd: out, stdio: 'inherit' });
console.log(`Lambda package ready in ${path.relative(root, out)}`);
