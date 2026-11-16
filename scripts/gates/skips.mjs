// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// The gate of the tests that are not run, or not run in full.
//
// Counts, in every test file, the marks that leave a test out or let it fail (`skip`, `todo`,
// `fails`, `only`, `skipIf`, `runIf`, `xit`, a `skip()` from the test context, and the same as
// options), the mentions of a list of known failures, and reads the allowances of the
// end-to-end tests (a constant named as a tolerance, a threshold or a margin). The gate fails
// when a file has more marks or mentions than scripts/gates/skips-baseline.json gives it, when an
// allowance is wider than its baseline, and on an allowance the baseline does not have. Only
// the maintainer changes the baseline.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isTestFile, readList, result, walk } from './lib/files.mjs';

export const name = 'skips';

const FOLDERS = ['src', 'ui', 'scripts', 'examples', 'playground', 'bench'];

const MARKS = [
  /\b(?:it|test|describe|suite|bench)(?:\.(?:concurrent|sequential|shuffle|each|for))*\.(?:skip|todo|fails|only|skipIf|runIf)\b/g,
  /\bx(?:it|test|describe)\s*\(/g,
  /\b(?:ctx|context|t|task)\.skip\s*\(/g,
  /\b(?:skip|todo|fails|only)\s*:\s*true\b/g,
];
const KNOWN = /\bknown[-_ ]?fail/gi;
const ALLOWANCE =
  /^\s*(?:export\s+)?const\s+([A-Z0-9_]*(?:TOLERANCE|THRESHOLD|MAX_?DIFF|ALLOWED|EPSILON|EPS|SLACK|MARGIN)[A-Z0-9_]*)\s*=\s*([-+]?[\d.]+(?:e[-+]?\d+)?)\s*;/gim;

/** What the gate counts in the test files of a tree */
export function countSkips(root) {
  const marks = {};
  const known = {};
  const allowances = {};
  for (const folder of FOLDERS) {
    for (const file of walk(root, folder, (f) => isTestFile(f) && /\.(ts|mts|js|mjs)$/.test(f))) {
      const text = readFileSync(join(root, file), 'utf8');
      const m = MARKS.reduce((n, re) => n + [...text.matchAll(re)].length, 0);
      if (m > 0) marks[file] = m;
      const k = [...text.matchAll(KNOWN)].length;
      if (k > 0) known[file] = k;
      if (/(^|\/)e2e\//.test(file)) {
        for (const a of text.matchAll(ALLOWANCE)) allowances[`${file}:${a[1]}`] = Number(a[2]);
      }
    }
  }
  return { marks, known, allowances };
}

/** @param {{ root: string }} ctx */
export function check(ctx) {
  const { root } = ctx;
  const out = result(name);
  const base = readList(root, 'skips-baseline.json');
  const now = countSkips(root);
  for (const [kind, label] of [
    ['marks', 'marks that leave a test out or let it fail'],
    ['known', 'mentions of known failures'],
  ]) {
    for (const [file, n] of Object.entries(now[kind])) {
      const was = base[kind]?.[file] ?? 0;
      if (n > was) out.errors.push(`${file}: ${n} ${label}, the baseline is ${was}`);
    }
  }
  for (const [key, value] of Object.entries(now.allowances)) {
    const was = base.allowances?.[key];
    if (was === undefined)
      out.errors.push(`${key} = ${value}: an allowance the baseline does not have`);
    else if (Math.abs(value) > Math.abs(was)) {
      out.errors.push(`${key} = ${value}: wider than the baseline (${was})`);
    }
  }
  return out;
}
