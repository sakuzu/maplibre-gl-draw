// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the selection frame the engine draws: the outline of `ScreenContext.outline`,
 * which has no margin, with `selectionStyle.boundingBox.margin` added on every side
 */

import type { ProjectionData } from 'maplibre-gl';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SELECTION_CONFIG } from '../../shared/config/selection.js';
import { createCoordinateTransform } from '../../shared/math/index.js';
import { drawProperties } from '../../shared/properties.js';
import type { Coordinate, Feature } from '../../store/types.js';
import { createMapStub } from '../../test-utils.js';
import type {
  AnchoredOutlineRenderer,
  OutlineOffset,
} from '../../view/renderers/anchored-outline.js';
import type { StrokeRenderer } from '../../view/renderers/stroke.js';
import { createSelectionExtensionRegistry } from '../../view/ui/selection-ui/extension-registry.js';
import { SelectionUIRenderer } from '../../view/ui/selection-ui/renderer.js';
import type { ScreenPoint } from '../events.js';
import { createScreenContext } from './contexts.js';
import { createDrawOnEngine } from './create-draw.js';
import { createEngine } from './engine.js';

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

/**
 * A renderer of selection frames whose drawing is recorded as the corners on the screen: a
 * frame on the map through its corners, a frame of the screen through its anchor and offsets
 */
function recordingRenderer(
  registry: typeof extensions,
  project: (lngLat: Coordinate) => ScreenPoint,
): { renderer: SelectionUIRenderer; frames: ScreenPoint[][] } {
  const frames: ScreenPoint[][] = [];
  const stroke = {
    // The path is closed: the first corner comes again at the end
    draw: (coords: Coordinate[]) => frames.push(coords.slice(0, 4).map((c) => project(c))),
  };
  const outline = {
    draw: (anchor: Coordinate, _elevation: number, corners: OutlineOffset[]) => {
      const [x, y] = project(anchor);
      frames.push(corners.map((c) => [x + c.x, y + c.y] as ScreenPoint));
    },
  };
  const renderer = new SelectionUIRenderer(
    stroke as unknown as StrokeRenderer,
    outline as unknown as AnchoredOutlineRenderer,
    DEFAULT_SELECTION_CONFIG,
    registry,
  );
  renderer.setProjectionData({} as ProjectionData);
  return { renderer, frames };
}

/** The corners of the frame the renderer draws for one selected feature, on the screen */
function drawnFrame(target: Feature): ScreenPoint[] {
  const { renderer, frames } = recordingRenderer(extensions, (c) => screen.project(c));
  renderer.setTransform(transform);
  renderer.draw([target], ZOOM);
  expect(frames).toHaveLength(1);
  return frames[0];
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
    // Without a draw instance to give the extent of the marker, the frame of a point is a
    // 12 px square around it, with no margin
    expect(screen.outline(point)).toEqual([
      [x - 6, y - 6],
      [x + 6, y - 6],
      [x + 6, y + 6],
      [x - 6, y + 6],
    ]);
  });
});

describe('the selection frame of a built-in point of a draw instance', () => {
  /** The half sides of the outline and of the drawn frame of a point with this style */
  function frameOf(style: Feature['style']): { outline: number; frame: number } {
    const { map: engineMap } = createMapStub();
    const engine = createEngine(engineMap, {}, { deferDefaultMode: true });
    try {
      const draw = createDrawOnEngine(engine);
      const created = draw.features.create({
        type: 'Point',
        geometry: { type: 'Point', coordinates: [0.1, 0.1] },
        style,
      });
      if (!created) throw new Error('no feature');
      const stored = engine.context.store.getFeature(created.id) as Feature;
      const registry = engine.context.selectionScope.extensions;
      const engineScreen = createScreenContext({
        map: engineMap,
        pixelRatio: { resolve: () => 1 } as never,
        selectionExtensions: registry,
      });
      const [x] = engineScreen.project([0.1, 0.1]);
      const { renderer, frames } = recordingRenderer(registry, (c) => engineScreen.project(c));
      renderer.setTransform(createCoordinateTransform(engineMap));
      renderer.draw([stored], ZOOM);
      const right = frames[0][1][0];
      return { outline: engineScreen.outline(stored)[1][0] - x, frame: right - x };
    } finally {
      engine.destroy();
    }
  }

  it('spans the marker (the radius and its outline), with the margin outside it', () => {
    // A radius of 6 px and an outline of 2 px by default: a 16 px frame before the margin
    expect(frameOf({})).toEqual({
      outline: expect.closeTo(8, 6),
      frame: expect.closeTo(8 + MARGIN, 6),
    });
  });

  it('follows the size of the marker and of its outline', () => {
    expect(frameOf({ pointRadius: 20, pointStrokeWidth: 4 })).toEqual({
      outline: expect.closeTo(24, 6),
      frame: expect.closeTo(24 + MARGIN, 6),
    });
  });
});

describe('the combined frame of a multiple selection', () => {
  const point = (id: string, coordinates: [number, number]): Feature => ({
    ...feature('Point', { type: 'Point', coordinates }),
    id,
  });
  const a = point('a', [0.1, 0.1]);
  const b = point('b', [0.3, -0.1]);

  /** The frames drawn for a selection, with the projection of the frame given */
  function framesOf(features: Feature[], projection: Partial<ProjectionData>): ScreenPoint[][] {
    const { renderer, frames } = recordingRenderer(extensions, (c) => screen.project(c));
    renderer.setTransform(transform);
    renderer.setProjectionData(projection as ProjectionData);
    renderer.draw(features, ZOOM);
    return frames;
  }

  /** The extent of a frame on the screen: [left, top, right, bottom] */
  const extentOf = (frame: ScreenPoint[]) => [
    Math.min(...frame.map(([x]) => x)),
    Math.min(...frame.map(([, y]) => y)),
    Math.max(...frame.map(([x]) => x)),
    Math.max(...frame.map(([, y]) => y)),
  ];

  it('spans the frames of its members on the screen', () => {
    const frames = framesOf([a, b], {});
    // The frame of each point, then the combined one
    expect(frames).toHaveLength(3);
    // a is up and to the left of b
    const [left, top] = extentOf(frames[0]);
    const [, , right, bottom] = extentOf(frames[1]);
    const expected = [left, top, right, bottom];
    extentOf(frames[2]).forEach((value, i) => {
      expect(value).toBeCloseTo(expected[i], 6);
    });
  });

  it('leaves out a member on the far side of the globe', () => {
    // The horizon at longitude 0.2: b (0.3) is behind the sphere
    const edge = Math.sin((0.2 * Math.PI) / 180);
    const globe = { clippingPlane: [-1, 0, 0, edge], projectionTransition: 1 } as never;
    const frames = framesOf([a, b], globe);
    const own = extentOf(frames[0]);
    const combined = extentOf(frames[frames.length - 1]);
    combined.forEach((value, i) => {
      expect(value).toBeCloseTo(own[i], 6);
    });
  });
});
