// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// Checks that core does not describe or depend on any particular extension.
//
// Core is a general drawing library. Its documentation, comments and examples must not
// name an extension package, its plugins or its feature types, nor describe how such an
// extension is built. This script greps the tracked text of the repository for a list of
// terms that would leak that, and fails when any is found outside the allowed places.
//
// It also fails on the retired names of scripts/term-map.json, so that a rename done with
// scripts/rename-terms.mjs leaves nothing of the old name behind.
//
// The writing rules of the documents (no product that uses the library, no history of the
// work, no dates or work notes) are the terms step of scripts/docs-check.mjs instead.
//
// Usage: node scripts/check-terms.mjs

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const SCAN = [
  'README.md',
  'CONTRIBUTING.md',
  'CONTRIBUTING.ja.md',
  'SECURITY.md',
  'CHANGELOG.md',
  'docs',
  'src',
  'examples',
  'scripts',
  'ui',
];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'public', '.pack']);
/** Generated output that is not written by hand, and the local list of terms itself */
const SKIP_PATHS = ['docs/reference/api', 'scripts/terms.local'];
const EXT = /\.(md|ts|mts|mjs|js|html|css|json|svelte)$/;

/**
 * Terms that name or describe an extension
 *
 * The lists are not kept in this repository, because they would themselves describe the
 * extensions they guard against. A maintainer links them into scripts/terms.local/, which git
 * ignores. The `extension` of every file is read:
 * `{ "extension": [{ "source": "<regular expression>", "flags": "i" }, ...] }`, and the other keys
 * of a file are left to other checks. Without a list, only the retired names are checked.
 */
const LOCAL_DIR = join(ROOT, 'scripts/terms.local');
const localLists = existsSync(LOCAL_DIR)
  ? readdirSync(LOCAL_DIR)
      .filter((f) => f.endsWith('.json'))
      .sort()
      .map((f) => JSON.parse(readFileSync(join(LOCAL_DIR, f), 'utf8')))
  : [];
const TERMS = localLists
  .flatMap((list) => list.extension ?? [])
  .map((t) => new RegExp(t.source, t.flags ?? ''));

/** Retired names: the old side of every rename in scripts/term-map.json */
const RETIRED = JSON.parse(readFileSync(join(ROOT, 'scripts/term-map.json'), 'utf8')).retired.map(
  (source) => new RegExp(source),
);
/** Where the retired names are looked for: everything written by hand */
const RETIRED_SCAN = [...SCAN, 'README.ja.md', 'playground', 'bench'];
/** The files that list the renames themselves */
const RENAME_FILES = new Set(['scripts/term-map.json', 'scripts/rename-terms.mjs']);

/** Places where a term is expected (the commercial license contact, the security contact) */
const ALLOW = [
  { file: 'README.md', pattern: /Kasika, Inc\.|kasika\.xyz/ },
  { file: 'README.ja.md', pattern: /Kasika, Inc\.|kasika\.xyz|可視化技研/ },
  { file: 'SECURITY.md', pattern: /kasika\.xyz/ },
  { file: 'scripts/check-terms.mjs', pattern: /./ },
];

function* walk(path) {
  const st = statSync(path);
  if (st.isDirectory()) {
    for (const name of readdirSync(path)) {
      if (SKIP_DIRS.has(name)) continue;
      if (SKIP_PATHS.includes(relative(ROOT, join(path, name)))) continue;
      yield* walk(join(path, name));
    }
  } else if (EXT.test(path)) {
    yield path;
  }
}

const hits = [];
for (const entry of SCAN) {
  let abs;
  try {
    abs = join(ROOT, entry);
    statSync(abs);
  } catch {
    continue;
  }
  for (const file of walk(abs)) {
    const rel = relative(ROOT, file);
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      for (const term of TERMS) {
        if (!term.test(line)) continue;
        if (ALLOW.some((a) => a.file === rel && a.pattern.test(line))) continue;
        hits.push(`${rel}:${i + 1}: ${line.trim().slice(0, 120)}  [${term.source}]`);
      }
    });
  }
}

const retiredHits = [];
for (const entry of RETIRED_SCAN) {
  let abs;
  try {
    abs = join(ROOT, entry);
    statSync(abs);
  } catch {
    continue;
  }
  for (const file of walk(abs)) {
    const rel = relative(ROOT, file);
    if (RENAME_FILES.has(rel)) continue;
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      for (const term of RETIRED) {
        if (term.test(line)) {
          retiredHits.push(`${rel}:${i + 1}: ${line.trim().slice(0, 120)}  [${term.source}]`);
        }
      }
    });
  }
}

if (hits.length > 0) {
  console.error('check-terms: text that names or describes an extension:');
  for (const h of hits) console.error(`  ${h}`);
  console.error(`check-terms: ${hits.length} hit(s)`);
}
if (retiredHits.length > 0) {
  console.error('check-terms: retired names (see scripts/term-map.json):');
  for (const h of retiredHits) console.error(`  ${h}`);
  console.error(`check-terms: ${retiredHits.length} hit(s)`);
}
if (hits.length > 0 || retiredHits.length > 0) process.exit(1);
if (localLists.length === 0) {
  console.log('check-terms: ok (retired names only; scripts/terms.local/ has no list)');
} else {
  console.log('check-terms: ok');
}
