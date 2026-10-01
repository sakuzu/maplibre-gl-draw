// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// The basemap and the elevation data of the examples. Both are public and need no key.
// The address of a page can replace them (`?style=<url>` and `?dem=<url>`), which is how the
// end-to-end tests run the examples without going to the network, and `?basemap=<id>` picks one
// of the basemaps of the standard UI's basemap row.

import type { Basemap } from '@sakuzu/maplibre-gl-draw-ui';

const params = new URLSearchParams(location.search);

const OPENFREEMAP = 'https://tiles.openfreemap.org/styles';

/**
 * The basemaps of the basemap row of the standard UI: the styles of OpenFreeMap, and a white
 * sheet, a style of one background layer that loads nothing. Each preview is a gradient in the
 * colors of its style
 */
export const BASEMAPS: Basemap[] = [
  {
    id: 'liberty',
    label: 'OpenFreeMap Liberty',
    style: `${OPENFREEMAP}/liberty`,
    preview: 'linear-gradient(135deg, #e8efe3, #cfdcc6)',
  },
  {
    id: 'bright',
    label: 'OpenFreeMap Bright',
    style: `${OPENFREEMAP}/bright`,
    preview: 'linear-gradient(135deg, #f4f1ea, #dfe7d5)',
  },
  {
    id: 'positron',
    label: 'OpenFreeMap Positron',
    style: `${OPENFREEMAP}/positron`,
    preview: 'linear-gradient(135deg, #f7f7f5, #e3e3e0)',
  },
  {
    id: 'dark',
    label: 'OpenFreeMap Dark',
    style: `${OPENFREEMAP}/dark`,
    preview: 'linear-gradient(135deg, #2a2d33, #16181c)',
  },
  {
    id: 'blank',
    label: 'Blank',
    preview: '#ffffff',
    style: {
      version: 8,
      sources: {},
      layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#ffffff' } }],
    },
  },
];

/**
 * The ID of the basemap the address names (`?basemap=<id>`), for the `basemap` option of the
 * standard UI
 *
 * @returns The ID when it is one of `BASEMAPS` and no `?style=` replaces the basemap, or
 *   undefined, and the UI then marks the basemap whose style the map has
 */
export function initialBasemapId(): string | undefined {
  if (params.has('style')) return undefined;
  const id = params.get('basemap');
  return id !== null && BASEMAPS.some((b) => b.id === id) ? id : undefined;
}

/**
 * The style of the basemap
 *
 * @param url The style the example uses (OpenFreeMap Bright when omitted)
 * @returns The style given in the address of the page (`?style=`), else the style of the basemap
 *   it names (`?basemap=`: a URL, or the style object of the white sheet), else `url`
 */
export function basemapStyle(url = `${OPENFREEMAP}/bright`): Basemap['style'] {
  const style = params.get('style');
  if (style !== null) return style;
  const named = BASEMAPS.find((b) => b.id === initialBasemapId());
  return named?.style ?? url;
}

/** The TileJSON of the elevation tiles (the MapLibre demo tiles) */
export const DEM_TILES =
  params.get('dem') ?? 'https://demotiles.maplibre.org/terrain-tiles/tiles.json';
