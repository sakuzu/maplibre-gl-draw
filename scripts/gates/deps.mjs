// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// The gate of the dependencies: every package of `dependencies`, `optionalDependencies` and
// `peerDependencies` of package.json is one of scripts/gates/deps-allowed.json.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readList, result } from './lib/files.mjs';

export const name = 'deps';

/** @param {{ root: string }} ctx */
export function check(ctx) {
  const { root } = ctx;
  const out = result(name);
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const allowed = readList(root, 'deps-allowed.json');
  const lists = [
    ['dependencies', allowed.dependencies],
    ['optionalDependencies', allowed.dependencies],
    ['peerDependencies', allowed.peerDependencies],
  ];
  for (const [field, names] of lists) {
    for (const dep of Object.keys(pkg[field] ?? {})) {
      if (!names.includes(dep)) {
        out.errors.push(
          `${field} of package.json has ${dep}, which scripts/gates/deps-allowed.json does not list`,
        );
      }
    }
  }
  return out;
}
