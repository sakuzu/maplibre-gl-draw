// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// The gate of the entries of the package: `exports` of package.json holds exactly the five
// entries of the library, the main entry, `/geometry`, `/table`, `/webgl` and `/store` (and
// `package.json`). An entry kept while its parts wait for their place fails the gate, so the work
// does not go on with it. An entry that is not there yet waits in the `entries` of
// scripts/gates/api-pending.json; one that is there and still listed fails, so the list only gets
// shorter.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readList, result } from './lib/files.mjs';

export const name = 'entries';

export const ENTRY_NAMES = ['.', './geometry', './table', './webgl', './store'];

/** @param {{ root: string }} ctx */
export function check(ctx) {
  const { root } = ctx;
  const out = result(name);
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const waiting = new Set(readList(root, 'api-pending.json').entries ?? []);
  const entries = Object.keys(pkg.exports ?? {}).filter((e) => e !== './package.json');
  for (const e of entries) {
    if (!ENTRY_NAMES.includes(e)) out.errors.push(`an entry that is not one of the library: ${e}`);
    if (waiting.has(e)) {
      out.errors.push(
        `${e} is there now; remove it from the entries of scripts/gates/api-pending.json`,
      );
    }
  }
  for (const e of ENTRY_NAMES) {
    if (!entries.includes(e) && !waiting.has(e)) out.errors.push(`an entry is missing: ${e}`);
  }
  for (const e of waiting) {
    if (!ENTRY_NAMES.includes(e))
      out.errors.push(`api-pending.json waits for ${e}, which is not an entry of the library`);
  }
  return out;
}
