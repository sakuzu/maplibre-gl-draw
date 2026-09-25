// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Draws symbols (billboards and glyphs) with the depth test disabled.
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
 * the per-point shapes (point-shape: triangle, star, icon, and the degenerate path for the
 * default circle) draw billboards. Wrapping only the instanced side leaves hand-drawn points as
 * half circles. A hand-drawn Point may be taken over by a registered CustomFeatureRenderer,
 * and then never goes through the instanced path at all. That is why this function is shared
 * by every renderer that draws billboards. SDF glyphs laid flat on the map plane (text that is
 * not painted into a ground quad) go through here for the same reason.
 * A glyph is a flat quad given elevation at its four corners, so, having no subdivision, its
 * strokes get shaved off where the terrain pokes through from the inside and the text looks
 * broken.
 *
 * The original state is always restored. Polygons and lines must be hidden correctly by the
 * depth of the terrain mesh.
 *
 * The original state is read from the record in `layer/depth-state.ts`. It must not be queried
 * with `gl.isEnabled` every time (that is a synchronous GPU round trip, and on a map with
 * thousands of labels a single frame reaches tens of seconds).
 */

import { isDepthTestEnabled, setDepthTestEnabled } from '../../layer/depth-state.js';

/**
 * Runs a draw callback with the depth test off, then restores the depth test as it was.
 *
 * Use it around anything drawn as a billboard (a marker or an icon facing the screen) so that
 * the terrain mesh does not cut it in half. Polygons and lines should stay depth-tested.
 *
 * @param gl The WebGL context of the map
 * @param draw The drawing to run
 */
export function drawBillboardsWithoutDepth(gl: WebGL2RenderingContext, draw: () => void): void {
  const depthWasEnabled = isDepthTestEnabled(gl);
  if (depthWasEnabled) setDepthTestEnabled(gl, false);
  try {
    draw();
  } finally {
    if (depthWasEnabled) setDepthTestEnabled(gl, true);
  }
}
