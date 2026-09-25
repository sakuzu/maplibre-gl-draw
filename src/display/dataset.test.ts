// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for a dataset
 *
 * The drawing goes to a stub batch without GL and is verified by "what goes onto the batch" (the
 * same style as batch-manager.test.ts). They look at the viewport culling, the evaluation of the
 * style rules, the precedence of an individual style, and the coordinate shapes of Multi and
 * holes.
 */

import type { ProjectionData } from 'maplibre-gl';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_FEATURE_STYLE_CONFIG } from '../shared/config/feature-style.js';
import type { BoundingBox, Feature, StyleRule } from '../store/types.js';
import { createBatchManager } from '../view/renderers/batch-manager.js';
import { FeatureDrawer } from '../view/renderers/drawer.js';
import type { ImageRenderer } from '../view/renderers/image.js';
import type { SDFLineRenderer } from '../view/renderers/line/sdf-line.js';
import type { PointInstanceRenderer } from '../view/renderers/point/point-instance.js';
import type { PointShapeRenderer } from '../view/renderers/point/point-shape.js';
import type { PolygonBatchRenderer } from '../view/renderers/polygon/batch.js';
import type {
  SDFPolygonBatchData,
  SDFPolygonRenderer,
} from '../view/renderers/polygon/sdf-polygon.js';
import type { DisplayBatchTarget } from './dataset.js';
import { createDatasetManager, type DatasetManager } from './manager.js';
import type { DatasetBaseStyle, DatasetFeatureInput, DatasetOptions } from './types.js';
import { normalizeDisplayFeature } from './types.js';

/**
 * A stub that has only the GL that StrokeRenderer / FillShaderManager call when FeatureDrawer is
 * built
 */
function createStubGL(): WebGL2RenderingContext {
  return {
    createBuffer: (): object => ({}),
    createVertexArray: (): object => ({}),
    bindBuffer: (): void => {},
    bindVertexArray: (): void => {},
    enableVertexAttribArray: (): void => {},
    vertexAttribPointer: (): void => {},
  } as unknown as WebGL2RenderingContext;
}

/** Viewport covering the whole globe */
const WORLD: BoundingBox = { minX: -180, minY: -85, maxX: 180, maxY: 85 };

/** A stub that records the features pushed onto the batch per frame */
function createBatchTarget(): { target: DisplayBatchTarget; frames: Feature[][] } {
  const frames: Feature[][] = [];
  let current: Feature[] = [];

  const target: DisplayBatchTarget = {
    beginFrame: (): void => {
      current = [];
    },
    processFeature: (feature: Feature): boolean => {
      current.push(feature);
      return false;
    },
    endFrame: (): void => {
      frames.push(current);
      current = [];
    },
  };

  return { target, frames };
}

function createManager(bounds: BoundingBox = WORLD): {
  manager: DatasetManager;
  repaints: () => number;
  setBounds: (next: BoundingBox) => void;
} {
  let currentBounds = bounds;
  let repaintCount = 0;

  const manager = createDatasetManager({
    getViewportBounds: () => currentBounds,
    getZoom: () => 10,
    onViewportChange: () => () => {},
    requestRepaint: () => {
      repaintCount++;
    },
  });

  return {
    manager,
    repaints: () => repaintCount,
    setBounds: (next: BoundingBox) => {
      currentBounds = next;
    },
  };
}

/** Assembles a real BatchManager without GL */
function createRealBatch(): {
  batch: ReturnType<typeof createBatchManager>;
  polygons: SDFPolygonBatchData[];
} {
  const polygons: SDFPolygonBatchData[] = [];
  const sdfPolygonRenderer = {
    drawBatch: (items: SDFPolygonBatchData[]): void => {
      for (const item of items) polygons.push({ ...item });
    },
  } as unknown as SDFPolygonRenderer;

  const featureDrawer = new FeatureDrawer({
    gl: createStubGL(),
    map: {} as never,
    sdfLineRenderer: {} as SDFLineRenderer,
    pointShapeRenderer: {} as PointShapeRenderer,
    imageRenderer: {} as ImageRenderer,
    featureStyle: DEFAULT_FEATURE_STYLE_CONFIG,
  });

  const batch = createBatchManager({
    gl: { canvas: { width: 800, height: 600 } } as WebGL2RenderingContext,
    featureDrawer,
    pointInstanceRenderer: { drawAll: vi.fn() } as unknown as PointInstanceRenderer,
    sdfLineRenderer: {
      beginDraw: vi.fn(),
      endDraw: vi.fn(),
      drawAll: vi.fn(),
    } as unknown as SDFLineRenderer,
    polygonBatchRenderer: { drawBatch: vi.fn() } as unknown as PolygonBatchRenderer,
    sdfPolygonRenderer,
  });

  return { batch, polygons };
}

function point(id: string, coord: [number, number], extra?: Partial<Feature>): DatasetFeatureInput {
  return { id, type: 'Point', coordinates: coord, ...extra };
}

function polygon(id: string, offset: number, extra?: Partial<Feature>): DatasetFeatureInput {
  return {
    id,
    type: 'Polygon',
    coordinates: [
      [
        [offset, 0],
        [offset + 1, 0],
        [offset + 1, 1],
        [offset, 0],
      ],
    ],
    ...extra,
  };
}

/** Draws and returns the features pushed in the first frame */
function drawOnce(manager: DatasetManager): Feature[][] {
  const { target, frames } = createBatchTarget();
  manager.draw('below-store', target, {} as ProjectionData, 10);
  manager.draw('above-store', target, {} as ProjectionData, 10);
  return frames;
}

function add(manager: DatasetManager, options: DatasetOptions): ReturnType<DatasetManager['add']> {
  return manager.add(options);
}

describe('adding, removing and replacing a Dataset', () => {
  it('the features of an added dataset go onto the batch', () => {
    const { manager } = createManager();
    add(manager, { id: 'c1', features: [point('a', [0, 0]), point('b', [1, 1])] });

    const frames = drawOnce(manager);

    expect(frames).toHaveLength(1);
    expect(frames[0].map((f) => f.id)).toEqual(['a', 'b']);
  });

  it('a removed dataset is not drawn', () => {
    const { manager } = createManager();
    add(manager, { id: 'c1', features: [point('a', [0, 0])] });

    expect(manager.remove('c1')).toBe(true);
    expect(manager.get('c1')).toBeUndefined();
    expect(drawOnce(manager)).toEqual([]);
  });

  it('dataset.remove() takes it off the manager too', () => {
    const { manager } = createManager();
    const dataset = add(manager, { id: 'c1', features: [point('a', [0, 0])] });

    dataset.remove();

    expect(manager.get('c1')).toBeUndefined();
    expect(drawOnce(manager)).toEqual([]);
  });

  it('removing an id that does not exist returns false', () => {
    const { manager } = createManager();
    expect(manager.remove('none')).toBe(false);
  });

  it('adding the same id throws', () => {
    const { manager } = createManager();
    add(manager, { id: 'c1', features: [] });

    expect(() => add(manager, { id: 'c1', features: [] })).toThrow();
  });

  it('giving features and provider together throws', () => {
    const { manager } = createManager();

    expect(() => add(manager, { id: 'c1', features: [], provider: async () => [] })).toThrow();
  });

  it('setFeatures replaces the contents and a repaint is requested', () => {
    const { manager, repaints } = createManager();
    const dataset = add(manager, { id: 'c1', features: [point('a', [0, 0])] });

    const before = repaints();
    dataset.setFeatures([point('b', [1, 1]), point('c', [2, 2])]);

    expect(repaints()).toBeGreaterThan(before);
    expect(drawOnce(manager)[0].map((f) => f.id)).toEqual(['b', 'c']);
  });

  it('getFeatures returns them with the optional fields filled in', () => {
    const { manager } = createManager();
    const dataset = add(manager, { id: 'c1', features: [point('a', [0, 0])] });

    const [feature] = dataset.getFeatures();
    expect(feature.visible).toBe(true);
    expect(feature.locked).toBe(false);
    expect(feature.properties).toEqual({});
    expect(feature.layerId).toBe('');
  });

  it('a feature with visible: false is not drawn', () => {
    const { manager } = createManager();
    add(manager, {
      id: 'c1',
      features: [polygon('hidden', 0, { visible: false }), polygon('shown', 1)],
    });

    const { batch, polygons } = createRealBatch();
    manager.draw('below-store', batch, {} as ProjectionData, 10);

    expect(polygons.map((p) => p.featureId)).toEqual(['shown']);
  });
});

describe('the viewport culling of a Dataset', () => {
  it('a feature outside the bbox does not go onto the batch', () => {
    const { manager } = createManager({ minX: -1, minY: -1, maxX: 1, maxY: 1 });
    add(manager, {
      id: 'c1',
      features: [point('in', [0, 0]), point('out', [50, 50]), point('edge', [1, 1])],
    });

    const drawn = drawOnce(manager)[0];

    expect(drawn.map((f) => f.id)).toEqual(['in', 'edge']);
  });

  it('moving the viewport changes what goes on', () => {
    const { manager, setBounds } = createManager({ minX: -1, minY: -1, maxX: 1, maxY: 1 });
    add(manager, { id: 'c1', features: [point('a', [0, 0]), point('b', [50, 50])] });

    expect(drawOnce(manager)[0].map((f) => f.id)).toEqual(['a']);

    setBounds({ minX: 49, minY: 49, maxX: 51, maxY: 51 });
    expect(drawOnce(manager)[0].map((f) => f.id)).toEqual(['b']);
  });

  it('no frame is opened when nothing is visible', () => {
    const { manager } = createManager({ minX: 100, minY: 10, maxX: 101, maxY: 11 });
    add(manager, { id: 'c1', features: [point('a', [0, 0])] });

    expect(drawOnce(manager)).toEqual([]);
  });

  it('a polygon is judged by the intersection of the bboxes', () => {
    const { manager } = createManager({ minX: 0.5, minY: 0.1, maxX: 0.6, maxY: 0.2 });
    add(manager, { id: 'c1', features: [polygon('p0', 0), polygon('p9', 9)] });

    expect(drawOnce(manager)[0].map((f) => f.id)).toEqual(['p0']);
  });

  it('collectVisible returns the features intersecting the given range in draw order', () => {
    // It is called while nothing is in the current viewport (the given range is the truth)
    const { manager } = createManager({ minX: 100, minY: 100, maxX: 101, maxY: 101 });
    const dataset = add(manager, {
      id: 'c1',
      features: [point('c', [2, 2]), point('a', [0, 0]), point('far', [50, 50])],
    });

    const visible = dataset.collectVisible({ minX: -1, minY: -1, maxX: 3, maxY: 3 });

    expect(visible.map((f) => f.id)).toEqual(['c', 'a']);
  });

  it('collectVisible returns them with the rule colors applied', () => {
    const { manager } = createManager();
    const dataset = add(manager, {
      id: 'c1',
      styleRule: {
        kind: 'categorical',
        property: 'kind',
        map: { a: '#ff0000' },
        other: '#0000ff',
      },
      features: [polygon('pa', 0, { properties: { kind: 'a' } })],
    });

    const visible = dataset.collectVisible(WORLD);

    expect(visible[0].style?.fillColor).toBe('#ff0000');
  });

  it('the draw order keeps the order of the array of the dataset', () => {
    const { manager } = createManager();
    const ids = ['e', 'd', 'c', 'b', 'a'];
    add(manager, {
      id: 'c1',
      features: ids.map((id, i) => point(id, [i, i])),
    });

    expect(drawOnce(manager)[0].map((f) => f.id)).toEqual(ids);
  });
});

describe('the style rules of a Dataset', () => {
  const rule: StyleRule = {
    kind: 'categorical',
    property: 'kind',
    map: { a: '#ff0000', b: '#00ff00' },
    other: '#0000ff',
  };

  it('the rule decides the color from an attribute and a missing one becomes other', () => {
    const { manager } = createManager();
    add(manager, {
      id: 'c1',
      styleRule: rule,
      features: [
        polygon('pa', 0, { properties: { kind: 'a' } }),
        polygon('pb', 1, { properties: { kind: 'b' } }),
        polygon('pn', 2, { properties: {} }),
      ],
    });

    const drawn = drawOnce(manager)[0];
    expect(drawn.map((f) => f.style?.fillColor)).toEqual(['#ff0000', '#00ff00', '#0000ff']);
  });

  it('the individual color of a feature beats the rule', () => {
    const { manager } = createManager();
    add(manager, {
      id: 'c1',
      styleRule: rule,
      features: [
        polygon('own', 0, { properties: { kind: 'a' }, style: { fillColor: '#123456' } }),
        polygon('ruled', 1, { properties: { kind: 'a' } }),
      ],
    });

    const drawn = drawOnce(manager)[0];
    expect(drawn[0].style?.fillColor).toBe('#123456');
    expect(drawn[1].style?.fillColor).toBe('#ff0000');
  });

  it('an individual style other than the color is used together with the rule', () => {
    const { manager } = createManager();
    add(manager, {
      id: 'c1',
      styleRule: rule,
      features: [polygon('p', 0, { properties: { kind: 'a' }, style: { strokeWidth: 5 } })],
    });

    const [feature] = drawOnce(manager)[0];
    expect(feature.style?.fillColor).toBe('#ff0000');
    expect(feature.style?.strokeWidth).toBe(5);
  });

  it('the color of a rule goes onto the channel of the geometry type', () => {
    const { manager } = createManager();
    const single: StyleRule = { kind: 'single', color: '#abcdef' };
    add(manager, {
      id: 'c1',
      styleRule: single,
      features: [
        point('pt', [0, 0]),
        {
          id: 'ln',
          type: 'LineString',
          coordinates: [
            [0, 0],
            [1, 1],
          ],
        },
        polygon('pg', 0),
      ],
    });

    const drawn = drawOnce(manager)[0];
    expect(drawn[0].style?.pointColor).toBe('#abcdef');
    expect(drawn[1].style?.strokeColor).toBe('#abcdef');
    expect(drawn[2].style?.fillColor).toBe('#abcdef');
  });

  it('setStyleRule swaps the colors (the cache is invalidated)', () => {
    const { manager } = createManager();
    const dataset = add(manager, {
      id: 'c1',
      styleRule: rule,
      features: [polygon('p', 0, { properties: { kind: 'a' } })],
    });

    expect(drawOnce(manager)[0][0].style?.fillColor).toBe('#ff0000');

    dataset.setStyleRule({
      kind: 'categorical',
      property: 'kind',
      map: { a: '#111111' },
      other: '#222222',
    });
    expect(drawOnce(manager)[0][0].style?.fillColor).toBe('#111111');

    dataset.setStyleRule(undefined);
    expect(drawOnce(manager)[0][0].style).toBeUndefined();
  });

  it('graduated and continuous are evaluated too', () => {
    const { manager } = createManager();
    add(manager, {
      id: 'c1',
      styleRule: {
        kind: 'graduated',
        property: 'pop',
        breaks: [10, 20],
        colors: ['#000000', '#111111', '#222222'],
        other: '#999999',
      },
      features: [
        polygon('low', 0, { properties: { pop: 5 } }),
        polygon('mid', 1, { properties: { pop: 15 } }),
        polygon('high', 2, { properties: { pop: 25 } }),
        polygon('none', 3, { properties: { pop: 'x' } }),
      ],
    });

    expect(drawOnce(manager)[0].map((f) => f.style?.fillColor)).toEqual([
      '#000000',
      '#111111',
      '#222222',
      '#999999',
    ]);
  });

  it('the evaluation of the rules is independent per dataset', () => {
    const { manager } = createManager();
    add(manager, {
      id: 'c1',
      styleRule: { kind: 'single', color: '#ff0000' },
      features: [polygon('same-id', 0)],
    });
    add(manager, {
      id: 'c2',
      styleRule: { kind: 'single', color: '#00ff00' },
      features: [polygon('same-id', 1)],
    });

    const frames = drawOnce(manager);
    expect(frames[0][0].style?.fillColor).toBe('#ff0000');
    expect(frames[1][0].style?.fillColor).toBe('#00ff00');
  });
});

describe('the base style of a Dataset', () => {
  const base: DatasetBaseStyle = {
    point: { pointColor: '#2d7ff9', pointRadius: 6 },
    stroke: { strokeColor: '#2d7ff9', strokeWidth: 2 },
    fill: { fillColor: '#2d7ff9', fillOpacity: 0.25, strokeWidth: 1 },
  };

  const rule: StyleRule = {
    kind: 'categorical',
    property: 'kind',
    map: { a: '#ff0000' },
    other: '#0000ff',
  };

  it('the base style comes from the channel of the geometry type', () => {
    const { manager } = createManager();
    add(manager, {
      id: 'c1',
      baseStyle: base,
      features: [
        point('pt', [0, 0]),
        {
          id: 'ln',
          type: 'LineString',
          coordinates: [
            [0, 0],
            [1, 1],
          ],
        },
        polygon('pg', 0),
      ],
    });

    const drawn = drawOnce(manager)[0];
    expect(drawn[0].style).toEqual({ pointColor: '#2d7ff9', pointRadius: 6 });
    expect(drawn[1].style).toEqual({ strokeColor: '#2d7ff9', strokeWidth: 2 });
    expect(drawn[2].style).toEqual({ fillColor: '#2d7ff9', fillOpacity: 0.25, strokeWidth: 1 });
  });

  it('the rule color beats the color of the base style, the rest comes from the base style', () => {
    const { manager } = createManager();
    add(manager, {
      id: 'c1',
      baseStyle: base,
      styleRule: rule,
      features: [polygon('p', 0, { properties: { kind: 'a' } })],
    });

    const [feature] = drawOnce(manager)[0];
    expect(feature.style?.fillColor).toBe('#ff0000');
    expect(feature.style?.fillOpacity).toBe(0.25);
    expect(feature.style?.strokeWidth).toBe(1);
  });

  it('the individual color of a feature beats both the rule color and the base style', () => {
    const { manager } = createManager();
    add(manager, {
      id: 'c1',
      baseStyle: base,
      styleRule: rule,
      features: [polygon('own', 0, { properties: { kind: 'a' }, style: { fillColor: '#123456' } })],
    });

    const [feature] = drawOnce(manager)[0];
    expect(feature.style?.fillColor).toBe('#123456');
    // Everything but the color has the base style underneath
    expect(feature.style?.fillOpacity).toBe(0.25);
  });

  it('setBaseStyle swaps the appearance (the cache is invalidated)', () => {
    const { manager, repaints } = createManager();
    const dataset = add(manager, { id: 'c1', baseStyle: base, features: [polygon('p', 0)] });

    expect(drawOnce(manager)[0][0].style?.fillOpacity).toBe(0.25);

    const before = repaints();
    dataset.setBaseStyle({ fill: { fillColor: '#00ff00', fillOpacity: 1 } });

    expect(repaints()).toBeGreaterThan(before);
    expect(drawOnce(manager)[0][0].style).toEqual({ fillColor: '#00ff00', fillOpacity: 1 });

    dataset.setBaseStyle(undefined);
    expect(drawOnce(manager)[0][0].style).toBeUndefined();
  });

  it('hitTest returns the effective style even with only a base style', () => {
    const { manager } = createManager();
    add(manager, {
      id: 'c1',
      interactive: true,
      baseStyle: base,
      features: [point('a', [0, 0])],
    });

    const hit = manager.hitTestSide('below-store', [0, 0], 0.1, () => true);

    expect(hit?.feature?.id).toBe('a');
    expect(hit?.feature?.style).toEqual({ pointColor: '#2d7ff9', pointRadius: 6 });
  });
});

describe('the hit radius of the hit testing of a Dataset', () => {
  /** The longitude that corresponds to one screen pixel at zoom 10 */
  const PX = 360 / (512 * 2 ** 10);

  /**
   * A point test that uses the given tolerance as it is (the same formula as
   * PointHitTestStrategy)
   *
   * The tolerance the dataset passes to the test is exactly what is to be seen, so nothing is
   * rounded here.
   */
  function pointTest(feature: Feature, coordinate: [number, number], tolerance: number): boolean {
    const [x, y] = feature.coordinates as [number, number];
    return Math.hypot(x - coordinate[0], y - coordinate[1]) <= tolerance;
  }

  /** Records the tolerance passed to the test */
  function recordingTest(
    record: number[],
  ): (f: Feature, c: [number, number], t: number) => boolean {
    return (_feature, _coordinate, tolerance) => {
      record.push(tolerance);
      return false;
    };
  }

  it('anywhere inside the drawn marker is grabbable, even beyond the click tolerance', () => {
    const { manager } = createManager();
    add(manager, { id: 'c1', interactive: true, features: [point('a', [0, 0])] });

    // The default marker is radius 6 + outline 2 = 8px. The click tolerance is about 2px
    const at = (px: number): string | null =>
      manager.hitTestSide('below-store', [px * PX, 0], 2 * PX, pointTest)?.feature?.id ?? null;

    expect(at(0)).toBe('a');
    expect(at(6)).toBe('a');
    // Outside the marker it cannot be grabbed
    expect(at(12)).toBeNull();
  });

  it('the hit radius follows the radius of the base style and the zoom factor', () => {
    const { manager } = createManager();
    const dataset = add(manager, {
      id: 'c1',
      interactive: true,
      baseStyle: { point: { pointRadius: 8 } },
      features: [point('a', [0, 0])],
    });

    const at = (px: number): string | null =>
      manager.hitTestSide('below-store', [px * PX, 0], 2 * PX, pointTest)?.feature?.id ?? null;

    // Radius 8 + outline 2 = 10px
    expect(at(9)).toBe('a');
    expect(at(12)).toBeNull();

    // Drawn with a factor of 2, the grabbable range doubles as well
    dataset.setZoomScale(() => ({ scale: 2, opacity: 1 }));
    expect(at(19)).toBe('a');
    expect(at(21)).toBeNull();
  });

  it('a point enlarged by an individual style is grabbable at that size', () => {
    const { manager } = createManager();
    add(manager, {
      id: 'c1',
      interactive: true,
      features: [point('big', [0, 0], { style: { pointRadius: 20 } })],
    });

    const hit = manager.hitTestSide('below-store', [18 * PX, 0], 2 * PX, pointTest);

    expect(hit?.feature?.id).toBe('big');
  });

  it('the tolerance for lines and polygons is unchanged (hit radius is about points)', () => {
    const { manager } = createManager();
    add(manager, {
      id: 'c1',
      interactive: true,
      features: [polygon('p', 0), point('a', [0, 0])],
    });

    const tolerances: number[] = [];
    manager.hitTestSide('below-store', [0, 0], 2 * PX, recordingTest(tolerances));

    // The point widens to the size it is drawn at (8px), while the polygon keeps the tolerance
    expect(tolerances).toContain(2 * PX);
    expect(tolerances.some((tolerance) => tolerance > 7 * PX && tolerance < 9 * PX)).toBe(true);
  });
});

describe('the change event of a Dataset', () => {
  it('it fires with a reason on a change of the contents and of the style', () => {
    const { manager } = createManager();
    const dataset = add(manager, { id: 'c1', features: [point('a', [0, 0])] });

    const reasons: string[] = [];
    dataset.on('change', (payload) => reasons.push(payload.reason));

    dataset.setFeatures([point('b', [1, 1])]);
    dataset.setStyleRule({ kind: 'single', color: '#ff0000' });
    dataset.setBaseStyle({ point: { pointRadius: 4 } });

    expect(reasons).toEqual(['features', 'style', 'style']);
  });

  it('setVisible fires only when the value actually changed', () => {
    const { manager } = createManager();
    const dataset = add(manager, { id: 'c1', features: [point('a', [0, 0])] });

    const reasons: string[] = [];
    dataset.on('change', (payload) => reasons.push(payload.reason));

    dataset.setVisible(false);
    dataset.setVisible(false);
    dataset.setVisible(true);

    expect(reasons).toEqual(['visibility', 'visibility']);
  });

  it('nothing fires once the subscription is cancelled', () => {
    const { manager } = createManager();
    const dataset = add(manager, { id: 'c1', features: [point('a', [0, 0])] });

    const handler = vi.fn();
    const unsubscribe = dataset.on('change', handler);
    unsubscribe();

    dataset.setStyleRule({ kind: 'single', color: '#ff0000' });

    expect(handler).not.toHaveBeenCalled();
  });
});

describe('a Dataset and the real batches (Multi and holes)', () => {
  it('a polygon with holes and a MultiPolygon flow into the batch as they are', () => {
    const { manager } = createManager();
    const outer: [number, number][] = [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
      [0, 0],
    ];
    const hole: [number, number][] = [
      [2, 2],
      [4, 2],
      [4, 4],
      [2, 2],
    ];

    add(manager, {
      id: 'c1',
      features: [
        { id: 'donut', type: 'Polygon', coordinates: [outer, hole] },
        {
          id: 'multi',
          type: 'MultiPolygon',
          coordinates: [
            [outer],
            [
              [
                [100, 0],
                [110, 0],
                [110, 10],
                [100, 0],
              ],
            ],
          ],
        },
      ],
    });

    const { batch, polygons } = createRealBatch();
    manager.draw('below-store', batch, {} as ProjectionData, 10);

    // 1 feature with a hole + the 2 parts of the MultiPolygon
    expect(polygons).toHaveLength(3);
    expect(polygons[0].featureId).toBe('donut');
    expect(polygons[0].coordinates).toHaveLength(2);
    expect(polygons[0].coordinates[1]).toEqual(hole);
    expect(polygons.slice(1).map((p) => p.featureId)).toEqual(['multi', 'multi']);
    expect(polygons.slice(1).map((p) => p.partIndex)).toEqual([0, 1]);
  });

  it('a rule color is reflected in the style of the real batch', () => {
    const { manager } = createManager();
    add(manager, {
      id: 'c1',
      styleRule: { kind: 'single', color: '#ff0000' },
      features: [polygon('p', 0)],
    });

    const { batch, polygons } = createRealBatch();
    manager.draw('below-store', batch, {} as ProjectionData, 10);

    expect(polygons).toHaveLength(1);
    // #ff0000 is resolved as the fill color
    expect(polygons[0].style.fillColor.slice(0, 3)).toEqual([1, 0, 0]);
  });
});

describe('the visibility control of a Dataset', () => {
  it('it is shown by default', () => {
    const { manager } = createManager();
    const dataset = add(manager, { id: 'c1', features: [point('a', [0, 0])] });

    expect(dataset.visible).toBe(true);
  });

  it('setVisible(false) drops it from what is drawn and true brings it back', () => {
    const { manager } = createManager();
    const dataset = add(manager, { id: 'c1', features: [point('a', [0, 0])] });

    expect(drawOnce(manager)[0].map((f) => f.id)).toEqual(['a']);

    dataset.setVisible(false);

    expect(dataset.visible).toBe(false);
    expect(drawOnce(manager)).toEqual([]);

    dataset.setVisible(true);

    expect(dataset.visible).toBe(true);
    expect(drawOnce(manager)[0].map((f) => f.id)).toEqual(['a']);
  });

  it('only the hidden dataset drops out and the others are drawn', () => {
    const { manager } = createManager();
    const hidden = add(manager, { id: 'c1', features: [point('a', [0, 0])] });
    add(manager, { id: 'c2', features: [point('b', [1, 1])] });

    hidden.setVisible(false);
    const frames = drawOnce(manager);

    expect(frames).toHaveLength(1);
    expect(frames[0].map((f) => f.id)).toEqual(['b']);
  });

  it('setVisible requests a repaint (no request for the same value)', () => {
    const { manager, repaints } = createManager();
    const dataset = add(manager, { id: 'c1', features: [point('a', [0, 0])] });

    const before = repaints();
    dataset.setVisible(false);
    expect(repaints()).toBe(before + 1);

    dataset.setVisible(false);
    expect(repaints()).toBe(before + 1);
  });

  it('setFeatures works while it is hidden and the new contents appear when shown', () => {
    const { manager } = createManager();
    const dataset = add(manager, { id: 'c1', features: [point('a', [0, 0])] });

    dataset.setVisible(false);
    dataset.setFeatures([point('b', [1, 1])]);

    expect(drawOnce(manager)).toEqual([]);

    dataset.setVisible(true);

    expect(drawOnce(manager)[0].map((f) => f.id)).toEqual(['b']);
  });
});

describe('the selection highlight of a Dataset', () => {
  /** A line feature */
  function line(id: string, offset: number, extra?: Partial<Feature>): DatasetFeatureInput {
    return {
      id,
      type: 'LineString',
      coordinates: [
        [offset, 0],
        [offset + 1, 1],
      ],
      ...extra,
    };
  }

  it('nothing is selected by default', () => {
    const { manager } = createManager();
    const dataset = add(manager, { id: 'c1', features: [point('a', [0, 0])] });

    expect(dataset.getSelectedIds()).toEqual([]);
    // No frame of the overpaint is opened
    expect(drawOnce(manager)).toHaveLength(1);
  });

  it('only the selected features are overpainted after the retained drawing', () => {
    const { manager } = createManager();
    const dataset = add(manager, {
      id: 'c1',
      features: [polygon('a', 0), polygon('b', 1), polygon('c', 2)],
    });

    dataset.setSelectedIds(['c', 'a']);
    const frames = drawOnce(manager);

    // The first frame is the ordinary drawing, the second is the overpaint
    expect(frames).toHaveLength(2);
    expect(frames[0].map((f) => f.id)).toEqual(['a', 'b', 'c']);
    // The overpaint keeps the draw order
    expect(frames[1].map((f) => f.id)).toEqual(['a', 'c']);
  });

  it('the ordinary drawing and the features held are unchanged by the overpaint', () => {
    const { manager } = createManager();
    const dataset = add(manager, {
      id: 'c1',
      features: [polygon('a', 0, { style: { fillColor: '#123456' } })],
    });

    dataset.setSelectedIds(['a']);
    const frames = drawOnce(manager);

    expect(frames[0][0].style).toEqual({ fillColor: '#123456' });
    expect(dataset.getFeatures()[0].style).toEqual({ fillColor: '#123456' });
    // Only the overpaint side takes the key color
    expect(frames[1][0].style?.fillColor).toBe('#FF2D55');
  });

  it('a polygon gets a translucent fill and a frame in the key color', () => {
    const { manager } = createManager();
    const dataset = add(manager, { id: 'c1', features: [polygon('a', 0)] });

    dataset.setSelectedIds(['a']);
    const [highlighted] = drawOnce(manager)[1];

    expect(highlighted.style?.fillColor).toBe('#FF2D55');
    expect(highlighted.style?.fillOpacity).toBe(0.25);
    expect(highlighted.style?.strokeColor).toBe('#FF2D55');
    expect(highlighted.style?.strokeWidth).toBe(4);
  });

  it('a line takes the key color with the original width + 2', () => {
    const { manager } = createManager();
    const dataset = add(manager, {
      id: 'c1',
      features: [line('a', 0), line('b', 1, { style: { strokeWidth: 6 } })],
    });

    dataset.setSelectedIds(['a', 'b']);
    const highlighted = drawOnce(manager)[1];

    // Added to the default width of 2
    expect(highlighted[0].style?.strokeWidth).toBe(4);
    expect(highlighted[1].style?.strokeWidth).toBe(8);
    expect(highlighted.map((f) => f.style?.strokeColor)).toEqual(['#FF2D55', '#FF2D55']);
  });

  it('a point is drawn over a point of the key color to make a ring', () => {
    const { manager } = createManager();
    const dataset = add(manager, {
      id: 'c1',
      features: [point('a', [0, 0], { style: { pointColor: '#0000ff', pointRadius: 5 } })],
    });

    dataset.setSelectedIds(['a']);
    const highlighted = drawOnce(manager)[1];

    expect(highlighted).toHaveLength(2);
    expect(highlighted[0].style?.pointColor).toBe('#FF2D55');
    expect(highlighted[0].style?.pointRadius).toBe(8);
    // What is laid on top keeps the original appearance
    expect(highlighted[1].style).toEqual({ pointColor: '#0000ff', pointRadius: 5 });
  });

  it('the rule color and the base style remain underneath the overpaint', () => {
    const { manager } = createManager();
    const dataset = add(manager, {
      id: 'c1',
      baseStyle: { fill: { fillColor: '#00ff00', lineStyle: 'dashed' } },
      features: [polygon('a', 0)],
    });

    dataset.setSelectedIds(['a']);
    const [highlighted] = drawOnce(manager)[1];

    expect(highlighted.style?.fillColor).toBe('#FF2D55');
    expect(highlighted.style?.lineStyle).toBe('dashed');
  });

  it('an id that is not held is ignored', () => {
    const { manager } = createManager();
    const dataset = add(manager, { id: 'c1', features: [point('a', [0, 0])] });

    dataset.setSelectedIds(['a', 'missing']);

    expect(dataset.getSelectedIds()).toEqual(['a']);
  });

  it('an id that disappeared through setFeatures drops out of the selection', () => {
    const { manager } = createManager();
    const dataset = add(manager, {
      id: 'c1',
      features: [point('a', [0, 0]), point('b', [1, 1])],
    });

    dataset.setSelectedIds(['a', 'b']);
    dataset.setFeatures([point('b', [1, 1]), point('c', [2, 2])]);

    expect(dataset.getSelectedIds()).toEqual(['b']);
    expect(drawOnce(manager)[1].map((f) => f.id)).toEqual(['b', 'b']);
  });

  it('emptying the selection removes the overpaint', () => {
    const { manager } = createManager();
    const dataset = add(manager, { id: 'c1', features: [polygon('a', 0)] });

    dataset.setSelectedIds(['a']);
    expect(drawOnce(manager)).toHaveLength(2);

    dataset.setSelectedIds([]);
    expect(dataset.getSelectedIds()).toEqual([]);
    expect(drawOnce(manager)).toHaveLength(1);
  });

  it('a selection outside the viewport is not drawn', () => {
    const { manager, setBounds } = createManager({ minX: -1, minY: -1, maxX: 1, maxY: 1 });
    const dataset = add(manager, {
      id: 'c1',
      features: [point('near', [0, 0]), point('far', [50, 50])],
    });

    dataset.setSelectedIds(['far']);
    expect(drawOnce(manager)).toHaveLength(1);

    setBounds({ minX: 49, minY: 49, maxX: 51, maxY: 51 });
    expect(drawOnce(manager)[1].map((f) => f.id)).toEqual(['far', 'far']);
  });

  it('there is no overpaint while it is hidden', () => {
    const { manager } = createManager();
    const dataset = add(manager, { id: 'c1', features: [polygon('a', 0)] });
    dataset.setSelectedIds(['a']);

    dataset.setVisible(false);

    expect(drawOnce(manager)).toEqual([]);
  });

  it('change and a repaint happen only when the selection actually changed', () => {
    const { manager, repaints } = createManager();
    const dataset = add(manager, {
      id: 'c1',
      features: [point('a', [0, 0]), point('b', [1, 1])],
    });

    const reasons: string[] = [];
    dataset.on('change', (payload) => reasons.push(payload.reason));

    const before = repaints();
    dataset.setSelectedIds(['a']);
    expect(repaints()).toBe(before + 1);

    // The same set (even in a different order) and adding an id that does not exist do nothing
    dataset.setSelectedIds(['a']);
    dataset.setSelectedIds(['a', 'missing']);
    expect(repaints()).toBe(before + 1);

    dataset.setSelectedIds(['b', 'a']);
    expect(repaints()).toBe(before + 2);

    expect(reasons).toEqual(['selection', 'selection']);
  });
});

describe('the coordinate normalization of normalizeDisplayFeature', () => {
  it('a 3-element position is truncated to 2 elements', () => {
    const f = normalizeDisplayFeature({
      id: 'p1',
      type: 'MultiLineString',
      coordinates: [
        [
          [139.7, 35.6, 9.41],
          [139.8, 35.7, 10.2],
        ],
      ] as unknown as Feature['coordinates'],
    });
    expect(f.coordinates).toEqual([
      [
        [139.7, 35.6],
        [139.8, 35.7],
      ],
    ]);
  });

  it('input with only 2 elements keeps the same reference', () => {
    const coords = [
      [0, 0],
      [1, 1],
    ] as [number, number][];
    const f = normalizeDisplayFeature({ id: 'p2', type: 'LineString', coordinates: coords });
    expect(f.coordinates).toBe(coords);
  });
});
