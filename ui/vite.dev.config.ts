// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// The development page (`npm run ui:dev` at the root): a map with a few features and the
// interface over it, on port 3100. Core is taken from its build (run `npm run build` at the root
// first), the way an application gets it; the interface from its sources.

import { fileURLToPath } from 'node:url';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';
import { scopeKata } from './build/scope-css.ts';

const core = fileURLToPath(new URL('../dist/index.js', import.meta.url));

export default defineConfig({
  root: fileURLToPath(new URL('./dev', import.meta.url)),
  plugins: [svelte()],
  css: { postcss: { plugins: [scopeKata()] } },
  server: { port: 3100, strictPort: true },
  resolve: {
    alias: [{ find: /^@sakuzu\/maplibre-gl-draw$/, replacement: core }],
  },
});
