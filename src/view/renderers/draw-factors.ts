// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Draw factors for retained-mode rendering (size and opacity)
 *
 * A retained batch bakes its vertex data, so changing dimensions or colors
 * would normally require rebuilding it. Per-frame adjustments such as "make it
 * slightly thinner and fainter as the zoom changes" can, however, be done with
 * a uniform that is multiplied into the baked values at draw time. This module
 * only defines the shape in which those factors are passed around.
 *
 * Conventions:
 *
 * - The default is `NEUTRAL_DRAW_FACTORS` (1x scale, opacity 1), so calls that
 *   pass no factors (Store rendering, immediate mode) look exactly as before,
 *   down to the pixel
 * - A uniform is per-program residual state, so even rendering paths that do
 *   not use the factors must write 1 (a value left over from a previous draw
 *   makes another draw come out thinner; this is the same family of accident as
 *   forgetting to restore the blend state)
 * - The factors are a per-dataset adjustment and do not propagate to the
 *   Store (the drawn features)
 */

/**
 * Factors multiplied in at draw time
 */
export interface RetainedDrawFactors {
  /**
   * Size factor (applies to point diameter, line width and outline width). 1 keeps the
   * former look
   */
  scale: number;
  /** Opacity factor (0..1). 1 keeps the former look */
  opacity: number;
}

/**
 * No factors (the former look)
 */
export const NEUTRAL_DRAW_FACTORS: RetainedDrawFactors = { scale: 1, opacity: 1 };

/**
 * Round factors that came from outside into a safe range
 *
 * This is a defense so that rendering is not broken when a caller's function
 * returns NaN, infinity or a negative value. Only positive finite numbers are
 * accepted for scale (anything else becomes 1), and opacity is clamped to
 * 0..1.
 */
export function sanitizeDrawFactors(
  factors: { scale: number; opacity: number } | null | undefined,
): RetainedDrawFactors {
  if (!factors) return NEUTRAL_DRAW_FACTORS;

  const scale = Number.isFinite(factors.scale) && factors.scale > 0 ? factors.scale : 1;
  const opacity = Number.isFinite(factors.opacity) ? Math.min(1, Math.max(0, factors.opacity)) : 1;

  return { scale, opacity };
}

/**
 * The draw-time factors of a Store layer (its opacity)
 *
 * `Layer.opacity` is a look-only setting, so it is applied at draw time rather than baked into
 * the vertex data: a change of the value does not rebuild a retained batch. The size is not
 * touched (scale 1). A missing layer, and an opacity of 1, give `NEUTRAL_DRAW_FACTORS` itself;
 * a value outside 0..1 or not finite is rounded the same way as `sanitizeDrawFactors`.
 */
export function layerDrawFactors(
  layer: { readonly opacity?: number } | null | undefined,
): RetainedDrawFactors {
  const opacity = layer?.opacity;
  if (opacity === undefined || opacity === 1) return NEUTRAL_DRAW_FACTORS;
  return sanitizeDrawFactors({ scale: 1, opacity });
}
