// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Where the examples and the playground are while the site is served by `vitepress dev`
 *
 * The built site has the examples under /examples/<name>/ and the playground under /playground/
 * (`npm run site:build` builds them there). `vitepress dev` serves the pages alone, and
 * `npm run site:dev` runs the dev servers of the examples (`npm run dev`, port 3200) and of the
 * playground (`npm run dev:playground`, port 3300) beside it. `import.meta.env.DEV` tells the
 * two apart.
 */

import { withBase } from 'vitepress';

/** The dev server of the examples */
export const DEV_EXAMPLES = 'http://localhost:3200/';
/** The dev server of the playground */
export const DEV_PLAYGROUND = 'http://localhost:3300/';

/**
 * The address of a live example, or of the playground for the name `playground`, with a query
 * such as `?locale=ja`
 */
export function liveUrl(name: string, query = ''): string {
  if (name === 'playground') {
    return `${import.meta.env.DEV ? DEV_PLAYGROUND : withBase('/playground/')}${query}`;
  }
  return `${import.meta.env.DEV ? DEV_EXAMPLES : withBase('/examples/')}${name}/${query}`;
}

/**
 * Under `vitepress dev`, sends an address of the built site that VitePress does not serve (the
 * playground, a live example) on to the dev server that does
 *
 * The links to them open a page of their own (the tab of the playground has a `target`), so
 * the theme starts at that address and replaces it before it renders anything.
 */
export function redirectToDevServer(): void {
  if (!import.meta.env.DEV) return;
  const base = withBase('/');
  const { pathname, search, hash } = window.location;
  if (!pathname.startsWith(base)) return;
  const path = pathname.slice(base.length).replace(/index\.html$/, '');
  const example = path.match(/^examples\/([a-z0-9-]+)\/$/);
  if (path === 'playground/') {
    window.location.replace(`${DEV_PLAYGROUND}${search}${hash}`);
  } else if (example) {
    window.location.replace(`${DEV_EXAMPLES}${example[1]}/${search}${hash}`);
  }
}
