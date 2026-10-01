// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// Checks that the interface uses core through its public entries only.
//
// The interface is built on what core publishes, so that anything it does, an application can do
// with its own interface. A file under ui/src fails the check when it imports:
//
// - a path of core that is not one of the entries of core's package.json (`exports`), such as
//   `@sakuzu/maplibre-gl-draw/src/...` or `@sakuzu/maplibre-gl-draw/dist/...`
// - a relative path that leaves ui/ (`../../src/...`), or an absolute path
//
// Usage: node scripts/check-imports.mjs

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const UI = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(UI, 'src');
const CORE = '@sakuzu/maplibre-gl-draw';
const coreExports = JSON.parse(readFileSync(join(UI, '..', 'package.json'), 'utf8')).exports;
/** The specifiers of core's public entries */
const PUBLIC = new Set(
  Object.keys(coreExports)
    .filter((key) => key !== './package.json')
    .map((key) => (key === '.' ? CORE : `${CORE}/${key.slice(2)}`)),
);

const SPECIFIERS = [
  /\bfrom\s*['"]([^'"]+)['"]/g,
  /^\s*import\s*['"]([^'"]+)['"]/gm,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
];

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* walk(path);
    else if (/\.(ts|js|mjs|svelte)$/.test(name)) yield path;
  }
}

/** The broken rule of an import, or null */
function problem(file, spec) {
  if (isAbsolute(spec)) return 'an absolute path';
  if (spec.startsWith('.')) {
    const target = resolve(dirname(file), spec);
    if (target !== UI && !target.startsWith(UI + sep)) return 'a relative path out of ui/';
    return null;
  }
  if ((spec === CORE || spec.startsWith(`${CORE}/`)) && !PUBLIC.has(spec)) {
    return `not a public entry of core (${[...PUBLIC].join(', ')})`;
  }
  return null;
}

const hits = [];
let files = 0;
for (const file of walk(SRC)) {
  files += 1;
  // Comments are not imports
  const text = readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  for (const pattern of SPECIFIERS) {
    for (const m of text.matchAll(pattern)) {
      const why = problem(file, m[1]);
      if (why) hits.push(`${relative(UI, file)}: '${m[1]}' is ${why}`);
    }
  }
}

if (hits.length > 0) {
  console.error('check-imports: imports that go around the public API of core:');
  for (const h of hits) console.error(`  ${h}`);
  process.exit(1);
}
console.log(`check-imports: ok (${files} files)`);
