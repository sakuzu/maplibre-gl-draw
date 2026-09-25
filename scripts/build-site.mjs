// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Builds the GitHub Pages site into site-dist/
 *
 * - `/` — the playground, opening the showcase (the README image) by default; `?plain`
 *   opens it without the showcase
 * - `/examples/` — the list of examples and the ten examples
 * - `/api/` — the generated API reference (typedoc, the same as `npm run docs:api`)
 *
 * Every page uses relative paths (vite's `base: './'`), so the site works under any
 * subpath, such as https://<owner>.github.io/maplibre-gl-draw/. The bench is not part of
 * the site. `npm run deploy:pages` builds the site and pushes it to the gh-pages branch.
 *
 * Usage: npm run build:site
 */

import { execFileSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SITE_DIR = join(root, 'site-dist');

rmSync(SITE_DIR, { recursive: true, force: true });

// The playground opens the showcase by default and shows the links to the site's pages
process.env.VITE_SITE = '1';

/** Builds one vite project into a directory of the site */
async function buildPages(project, outDir) {
  await build({
    root: join(root, project),
    configFile: join(root, project, 'vite.config.ts'),
    logLevel: 'warn',
    build: { outDir, emptyOutDir: true },
  });
  console.log(`Built ${project}/ into ${outDir}`);
}

await buildPages('playground', SITE_DIR);
await buildPages('examples', join(SITE_DIR, 'examples'));

// The API reference, written straight into the site (typedoc.json is the configuration)
const typedoc = join(root, 'node_modules/.bin/typedoc');
execFileSync(typedoc, ['--out', join(SITE_DIR, 'api'), '--logLevel', 'Warn'], {
  cwd: root,
  stdio: 'inherit',
});
console.log(`Built the API reference into ${join(SITE_DIR, 'api')}`);

for (const page of ['index.html', 'examples/index.html', 'api/index.html']) {
  if (!existsSync(join(SITE_DIR, page))) throw new Error(`site-dist/${page} is missing`);
}
console.log(`The site is in ${SITE_DIR}`);
