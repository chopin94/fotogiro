// Rigenera l'elenco dei file in cache (e opzionalmente la versione) in web/sw.js.
// Uso: node tools/build-sw.mjs [versione]

import { readdirSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = fileURLToPath(new URL('../web/', import.meta.url));
const SW = join(WEB, 'sw.js');
const SKIP = new Set(['sw.js', '.nojekyll']);
const SKIP_DIRS = ['screenshots/'];

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(relative(WEB, p).split(sep).join('/'));
  }
  return out;
}

const rank = (f) => (f === 'index.html' ? 0 : f.includes('/') ? 2 : 1);
const files = walk(WEB)
  .filter((f) => !SKIP.has(f) && !SKIP_DIRS.some((d) => f.startsWith(d)))
  .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));

let sw = readFileSync(SW, 'utf8');
const list = ["  './',", ...files.map((f) => `  '${f}',`)].join('\n');
sw = sw.replace(/const ASSETS = \[[\s\S]*?\n\];/, `const ASSETS = [\n${list}\n];`);
const version = process.argv[2];
if (version) sw = sw.replace(/^const VERSION = .*$/m, `const VERSION = 'fotogiro-${version}';`);
writeFileSync(SW, sw);
console.log(`sw.js: ${files.length + 1} file in cache${version ? `, versione ${version}` : ''}`);
