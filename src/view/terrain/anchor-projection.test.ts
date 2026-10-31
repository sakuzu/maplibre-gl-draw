// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The projection of the anchors on the CPU (what hit testing reads over terrain) against the
 * projection of maplibre
 *
 * The anchors are projected in float64 with the formula the shaders draw with, so a point is
 * grabbed where it is drawn. On Web Mercator and on the globe that is where maplibre projects it
 * (`map.project`); in the transition between, where maplibre draws its own layers (the positions
 * of both projections mixed by the transition). The reference is computed in float64 with the
 * matrices maplibre builds (`test-support/glsl-projection.ts`), at every zoom from 0 to 24.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  frameProjection,
  mercatorOf,
  referenceClip,
  screenOf,
  type TestCamera,
} from '../../test-support/glsl-projection.js';
import { calculateOffsetUniforms, type ProjectionMatrices } from '../shaders/helpers.js';
import {
  clearAnchorFrame,
  projectAnchorAt,
  projectOnView,
  setAnchorFrame,
  setViewFrame,
  unprojectOnView,
} from './anchor.js';
import { NO_VIEW_FRAME, TerrainContext } from './context.js';
import type { TerrainLike } from './detect.js';

const WIDTH = 1280;
const HEIGHT = 720;
const context = new TerrainContext();

/** A terrain of no elevation */
const flat = {
  getTerrainData: () => null,
  getElevationForLngLatZoom: () => 0,
  tileManager: { getRenderableTiles: () => [] },
} as unknown as TerrainLike;

afterEach(() => {
  clearAnchorFrame(context);
  setViewFrame(context, NO_VIEW_FRAME);
});

/** The latitude of a Mercator y */
const latitudeOf = (y: number): number =>
  (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI;

/** The largest distance in CSS px from the anchors to the reference, over positions on the screen */
function worstOf(camera: TestCamera, transition: number): { px: number; where: string } {
  const projection = frameProjection(camera, transition);
  const data = {
    mainMatrix: projection.mainMatrix,
    fallbackMatrix: projection.fallbackMatrix,
    projectionTransition: projection.projectionTransition,
    clippingPlane: [...projection.clippingPlane],
  } as unknown as ProjectionMatrices;
  setAnchorFrame(context, {
    terrain: flat,
    zoom: camera.zoom,
    elevationScale: 0,
    projection: data,
    offsetUniforms: calculateOffsetUniforms(camera.center, data),
    width: camera.width,
    height: camera.height,
  });
  const worldSize = 512 * 2 ** camera.zoom;
  const [cx, cy] = mercatorOf(camera.center[0], camera.center[1]);
  let worst = { px: 0, where: '' };
  for (const distance of [0, 40, 300, 700]) {
    for (let k = 0; k < 8; k++) {
      const angle = (k * Math.PI) / 4 + 0.4;
      const lng = (cx + (Math.cos(angle) * distance) / worldSize) * 360 - 180;
      const lat = latitudeOf(cy + (Math.sin(angle) * distance) / worldSize);
      // A point is projected on the copy of the world nearest to the center
      if (Math.abs(lng - camera.center[0]) > 180) continue;
      const clip = referenceClip(projection, lng, lat);
      const w = clip[3];
      if (!(w > 0) || Math.abs(clip[0] / w) > 1 || Math.abs(clip[1] / w) > 1) continue;
      const [x, y] = screenOf(clip, camera.width, camera.height);
      const anchor = projectAnchorAt(context, lng, lat, 0);
      const px = anchor ? Math.hypot(anchor.x - x, anchor.y - y) : Number.POSITIVE_INFINITY;
      if (!(px <= worst.px)) {
        worst = { px, where: `zoom ${camera.zoom} center ${camera.center} position ${[lng, lat]}` };
      }
    }
  }
  return worst;
}

const ZOOMS = [...Array.from({ length: 25 }, (_, z) => z), 11.99];

describe('the projection of the anchors', () => {
  it.each([
    ['Web Mercator', 0],
    ['the globe', 1],
    ['the transition from the globe to Web Mercator', 0.5],
  ] as const)('lands where maplibre puts a position on %s', (_name, transition) => {
    let worst = { px: 0, where: '' };
    for (const zoom of ZOOMS) {
      for (const lat of [0, 15, 35.68, 60, 80]) {
        for (const pitch of [0, 50]) {
          const camera: TestCamera = {
            center: [139.7, lat],
            zoom,
            pitch,
            bearing: 25,
            width: WIDTH,
            height: HEIGHT,
          };
          const result = worstOf(camera, transition);
          if (!(result.px <= worst.px)) worst = result;
        }
      }
    }
    expect(worst.px, worst.where).toBeLessThan(0.01);
  });
});

describe('the view of the frame drawn last, without terrain', () => {
  /** Records the view of a frame of a camera, as the drawing does every frame */
  function drawView(camera: TestCamera, transition: number): void {
    const projection = frameProjection(camera, transition);
    const data = {
      mainMatrix: projection.mainMatrix,
      fallbackMatrix: projection.fallbackMatrix,
      projectionTransition: projection.projectionTransition,
      clippingPlane: [...projection.clippingPlane],
    } as unknown as ProjectionMatrices;
    setViewFrame(context, {
      projection: data,
      offsetUniforms: calculateOffsetUniforms(camera.center, data),
      width: camera.width,
      height: camera.height,
    });
  }

  it('answers nothing before the first frame', () => {
    expect(projectOnView(context, 139.7, 35.6)).toBeNull();
    expect(unprojectOnView(context, 10, 10, { lng: 139.7, lat: 35.6 })).toBeNull();
  });

  it.each([
    ['Web Mercator', 0],
    ['the globe', 1],
    ['the transition from the globe to Web Mercator', 0.5],
  ] as const)(
    'projects where maplibre puts a position on %s, and back from a point',
    (_name, transition) => {
      for (const zoom of [2, 10, 18, 24]) {
        const camera: TestCamera = {
          center: [139.7, 35.68],
          zoom,
          pitch: 50,
          bearing: 25,
          width: WIDTH,
          height: HEIGHT,
        };
        drawView(camera, transition);
        const worldSize = 512 * 2 ** zoom;
        const [cx, cy] = mercatorOf(camera.center[0], camera.center[1]);
        for (const [dx, dy] of [
          [0, 0],
          [200, -100],
          [-300, 150],
        ]) {
          const lng = (cx + dx / worldSize) * 360 - 180;
          const lat = latitudeOf(cy + dy / worldSize);
          const [x, y] = screenOf(
            referenceClip(frameProjection(camera, transition), lng, lat),
            WIDTH,
            HEIGHT,
          );
          const point = projectOnView(context, lng, lat);
          expect(point && Math.hypot(point.x - x, point.y - y)).toBeLessThan(0.01);
          // The position drawn at the point, found from a position some pixels away from it, as the
          // camera of the map may have moved since the frame
          const near = {
            lng: lng + (30 / worldSize) * 360,
            lat: latitudeOf(mercatorOf(lng, lat)[1] - 20 / worldSize),
          };
          const back = unprojectOnView(context, x, y, near);
          expect(back).not.toBeNull();
          const again = back && projectOnView(context, back.lng, back.lat);
          expect(again && Math.hypot(again.x - x, again.y - y)).toBeLessThan(1e-3);
        }
      }
    },
  );
});
