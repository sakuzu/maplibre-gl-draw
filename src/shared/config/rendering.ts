// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Rendering configuration
 *
 * Makes the default style of the box selection UI configurable.
 */

import type { Color } from '../types/style.js';

/**
 * How the rectangle of a box selection (a Shift-drag in the select mode) looks (part of
 * {@link RenderingConfig})
 */
export interface BoxSelectionStyleConfig {
  /**
   * The fill; its alpha is the opacity of the fill
   *
   * @defaultValue `#FF0099` at an alpha of 0.2
   */
  fillColor: Color;
  /**
   * The color of the outline
   *
   * @defaultValue `#FF0099`
   */
  strokeColor: Color;
  /**
   * The width of the outline in CSS pixels
   *
   * @defaultValue `2`
   */
  strokeWidth: number;
  /**
   * The opacity of the outline, from 0 to 1
   *
   * @defaultValue `1`
   */
  strokeOpacity: number;
  /**
   * The dash pattern of the outline in CSS pixels, `[dash, gap]`
   *
   * @defaultValue `[6, 4]`
   */
  dashArray: [number, number];
}

/**
 * Rendering settings: the look of the box selection and two switches of the renderer
 *
 * Give the settings to change through the `renderingStyle` option of `createMapLibreGLDraw`;
 * the ones left out keep their defaults.
 */
export interface RenderingConfig {
  /**
   * The rectangle of a box selection
   *
   * @defaultValue a `#FF0099` 2 px outline dashed 6 px / 4 px, filled at an alpha of 0.2
   */
  boxSelectionStyle: BoxSelectionStyleConfig;
  /**
   * Retained-mode rendering of Store features
   *
   * When true (the default), Store features are drawn from retained batches prepared per
   * layer. Features that stay still are no longer rebuilt every frame.
   * Setting it to false goes back to the previous immediate-mode rendering (an escape hatch).
   *
   * The rendering result (including z-order) is the same either way.
   *
   * @defaultValue `true`
   */
  storeRetained?: boolean;
  /**
   * Whether work that does not fit in one frame is spread over the following frames
   *
   * When true (the default), the renderer keeps every frame short while the picture fills in
   * over a few frames, much like tiles arriving:
   *
   * - the retained batches of the datasets are built within a time budget per frame, the
   *   chunks in view first (the ones left over appear in the next frames)
   * - polygons of a dataset with more than 10,000 vertices are triangulated in slices across
   *   frames; their fill appears when the triangulation ends (the outline appears at once)
   * - the tile index of the terrain drape is built within a time budget per frame
   *
   * Set it to false to draw frames that are complete: everything above is done in the frame
   * that needs it, however long that frame takes. It is meant for a map that draws a frame to
   * read the picture back (printing, thumbnails, exports), not for an interactive map. While
   * the camera moves, the rebuilds that wait for the camera to stop still wait (a capture is
   * taken with the camera still).
   *
   * A complete frame is not yet a complete picture: the map's tiles and the DEM arrive
   * asynchronously. Wait for the map's `idle`, then for
   * {@link MapLibreGLDraw.hasPendingWork} to return false, which also covers the work that no
   * setting can make synchronous (the responses of a provider, an overlay renderer that
   * prepares resources over several frames).
   *
   * @defaultValue `true`
   */
  timeSlicing?: boolean;
}

/**
 * Default style configuration for the box selection UI
 */
export const DEFAULT_BOX_SELECTION_STYLE_CONFIG: BoxSelectionStyleConfig = {
  fillColor: [1.0, 0.0, 0.6, 0.2],
  strokeColor: [1.0, 0.0, 0.6, 1.0],
  strokeWidth: 2,
  strokeOpacity: 1.0,
  dashArray: [6, 4],
};

/**
 * Default rendering configuration
 */
export const DEFAULT_RENDERING_CONFIG: RenderingConfig = {
  boxSelectionStyle: DEFAULT_BOX_SELECTION_STYLE_CONFIG,
  storeRetained: true,
  timeSlicing: true,
};

/**
 * Helper function that merges configurations
 */
export function mergeRenderingConfig(
  base: RenderingConfig,
  override: Partial<RenderingConfig>,
): RenderingConfig {
  return {
    boxSelectionStyle: {
      ...base.boxSelectionStyle,
      ...override.boxSelectionStyle,
    },
    storeRetained: override.storeRetained ?? base.storeRetained,
    timeSlicing: override.timeSlicing ?? base.timeSlicing,
  };
}
