// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  base: './',
  server: {
    port: 3002,
    open: '/perf.html',
  },
  build: {
    // Each page bundles maplibre-gl and the whole library in one script
    chunkSizeWarningLimit: 2500,
    rolldownOptions: {
      input: {
        perf: resolve(root, 'perf.html'),
        bench: resolve(root, 'bench.html'),
        drape: resolve(root, 'drape.html'),
      },
    },
  },
  resolve: {
    alias: {
      // The library is taken from its sources, so a change is measured without a build
      '@sakuzu/maplibre-gl-draw': resolve(root, '../src/index.ts'),
    },
  },
});
