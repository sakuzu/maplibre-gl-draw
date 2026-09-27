// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// Prints the section of CHANGELOG.md for a release, for the body of the GitHub release.
//
// Usage: node scripts/release-notes.mjs vX.Y.Z
//
// It exits with 1 when the tag does not match the version in package.json, or when
// CHANGELOG.md has no `## [X.Y.Z] - YYYY-MM-DD` section with content.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const tag = process.argv[2] ?? '';

function fail(message) {
  process.stderr.write(`release-notes: ${message}\n`);
  process.exit(1);
}

const { version } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
if (tag !== `v${version}`)
  fail(`the tag ${tag || '(none)'} does not match package.json (v${version})`);

const lines = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8').split('\n');
const heading = new RegExp(`^## \\[${version.replaceAll('.', '\\.')}\\] - \\d{4}-\\d{2}-\\d{2}$`);
const start = lines.findIndex((line) => heading.test(line));
if (start === -1) fail(`CHANGELOG.md has no "## [${version}] - YYYY-MM-DD" section`);
const next = lines.findIndex((line, i) => i > start && /^## /.test(line));
const body = lines
  .slice(start + 1, next === -1 ? undefined : next)
  .filter((line) => !/^\[[^\]]+\]: /.test(line))
  .join('\n')
  .trim();
if (body === '') fail(`the section of ${version} in CHANGELOG.md is empty`);

process.stdout.write(`${body}\n`);
