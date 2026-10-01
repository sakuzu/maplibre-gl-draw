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
// - data-color-mode="light" on the root element switches every token kata's light theme sets,
//   not only color-scheme
//
// Usage: node scripts/check-dist.mjs

import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
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
  checkLight(css);
}

/** The custom properties a block of declarations sets */
function properties(block) {
  return new Set([...block.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
}

/** The tokens of kata's light theme are set on the root element with the attribute */
function checkLight(css) {
  const require = createRequire(import.meta.url);
  const kata = dirname(require.resolve('@sakuzu/kata/package.json'));
  const source = readFileSync(join(kata, 'dist/tokens.css'), 'utf8');
  const light = /\[data-color-mode="light"\]\s*\{([^}]*)\}/.exec(source);
  if (!light) {
    problems.push("kata's tokens have no light theme");
    return;
  }
  const want = properties(light[1]);
  const root = /\.mgd-ui(?::is\()?\[data-color-mode=(?:"light"|light)\]/;
  const have = new Set();
  for (const m of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    if (m[1].split(',').some((s) => root.test(s.trim()))) {
      for (const p of properties(m[2])) have.add(p);
    }
  }
  const missing = [...want].filter((p) => !have.has(p));
  if (missing.length > 0) {
    problems.push(`the light theme of the root element leaves out ${missing.join(', ')}`);
  }
}

if (problems.length > 0) {
  console.error('check-dist:');
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log('check-dist: ok');
