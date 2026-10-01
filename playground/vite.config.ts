// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  // Relative asset paths, so the build can be served from any directory (GitHub Pages)
  base: './',
  build: {
    // The page bundles maplibre-gl, the whole library and the standard UI in one script
    chunkSizeWarningLimit: 3000,
  },
  server: {
    // A port of its own, kept: the pages of the examples frame the playground from this address
    port: 3300,
    strictPort: true,
    open: true,
  },
  resolve: {
    // As in the examples: the library from its sources, the standard UI from its build
    // (npm run ui:build), which imports core by its name and gets the same sources
    alias: [
      {
        find: /^@sakuzu\/maplibre-gl-draw\/geometry$/,
        replacement: resolve(root, '../src/geometry/index.ts'),
      },
      {
        find: /^@sakuzu\/maplibre-gl-draw\/table$/,
        replacement: resolve(root, '../src/table/index.ts'),
      },
      { find: /^@sakuzu\/maplibre-gl-draw$/, replacement: resolve(root, '../src/index.ts') },
      {
        find: /^@sakuzu\/maplibre-gl-draw-ui\/style\.css$/,
        replacement: resolve(root, '../ui/dist/style.css'),
      },
      {
        find: /^@sakuzu\/maplibre-gl-draw-ui$/,
        replacement: resolve(root, '../ui/dist/index.js'),
      },
    ],
  },
});
