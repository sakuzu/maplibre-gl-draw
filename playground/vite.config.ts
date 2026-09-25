// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  // Relative asset paths, so the build can be served from any directory (GitHub Pages)
  base: './',
  // The sample data is shared with the examples
  publicDir: resolve(root, '../examples/public'),
  build: {
    // The page bundles maplibre-gl and the whole library in one script
    chunkSizeWarningLimit: 2500,
  },
  server: {
    port: 3001,
    open: true,
  },
  resolve: {
    alias: {
      // The library is taken from its sources, so a change shows without a build
      '@sakuzu/maplibre-gl-draw': resolve(root, '../src/index.ts'),
    },
  },
});
