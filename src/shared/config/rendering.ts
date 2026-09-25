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
   * Time-slicing of the triangulation of huge polygons
   *
   * When true (the default), polygons with many vertices that are placed on a
   * dataset (by default more than 10,000 vertices) are triangulated in small pieces,
   * progressing across frames. The fill of such a polygon does not appear until the
   * triangulation finishes (the outline does appear).
   *
   * Setting it to false always triangulates on the spot. Rendering that "cannot wait", that
   * is, uses that draw once and take the picture out (printing, thumbnails), should use this,
   * because it prevents taking the picture out while the fill is not yet ready.
   *
   * @defaultValue `true`
   */
  asyncTriangulation?: boolean;
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
  asyncTriangulation: true,
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
    asyncTriangulation: override.asyncTriangulation ?? base.asyncTriangulation,
  };
}
