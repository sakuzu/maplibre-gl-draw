// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  // @sakuzu/tabane is a clone next to this one with its own node_modules: one earcut for both, and
  // the package run through Vite, so that a test that mocks earcut sees the triangulation of rows
  resolve: { dedupe: ['earcut'] },
  test: {
    server: { deps: { inline: ['@sakuzu/tabane'] } },
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
