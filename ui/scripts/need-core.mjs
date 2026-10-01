// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// Fails with a clear message when core has not been built.
//
// The interface takes core from the root package, whose entries point at its build (dist/), as
// an application gets it from npm. So core is built before the interface is type-checked,
// tested, built or served: `npm run build` at the root. A build that is out of date is not
// detected; build core again after changing it.
//
// Usage: node scripts/need-core.mjs

import { existsSync } from 'node:fs';

const dist = new URL('../../dist/', import.meta.url);
const missing = ['index.js', 'index.d.ts'].filter((file) => !existsSync(new URL(file, dist)));
if (missing.length > 0) {
  console.error(
    `need-core: core is not built (dist/${missing.join(', dist/')} missing). ` +
      'Run `npm run build` at the root of the repository first.',
  );
  process.exit(1);
}
