// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The vitest configuration of the end-to-end tests (`vitest run --config src/e2e/vitest.config.ts`)
 *
 * They start headless Chromium and compile the shaders on its software WebGL, which takes
 * about ten seconds, so they run apart from the unit tests.
 */

import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { browserTimeout } from '../test-utils.js';

export default defineConfig({
  root: fileURLToPath(new URL('../..', import.meta.url)),
  test: {
    globals: true,
    environment: 'node',
    include: ['src/e2e/**/*.test.ts'],
    testTimeout: browserTimeout(30_000),
    hookTimeout: browserTimeout(60_000),
  },
});
