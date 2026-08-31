/**
 * Syntax-check every .js/.mjs file in the project (ESM-aware).
 * Uses `node --check`, which honors the package "type": "module" setting.
 * Exits non-zero and prints every failure if any file is invalid.
 */

import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const SKIP_DIRS = new Set(['node_modules', '.git', 'data']);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(js|mjs)$/.test(entry)) out.push(p);
  }
  return out;
}

const files = walk(ROOT).sort();
let failures = 0;

for (const file of files) {
  const res = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (res.status !== 0) {
    failures++;
    console.error(`✘ ${relative(ROOT, file)}`);
    console.error((res.stderr || res.stdout).trim());
  }
}

if (failures > 0) {
  console.error(`\n${failures} of ${files.length} files failed syntax check.`);
  process.exit(1);
}
console.log(`✔ ${files.length} files passed syntax check.`);
