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
// scripts/gates/api-pending.json, under the number of the change that explains them. The gate fails
// on a difference that is not listed, and on a listed one that is gone: the unit that makes the
// build match removes its rows, so the list only gets shorter. The table and webgl entries have
// no list: their fixed files are the declarations of the published version.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  diffRecords,
  ENTRIES,
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
  for (const { id } of ENTRIES) {
    const file = join(root, fixedFileOf(id));
    if (!existsSync(file)) {
      missingFixed.push(fixedFileOf(id));
      continue;
    }
    diffs.push(...diffRecords(id, built.entries[id] ?? null, recordsOfFixedFile(file)));
  }
  return { diffs, missingFixed };
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
  for (const [item, keys] of Object.entries(
    readList(root, 'api-pending.json').declarations ?? {},
  )) {
    if (!/^\d+$/.test(item))
      out.errors.push(`api-pending.json: "${item}" is not the number of a change`);
    for (const key of keys) {
      if (waiting.has(key)) out.errors.push(`api-pending.json: ${key} is listed twice`);
      if (FROZEN.has(key.split(':')[0])) {
        out.errors.push(`api-pending.json: ${key}: the ${key.split(':')[0]} entry may not wait`);
      }
      waiting.set(key, item);
    }
  }

  const { diffs, missingFixed } = declarationDifferences(root, built);
  for (const f of missingFixed) out.errors.push(`${f} is missing`);
  const found = new Set();
  for (const d of diffs) {
    found.add(d.key);
    if (!waiting.has(d.key)) out.errors.push(`${d.key}: ${d.text}`);
  }
  for (const [key, item] of waiting) {
    if (!found.has(key)) {
      out.errors.push(
        `${key} matches the fixed declaration now; remove it from change ${item} of scripts/gates/api-pending.json`,
      );
    }
  }
  if (out.errors.length === 0) {
    out.notes.push(`${waiting.size} differences wait in api-pending.json`);
  }
  return out;
}
