// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The factory of a draw instance: the public object of the first version of the API on the
 * engine of src/api/engine.ts.
 */

import type { Map as MapLibreMap } from 'maplibre-gl';

import type { MapLibreGLDraw } from './api/api.js';
import type { Options } from './api/context.js';
import { createEngine } from './api/engine.js';

// Re-export of the types
export type { EventPayloads, MapLibreGLDraw } from './api/api.js';
export type { Options } from './api/context.js';
export type { ImportExportAPI } from './api/import-export/index.js';
export type { Data, LoadResult, Metadata } from './store/types.js';

/**
 * Creates a draw instance on a MapLibre map: the drawing and editing tools, their rendering and
 * their input handling.
 *
 * It can be called before, while or after the map loads. The render layers are added as soon
 * as the style accepts layers, and added again after `setStyle`. Unless
 * `initDefaultLayer: false` is given, the document starts with one empty layer. The instance
 * turns off the map's box zoom (Shift + drag selects features instead) and gives it back on
 * {@link MapLibreGLDraw.destroy}. Several instances can share a page, each on its own map.
 *
 * @param map the MapLibre map to draw on
 * @param options the options; every one can be omitted (see {@link Options})
 * @returns the draw instance
 *
 * @example
 * ```typescript
 * import { createMapLibreGLDraw } from '@sakuzu/maplibre-gl-draw';
 * import * as maplibregl from 'maplibre-gl';
 *
 * const map = new maplibregl.Map({
 *   container: 'map',
 *   style: 'https://demotiles.maplibre.org/style.json',
 *   center: [139.767, 35.681],
 *   zoom: 12,
 * });
 * const draw = createMapLibreGLDraw(map, { defaultMode: 'select' });
 *
 * draw.setMode('draw_polygon');
 * draw.on('draw.feature.create', ({ feature }) => console.log('Created', feature.id));
 * ```
 */
export function createMapLibreGLDraw(map: MapLibreMap, options: Options = {}): MapLibreGLDraw {
  return createEngine(map, options).facade;
}
