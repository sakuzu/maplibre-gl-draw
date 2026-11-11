// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// Checks, before the package is published, that it has exactly the five entries the library
// promises: the main entry, `/geometry`, `/table`, `/webgl` and `/extend` (and `package.json`).
//
// An entry kept only while the parts it holds wait for their place in the others fails the check:
// it is not to be published. The check is part of `check:package`, not of `lint`, so that the work
// goes on while such an entry is still there.
//
// Usage: node scripts/check-entries.mjs

import { readFileSync } from 'node:fs';

const ROOT = new URL('..', import.meta.url).pathname;
const ENTRIES = ['.', './geometry', './table', './webgl', './extend'];

const pkg = JSON.parse(readFileSync(`${ROOT}package.json`, 'utf8'));
const entries = Object.keys(pkg.exports ?? {}).filter((entry) => entry !== './package.json');
const extra = entries.filter((entry) => !ENTRIES.includes(entry));
const missing = ENTRIES.filter((entry) => !entries.includes(entry));

if (extra.length > 0 || missing.length > 0) {
  console.error(
    `The entries of package.json are not the five of the library (${ENTRIES.join(', ')}):`,
  );
  for (const entry of extra) console.error(`  an entry to take out before publishing: ${entry}`);
  for (const entry of missing) console.error(`  an entry missing: ${entry}`);
  process.exit(1);
}
console.log(`check:entries: the ${ENTRIES.length} entries of the library`);
