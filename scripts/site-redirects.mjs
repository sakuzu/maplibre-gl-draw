// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Keeps the URLs of the 1.0 API reference working
 *
 * In 1.0 the modules of the reference were `index`, `geometry` and `columnar`; since 2.0 they
 * are `maplibre-gl-draw`, `geometry`, `table` and `webgl`, and some symbols have new names.
 * For every 1.0 page (scripts/site-redirects-1.0.json) that the current reference does not
 * have, this writes a small page that redirects to the page of the same symbol under its
 * current module and name, or to the page of the module when the symbol is gone. Every URL
 * is relative, so the redirects work under any subpath of the site.
 *
 * A real page of the reference is never overwritten, and running it again gives the same
 * result. It fails when a redirect would point to a page that does not exist.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const MANIFEST = join(dirname(fileURLToPath(import.meta.url)), 'site-redirects-1.0.json');

/** The 2.0 modules to look for a 1.0 symbol in, in order */
const MODULES = {
  index: ['maplibre-gl-draw', 'table', 'webgl', 'geometry'],
  geometry: ['geometry', 'maplibre-gl-draw'],
  columnar: ['table', 'maplibre-gl-draw'],
};

/** The 2.0 module page that takes the place of each 1.0 module page */
const MODULE_PAGES = {
  index: 'maplibre-gl-draw',
  geometry: 'geometry',
  columnar: 'table',
};

/** 1.0 names whose symbol has a new name (the CHANGELOG lists every rename) */
const RENAMES = {
  MapLibreGLDraw: 'Draw',
  createMapLibreGLDraw: 'createDraw',
  Options: 'DrawOptions',
  EventPayloads: 'DrawEvents',
  Data: 'DrawDocument',
  RenderSlot: 'LayerStackEntry',
  DatasetColumnarInput: 'Table',
  DatasetColumnarGeometry: 'TableGeometry',
  DatasetColumnarMixedGeometry: 'TableMixedGeometry',
  DatasetColumnarGeometryType: 'GeometryType',
  DatasetColumn: 'Column',
  DatasetDictionaryColumn: 'DictionaryColumn',
  DatasetColumnarPrepared: 'PreparedTable',
  prepareDatasetColumnar: 'prepareTable',
  columnarTransferables: 'transferList',
};

const KINDS = ['classes', 'functions', 'interfaces', 'types', 'variables', 'enums'];

/** Marks a page written here, so that a later run may write it again */
const MARKER = '<meta name="generator" content="site-redirects">';

/** The current page (relative to the reference) for a 1.0 page */
function targetOf(page, exists) {
  const [kind, file] = page.split('/');
  const module = file.replace(/\.html$/, '');
  if (kind === 'modules') return `modules/${MODULE_PAGES[module] ?? MODULE_PAGES.index}.html`;
  const dot = module.indexOf('.');
  const from = module.slice(0, dot);
  const name = module.slice(dot + 1);
  const renamed = RENAMES[name] ?? name;
  const modules = MODULES[from] ?? MODULES.index;
  for (const k of [kind, ...KINDS.filter((k) => k !== kind)]) {
    for (const m of modules) {
      const candidate = `${k}/${m}.${renamed}.html`;
      if (exists(candidate)) return candidate;
    }
  }
  return `modules/${MODULE_PAGES[from] ?? MODULE_PAGES.index}.html`;
}

function redirectPage(url) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
${MARKER}
<meta name="robots" content="noindex">
<meta http-equiv="refresh" content="0; url=${url}">
<link rel="canonical" href="${url}">
<title>Moved</title>
</head>
<body>
<p>This page has moved to <a href="${url}">${url}</a>.</p>
</body>
</html>
`;
}

/**
 * Writes the redirects into the generated reference
 *
 * @param {string} apiDir the directory of the reference (site-dist/api)
 * @returns {number} the number of redirect pages written
 */
export function writeRedirects(apiDir) {
  const { pages } = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  const isRedirect = (page) => readFileSync(join(apiDir, page), 'utf8').includes(MARKER);
  const exists = (page) => existsSync(join(apiDir, page)) && !isRedirect(page);
  let written = 0;
  for (const page of pages) {
    if (exists(page)) continue;
    const target = targetOf(page, exists);
    if (!exists(target)) {
      throw new Error(`The redirect for api/${page} points to api/${target}, which is missing`);
    }
    const url = posix.relative(posix.dirname(page), target);
    mkdirSync(dirname(join(apiDir, page)), { recursive: true });
    writeFileSync(join(apiDir, page), redirectPage(url));
    written += 1;
  }
  return written;
}
