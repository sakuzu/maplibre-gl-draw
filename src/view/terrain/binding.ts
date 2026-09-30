// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The link between the public terrain objects and the terrain state of an instance
 *
 * A renderer of an extension receives a `RenderContext` whose `terrain` is the public
 * `TerrainAnchors`; the building blocks of the second entry that draw on the terrain need the
 * terrain state behind it. The engine binds each render context and each set of anchors it
 * hands out to its terrain state here, so that the public types name nothing of that state
 * and an object the engine did not hand out resolves to no terrain.
 */

import type { TerrainAnchors } from '../../api/extension/context.js';
import type { RenderContext } from '../../api/extension/render.js';
import type { TerrainContext } from './context.js';

/** The terrain state behind each render context and each set of anchors */
const terrainByHandle = new WeakMap<object, TerrainContext>();

/**
 * Binds a render context or a set of anchors to the terrain state it stands for
 *
 * @internal
 */
export function bindTerrainState(handle: object, terrain: TerrainContext): void {
  terrainByHandle.set(handle, terrain);
}

/**
 * The terrain state behind a render context or its `terrain`
 *
 * @returns The state, or `null` for `null` and for an object the engine did not hand out
 * @internal
 */
export function terrainStateOf(
  source: RenderContext | TerrainAnchors | null | undefined,
): TerrainContext | null {
  if (!source) return null;
  return terrainByHandle.get(source) ?? terrainByHandle.get(renderTerrainOf(source)) ?? null;
}

/** The `terrain` of a render context, or the object itself */
function renderTerrainOf(source: RenderContext | TerrainAnchors): object {
  return 'terrain' in source && typeof source.terrain === 'object' && source.terrain !== null
    ? source.terrain
    : source;
}
