// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Blend state (alpha blending) for our own rendering
 *
 * The fragment shader of every renderer outputs a color that is not premultiplied by alpha.
 * RGB therefore composites correctly with `SRC_ALPHA` / `ONE_MINUS_SRC_ALPHA`.
 *
 * The maplibre canvas, on the other hand, uses `premultipliedAlpha` (the WebGL default), so the
 * alpha component of the destination represents the opacity of everything composited so far.
 * Applying the same factors as RGB to it gives
 *
 *   dst.a = a × a + (1 - a) × dst.a
 *
 * which squares the alpha alone. A 25% fill drops to 6.25%, and where the destination alpha is 0
 * (where the canvas is still transparent) it almost disappears when the canvas itself is
 * composited. This is the 2026-08-10 bug where only the fill of a drawn feature vanished in the
 * print preview while its outline (opaque) remained.
 *
 * Set the factor of the alpha component alone to `ONE` so that the correct over composition
 *
 *   dst.a = a + (1 - a) × dst.a
 *
 * is used. The RGB equation is exactly the same as before, so the appearance where the
 * destination is opaque does not change.
 *
 * This state is a contract for the whole frame, and CustomLayer sets it once at the entry point
 * of rendering. Handing control to an external renderer (a renderer for a custom feature type or
 * an overlay renderer) may overwrite it in the middle of a frame, so call this function again at
 * the point control comes back to re-establish the contract
 * (rendering.md, "Ownership of the blend state").
 */

/**
 * The part of a WebGL context {@link applyDrawBlendState} uses; a `WebGL2RenderingContext`
 * satisfies it.
 */
export interface BlendCapableGL {
  /** The `BLEND` capability constant */
  BLEND: number;
  /** The `ONE` blend factor constant */
  ONE: number;
  /** The `SRC_ALPHA` blend factor constant */
  SRC_ALPHA: number;
  /** The `ONE_MINUS_SRC_ALPHA` blend factor constant */
  ONE_MINUS_SRC_ALPHA: number;
  /** Enables a capability */
  enable(cap: number): void;
  /** Sets the RGB and alpha blend factors separately */
  blendFuncSeparate(srcRGB: number, dstRGB: number, srcAlpha: number, dstAlpha: number): void;
}

/**
 * Restores the blend state the library's renderers expect: blending on, straight alpha for
 * RGB and `ONE` / `ONE_MINUS_SRC_ALPHA` for alpha.
 *
 * A custom renderer that changes the blend state calls it before handing control back.
 *
 * @param gl The WebGL context of the map
 */
export function applyDrawBlendState(gl: BlendCapableGL): void {
  gl.enable(gl.BLEND);
  gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
}
