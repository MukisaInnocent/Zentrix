import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolves the repository root by walking up to the package.json named "zentrix". Works from
// server/src (tsx) and from server/dist/src (compiled) alike.
function findRoot(start: string): string {
  let dir = start;
  for (;;) {
    const pkg = path.join(dir, 'package.json');
    if (existsSync(pkg)) {
      try {
        if ((JSON.parse(readFileSync(pkg, 'utf8')) as { name?: string }).name === 'zentrix') return dir;
      } catch {
        // Not our package.json; keep walking up.
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error('Cannot find the Pexerearn project root (package.json named "zentrix").');
    dir = parent;
  }
}

export const ROOT_DIR = findRoot(path.dirname(fileURLToPath(import.meta.url)));
export const WEB_DIR = path.join(ROOT_DIR, 'web');
export const MIGRATIONS_DIR = path.join(ROOT_DIR, 'server', 'migrations');
export const DATA_DIR = path.join(ROOT_DIR, '.data');
