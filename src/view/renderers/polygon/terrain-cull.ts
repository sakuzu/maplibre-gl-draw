// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// Back-face culling for terrain-following fills
//
// Fills are drawn lifted slightly in front of the terrain by a depth bias, so on a
// ridge silhouette the fill pasted onto the slope on the far side of the ridge line
// passes the depth test and leaks through as a bright band (a double fill) along the
// ridge line. The far-side slope faces away from the camera, so culling back faces
// removes this leak structurally, regardless of how large or small the bias is.
//
// Precondition: terrain tessellation (pushOriented in terrain/tessellation.ts)
// normalizes the winding of every triangle to "positive Mercator cross product =
// CCW in window coordinates = front face". When terrain is disabled there is no
// guarantee that the winding is consistent (it stays as the plain earcut output),
// so culling is limited to when terrain is enabled.

import type { TerrainContext } from '../../terrain/context.js';

/** Draws with back-face culling enabled only while terrain is active */
export function drawFillWithTerrainCull(
  gl: WebGL2RenderingContext,
  terrain: TerrainContext,
  draw: () => void,
): void {
  const active = terrain.renderState.active;
  if (active) {
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
    gl.frontFace(gl.CCW);
  }
  draw();
  if (active) gl.disable(gl.CULL_FACE);
}
