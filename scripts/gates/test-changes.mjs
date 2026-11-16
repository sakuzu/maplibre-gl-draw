// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// The gate of the changes to the tests: a test file (`*.test.*` and the files of the end-to-end
// tests) that the working tree changed or deleted since `redesign/main` is a row of
// scripts/gates/test-changes-allowed.json. A row has the path, the number of the change (or the
// work) it follows from and the work that changes it. A new test file needs no row.

import { isTestFile, readList, result } from './lib/files.mjs';
import { firstRef, git } from './lib/git.mjs';

export const name = 'test-changes';

export const BASE_REFS = ['redesign/main', 'origin/redesign/main'];

/** @param {{ root: string, baseRefs?: string[] }} ctx */
export function check(ctx) {
  const { root } = ctx;
  const out = result(name);
  const base = firstRef(root, ctx.baseRefs ?? BASE_REFS);
  if (!base) {
    out.errors.push(
      `no base to compare the tests with (${(ctx.baseRefs ?? BASE_REFS).join(', ')})`,
    );
    return out;
  }
  const allowed = readList(root, 'test-changes-allowed.json').allowed ?? [];
  const byPath = new Map(allowed.map((a) => [a.path, a]));
  for (const a of allowed) {
    if (!a.path || !a.change || !a.unit) {
      out.errors.push(
        `a row of test-changes-allowed.json without its path, change and unit: ${JSON.stringify(a)}`,
      );
    }
  }
  const mergeBase = git(root, ['merge-base', base, 'HEAD']).trim();
  // Against the working tree, so that a change not committed yet counts too
  const lines = git(root, ['diff', '--name-status', '--no-renames', mergeBase, '--']).trim();
  for (const line of lines ? lines.split('\n') : []) {
    const [status, path] = line.split('\t');
    if (status === 'A' || !isTestFile(path)) continue;
    if (byPath.has(path)) continue;
    const what = status === 'D' ? 'deletes' : 'changes';
    out.errors.push(`${what} ${path}, which scripts/gates/test-changes-allowed.json does not list`);
  }
  return out;
}
