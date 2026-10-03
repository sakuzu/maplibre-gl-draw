// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Which side of the globe a position is on
 *
 * maplibre's globe shaders hide the far side of the sphere by the depth they give a vertex:
 * `globeComputeClippingZ` puts a vertex beyond the plane of the horizon past the far plane, so it
 * is clipped. A mark projected in the shader is hidden that way; a computation on the CPU that
 * projects a position with the map (which projects the far side onto the near face) has to ask
 * the same question to leave the hidden position out.
 */

/** The radius of the sphere of maplibre's globe, in meters (`GLOBE_RADIUS` of its shaders) */
const GLOBE_RADIUS_METERS = 6371008.8;

/**
 * Where the transition between the Mercator projection and the globe begins to clip (maplibre's
 * `z_globeness_threshold`)
 */
const CLIPPING_TRANSITION_START = 0.2;

/** What the test reads of the projection of the frame: the horizon plane and the transition */
export interface GlobeClipping {
  /** The plane of the horizon on the unit sphere (`u_projection_clipping_plane`) */
  clippingPlane: readonly [number, number, number, number] | readonly number[];
  /** 0 on the Mercator plane, 1 on the globe (`u_projection_transition`) */
  projectionTransition: number;
}

/**
 * Whether a position is on the side of the globe the camera sees, as maplibre's globe shaders
 * decide it: the clip depth `globeComputeClippingZ` gives the position, mixed in as the
 * transition does, stays within the far plane
 *
 * Always true on the Mercator plane (a transition of 0).
 *
 * @param lng The longitude in degrees
 * @param lat The latitude in degrees
 * @param elevationMeters The height of the position above the sphere
 * @param projection The horizon plane and the transition of the frame
 */
export function isOnVisibleSideOfGlobe(
  lng: number,
  lat: number,
  elevationMeters: number,
  projection: GlobeClipping,
): boolean {
  const transition = projection.projectionTransition;
  if (!(transition > 0)) return true;
  const plane = projection.clippingPlane;
  if (plane.length < 4) return true;

  // The position on the unit sphere as maplibre's projectToSphere places it, raised by its height
  const lngRad = (lng * Math.PI) / 180;
  const latRad = (lat * Math.PI) / 180;
  const raise = 1 + elevationMeters / GLOBE_RADIUS_METERS;
  const x = Math.sin(lngRad) * Math.cos(latRad) * raise;
  const y = Math.sin(latRad) * raise;
  const z = Math.cos(lngRad) * Math.cos(latRad) * raise;
  const depth = 1 - (x * plane[0] + y * plane[1] + z * plane[2] + plane[3]);

  // During the transition the depth is mixed in from the threshold on
  const weight =
    transition > 0.999
      ? 1
      : Math.min(
          1,
          Math.max(0, (transition - CLIPPING_TRANSITION_START) / (1 - CLIPPING_TRANSITION_START)),
        );
  return weight * depth <= 1;
}
