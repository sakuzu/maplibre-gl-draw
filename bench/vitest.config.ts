// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// The tests of the measurement pages that run without a browser (`npx vitest run --config
// bench/vitest.config.ts`): the library is taken from its sources, as the pages take it

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root,
  test: { include: ['*.test.ts'], environment: 'node', testTimeout: 30_000 },
  resolve: {
    alias: [
      {
        find: '@sakuzu/maplibre-gl-draw/table',
        replacement: resolve(root, '../src/table/index.ts'),
      },
      {
        find: '@sakuzu/maplibre-gl-draw/kasane',
        replacement: resolve(root, '../src/kasane/index.ts'),
      },
      { find: '@sakuzu/maplibre-gl-draw', replacement: resolve(root, '../src/index.ts') },
    ],
  },
});
