// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Remembering the state of the depth test
 *
 * Symbols (point billboards and SDF glyphs) must not be clipped by the depth of the terrain, so
 * the depth test is disabled while they are drawn and then restored
 * (`renderers/point/billboard-depth.ts`). That "restored" value must not be obtained by asking
 * `gl.isEnabled` every time. A WebGL state query synchronously round-trips to the GPU process, so
 * on a map with thousands of labels it becomes thousands of round-trips in a single frame and
 * rendering stalls for tens of seconds.
 *
 * Only CustomLayer and the analysis drape switch the depth test. The side that switches it records
 * the value here, and the symbol side reads that record. The record belongs to the WebGL context
 * whose state it mirrors (one entry per context), so two maps never read each other's value, and
 * two draw instances on one map share the context's true state. CustomLayer also reads the actual
 * state once at the start of a frame and syncs to it.
 */

/** The recorded depth test state of each WebGL context */
const depthTestState = new WeakMap<WebGL2RenderingContext, boolean>();

/**
 * Switch the depth test and record the new state
 */
export function setDepthTestEnabled(gl: WebGL2RenderingContext, enabled: boolean): void {
  if (enabled) gl.enable(gl.DEPTH_TEST);
  else gl.disable(gl.DEPTH_TEST);
  depthTestState.set(gl, enabled);
}

/**
 * The recorded state of the depth test of a context (false when nothing was recorded yet)
 */
export function isDepthTestEnabled(gl: WebGL2RenderingContext): boolean {
  return depthTestState.get(gl) === true;
}

/**
 * Sync back to the actual GL state (once at the start of a frame)
 *
 * This is the only place that asks GL. It happens once per frame, so the cost is negligible.
 */
export function syncDepthTestEnabled(gl: WebGL2RenderingContext): void {
  depthTestState.set(gl, gl.isEnabled(gl.DEPTH_TEST));
}
