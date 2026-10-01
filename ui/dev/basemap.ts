// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// The basemap of the development page, the same as the examples of core. It is public and needs
// no key; `?style=<url>` in the address of the page replaces it.

const params = new URLSearchParams(location.search);

/**
 * The style of the basemap
 *
 * @param url The style to use (OpenFreeMap Bright when omitted)
 * @returns `url`, or the style given in the address of the page
 */
export function basemapStyle(url = 'https://tiles.openfreemap.org/styles/bright'): string {
  return params.get('style') ?? url;
}
