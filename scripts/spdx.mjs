// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// Checks, or writes, the SPDX header at the top of every source file.
//
// Every file of code written by hand starts with two lines that name the copyright holder
// and the license, in the form of the REUSE specification:
//
//   // SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
//   // SPDX-License-Identifier: AGPL-3.0-only
//
// A CSS file uses a block comment, an HTML file an HTML comment after its doctype, and a Svelte
// component an HTML comment on its first lines. A file that starts with a shebang keeps it on
// the first line.
//
// Usage:
//   node scripts/spdx.mjs          fails when a tracked file has no header
//   node scripts/spdx.mjs --write  adds the header where it is missing

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const HOLDER = '2026 SAKAIDA Atsushi';
const LICENSE = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).license.startsWith(
  'SEE LICENSE',
)
  ? 'LicenseRef-Kasika-Commercial'
  : 'AGPL-3.0-only';

const CODE = /\.(ts|mts|cts|js|mjs|cjs)$/;
const EXT = /\.(ts|mts|cts|js|mjs|cjs|css|html|svelte)$/;
/**
 * Files that contain a port of third-party code keep the license of the original next to ours
 * (THIRD_PARTY_NOTICES.md names the originals)
 */
const PORTS = {
  'src/view/shaders/helpers.ts': 'MIT',
  'src/view/terrain/drape/shared.ts': 'BSD-3-Clause',
  'src/view/terrain/dem-atlas.ts': 'BSD-3-Clause',
  'src/view/renderers/polygon/earcut-sliced.ts': 'ISC',
};

/** Generated or third-party files that are not ours to label */
const SKIP = [/^dist\//, /^site-dist\//, /\/dist\//, /^docs\/reference\/api\//, /\/public\//];

function header(file) {
  const license = PORTS[file] ? `${LICENSE} AND ${PORTS[file]}` : LICENSE;
  const lines = [`SPDX-FileCopyrightText: ${HOLDER}`, `SPDX-License-Identifier: ${license}`];
  if (CODE.test(file)) return lines.map((l) => `// ${l}`).join('\n');
  if (file.endsWith('.css')) return `/*\n${lines.map((l) => ` * ${l}`).join('\n')}\n */`;
  return `<!--\n${lines.map((l) => `  ${l}`).join('\n')}\n-->`;
}

function withHeader(file, text) {
  const h = header(file);
  if (file.endsWith('.html') || file.endsWith('.svelte')) {
    const m = text.match(/^<!doctype html>\r?\n/i);
    if (m) return `${m[0]}${h}\n${text.slice(m[0].length)}`;
    return `${h}\n${text}`;
  }
  if (text.startsWith('#!')) {
    const end = text.indexOf('\n') + 1;
    return `${text.slice(0, end)}${h}\n${text.slice(end)}`;
  }
  return `${h}\n\n${text}`;
}

const write = process.argv.includes('--write');
const files = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
  .split('\n')
  .filter((f) => EXT.test(f) && !SKIP.some((re) => re.test(f)));

const missing = [];
for (const file of files) {
  let text = readFileSync(join(ROOT, file), 'utf8');
  const expected = header(file);
  if (text.includes(expected)) continue;
  if (text.slice(0, 400).includes('SPDX-License-Identifier:')) {
    // A header with another holder or license: replace it
    if (!write) {
      missing.push(file);
      continue;
    }
    text = text.replace(
      /^(#![^\n]*\n)?(<!doctype html>\r?\n)?(\/\/ SPDX-[^\n]*\n)+\n?|<!--\n( {2}SPDX-[^\n]*\n)+-->\n|\/\*\n( \* SPDX-[^\n]*\n)+ \*\/\n\n?/,
      (_m, shebang = '', doctype = '') => `${shebang}${doctype}`,
    );
  }
  if (write) writeFileSync(join(ROOT, file), withHeader(file, text));
  missing.push(file);
}

if (write) {
  console.log(`spdx: added the header to ${missing.length} of ${files.length} files`);
} else if (missing.length > 0) {
  console.error('spdx: files without the SPDX header (run node scripts/spdx.mjs --write):');
  for (const f of missing) console.error(`  ${f}`);
  process.exit(1);
} else {
  console.log(`spdx: ok (${files.length} files)`);
}
