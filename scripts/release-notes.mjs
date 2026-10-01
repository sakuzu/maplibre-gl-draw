// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// Prints the section of a changelog for a release, for the body of the GitHub release.
//
// Usage:
//   node scripts/release-notes.mjs vX.Y.Z                       core (CHANGELOG.md, tags vX.Y.Z)
//   node scripts/release-notes.mjs ui-vX.Y.Z --changelog ui/CHANGELOG.md --prefix ui-v
//
// --changelog names the changelog, relative to the root of the repository (CHANGELOG.md by
// default); the version is read from the package.json next to it. --prefix is what the tag puts
// before the version (v by default).
//
// It exits with 1 when the tag does not match the version in that package.json, or when the
// changelog has no `## [X.Y.Z] - YYYY-MM-DD` section with content.

import { readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function fail(message) {
  process.stderr.write(`release-notes: ${message}\n`);
  process.exit(1);
}

let parsed;
try {
  parsed = parseArgs({
    allowPositionals: true,
    options: {
      changelog: { type: 'string', default: 'CHANGELOG.md' },
      prefix: { type: 'string', default: 'v' },
    },
  });
} catch (error) {
  fail(error.message);
}
const tag = parsed.positionals[0] ?? '';
const { changelog, prefix } = parsed.values;
const changelogPath = join(ROOT, changelog);
const manifest = join(dirname(changelogPath), 'package.json');

const { version } = JSON.parse(readFileSync(manifest, 'utf8'));
const expected = `${prefix}${version}`;
if (tag !== expected) {
  fail(`the tag ${tag || '(none)'} does not match ${relative(ROOT, manifest)} (${expected})`);
}

const lines = readFileSync(changelogPath, 'utf8').split('\n');
const heading = new RegExp(`^## \\[${version.replaceAll('.', '\\.')}\\] - \\d{4}-\\d{2}-\\d{2}$`);
const start = lines.findIndex((line) => heading.test(line));
if (start === -1) fail(`${changelog} has no "## [${version}] - YYYY-MM-DD" section`);
const next = lines.findIndex((line, i) => i > start && /^## /.test(line));
const body = lines
  .slice(start + 1, next === -1 ? undefined : next)
  .filter((line) => !/^\[[^\]]+\]: /.test(line))
  .join('\n')
  .trim();
if (body === '') fail(`the section of ${version} in ${changelog} is empty`);

process.stdout.write(`${body}\n`);
