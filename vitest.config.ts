// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

import { fileURLToPath } from 'node:url';
import { configDefaults, defineConfig } from 'vitest/config';

const path = (to: string): string => fileURLToPath(new URL(to, import.meta.url));

export default defineConfig({
  // The tests take the package of the tests of a storage from its source, and it takes the entry
  // of core it imports from the source being tested (not from the build)
  resolve: {
    alias: [
      {
        find: /^@sakuzu\/maplibre-gl-draw-testing$/,
        replacement: path('./testing/src/index.ts'),
      },
      { find: /^@sakuzu\/maplibre-gl-draw\/extend$/, replacement: path('./src/extend/index.ts') },
    ],
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // The end-to-end tests start a browser and run separately (`npm run test:e2e`)
    exclude: [...configDefaults.exclude, 'src/e2e/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/**/index.ts'],
    },
  },
});
