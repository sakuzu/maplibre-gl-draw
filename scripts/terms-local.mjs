// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// Reads the local lists of terms that scripts/check-terms.mjs (the text of the repository) and
// scripts/check-commit-terms.mjs (the messages of the commits) check against.
//
// The lists are not kept in this repository, because they would themselves describe the
// extensions they guard against. A maintainer links them into scripts/terms.local/, which git
// ignores. A list is a JSON object. These keys are read, and the other keys of a file are left
// to other checks:
//
//   extension     [{ "source": "<regular expression>", "flags": "i", "skip": ["docs/x/"],
//                    "commits": false }]
//                 The terms that name or describe an extension. `skip` names the files, and the
//                 directories (ending with "/"), the term is not looked for in. `commits: false`
//                 leaves the term out of the check of the commit messages.
//   allow         [{ "file": "<path>", "source": "<regular expression>", "flags": "i" }]
//                 The lines of a file where any term is let be: those that match `source`, or
//                 every line of the file without it. An allowance no line needs fails the check,
//                 so that the list does not outlive the text it was made for.
//   allowCommits  ["<the hash of a commit, or its first characters>"]
//                 The commits whose messages are let be.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Whether a file is one of the entries, or under one of them (an entry that ends with "/" is a
 * directory)
 *
 * @param {string} file A path relative to the root of the repository
 * @param {readonly string[]} entries Files and directories relative to the root
 * @returns {boolean}
 */
export function within(file, entries) {
  return entries.some((entry) => (entry.endsWith('/') ? file.startsWith(entry) : file === entry));
}

/**
 * Reads every list of scripts/terms.local/ under a root
 *
 * @param {string} root The root of the repository
 */
export function readTermLists(root) {
  const dir = join(root, 'scripts/terms.local');
  const lists = existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith('.json'))
        .sort()
        .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')))
    : [];

  const terms = lists
    .flatMap((list) => list.extension ?? [])
    .map((t) => ({
      pattern: new RegExp(t.source, t.flags ?? ''),
      skip: t.skip ?? [],
      commits: t.commits !== false,
    }));

  const allowances = lists
    .flatMap((list) => list.allow ?? [])
    .map((a) => ({
      file: a.file,
      pattern: a.source === undefined ? null : new RegExp(a.source, a.flags ?? ''),
      used: false,
    }));

  const allowedCommits = lists.flatMap((list) => list.allowCommits ?? []);

  return {
    /** The number of lists read */
    count: lists.length,
    /** The terms of every list */
    terms,
    /** The commits whose messages are let be (hashes or their first characters) */
    allowedCommits,
    /**
     * Whether a line of a file is let be by an allowance (the allowance is then marked used)
     *
     * @param {string} file A path relative to the root
     * @param {string} line The text of the line
     * @returns {boolean}
     */
    allowLine(file, line) {
      let allowed = false;
      for (const a of allowances) {
        if (a.file !== file || (a.pattern !== null && !a.pattern.test(line))) continue;
        a.used = true;
        allowed = true;
      }
      return allowed;
    },
    /**
     * The allowances that let no line be, as `file [source]`
     *
     * @returns {string[]}
     */
    unusedAllowances() {
      return allowances
        .filter((a) => !a.used)
        .map((a) => (a.pattern === null ? a.file : `${a.file} [${a.pattern.source}]`));
    },
  };
}
