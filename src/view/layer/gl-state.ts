// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The GL state of a slot
 *
 * maplibre resets the GL state between the slots, so every slot establishes the state its frame
 * assumes when it starts and hands the defaults of maplibre back when it ends. Every switch of
 * the blending, the depth test, the depth function, the depth mask and the polygon offset made
 * by the layer itself (outside the renderers) is here:
 *
 * - `applySegmentGlState` / `restoreSegmentGlState`: the start and the end of a slot
 * - `applySegmentDepthState`: the depth state of the layer rendering, set at the start of a
 *   slot and again after the drape
 * - `applyDrapeGlState`: the analytic drape (premultiplied alpha, LEQUAL, no offset)
 * - `enterSymbolGlState`: the foreground, the selection UI and the overlays (always in front)
 *
 * The record of the depth test (depth-state.ts) is updated by every switch, and the blend state
 * of the frame (blend.ts) is re-established through `restoreBlendState`.
 */

import type { TerrainContext, TerrainRenderState } from '../terrain/context.js';
import type { QuadDrapeFrame } from '../terrain/drape/quad.js';
import type { DrapeLight } from '../terrain/drape/renderer.js';
import { TERRAIN_DEPTH_BIAS } from '../terrain/metrics.js';
import {
  getTerrainCoarsening,
  setQuadDrapeFrame,
  setTerrainShadeLight,
  TERRAIN_ATLAS_TEXTURE_UNIT,
} from '../terrain/state.js';
import { setDepthTestEnabled, syncDepthTestEnabled } from './depth-state.js';

/** The parts of the frame that decide the GL state of a slot */
export interface SegmentGlFrame {
  readonly terrainState: TerrainRenderState;
  readonly drapeLight: DrapeLight;
  readonly wideFallback: boolean;
  readonly quadDrapeFrame: QuadDrapeFrame | null;
  readonly restoreBlendState: () => void;
}

/** Establishes the GL state this frame assumes, at the start of the drawing of a slot */
export function applySegmentGlState(
  gl: WebGL2RenderingContext,
  terrainContext: TerrainContext,
  f: SegmentGlFrame,
): void {
  // Sync the record of the depth test with the actual state of this frame (the foundation that
  // keeps the symbol rendering from asking gl.isEnabled every time; depth-state.ts)
  syncDepthTestEnabled(gl);
  // Deliver the same light as the analytic drape to the polygon fills of the vertex
  // displacement path, so that the look of a fill does not jump when the paths swap
  // (terrain/shade.ts). Without terrain it is null and there is no shading
  setTerrainShadeLight(terrainContext, f.terrainState.active ? f.drapeLight : null);
  if (f.terrainState.active && f.terrainState.atlasTexture) {
    // The DEM atlas is left bound to a dedicated texture unit (every renderer uses unit 0 for
    // its coordinate texture)
    gl.activeTexture(gl.TEXTURE0 + TERRAIN_ATLAS_TEXTURE_UNIT);
    gl.bindTexture(gl.TEXTURE_2D, f.terrainState.atlasTexture);
    gl.activeTexture(gl.TEXTURE0);
  }
  f.restoreBlendState();

  applySegmentDepthState(gl, terrainContext, f);
  if (f.quadDrapeFrame) {
    // The layer rendering keeps the depth test after a quad, whether or not the drape was used
    f.quadDrapeFrame.keepDepthTest = true;
    setQuadDrapeFrame(terrainContext, f.quadDrapeFrame);
  }
}

/**
 * Establishes the depth state of the layer rendering of a slot
 *
 * `applySegmentGlState` sets it at the start of a slot, and the drape of the segment, which
 * changes the depth function and the offset, hands it back with this before the layers are
 * drawn. The layers are therefore drawn in one depth state whether or not the drape was used.
 * What the drape cannot paint (the geometry being drawn, the features of extensions, the datasets
 * not handed over to it) is drawn after it by the vertex displacement path and must be hidden by the terrain in the same
 * way. Symbols switch the depth test off themselves (`drawBillboardsWithoutDepth`).
 */
export function applySegmentDepthState(
  gl: WebGL2RenderingContext,
  terrainContext: TerrainContext,
  f: Pick<SegmentGlFrame, 'terrainState' | 'wideFallback'>,
): void {
  // Depth (used only when there is terrain)
  //
  // MapLibre hands control to a '3d' CustomLayer with the depth test enabled, LEQUAL, and
  // writing allowed. The depth of the terrain mesh is written into the framebuffer of the
  // screen, so enabling the test correctly hides the features behind a mountain. Writing,
  // however, is turned off: the stacking order of core (the layer order, the selection UI in
  // front) was built on a draw order without depth, and letting our own drawings order each
  // other by depth would break it. gl.depthRange is not rewritten (MapLibre sets a narrowed
  // range shared with the terrain mesh). The depth function is set to the LEQUAL MapLibre
  // hands over, so that it is the same after the drape.
  if (f.terrainState.active && !f.wideFallback) {
    setDepthTestEnabled(gl, true);
    gl.depthMask(false);
    gl.depthFunc(gl.LEQUAL);
    // The depth bias is applied in proportion to the slope. The disagreement between the
    // terrain mesh and our own polygons is largest on a slope, so a constant lift cannot cover
    // it. The factor of polygonOffset is proportional to "the screen-space gradient of the
    // depth", which fits the shape of this problem.
    //
    // The amount is made proportional to "the coarseness of the step". A coarsely subdivided
    // polygon becomes a chord between the nodes, and on a hilltop the chord sinks below the
    // terrain. Measured, the sinking was at most 1.2 m for a step of 7.8 m, 3.7 m for 15.6 m
    // and 5.2 m for 31 m (the hills of northern Kawasaki). The coarser the step, the deeper it
    // sinks, so the bias grows by the same amount.
    const bias = TERRAIN_DEPTH_BIAS * getTerrainCoarsening(terrainContext);
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(-bias, -bias);
  } else {
    setDepthTestEnabled(gl, false);
  }
}

/** Restores the GL state to the defaults of maplibre at the end of the drawing of a slot */
export function restoreSegmentGlState(gl: WebGL2RenderingContext, f: SegmentGlFrame): void {
  if (f.terrainState.active && !f.wideFallback) {
    gl.depthMask(true);
    gl.disable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(0, 0);
  }
  // The depth function goes back to the default of maplibre (the slot drew with LEQUAL)
  gl.depthFunc(gl.LESS);
  setDepthTestEnabled(gl, true);
}

/**
 * Establishes the GL state of the analytic drape
 *
 * Composite with premultiplied alpha (the coverage is evaluated once per pixel, so an overlap
 * is never painted twice).
 *
 * What the drape draws is the ground itself. It coincides with the terrain surface of maplibre
 * at the same height, so on pixels of equal depth the winner wavers and the edges get eaten away
 * (pronounced on a shallow slope; confirmed in the field). The depth function is set to LEQUAL so
 * that equality wins, and the slope-proportional bias (which exists to fill the sinking of the
 * chords of the CPU subdivision) is not applied: the surfaces of the drape are not chords, so it
 * is not needed. The occlusion is carried by the depth test itself, so it must not be turned off.
 *
 * The depth bias (polygonOffset) is not used. The factor is proportional to the screen-space
 * gradient of the depth, so it acts too strongly on a shallow slope, and its unit depends on the
 * resolution of the depth buffer. The drape lifts its vertices ever so slightly to win instead
 * (DRAPE_LIFT_RATIO in drape/renderer.ts).
 */
export function applyDrapeGlState(gl: WebGL2RenderingContext): void {
  applyDrapeBlendState(gl);
  setDepthTestEnabled(gl, true);
  gl.depthFunc(gl.LEQUAL);
  gl.disable(gl.POLYGON_OFFSET_FILL);
}

/**
 * Goes back to the drape after an image was interleaved (the blending and the depth test; the
 * depth function and the offset were left as the drape set them)
 */
export function resumeDrapeGlState(gl: WebGL2RenderingContext): void {
  applyDrapeBlendState(gl);
  setDepthTestEnabled(gl, true);
}

/**
 * Establishes the GL state of the symbols and the UI (no depth test)
 *
 * From here on it is not "something painted onto the ground" but the symbols and the UI.
 * Points, handles and selection boxes are billboards, so with the depth in effect they disappear
 * entirely as soon as they sink a little into the ground. Measured, enabling the terrain made
 * every point invisible. Symbols are always drawn in front.
 */
export function enterSymbolGlState(gl: WebGL2RenderingContext): void {
  setDepthTestEnabled(gl, false);
}

/** Premultiplied alpha compositing of the drape */
function applyDrapeBlendState(gl: WebGL2RenderingContext): void {
  gl.enable(gl.BLEND);
  gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
}
