// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * How the selection highlight of datasets looks
 *
 * Two rendering paths read the same values.
 *
 * - Immediate mode (`highlightFeature` in `dataset/selection.ts`). Draws points, and the
 *   polygons and lines that do not go through the analysis drape (dashed outlines and so on)
 * - Analysis drape (`view/terrain/drape/renderer.ts`). Draws the selection highlight for the
 *   band (z > 11) that draws polygons and lines as pixels of the ground surface
 *
 * Putting separate constants in the two places would make the color or the width change when
 * crossing a band. This single file owns the values.
 *
 * This file imports nothing, so that it depends on neither path.
 */

/** Base color of the selection highlight (#FF2D55, the same as the selection UI) */
export const SELECTION_HIGHLIGHT_COLOR = '#FF2D55';

/** Opacity of the polygon fill of the selection highlight */
export const SELECTION_HIGHLIGHT_FILL_OPACITY = 0.25;

/** Extra line width added by the selection highlight (CSS pixels) */
export const SELECTION_HIGHLIGHT_STROKE_EXTRA = 2;

/** Extra ring width added to points by the selection highlight (CSS pixels) */
export const SELECTION_HIGHLIGHT_RING_EXTRA = 3;

/**
 * Resolves the base color into an RGB triple in the range 0 to 1
 *
 * Used to pass it to a shader uniform (the color is a constant, so it is parsed only once).
 */
export const SELECTION_HIGHLIGHT_RGB: readonly [number, number, number] = [
  Number.parseInt(SELECTION_HIGHLIGHT_COLOR.slice(1, 3), 16) / 255,
  Number.parseInt(SELECTION_HIGHLIGHT_COLOR.slice(3, 5), 16) / 255,
  Number.parseInt(SELECTION_HIGHLIGHT_COLOR.slice(5, 7), 16) / 255,
];
