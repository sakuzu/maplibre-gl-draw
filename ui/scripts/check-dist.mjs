// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// Checks the output of the build (the last step of `npm run build`):
//
// - the files of the package are there: dist/index.js, dist/index.d.ts,
//   dist/maplibre-gl-draw-ui.js and dist/style.css
// - dist/index.js imports only svelte, core and maplibre-gl, and the single file only core and
//   maplibre-gl (kata and the icons are compiled into both)
// - dist/style.css reaches nothing outside the root element: no :root, html or body selector,
//   and no rule for every element of the page
//
// Usage: node scripts/check-dist.mjs

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIST = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'dist');
const problems = [];

for (const file of ['index.js', 'index.d.ts', 'maplibre-gl-draw-ui.js', 'style.css']) {
  if (!existsSync(join(DIST, file))) problems.push(`dist/${file} is missing`);
}

const PEERS = /^(@sakuzu\/maplibre-gl-draw|maplibre-gl)(\/|$)/;
const SVELTE = /^svelte(\/|$)/;
const IMPORTS = [
  /\bfrom\s*["']([^"']+)["']/g,
  /\bimport\s*["']([^"']+)["']/g,
  /\bimport\(\s*["']([^"']+)["']\s*\)/g,
];

function checkImports(file, allowed) {
  const path = join(DIST, file);
  if (!existsSync(path)) return;
  const text = readFileSync(path, 'utf8');
  for (const pattern of IMPORTS) {
    for (const m of text.matchAll(pattern)) {
      const spec = m[1];
      if (spec.startsWith('.')) continue;
      if (!allowed.some((re) => re.test(spec))) problems.push(`dist/${file} imports ${spec}`);
    }
  }
}
checkImports('index.js', [SVELTE, PEERS]);
checkImports('maplibre-gl-draw-ui.js', [PEERS]);

const cssPath = join(DIST, 'style.css');
if (existsSync(cssPath)) {
  const css = readFileSync(cssPath, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  if (/:root\b/.test(css)) problems.push('dist/style.css has a :root selector');
  if (/(^|[{},;])\s*(html|body)\b/.test(css)) problems.push('dist/style.css styles html or body');
  if (/(^|[{},;])\s*\*/.test(css)) problems.push('dist/style.css has a rule for every element');
  if (!css.includes('.mgd-ui{') && !css.includes('.mgd-ui {')) {
    problems.push('dist/style.css does not put the tokens on .mgd-ui');
  }
}

if (problems.length > 0) {
  console.error('check-dist:');
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log('check-dist: ok');
