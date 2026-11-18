// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// The gate of the fixed public declarations.
//
// Compares the declarations the build emits for each entry with the fixed file of the entry,
// api/core.<entry>.d.ts: the exported names, the shape of each type, the members, the parameters,
// the return types, and the TSDoc text with its whitespace and line breaks collapsed. The two
// sides are put in one normal form first (scripts/gates/lib/declarations.mjs), so the way the
// build writes a type and the way the fixed file writes it do not count, only what they say.
//
// The differences the published version still has wait in the `declarations` of
// scripts/gates/api-pending.json, under the number of the change that explains them. A row is the
// key of one difference with the digest of what the build has there now (its normal signature,
// its TSDoc and whether it is exported). The gate fails on a difference that is not listed, on a
// listed one that is gone (the change that makes the build match removes its rows, so the list
// only gets shorter), and on a listed one whose build no longer has the digest of its row: while
// it waits, a declaration has the form of the published version or the fixed form, nothing else.
// The work that changes a waiting declaration on its way writes the new digest in its own row; the
// gate prints it. The table and webgl entries have no list: their fixed files are the
// declarations of the published version.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  diffRecords,
  digestOfRecord,
  ENTRIES,
  exportedNames,
  fixedFileOf,
  recordsOfBuild,
  recordsOfFixedFile,
} from './lib/declarations.mjs';
import { readList, result } from './lib/files.mjs';

export const name = 'api';

/** The entries whose differences may not wait */
const FROZEN = new Set(['table', 'webgl']);

/**
 * Every difference between the build and the fixed files
 *
 * @param {string} root
 * @param {ReturnType<typeof recordsOfBuild>} built
 */
export function declarationDifferences(root, built) {
  const diffs = [];
  const missingFixed = [];
  const exported = exportedNames(built.entries);
  for (const { id } of ENTRIES) {
    const file = join(root, fixedFileOf(id));
    if (!existsSync(file)) {
      missingFixed.push(fixedFileOf(id));
      continue;
    }
    const elsewhere = new Set();
    for (const [other, names] of exported) {
      if (other !== id) for (const n of names) elsewhere.add(n);
    }
    diffs.push(...diffRecords(id, built.entries[id] ?? null, recordsOfFixedFile(file), elsewhere));
  }
  return { diffs, missingFixed };
}

/**
 * The digest of what the build has now at the declaration a key of a difference names
 *
 * @param {ReturnType<typeof recordsOfBuild>} built
 * @param {string} key `<entry>:<kind>:<name>`
 */
export function digestOfKey(built, key) {
  const [entry, , ...rest] = key.split(':');
  return digestOfRecord(built.entries[entry]?.[rest.join(':')]);
}

/** @param {{ root: string, built?: ReturnType<typeof recordsOfBuild> }} ctx */
export function check(ctx) {
  const { root } = ctx;
  const out = result(name);
  if (!existsSync(join(root, 'dist'))) {
    out.errors.push('dist/ is missing: run the build first');
    return out;
  }
  const built = ctx.built ?? recordsOfBuild(root);
  for (const p of built.problems) out.errors.push(`the build: ${p}`);

  const waiting = new Map();
  for (const [item, rows] of Object.entries(
    readList(root, 'api-pending.json').declarations ?? {},
  )) {
    if (!/^\d+$/.test(item))
      out.errors.push(`api-pending.json: "${item}" is not the number of a change`);
    if (typeof rows !== 'object' || rows === null || Array.isArray(rows)) {
      out.errors.push(
        `api-pending.json: change ${item} is not an object of the keys and their digests`,
      );
      continue;
    }
    for (const [key, digest] of Object.entries(rows)) {
      if (waiting.has(key)) out.errors.push(`api-pending.json: ${key} is listed twice`);
      if (FROZEN.has(key.split(':')[0])) {
        out.errors.push(`api-pending.json: ${key}: the ${key.split(':')[0]} entry may not wait`);
      }
      waiting.set(key, { item, digest });
    }
  }

  const { diffs, missingFixed } = declarationDifferences(root, built);
  for (const f of missingFixed) out.errors.push(`${f} is missing`);
  const found = new Set();
  for (const d of diffs) {
    found.add(d.key);
    const row = waiting.get(d.key);
    if (!row) {
      out.errors.push(`${d.key}: ${d.text}`);
      continue;
    }
    const now = digestOfKey(built, d.key);
    if (now !== row.digest) {
      out.errors.push(
        `${d.key} waits in change ${row.item} of scripts/gates/api-pending.json, and the build changed it: ` +
          `it has neither the form its row holds nor the fixed form (the row has ${row.digest}, the build gives ${now})`,
      );
    }
  }
  const kindOf = new Map(
    diffs.map((d) => [d.key.replace(/^(\w+):\w+:/, '$1:'), d.key.split(':')[1]]),
  );
  for (const [key, { item }] of waiting) {
    if (found.has(key)) continue;
    const now = kindOf.get(key.replace(/^(\w+):\w+:/, '$1:'));
    out.errors.push(
      now
        ? `${key} differs in another way now (${now}); change its row in change ${item} of scripts/gates/api-pending.json`
        : `${key} matches the fixed declaration now; remove it from change ${item} of scripts/gates/api-pending.json`,
    );
  }
  if (out.errors.length === 0) {
    out.notes.push(`${waiting.size} differences wait in api-pending.json`);
  }
  return out;
}
