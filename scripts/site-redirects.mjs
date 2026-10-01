// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Keeps the URLs the site published before working
 *
 * Two kinds of URL moved when the site became the documentation site:
 *
 * - The API reference was a set of HTML pages, `api/<kind>/<module>.<name>.html`
 *   (scripts/site-redirects-api.json lists every one the site published: the pages of 2.0 and
 *   the redirects of the 1.0 pages). The reference is now `api/<module>/<kind>/<name>.html`. In
 *   1.0 the modules were `index`, `geometry` and `columnar`, and some symbols have new names
 *   since 2.0. Each old page redirects to the page of the same symbol under its current module
 *   and name, or to the page of the module when the symbol is gone.
 * - The examples of 1.0 and 2.0 (scripts/site-redirects-examples.json, old path to new path)
 *   redirect to the page of the example that took their place.
 *
 * A redirect is a small HTML page with a relative URL, written into the built site. A real page
 * is never overwritten, and running it again gives the same result. It fails when a redirect
 * would point to a page that does not exist.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const API_MANIFEST = join(HERE, 'site-redirects-api.json');
const EXAMPLES_MANIFEST = join(HERE, 'site-redirects-examples.json');

/** The current modules to look for a symbol of an old module in, in order */
const MODULES = {
  index: ['maplibre-gl-draw', 'table', 'webgl', 'geometry'],
  columnar: ['table', 'maplibre-gl-draw'],
  'maplibre-gl-draw': ['maplibre-gl-draw', 'table', 'webgl', 'geometry'],
  geometry: ['geometry', 'maplibre-gl-draw'],
  table: ['table', 'maplibre-gl-draw'],
  webgl: ['webgl', 'maplibre-gl-draw'],
};

/** The current module that takes the place of each old module */
const MODULE_PAGES = {
  index: 'maplibre-gl-draw',
  columnar: 'table',
  'maplibre-gl-draw': 'maplibre-gl-draw',
  geometry: 'geometry',
  table: 'table',
  webgl: 'webgl',
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

/** The folder of each kind of symbol in the current reference, by its folder in the old one */
const KINDS = {
  classes: 'classes',
  functions: 'functions',
  interfaces: 'interfaces',
  types: 'type-aliases',
  variables: 'variables',
  enums: 'enumerations',
};

/** Marks a page written here, so that a later run may write it again */
const MARKER = '<meta name="generator" content="site-redirects">';

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

/** Every HTML file under a directory, relative to it, with `/` as the separator */
function htmlFiles(dir) {
  if (!existsSync(dir)) return new Set();
  return new Set(
    readdirSync(dir, { recursive: true })
      .map((file) => String(file).split('\\').join('/'))
      .filter((file) => file.endsWith('.html')),
  );
}

/** The current page (relative to the site) for a page of the old API reference */
function apiTarget(page, pages) {
  if (page === 'hierarchy.html' || page === 'modules.html') return 'api/index.html';
  const [kind, file] = page.split('/');
  const name = file?.replace(/\.html$/, '') ?? '';
  if (kind === 'modules') return `api/${MODULE_PAGES[name] ?? MODULE_PAGES.index}/index.html`;
  const dot = name.indexOf('.');
  const from = name.slice(0, dot);
  const symbol = RENAMES[name.slice(dot + 1)] ?? name.slice(dot + 1);
  const kinds = [KINDS[kind], ...Object.values(KINDS).filter((k) => k !== KINDS[kind])];
  for (const k of kinds) {
    for (const m of MODULES[from] ?? MODULES.index) {
      const candidate = `api/${m}/${k}/${symbol}.html`;
      if (pages.has(candidate)) return candidate;
    }
  }
  return `api/${MODULE_PAGES[from] ?? MODULE_PAGES.index}/index.html`;
}

/**
 * Writes the redirects into the built site
 *
 * @param {string} siteDir the directory of the built site
 * @returns {{ api: number, examples: number }} the number of redirect pages written of each kind
 */
export function writeRedirects(siteDir) {
  const isRedirect = (page) => readFileSync(join(siteDir, page), 'utf8').includes(MARKER);
  const pages = new Set([...htmlFiles(siteDir)].filter((page) => !isRedirect(page)));

  const write = (from, to) => {
    if (pages.has(from)) throw new Error(`The redirect from ${from} would replace a page`);
    if (!pages.has(to)) {
      throw new Error(`The redirect from ${from} points to ${to}, which is missing`);
    }
    const url = posix.relative(posix.dirname(from), to);
    mkdirSync(dirname(join(siteDir, from)), { recursive: true });
    writeFileSync(join(siteDir, from), redirectPage(url));
  };

  let api = 0;
  for (const page of JSON.parse(readFileSync(API_MANIFEST, 'utf8')).pages) {
    // The index of the reference is still where it was
    if (pages.has(`api/${page}`)) continue;
    write(`api/${page}`, apiTarget(page, pages));
    api += 1;
  }

  let examples = 0;
  const { redirects } = JSON.parse(readFileSync(EXAMPLES_MANIFEST, 'utf8'));
  for (const [from, to] of Object.entries(redirects)) {
    write(from.endsWith('/') ? `${from}index.html` : from, to);
    examples += 1;
  }
  return { api, examples };
}
