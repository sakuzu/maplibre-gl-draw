// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The vitest configuration of the end-to-end tests of the interface (`npm run test:e2e` in ui/,
 * `npm run ui:test:e2e` at the root)
 *
 * They build a page in memory, start headless Chromium and drive the interface on a real map
 * with the real pointer and keyboard, so they run apart from the unit tests (jsdom).
 */

import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { browserTimeout } from './timeout.js';

export default defineConfig({
  root: fileURLToPath(new URL('..', import.meta.url)),
  test: {
    environment: 'node',
    include: ['e2e/**/*.e2e.test.ts'],
    testTimeout: browserTimeout(30_000),
    hookTimeout: browserTimeout(90_000),
  },
});
