// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// Checks that core does not describe or depend on any particular extension.
//
// Core is a general drawing library. Its documentation, comments, tests and examples must not
// name an extension package, its plugins or its feature types, nor describe how such an
// extension is built. This script greps the tracked text of the repository for a list of
// terms that would leak that, and fails when any is found outside the allowed places. The
// messages of the commits are checked against the same lists by scripts/check-commit-terms.mjs.
//
// It also fails on the retired names of scripts/term-map.json, so that a rename done with
// scripts/rename-terms.mjs leaves nothing of the old name behind.
//
// The writing rules of the documents (no product that uses the library, no history of the
// work, no dates or work notes) are the terms step of scripts/docs-check.mjs instead.
//
// Usage: node scripts/check-terms.mjs

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readTermLists, within } from './terms-local.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
/** What is checked: these files, and the files under these directories */
const SCAN = [
  'README.md',
  'README.ja.md',
  'CONTRIBUTING.md',
  'CONTRIBUTING.ja.md',
  'SECURITY.md',
  'CHANGELOG.md',
  'docs/',
  'src/',
  'examples/',
  'scripts/',
  'ui/',
  'playground/',
];
/** Generated output that is not written by hand, and the local list of terms itself */
const SKIP_PATHS = ['docs/reference/api/', 'scripts/terms.local/'];
const EXT = /\.(md|ts|mts|mjs|js|html|css|json|svelte)$/;

/**
 * Terms that name or describe an extension, from the lists of scripts/terms.local/
 * (scripts/terms-local.mjs reads them). Without a list, only the retired names are checked.
 */
const LISTS = readTermLists(ROOT);
const TERMS = LISTS.terms;

/** Retired names: the old side of every rename in scripts/term-map.json */
const RETIRED = JSON.parse(readFileSync(join(ROOT, 'scripts/term-map.json'), 'utf8')).retired.map(
  (source) => new RegExp(source),
);
/** Where the retired names are looked for: everything written by hand */
const RETIRED_SCAN = [...SCAN, 'bench/'];
/** The files that list the renames themselves */
const RENAME_FILES = new Set(['scripts/term-map.json', 'scripts/rename-terms.mjs']);

/** Places where a term is expected (the commercial license contact, the security contact) */
const ALLOW = [
  { file: 'README.md', pattern: /Kasika, Inc\.|kasika\.xyz/ },
  { file: 'README.ja.md', pattern: /Kasika, Inc\.|kasika\.xyz|可視化技研/ },
  { file: 'SECURITY.md', pattern: /kasika\.xyz/ },
  { file: 'scripts/check-terms.mjs', pattern: /./ },
];

/** The tracked files and the new files git does not ignore, relative to the root */
function trackedFiles() {
  return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 1 << 28,
  })
    .split('\n')
    .filter((file) => file !== '' && EXT.test(file) && existsSync(join(ROOT, file)))
    .filter((file) => !SKIP_PATHS.some((skip) => file.startsWith(skip)));
}

const files = trackedFiles();
const hits = [];
const retiredHits = [];
for (const rel of files) {
  const scanned = within(rel, SCAN);
  const retiredScanned = within(rel, RETIRED_SCAN) && !RENAME_FILES.has(rel);
  if (!scanned && !retiredScanned) continue;
  const lines = readFileSync(join(ROOT, rel), 'utf8').split('\n');
  lines.forEach((line, i) => {
    if (scanned) {
      for (const term of TERMS) {
        if (within(rel, term.skip) || !term.pattern.test(line)) continue;
        if (ALLOW.some((a) => a.file === rel && a.pattern.test(line))) continue;
        if (LISTS.allowLine(rel, line)) continue;
        hits.push(`${rel}:${i + 1}: ${line.trim().slice(0, 120)}  [${term.pattern.source}]`);
      }
    }
    if (retiredScanned) {
      for (const term of RETIRED) {
        if (term.test(line)) {
          retiredHits.push(`${rel}:${i + 1}: ${line.trim().slice(0, 120)}  [${term.source}]`);
        }
      }
    }
  });
}

/** Allowances of the lists that no line needs any more: they are taken out of the list */
const unused = LISTS.unusedAllowances();

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
if (unused.length > 0) {
  console.error('check-terms: allowances of scripts/terms.local/ that no line needs any more:');
  for (const a of unused) console.error(`  ${a}`);
}
if (hits.length > 0 || retiredHits.length > 0 || unused.length > 0) process.exit(1);
if (LISTS.count === 0) {
  console.log('check-terms: ok (retired names only; scripts/terms.local/ has no list)');
} else {
  console.log('check-terms: ok');
}
