// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// The build of the package, in two passes over the same entry (`npm run build`):
//
// - `vite build` writes dist/index.js for bundlers. It imports svelte, core and maplibre-gl,
//   which the application's bundler resolves (svelte is a dependency, the other two are peers).
//   kata and its icons are compiled into it: they are published as Svelte sources, which only a
//   bundler with the Svelte plugin could read, and the interface must work in any application
// - `vite build --mode bundle` writes dist/maplibre-gl-draw-ui.js, one file with svelte and kata
//   in it, for a page that loads modules with an import map. Only core and maplibre-gl stay
//   outside
//
// Both write the same dist/style.css: kata's tokens moved onto the root element (build/scope-css),
// the rules of kata's components and the interface's own. The declarations (dist/index.d.ts) come
// from tsc afterwards (tsconfig.build.json).

import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';
import { scopeKata } from './build/scope-css.ts';

/** What stays outside each output */
const PEERS = [/^@sakuzu\/maplibre-gl-draw(\/|$)/, /^maplibre-gl(\/|$)/];
const SVELTE = /^svelte(\/|$)/;

export default defineConfig(({ mode }) => {
  const bundle = mode === 'bundle';
  return {
    plugins: [svelte()],
    css: { postcss: { plugins: [scopeKata()] } },
    build: {
      target: 'es2022',
      // The first pass empties dist; the second adds to it
      emptyOutDir: !bundle,
      minify: bundle,
      // Both passes write the same style sheet
      cssMinify: true,
      sourcemap: true,
      lib: {
        entry: 'src/main.ts',
        formats: ['es'],
        fileName: () => (bundle ? 'maplibre-gl-draw-ui.js' : 'index.js'),
        cssFileName: 'style',
      },
      rolldownOptions: {
        external: bundle ? PEERS : [...PEERS, SVELTE],
      },
    },
  };
});
