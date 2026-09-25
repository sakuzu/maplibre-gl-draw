// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Accessors of the frame state of terrain rendering
 *
 * This is state during rendering that is set only while the terrain (MapLibre's terrain) is
 * enabled. The owner of the values is the `TerrainContext` of each draw instance
 * (`context.ts`; how a shared global broke with several instances is written there). Every
 * accessor takes that context explicitly: the renderers of a CustomLayer receive their
 * instance's context at construction, and extension renderers receive it in the draw context
 * (`CustomRendererDrawContext.terrain`). Nothing here reads "the instance drawn last".
 *
 * When the terrain is disabled, `INACTIVE_TERRAIN_STATE` is held and the shader's
 * `u_terrain_on` becomes 0. The vertex computation when it is 0 is exactly identical to
 * the former one (this guarantees zero regression).
 */

import {
  INACTIVE_TERRAIN_STATE,
  type TerrainContext,
  type TerrainDrapeDebug,
  type TerrainRenderState,
} from './context.js';
import type { QuadDrapeFrame } from './drape/quad.js';
import type { TerrainShadeLight } from './shade.js';

export type { TerrainDrapeDebug, TerrainRenderState };
export { INACTIVE_TERRAIN_STATE };

/**
 * Texture unit that binds the DEM atlas (unit 0 is used by the coordinate texture)
 *
 * @internal
 */
export const TERRAIN_ATLAS_TEXTURE_UNIT = 6;

/**
 * Gets the terrain state of the current frame
 *
 * @internal
 */
export function getTerrainRenderState(context: TerrainContext): TerrainRenderState {
  return context.renderState;
}

/**
 * Replaces the terrain state of the frame (custom-layer calls this every frame)
 */
export function setTerrainRenderState(context: TerrainContext, state: TerrainRenderState): void {
  context.renderState = state;
}

/**
 * Whether giving elevation to the vertices is suppressed
 *
 * UI drawn as a rectangle on the screen (the rubber band of a rectangular selection) stops
 * being a rectangle once it is pasted onto the ground surface. Elevation is stopped only
 * for such drawing.
 */
export function isTerrainElevationSuppressed(context: TerrainContext): boolean {
  return context.elevationSuppressed;
}

/**
 * Draws with the elevation turned off
 *
 * @internal
 */
export function withoutTerrainElevation<T>(context: TerrainContext, draw: () => T): T {
  const previous = context.elevationSuppressed;
  context.elevationSuppressed = true;
  try {
    return draw();
  } finally {
    context.elevationSuppressed = previous;
  }
}

/**
 * Whether this is a frame that draws polygons and lines flat (a band that cannot be made
 * to follow the ground surface)
 *
 * The reason is written at `surfacesFlattened` in `context.ts`.
 */
export function isTerrainSurfacesFlattened(context: TerrainContext): boolean {
  return context.surfacesFlattened;
}

/**
 * Sets whether polygons and lines are drawn flat in this frame (custom-layer calls this
 * every frame)
 */
export function setTerrainSurfacesFlattened(context: TerrainContext, flattened: boolean): void {
  context.surfacesFlattened = flattened;
}

/**
 * Sets the shading light source of this frame (custom-layer calls this for each frame)
 *
 * null is set for frames where the terrain is disabled. While it is null, fills on the
 * vertex displacement path are drawn with a shading factor of 1.0 (the same pixels as
 * before the terrain was introduced).
 */
export function setTerrainShadeLight(
  context: TerrainContext,
  light: TerrainShadeLight | null,
): void {
  context.shadeLight = light;
}

/**
 * The shading light source of this frame (null when the terrain is disabled)
 */
export function getTerrainShadeLight(context: TerrainContext): TerrainShadeLight | null {
  return context.shadeLight;
}

/**
 * Sets the datasets whose polygons and lines are painted by the analytic drape in this
 * frame
 *
 * The reason is written at `drapePaintedDatasets` in `context.ts`.
 */
export function setDrapePaintedDatasets(
  context: TerrainContext,
  ids: ReadonlySet<string> | null,
): void {
  context.drapePaintedDatasets = ids;
}

/**
 * Whether the polygons and lines of this dataset are painted by the analytic drape in
 * this frame
 */
export function isDrapePaintedDataset(context: TerrainContext, id: string): boolean {
  return context.drapePaintedDatasets?.has(id) === true;
}

/**
 * Whether the vertex shader adds the elevation (the state combined with the suppression)
 *
 * @internal
 */
export function isTerrainElevationActive(context: TerrainContext): boolean {
  return context.renderState.active && !context.elevationSuppressed;
}

/**
 * Whether the subdivision on the CPU side is enabled
 *
 * This is independent of the suppression (`withoutTerrainElevation`), because subdivision
 * is a matter of building the vertex data while suppression is a matter of drawing.
 *
 * @internal
 */
export function isTerrainTessellationActive(context: TerrainContext): boolean {
  const state = context.renderState;
  return state.active && state.stepMeters > 0;
}

/**
 * Whether the camera is in the middle of moving (used to decide to defer rebaking the
 * retained batches)
 */
export function isTerrainCameraMoving(context: TerrainContext): boolean {
  return context.cameraMoving;
}

/**
 * Records the movement of the camera (custom-layer calls this every frame)
 */
export function setTerrainCameraMoving(context: TerrainContext, moving: boolean): void {
  context.cameraMoving = moving;
}

/**
 * Reports the coarseness of the step that was used (the polygon renderer calls this when
 * building a batch)
 *
 * The coarsest value within the generation is kept. Only one depth bias can be set for the
 * whole frame, so it is matched to a value at which the coarsest polygon does not sink.
 */
export function reportTerrainCoarsening(context: TerrainContext, factor: number): void {
  if (factor > context.tessellationCoarsening) context.tessellationCoarsening = factor;
}

/**
 * The coarsest step multiplier used in this generation
 */
export function getTerrainCoarsening(context: TerrainContext): number {
  return context.tessellationCoarsening;
}

/**
 * Gets the handle of the quad analytic drape for this frame (null when the terrain is
 * disabled)
 *
 * QuadShader (Image, and the fill of text quads) reads it.
 */
export function getQuadDrapeFrame(context: TerrainContext): QuadDrapeFrame | null {
  return context.quadDrapeFrame;
}

/** Sets the handle of the quad analytic drape (custom-layer calls this every frame) */
export function setQuadDrapeFrame(context: TerrainContext, frame: QuadDrapeFrame | null): void {
  context.quadDrapeFrame = frame;
}

/**
 * Gets the diagnostic values
 *
 * @internal
 */
export function getTerrainDrapeDebug(context: TerrainContext): TerrainDrapeDebug {
  return context.drapeDebug;
}

/** Sets the diagnostic values (custom-layer calls this) */
export function setTerrainDrapeDebug(context: TerrainContext, value: TerrainDrapeDebug): void {
  context.drapeDebug = value;
}
