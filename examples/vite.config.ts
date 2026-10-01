// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const root = fileURLToPath(new URL('.', import.meta.url));

/** The pages: the list, the examples with the standard UI and the ten examples */
const PAGES = [
  'index',
  'get-started',
  'style-features',
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
  'feature-properties',
  'layers-and-groups',
  'style-rules-and-legend',
  'snapping-and-tracing',
  'geometry-operations',
  'images',
  'save-and-load',
  'globe',
  '200000-features',
  'datasets',
  'columnar-data-in-a-worker',
  'read-only-viewer',
  'plugins',
  'custom-feature-types',
  'custom-ui',
];

export default defineConfig({
  // Relative asset paths, so the build can be served from any directory (GitHub Pages)
  base: './',
  server: {
    // A port of its own, kept: a page that moved to another port would not be where the docs say
    port: 3200,
    strictPort: true,
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
      // The standard UI is taken from its build (npm run ui:build), the files that users install.
      // It imports core by its name, which the aliases above resolve to the same sources
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
