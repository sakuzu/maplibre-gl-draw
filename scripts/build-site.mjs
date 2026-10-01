// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Builds the GitHub Pages site into site-dist/
 *
 * The site is the documentation site, `npm run site:build` (VitePress, docs/.vitepress/), for
 * the address https://sakuzu.github.io/maplibre-gl-draw/ (the `base` of its configuration):
 *
 * - `/` — the top page; `/getting-started.html` and `/guides/` — the guides; `/ja/` — the
 *   Japanese pages
 * - `/examples/` — the gallery, `/examples/<name>.html` — the page of each example, and
 *   `/examples/<name>/` — the example itself, which the page frames
 * - `/playground/` — the playground
 * - `/api/` — the API reference
 * - the redirects of the URLs the site published before: the HTML pages of the API reference of
 *   1.0 and 2.0, and the examples that were replaced (scripts/site-redirects.mjs)
 *
 * This removes site-dist/ first, builds the site and checks that each part is in it. The bench
 * is not part of the site. `npm run deploy:pages` builds the site and pushes it to the gh-pages
 * branch; `npm run site:preview` serves the build locally.
 *
 * Usage: npm run build:site   (which builds core and the standard UI first)
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SITE_DIR = join(root, 'site-dist');

rmSync(SITE_DIR, { recursive: true, force: true });
execFileSync('npm', ['run', 'site:build'], { cwd: root, stdio: 'inherit' });

const catalog = JSON.parse(readFileSync(join(root, 'docs/examples/catalog.json'), 'utf8'));
const pages = [
  'index.html',
  'ja/index.html',
  'getting-started.html',
  'examples/index.html',
  'ja/examples/index.html',
  'playground/index.html',
  'api/index.html',
  'api/maplibre-gl-draw/functions/createDraw.html',
  // A redirect of each kind
  'api/functions/maplibre-gl-draw.createDraw.html',
  'examples/basic/index.html',
];
for (const name of Object.keys(catalog)) {
  pages.push(`examples/${name}.html`, `ja/examples/${name}.html`, `examples/${name}.jpg`);
  if (name !== 'playground') pages.push(`examples/${name}/index.html`);
}
const missing = pages.filter((page) => !existsSync(join(SITE_DIR, page)));
if (missing.length > 0) throw new Error(`site-dist/ has no ${missing.join(', ')}`);
console.log(`The site is in ${SITE_DIR}`);
