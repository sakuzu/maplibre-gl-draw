// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The members of the draw instance about the drawing: the divisions of the stacking order,
 * the work left to later frames and the diagnostics of the terrain
 */

import type { TerrainRenderState } from '../../view/terrain/context.js';
import { INITIAL_DRAPE_DEBUG } from '../../view/terrain/context.js';
import {
  getTerrainDrapeDebug,
  getTerrainRenderState,
  INACTIVE_TERRAIN_STATE,
} from '../../view/terrain/state.js';
import type { Draw } from '../draw.js';
import type { LayerStackEntry, TerrainDiagnostics } from '../state.js';
import type { Engine } from './engine.js';

/**
 * `getLayerStack`, `hasPendingWork` and `debug` over the engine
 *
 * @internal
 */
export function createDrawing(
  engine: Pick<Engine, 'customLayer'>,
): Pick<Draw, 'getLayerStack' | 'hasPendingWork' | 'debug'> {
  const { customLayer } = engine;
  return {
    getLayerStack(): readonly LayerStackEntry[] {
      return Object.freeze(
        customLayer
          .getStackSlots()
          .map(({ layerId, from, to }) => Object.freeze({ layerId, from, to })),
      );
    },

    hasPendingWork: () => customLayer.hasPendingWork(),

    debug: {
      terrain(): TerrainDiagnostics {
        const terrain = customLayer.getTerrainContext();
        return Object.freeze({
          render: toRenderDiagnostics(
            terrain ? getTerrainRenderState(terrain) : INACTIVE_TERRAIN_STATE,
          ),
          drape: Object.freeze({
            ...(terrain ? getTerrainDrapeDebug(terrain) : INITIAL_DRAPE_DEBUG),
          }),
        });
      },
    },
  };
}

/** The plain numbers of a terrain state, without the GL objects and the internal plans */
function toRenderDiagnostics(state: TerrainRenderState): TerrainDiagnostics['render'] {
  return Object.freeze({
    active: state.active,
    atlasRect: Object.freeze([
      ...state.atlasRect,
    ]) as unknown as TerrainDiagnostics['render']['atlasRect'],
    atlasSize: Object.freeze([
      ...state.atlasSize,
    ]) as unknown as TerrainDiagnostics['render']['atlasSize'],
    elevationScale: state.elevationScale,
    liftMeters: state.liftMeters,
    stepMeters: state.stepMeters,
    stepGrid: state.stepGrid,
    generation: state.generation,
  });
}
