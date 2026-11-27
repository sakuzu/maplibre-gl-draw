#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// Runs every gate (`npm run gates`, after the build). Each gate prints what it fails on; the
// exit code is 1 when any gate fails. `node scripts/gates/run.mjs <name> ...` runs only those.

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as api from './api.mjs';
import * as branch from './branch.mjs';
import * as deps from './deps.mjs';
import * as entries from './entries.mjs';
import * as extensionPoints from './extension-points.mjs';
import * as fileLength from './file-length.mjs';
import * as imports from './imports.mjs';
import { recordsOfBuild } from './lib/declarations.mjs';
import * as moduleState from './module-state.mjs';
import * as parityRecords from './parity-records.mjs';
import * as samples from './samples.mjs';
import * as skips from './skips.mjs';
import * as storeWrites from './store-writes.mjs';
import * as terms from './terms.mjs';
import * as testChanges from './test-changes.mjs';
import * as workScenes from './work-scenes.mjs';

export const GATES = [
  api,
  samples,
  entries,
  imports,
  terms,
  deps,
  extensionPoints,
  skips,
  testChanges,
  branch,
  moduleState,
  storeWrites,
  workScenes,
  parityRecords,
  fileLength,
];

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const only = process.argv.slice(2);
const chosen = only.length ? GATES.filter((g) => only.includes(g.name)) : GATES;
let built = null;
const ctx = {
  root,
  env: process.env,
  get built() {
    built ??= recordsOfBuild(root);
    return built;
  },
};

let failed = 0;
for (const gate of chosen) {
  let r;
  try {
    r = gate.check(ctx);
  } catch (error) {
    r = { name: gate.name, errors: [`the gate threw: ${error?.stack ?? error}`], notes: [] };
  }
  if (r.errors.length > 0) {
    failed += 1;
    console.error(`gates: ${r.name}: ${r.errors.length} problem(s)`);
    for (const e of r.errors) console.error(`  ${e}`);
  } else {
    console.log(`gates: ${r.name}: ok${r.notes.length ? ` (${r.notes.join('; ')})` : ''}`);
  }
}
console.log(`gates: ${chosen.length - failed} of ${chosen.length} passed`);
process.exit(failed > 0 ? 1 : 0);
