// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// Fails with a clear message when the standard UI has not been built.
//
// The examples take the standard UI (`@sakuzu/maplibre-gl-draw-ui`) from its build, ui/dist/,
// as an application gets it from npm (examples/vite.config.ts). So the UI is built before the
// examples are served, built or tested: `npm run build` (core, which the UI is built against)
// and then `npm run ui:build` at the root. A build that is out of date is not detected; build
// the UI again after changing it.
//
// Usage: node scripts/need-ui.mjs

import { existsSync } from 'node:fs';

const dist = new URL('../ui/dist/', import.meta.url);
const missing = ['index.js', 'index.d.ts', 'style.css'].filter(
  (file) => !existsSync(new URL(file, dist)),
);
if (missing.length > 0) {
  console.error(
    `need-ui: the standard UI is not built (ui/dist/${missing.join(', ui/dist/')} missing). ` +
      'Run `npm run build && npm run ui:build` at the root of the repository first.',
  );
  process.exit(1);
}
