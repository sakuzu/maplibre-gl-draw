// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// The basemap and the elevation data of the examples. Both are public and need no key.
// The address of a page can replace them (`?style=<url>` and `?dem=<url>`), which is how the
// end-to-end tests run the examples without going to the network.

const params = new URLSearchParams(location.search);

/**
 * The style of the basemap
 *
 * @param url The style the example uses (OpenFreeMap Bright when omitted)
 * @returns `url`, or the style given in the address of the page
 */
export function basemapStyle(url = 'https://tiles.openfreemap.org/styles/bright'): string {
  return params.get('style') ?? url;
}

/** The TileJSON of the elevation tiles (the MapLibre demo tiles) */
export const DEM_TILES =
  params.get('dem') ?? 'https://demotiles.maplibre.org/terrain-tiles/tiles.json';
