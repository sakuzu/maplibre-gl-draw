// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// The gate of the tests that are not run, or not run in full.
//
// Counts, in every test file, the marks that leave a test out or let it fail (`skip`, `todo`,
// `fails`, `only`, `skipIf`, `runIf`, `xit`, a `skip()` from the test context, and the same as
// options), the mentions of a list of known failures, and reads the allowances of the
// end-to-end tests: every variable named as a tolerance, a threshold or a margin, with the text of
// the expression that gives its value. It reads the `include` and `exclude` of the `test` of the
// vitest configurations too, which choose the test files that run. The gate fails when a file has
// more marks or mentions than scripts/gates/skips-baseline.json gives it, when the expression of an
// allowance is not the one of the baseline (`0.05 * 100` in place of `0.05` fails as `5` does), on
// an allowance the baseline does not have, and when the files a configuration includes or
// excludes are not those of the baseline. Only the maintainer changes the baseline.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeSignature } from './lib/declarations.mjs';
import { isTestFile, readList, result, walk } from './lib/files.mjs';
import { loadTypeScript } from './lib/ts.mjs';

export const name = 'skips';

const FOLDERS = ['src', 'ui', 'scripts', 'examples', 'playground', 'bench'];

const MARKS = [
  /\b(?:it|test|describe|suite|bench)(?:\.(?:concurrent|sequential|shuffle|each|for))*\.(?:skip|todo|fails|only|skipIf|runIf)\b/g,
  /\bx(?:it|test|describe)\s*\(/g,
  /\b(?:ctx|context|t|task)\.skip\s*\(/g,
  /\b(?:skip|todo|fails|only)\s*:\s*true\b/g,
];
const KNOWN = /\bknown[-_ ]?fail/gi;
/** The name of a variable that holds an allowance */
const ALLOWANCE =
  /^[A-Z0-9_]*(?:TOLERANCE|THRESHOLD|MAX_?DIFF|ALLOWED|EPSILON|EPS|SLACK|MARGIN)[A-Z0-9_]*$/i;

/** The vitest configurations whose `include` and `exclude` are compared with the baseline */
export const CONFIGS = ['vitest.config.ts', 'src/e2e/vitest.config.ts'];

/**
 * The allowances of a file: each variable named as one, with the expression of its value
 *
 * @returns {[string, string][]} The name (with `#2`, `#3` for a name declared again) and the text
 */
function allowancesOf(text, file) {
  const ts = loadTypeScript();
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const out = [];
  const counts = new Map();
  const visit = (n) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && ALLOWANCE.test(n.name.text)) {
      const k = (counts.get(n.name.text) ?? 0) + 1;
      counts.set(n.name.text, k);
      const value = n.initializer ? normalizeSignature(n.initializer.getText(sf)) : '';
      out.push([k > 1 ? `${n.name.text}#${k}` : n.name.text, value]);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/**
 * The `include` and `exclude` of the `test` of a vitest configuration, as text in normal form
 *
 * @returns {{ include: string | null, exclude: string | null } | null} Null when there is no file
 */
export function testFilesOf(root, file) {
  const abs = join(root, file);
  if (!existsSync(abs)) return null;
  const ts = loadTypeScript();
  const sf = ts.createSourceFile(file, readFileSync(abs, 'utf8'), ts.ScriptTarget.Latest, true);
  const out = { include: null, exclude: null };
  const nameOf = (p) =>
    p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? p.name.text : null;
  const visit = (n) => {
    if (
      ts.isPropertyAssignment(n) &&
      nameOf(n) === 'test' &&
      ts.isObjectLiteralExpression(n.initializer)
    ) {
      for (const p of n.initializer.properties) {
        const key = nameOf(p);
        if (key !== 'include' && key !== 'exclude') continue;
        out[key] = ts.isPropertyAssignment(p)
          ? normalizeSignature(p.initializer.getText(sf))
          : normalizeSignature(p.getText(sf));
      }
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

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
        for (const [n, value] of allowancesOf(text, file)) allowances[`${file}:${n}`] = value;
      }
    }
  }
  const configs = {};
  for (const file of CONFIGS) configs[file] = testFilesOf(root, file);
  return { marks, known, allowances, configs };
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
    else if (value !== was) {
      out.errors.push(`${key} = ${value}: the baseline gives it as ${was}`);
    }
  }
  for (const file of CONFIGS) {
    const was = base.configs?.[file];
    const conf = now.configs[file];
    if (was === undefined) {
      out.errors.push(`${file}: the baseline has no include and exclude of the configuration`);
      continue;
    }
    if (conf === null) {
      out.errors.push(`${file}: the configuration of the tests is missing`);
      continue;
    }
    for (const key of ['include', 'exclude']) {
      if (conf[key] !== (was[key] ?? null)) {
        out.errors.push(
          `${file}: the ${key} of the tests is ${conf[key] ?? 'not given'}, the baseline gives ${was[key] ?? 'none'}`,
        );
      }
    }
  }
  return out;
}
