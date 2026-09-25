// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Serial number of the render frame
 *
 * Uniforms are per-program residual state, so a value that does not change
 * within a frame only needs to be written once. Retained-mode rendering
 * rewrites the same projection matrix and the same camera-related values for
 * every chunk (batch), and once there are hundreds of visible chunks this
 * re-setting alone eats up the frame's CPU budget.
 *
 * Each renderer remembers "the value it wrote last time" and skips the gl call
 * when it is unchanged, but to avoid missing an update should the
 * ProjectionData handed over by MapLibre ever change to a design where the
 * same reference is kept and only its contents are rewritten, the memo is
 * always invalidated when the frame changes over. This serial number is the
 * basis for that.
 *
 * The number is advanced by one at the entry point of the custom layer's
 * render. Sharing the number across multiple maps is fine (an advance caused
 * by another map's render only errs on the side of "rewriting more than
 * necessary", and correctness is not harmed).
 */

/** The current frame number */
let renderFrame = 0;

/**
 * Declares the start of a frame (invalidates the memoization of uniforms)
 */
export function beginRenderFrame(): void {
  renderFrame++;
}

/**
 * Returns the current frame number
 */
export function getRenderFrame(): number {
  return renderFrame;
}
