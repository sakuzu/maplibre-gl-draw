// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// The gate of the records of the table of what the instance does (src/parity/records/): a row
// keeps the value it was recorded with on the published version. scripts/gates/parity-baseline.json
// holds the digest of the value of every row of those records, by axis. The gate fails when the
// value of a row is not the one of its digest and the row has no mark of a decided change in
// src/parity/marks.json, and when a row of the baseline is no longer recorded. A row the baseline
// does not have may be added. Only the maintainer changes the baseline.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readList, result } from './lib/files.mjs';

export const name = 'parity-records';

/** A value written with the keys of every object in order, so that the order of keys is no change */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** The digest of the value of a row */
export function digestOfValue(value) {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

/**
 * The digests of the rows of the text of a record file (a JSON line per row or scene)
 *
 * @param {string} text
 * @returns {Map<string, string>}
 */
export function rowDigests(text) {
  const out = new Map();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const entry = JSON.parse(line);
    if (typeof entry.row === 'string') out.set(entry.row, digestOfValue(entry.value));
  }
  return out;
}

/** @param {{ root: string }} ctx */
export function check(ctx) {
  const { root } = ctx;
  const out = result(name);
  const baseline = readList(root, 'parity-baseline.json').rows ?? {};
  const marksFile = join(root, 'src', 'parity', 'marks.json');
  const marks = existsSync(marksFile)
    ? (JSON.parse(readFileSync(marksFile, 'utf8')).marks ?? {})
    : {};
  let changed = 0;
  for (const [axis, rows] of Object.entries(baseline)) {
    const file = join(root, 'src', 'parity', 'records', `${axis}.jsonl`);
    const now = existsSync(file) ? rowDigests(readFileSync(file, 'utf8')) : new Map();
    for (const [row, digest] of Object.entries(rows)) {
      const current = now.get(row);
      if (current === undefined) {
        out.errors.push(
          `src/parity/records/${axis}.jsonl no longer records the row "${row}" of scripts/gates/parity-baseline.json`,
        );
      } else if (current !== digest) {
        if (marks[axis]?.[row]) changed += 1;
        else {
          out.errors.push(
            `src/parity/records/${axis}.jsonl: the value of the row "${row}" is not the one of scripts/gates/parity-baseline.json, and src/parity/marks.json has no mark for it`,
          );
        }
      }
    }
  }
  if (changed > 0) out.notes.push(`${changed} marked rows have a value of their change`);
  return out;
}
