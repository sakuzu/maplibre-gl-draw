// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the selection frame the engine draws: the outline of `ScreenContext.outline`,
 * which has no margin, with `selectionStyle.boundingBox.margin` added on every side
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_SELECTION_CONFIG } from '../../shared/config/selection.js';
import { createCoordinateTransform } from '../../shared/math/index.js';
import { drawProperties } from '../../shared/properties.js';
import type { Coordinate, Feature } from '../../store/types.js';
import { createMapStub } from '../../test-utils.js';
import type { StrokeRenderer } from '../../view/renderers/stroke.js';
import { createSelectionExtensionRegistry } from '../../view/ui/selection-ui/extension-registry.js';
import { SelectionUIRenderer } from '../../view/ui/selection-ui/renderer.js';
import type { ScreenPoint } from '../events.js';
import { createScreenContext } from './contexts.js';

/** The zoom at which a pixel of the map plane is a pixel of the stub map (100 px a degree) */
const ZOOM = Math.log2((360 * 100) / 512);
const MARGIN = DEFAULT_SELECTION_CONFIG.boundingBox.margin;

const { map } = createMapStub();
const extensions = createSelectionExtensionRegistry();
const screen = createScreenContext({
  map,
  pixelRatio: { resolve: () => 1 } as never,
  selectionExtensions: extensions,
});
const transform = createCoordinateTransform(map);

/** A point type whose frame is a rectangle 60 by 20 px turned by 30 degrees */
extensions.registerPointFrameOutline('Turned', (feature) => {
  const [x, y] = screen.project((feature.geometry as GeoJSON.Point).coordinates);
  const angle = Math.PI / 6;
  const u = [Math.cos(angle), Math.sin(angle)];
  const v = [-Math.sin(angle), Math.cos(angle)];
  return [
    [-30, -10],
    [30, -10],
    [30, 10],
    [-30, 10],
  ].map(([a, b]) => ({ x: x + u[0] * a + v[0] * b, y: y + u[1] * a + v[1] * b }));
});

function feature(type: string, geometry: GeoJSON.Geometry, properties = {}): Feature {
  return {
    id: type,
    type,
    geometry,
    layerId: 'l1',
    groupId: undefined,
    properties,
    style: {},
    visible: true,
    locked: false,
  } as Feature;
}

const FEATURES: Feature[] = [
  feature('Point', { type: 'Point', coordinates: [0.1, 0.1] }),
  feature('Turned', { type: 'Point', coordinates: [0.2, -0.1] }),
  feature(
    'Image',
    { type: 'Point', coordinates: [-0.1, 0.2] },
    drawProperties({ imageWidth: 80, imageHeight: 40, rotation: 20, createdZoom: ZOOM }),
  ),
  feature('LineString', {
    type: 'LineString',
    coordinates: [
      [-0.3, 0],
      [0.3, 0],
    ],
  }),
  feature('Polygon', {
    type: 'Polygon',
    coordinates: [
      [
        [-0.2, -0.2],
        [0.3, -0.2],
        [0.3, 0.1],
        [-0.2, -0.2],
      ],
    ],
  }),
];

/** The corners of the frame the renderer draws for one selected feature, on the screen */
function drawnFrame(target: Feature): ScreenPoint[] {
  const frames: Coordinate[][] = [];
  const stroke = { draw: (coords: Coordinate[]) => frames.push(coords) };
  const renderer = new SelectionUIRenderer(
    stroke as unknown as StrokeRenderer,
    DEFAULT_SELECTION_CONFIG,
    extensions,
  );
  renderer.setTransform(transform);
  renderer.draw([target], ZOOM);
  expect(frames).toHaveLength(1);
  // The path is closed: the first corner comes again at the end
  return frames[0].slice(0, 4).map((c) => screen.project(c));
}

/** The distance from a point to the line through two points, positive away from `inside` */
function outwardDistance(p: ScreenPoint, a: ScreenPoint, b: ScreenPoint, inside: ScreenPoint) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const length = Math.hypot(dx, dy);
  const side = (q: ScreenPoint) => ((q[0] - a[0]) * dy - (q[1] - a[1]) * dx) / length;
  return side(inside) > 0 ? -side(p) : side(p);
}

describe('the selection frame', () => {
  it.each(FEATURES.map((f) => [f.type, f] as const))(
    'of a %s stands the margin outside every edge of its outline',
    (_type, target) => {
      const outline = screen.outline(target);
      expect(outline).toHaveLength(4);
      const frame = drawnFrame(target);
      const middle: ScreenPoint = [
        outline.reduce((sum, c) => sum + c[0], 0) / 4,
        outline.reduce((sum, c) => sum + c[1], 0) / 4,
      ];
      for (let i = 0; i < 4; i++) {
        const corner = outline[i];
        // The two edges of the outline that meet at the corner
        for (const next of [outline[(i + 1) % 4], outline[(i + 3) % 4]]) {
          if (Math.hypot(next[0] - corner[0], next[1] - corner[1]) < 1e-9) continue;
          // The middle of a straight line lies on its edge: the frame is outside on either side
          const inside: ScreenPoint =
            Math.abs(outwardDistance(middle, corner, next, middle)) < 1e-9
              ? [2 * corner[0] - frame[i][0], 2 * corner[1] - frame[i][1]]
              : middle;
          expect(outwardDistance(frame[i], corner, next, inside)).toBeCloseTo(MARGIN, 1);
        }
      }
    },
  );

  it('keeps ScreenContext.outline without the margin', () => {
    const [point] = FEATURES;
    const [x, y] = screen.project((point.geometry as GeoJSON.Point).coordinates);
    // The default frame of a point is a 12 px square around it, with no margin
    expect(screen.outline(point)).toEqual([
      [x - 6, y - 6],
      [x + 6, y - 6],
      [x + 6, y + 6],
      [x - 6, y + 6],
    ]);
  });
});
