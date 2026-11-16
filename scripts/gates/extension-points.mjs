// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// The gate of the extension points (scripts/gates/extension-points.json): every point of the
// published version is still in the declarations the build emits and in the fixed declarations
// of api/, except the points a change took out.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ENTRIES, fixedFileOf, recordsOfBuild, recordsOfFixedFile } from './lib/declarations.mjs';
import { readList, result } from './lib/files.mjs';

export const name = 'extension-points';

/** A record key without the number of an overload, a repeated member or a member of a union */
const pointOf = (key) =>
  key
    .replace(/#overload\d+$/, '')
    .replace(/#\d+$/, '')
    .replace(/\{\d+\}/g, '');

/** @param {{ root: string, built?: ReturnType<typeof recordsOfBuild> }} ctx */
export function check(ctx) {
  const { root } = ctx;
  const out = result(name);
  if (!existsSync(join(root, 'dist'))) {
    out.errors.push('dist/ is missing: run the build first');
    return out;
  }
  const built = ctx.built ?? recordsOfBuild(root);
  const inBuild = new Set(Object.values(built.entries).flatMap((e) => Object.keys(e).map(pointOf)));
  const inFixed = new Set();
  for (const { id } of ENTRIES) {
    const file = join(root, fixedFileOf(id));
    if (existsSync(file))
      for (const k of Object.keys(recordsOfFixedFile(file))) inFixed.add(pointOf(k));
  }
  for (const p of readList(root, 'extension-points.json').points) {
    if (!p.removed) {
      if (!inBuild.has(p.key)) out.errors.push(`${p.key}: the build has lost this extension point`);
      if (!inFixed.has(p.key))
        out.errors.push(`${p.key}: the fixed declarations do not have this extension point`);
      continue;
    }
    if (inFixed.has(p.key)) {
      out.errors.push(
        `${p.key}: taken out by change ${p.removed.change}, but the fixed declarations have it`,
      );
    }
    if (p.pending && !inBuild.has(p.key)) {
      out.errors.push(
        `${p.key} is out of the build now; clear its pending in scripts/gates/extension-points.json`,
      );
    }
    if (!p.pending && inBuild.has(p.key)) {
      out.errors.push(
        `${p.key}: taken out by change ${p.removed.change}, but the build has it again`,
      );
    }
  }
  return out;
}
