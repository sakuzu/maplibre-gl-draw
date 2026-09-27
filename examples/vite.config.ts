// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const root = fileURLToPath(new URL('.', import.meta.url));

/** The pages: the list and the ten examples */
const PAGES = [
  'index',
  'basic',
  'save-load',
  'style-rules',
  'snapping-and-geometry',
  'terrain',
  'read-only',
  'plugin',
  'custom-feature-type',
  'large-data',
  'table-worker',
];

export default defineConfig({
  // Relative asset paths, so the build can be served from any directory (GitHub Pages)
  base: './',
  server: {
    port: 3000,
    open: true,
  },
  build: {
    // Each example bundles maplibre-gl and the library in one script
    chunkSizeWarningLimit: 2500,
    rolldownOptions: {
      input: Object.fromEntries(
        PAGES.map((page) => [
          page,
          resolve(root, page === 'index' ? 'index.html' : `${page}/index.html`),
        ]),
      ),
    },
  },
  resolve: {
    // The library is taken from its sources, so a change shows without a build
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
    ],
  },
});
