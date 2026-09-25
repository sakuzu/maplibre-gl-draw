// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Map utilities
 *
 * Utility functions related to the MapLibre GL JS map instance.
 */

import type { Map as MapLibreMap } from 'maplibre-gl';
import { DEFAULT_TILE_SIZE } from '../math/index.js';

/**
 * Gets the tile size of the map
 *
 * Accesses an internal property of MapLibre GL JS to get the tile size.
 * Returns the default value (512) when it cannot be obtained.
 *
 * @param map MapLibre map instance
 * @returns Tile size (pixels)
 */
export function getTileSize(map: MapLibreMap): number {
  return (
    (map as unknown as { transform?: { tileSize?: number } }).transform?.tileSize ??
    DEFAULT_TILE_SIZE
  );
}

/**
 * Whether the map is set to a projection other than Web Mercator (the globe)
 *
 * The globe projection switches to Mercator as the map zooms in, but the setting stays, so
 * this is true at every zoom of a globe map. A map whose style is not loaded yet counts as
 * Mercator.
 *
 * @param map MapLibre map instance
 */
export function isGlobeProjection(map: MapLibreMap): boolean {
  let type: unknown;
  try {
    type = map.getProjection?.()?.type;
  } catch {
    return false;
  }
  return type !== undefined && type !== 'mercator';
}
