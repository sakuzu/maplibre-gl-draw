// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// Checks that the messages of the commits not yet on the main branch do not name or describe
// any particular extension.
//
// A commit message is published with the history, so it follows the rule the text of the
// repository follows (scripts/check-terms.mjs): the subject and the body are searched for the
// terms of the lists in scripts/terms.local/ (read by scripts/terms-local.mjs), and the check
// fails when a message holds one. A commit the lists let be (`allowCommits`) is skipped.
//
// Without a list, or without the base to compare with, there is nothing to check and it passes.
//
// Usage: node scripts/check-commit-terms.mjs [<range>]   (default: origin/main..HEAD)

import { execFileSync } from 'node:child_process';
import { readTermLists } from './terms-local.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const RANGE = process.argv[2] ?? 'origin/main..HEAD';

/** Runs git in the repository and returns its output, or null when it fails */
function git(args) {
  try {
    return execFileSync('git', args, {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 1 << 28,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

const lists = readTermLists(ROOT);
if (lists.count === 0) {
  console.log('check-commit-terms: ok (scripts/terms.local/ has no list)');
  process.exit(0);
}
const base = RANGE.includes('..') ? RANGE.split('..')[0] : null;
if (base && git(['rev-parse', '--verify', '--quiet', `${base}^{commit}`]) === null) {
  console.log(`check-commit-terms: ok (no ${base} to compare with)`);
  process.exit(0);
}

const log = git(['log', '--format=%H%x1f%B%x1e', RANGE]);
if (log === null) {
  console.error(`check-commit-terms: git log ${RANGE} failed`);
  process.exit(1);
}
const commits = log
  .split('\x1e')
  .map((entry) => entry.trim())
  .filter((entry) => entry !== '')
  .map((entry) => {
    const [hash, message = ''] = entry.split('\x1f');
    return { hash, message };
  });

const terms = lists.terms.filter((term) => term.commits);
const hits = [];
for (const { hash, message } of commits) {
  if (lists.allowedCommits.some((allowed) => allowed !== '' && hash.startsWith(allowed))) continue;
  message.split('\n').forEach((line, i) => {
    for (const term of terms) {
      if (term.pattern.test(line)) {
        hits.push(
          `${hash.slice(0, 8)}:${i + 1}: ${line.trim().slice(0, 120)}  [${term.pattern.source}]`,
        );
      }
    }
  });
}

if (hits.length > 0) {
  console.error('check-commit-terms: commit messages that name or describe an extension:');
  for (const h of hits) console.error(`  ${h}`);
  console.error(`check-commit-terms: ${hits.length} hit(s) in ${RANGE}`);
  process.exit(1);
}
console.log(`check-commit-terms: ok (${commits.length} commits in ${RANGE})`);
