// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The link between the public terrain objects and the terrain state of an instance
 *
 * A renderer of an extension receives a `RenderContext` whose `terrain` is the public
 * `TerrainSurface`; the building blocks of the second entry that draw on the terrain need the
 * terrain state behind it. The engine binds each render context and each surface of the terrain
 * it hands out to its terrain state here, so that the public types name nothing of that state.
 * `null` resolves to no terrain, and an object the engine did not hand out is refused, as
 * `viewUniforms` refuses a render context it did not hand out.
 */

import type { TerrainSurface } from '../../api/extension/context.js';
import type { RenderContext } from '../../api/extension/render.js';
import { DrawError } from '../../shared/draw-error.js';
import type { TerrainContext } from './context.js';

/** The terrain state behind each render context and each surface of the terrain */
const terrainByHandle = new WeakMap<object, TerrainContext>();

/**
 * Binds a render context or a surface of the terrain to the terrain state it stands for
 *
 * @internal
 */
export function bindTerrainState(handle: object, terrain: TerrainContext): void {
  terrainByHandle.set(handle, terrain);
}

/**
 * The terrain state behind a render context or its `terrain`
 *
 * @returns The state, or `null` for `null`
 * @throws `DrawError` with the code `invalid-input` for an object the engine did not hand out
 * @internal
 */
export function terrainStateOf(
  source: RenderContext | TerrainSurface | null | undefined,
): TerrainContext | null {
  if (source === null || source === undefined) return null;
  const state =
    typeof source === 'object'
      ? (terrainByHandle.get(source) ?? terrainByHandle.get(renderTerrainOf(source)))
      : undefined;
  if (!state) {
    throw new DrawError(
      'invalid-input',
      'The render context (or its terrain) is not one the instance gave a renderer in a draw call',
    );
  }
  return state;
}

/** The `terrain` of a render context, or the object itself */
function renderTerrainOf(source: RenderContext | TerrainSurface): object {
  return 'terrain' in source && typeof source.terrain === 'object' && source.terrain !== null
    ? source.terrain
    : source;
}
