// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

const root = fileURLToPath(new URL('.', import.meta.url));

/**
 * Isolates the page of the rows held as columns (table.html) across origins, so that it can
 * measure its memory with `performance.measureUserAgentSpecificMemory`. Only that page: the
 * others load the tiles of a base map from another origin, which the isolation would block.
 */
function isolateTablePage(): Plugin {
  const isolate = (url: string | undefined, setHeader: (name: string, value: string) => void) => {
    if (!url) return;
    const path = url.split('?')[0] ?? url;
    // Another page (an HTML document other than table.html, or a directory) stays unisolated.
    // The scripts and the Workers are isolated too: a Worker of an isolated page fails to load
    // when its own response does not carry the embedder policy.
    if (path !== '/table.html' && (path.endsWith('.html') || path.endsWith('/'))) return;
    setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  };
  return {
    name: 'isolate-table-page',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        isolate(req.url, (name, value) => res.setHeader(name, value));
        next();
      });
    },
    configurePreviewServer(server) {
      server.middlewares.use((req, res, next) => {
        isolate(req.url, (name, value) => res.setHeader(name, value));
        next();
      });
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [isolateTablePage()],
  worker: { format: 'es' },
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
        table: resolve(root, 'table.html'),
        quad: resolve(root, 'quad.html'),
      },
    },
  },
  resolve: {
    // The library is taken from its sources, so a change is measured without a build (the
    // subpath first: an alias matches the start of a path)
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
