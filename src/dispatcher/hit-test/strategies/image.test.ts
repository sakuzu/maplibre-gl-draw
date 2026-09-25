// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for ImageHitTestStrategy
 *
 * The rendered image (computeQuadVertices) is rotated in latitude-normalized space. The
 * hit test has to agree with that. For a rotated image at a high latitude, it verifies at
 * sample points that the hit test agrees with the inside/outside of the rendered box.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TILE_SIZE,
  getMetersPerPixel,
  metersToDegreesLat,
  metersToDegreesLng,
} from '../../../shared/math/index.js';
import type { Coordinate, Feature } from '../../../store/types.js';
import { computeQuadVertices } from '../../../view/shaders/quad.js';
import { ImageHitTestStrategy } from './image.js';

const IMG_W = 200;
const IMG_H = 100;

function image(lng: number, lat: number, rotation: number): Feature {
  return {
    id: 'img',
    type: 'Image',
    coordinates: [lng, lat],
    layerId: 'l1',
    properties: {
      imageFileId: 'f',
      imageWidth: IMG_W,
      imageHeight: IMG_H,
      createdZoom: 14,
      rotation,
    },
    locked: false,
    visible: true,
  };
}

/** The four corners of the rendered image (the same size computation as
 * computeQuadVertices) */
function drawnCorners(lng: number, lat: number, rotation: number): Coordinate[] {
  const mpp = getMetersPerPixel(lat, 14, DEFAULT_TILE_SIZE);
  const widthDeg = metersToDegreesLng(mpp * IMG_W, lat);
  const heightDeg = metersToDegreesLat(mpp * IMG_H);
  const q = computeQuadVertices(lng, lat, widthDeg, heightDeg, (rotation * Math.PI) / 180);
  return [q.topLeft, q.topRight, q.bottomRight, q.bottomLeft];
}

function insideQuad(p: Coordinate, corners: Coordinate[]): boolean {
  let sign = 0;
  for (let i = 0; i < corners.length; i++) {
    const a = corners[i];
    const b = corners[(i + 1) % corners.length];
    const cross = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
    if (Math.abs(cross) < 1e-12) continue;
    const s = cross > 0 ? 1 : -1;
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

describe('ImageHitTestStrategy agrees with the rendered image', () => {
  const strategy = new ImageHitTestStrategy(DEFAULT_TILE_SIZE);

  for (const { lat, rotation } of [
    { lat: 0, rotation: 0 },
    { lat: 35, rotation: 45 },
    { lat: 60, rotation: 30 },
    { lat: 60, rotation: 45 },
  ]) {
    it(`the hit area agrees with the rendered box at lat=${lat}, rotation=${rotation}`, () => {
      const feature = image(139, lat, rotation);
      const corners = drawnCorners(139, lat, rotation);

      const cx = 139;
      const cy = lat;
      const half = Math.max(...corners.map((c) => Math.hypot(c[0] - cx, c[1] - cy)));
      const margin = half * 0.05;

      let checked = 0;
      const step = (half * 2) / 16;
      for (let x = cx - half * 1.3; x <= cx + half * 1.3; x += step) {
        for (let y = cy - half * 1.3; y <= cy + half * 1.3; y += step) {
          const p: Coordinate = [x, y];
          const distToCenter = Math.hypot(x - cx, y - cy);
          if (Math.abs(distToCenter - half) < margin) continue;

          const inside = insideQuad(p, corners);
          const hit = strategy.test(feature, p, 0);
          expect(hit, `point ${x},${y} inside=${inside}`).toBe(inside);
          checked++;
        }
      }
      expect(checked).toBeGreaterThan(0);
    });
  }
});
