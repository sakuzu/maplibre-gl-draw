// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Draws billboards with the depth test disabled.
 *
 * A point is lifted to the elevation of its anchor and then drawn as a billboard that faces
 * the screen. The lower half of the billboard sits below the anchor, so testing it against the
 * depth of the terrain mesh buries it in the ground and clips it away, leaving the point as a
 * half circle. Whether something is hidden by the terrain is the job of the occlusion ghost
 * (occlusion.ts), not of the depth test, so the depth test is always disabled here.
 *
 * The responsibility for disabling the depth test belongs to the renderer. Disabling it in
 * custom-layer instead means it gets forgotten in configurations where the analytic drape is
 * unavailable (a single dataset makes canDrape false). That is exactly what the
 * "only points of datasets become half circles" defect was.
 *
 * Billboards are not drawn in a single place. Both the instanced billboard (point-instance) and
 * the per-point shapes (point-shape: triangle, star, and the degenerate path for the default
 * circle) draw billboards. Wrapping only the instanced side leaves hand-drawn points as half
 * circles. A hand-drawn Point may be taken over by a registered FeatureTypeRenderer, and then
 * never goes through the instanced path at all. That is why this function is shared by every
 * renderer that draws billboards. A small flat quad laid on the map plane goes through here for
 * the same reason: given elevation at its four corners only, with no subdivision, it gets shaved
 * off where the terrain pokes through from the inside.
 *
 * The original state is always restored. Polygons and lines must be hidden correctly by the
 * depth of the terrain mesh.
 *
 * The original state is read from the record in `layer/depth-state.ts`. It must not be queried
 * with `gl.isEnabled` every time (that is a synchronous GPU round trip, and with thousands of
 * billboards drawn in a frame the frame reaches tens of seconds).
 */

import { isDepthTestEnabled, setDepthTestEnabled } from '../../layer/depth-state.js';

/**
 * Runs a draw callback with the depth test off, then restores the depth test as it was.
 *
 * Use it around anything drawn as a billboard (a marker or a picture facing the screen) so that
 * the terrain mesh does not cut it in half. Polygons and lines should stay depth-tested.
 *
 * @param gl The WebGL context of the map
 * @param draw The drawing to run
 */
export function drawBillboardsWithoutDepth(gl: WebGL2RenderingContext, draw: () => void): void {
  const depthWasEnabled = disableDepthForBillboards(gl);
  try {
    draw();
  } finally {
    restoreDepthAfterBillboards(gl, depthWasEnabled);
  }
}

/**
 * The first half of {@link drawBillboardsWithoutDepth}, for a draw that makes no callback: turns
 * the depth test off and returns whether it was on (give it to `restoreDepthAfterBillboards`,
 * in a `finally`)
 *
 * @internal
 */
export function disableDepthForBillboards(gl: WebGL2RenderingContext): boolean {
  const depthWasEnabled = isDepthTestEnabled(gl);
  if (depthWasEnabled) setDepthTestEnabled(gl, false);
  return depthWasEnabled;
}

/**
 * The second half of {@link drawBillboardsWithoutDepth}: turns the depth test back on when it
 * was on
 *
 * @internal
 */
export function restoreDepthAfterBillboards(
  gl: WebGL2RenderingContext,
  depthWasEnabled: boolean,
): void {
  if (depthWasEnabled) setDepthTestEnabled(gl, true);
}
