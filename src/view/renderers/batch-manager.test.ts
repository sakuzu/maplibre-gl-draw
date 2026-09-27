// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Batching tests for BatchManager
 *
 * The instance attributes of Point and LineString (color, size, stroke) are read per
 * instance on the GPU side, so the only condition that splits a batch is the shape.
 * These tests verify that items with different colors and sizes are put into the same
 * batch and drawn with one draw call per shape.
 */

import type { ProjectionData } from 'maplibre-gl';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_FEATURE_STYLE_CONFIG } from '../../shared/config/feature-style.js';
import type { Feature, FeatureStyle, Layer, StyleRule } from '../../store/types.js';
import {
  createBatchManager,
  lineBatchKey,
  toLineBatchItem,
  toLineBatchShape,
} from './batch-manager.js';
import { FeatureDrawer } from './drawer.js';
import type { ImageRenderer } from './image.js';
import type { LineBatchItem, LineBatchShape } from './line/line-types.js';
import type { SDFLineRenderer, SDFStrokeStyle } from './line/sdf-line.js';
import type {
  PointInstanceDataFull,
  PointInstanceRenderer,
  PointShape,
} from './point/point-instance.js';
import type { PointShapeRenderer, PointStyle } from './point/point-shape.js';
import type { PolygonBatchRenderer } from './polygon/batch.js';
import type { SDFPolygonBatchData, SDFPolygonRenderer } from './polygon/sdf-polygon.js';

/**
 * A stub that has only the GL functions called by StrokeRenderer / FillShaderManager
 * when FeatureDrawer is constructed
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

/** A stub that records the calls to drawAll */
interface DrawAllCall {
  points: PointInstanceDataFull[];
  shape: PointShape;
}

function createPointInstanceRendererStub(): {
  renderer: PointInstanceRenderer;
  calls: DrawAllCall[];
} {
  const calls: DrawAllCall[] = [];
  const renderer = {
    drawAll: (points: PointInstanceDataFull[], shape: PointShape): void => {
      // Copy it so that the record is not broken even if BatchManager reuses the array
      calls.push({ points: points.map((p) => ({ ...p })), shape });
    },
  } as unknown as PointInstanceRenderer;

  return { renderer, calls };
}

/**
 * Nothing other than getPointStyle is referenced, so FeatureDrawer is created from stubs.
 */
function createDrawer(): FeatureDrawer {
  return new FeatureDrawer({
    gl: createStubGL(),
    map: {} as never,
    sdfLineRenderer: {} as SDFLineRenderer,
    pointShapeRenderer: {} as PointShapeRenderer,
    imageRenderer: {} as ImageRenderer,
    featureStyle: DEFAULT_FEATURE_STYLE_CONFIG,
  });
}

function createManager(featureDrawer: FeatureDrawer = createDrawer()): {
  manager: ReturnType<typeof createBatchManager>;
  calls: DrawAllCall[];
} {
  const { renderer, calls } = createPointInstanceRendererStub();
  const manager = createBatchManager({
    gl: {
      canvas: { width: 800, height: 600 },
      drawingBufferWidth: 800,
      drawingBufferHeight: 600,
    } as WebGL2RenderingContext,
    featureDrawer,
    pointInstanceRenderer: renderer,
    sdfLineRenderer: {} as SDFLineRenderer,
    polygonBatchRenderer: {} as PolygonBatchRenderer,
    sdfPolygonRenderer: {} as SDFPolygonRenderer,
  });
  manager.beginFrame({} as ProjectionData, 14);

  return { manager, calls };
}

function makePoint(id: string, coord: [number, number], style?: FeatureStyle): Feature {
  return {
    id,
    type: 'Point',
    geometry: { type: 'Point', coordinates: coord },
    layerId: 'layer-1',
    properties: {},
    style: style ?? {},
    locked: false,
    visible: true,
  };
}

describe('BatchManager Point batches', () => {
  it('puts Points of different colors and sizes in one batch, drawn with a single drawAll', () => {
    const { manager, calls } = createManager();

    manager.processFeature(
      makePoint('a', [0, 0], { pointColor: '#ff0000', pointRadius: 4 }),
      false,
    );
    manager.processFeature(
      makePoint('b', [1, 1], { pointColor: '#00ff00', pointRadius: 8 }),
      false,
    );
    manager.processFeature(
      makePoint('c', [2, 2], { pointColor: '#0000ff', pointRadius: 8 }),
      false,
    );
    manager.endFrame();

    expect(calls).toHaveLength(1);
    const { points, shape } = calls[0];
    expect(shape).toBe('circle');
    expect(points).toHaveLength(3);

    // The colors are kept per instance
    expect(points.map((p) => p.fillColor)).toEqual([
      [1, 0, 0, 1],
      [0, 1, 0, 1],
      [0, 0, 1, 1],
    ]);
    // The size (radius) is kept per instance as well
    expect(points.map((p) => p.fillSize)).toEqual([4, 8, 8]);
    // The coordinates keep the input order
    expect(points.map((p) => p.coord)).toEqual([
      [0, 0],
      [1, 1],
      [2, 2],
    ]);
  });

  it('folds the opacity into the color alpha and carries over the stroke attributes', () => {
    const { manager, calls } = createManager();

    manager.processFeature(makePoint('a', [0, 0]), false);
    manager.endFrame();

    const defaults = DEFAULT_FEATURE_STYLE_CONFIG.point.point;
    const point = calls[0].points[0];
    expect(point.fillColor[3]).toBe(defaults.fillColor[3] * defaults.fillOpacity);
    expect(point.strokeColor[3]).toBe(defaults.strokeColor[3] * defaults.strokeOpacity);
    expect(point.strokeWidth).toBe(defaults.strokeWidth);
    expect(point.fillSize).toBe(defaults.size / 2);
  });

  it('disables the stroke as width 0 when its opacity is 0', () => {
    const drawer = createDrawer();
    const style: PointStyle = {
      ...DEFAULT_FEATURE_STYLE_CONFIG.point.point,
      strokeOpacity: 0,
    };
    vi.spyOn(drawer, 'getPointStyle').mockReturnValue(style);
    const { manager, calls } = createManager(drawer);

    manager.processFeature(makePoint('a', [0, 0]), false);
    manager.endFrame();

    expect(calls[0].points[0].strokeWidth).toBe(0);
  });

  it('splits the batch when the shape differs (the draw order is preserved)', () => {
    const drawer = createDrawer();
    const shapes: Record<string, PointShape> = { a: 'circle', b: 'square', c: 'circle' };
    let current: PointShape = 'circle';
    vi.spyOn(drawer, 'getPointStyle').mockImplementation(() => ({
      ...DEFAULT_FEATURE_STYLE_CONFIG.point.point,
      shape: current,
    }));
    const { manager, calls } = createManager(drawer);

    for (const id of ['a', 'b', 'c']) {
      current = shapes[id];
      manager.processFeature(makePoint(id, [0, 0]), false);
    }
    manager.endFrame();

    expect(calls.map((c) => c.shape)).toEqual(['circle', 'square', 'circle']);
    expect(calls.map((c) => c.points.length)).toEqual([1, 1, 1]);
  });
});

describe('BatchManager iteration over the parts of the Multi kinds', () => {
  function makeMultiPoint(id: string, coords: [number, number][]): Feature {
    return {
      id,
      type: 'MultiPoint',
      geometry: { type: 'MultiPoint', coordinates: coords },
      layerId: 'layer-1',
      properties: {},
      locked: false,
      visible: true,
      style: {},
    };
  }

  it('puts all parts of a MultiPoint into the same point batch', () => {
    const { manager, calls } = createManager();

    manager.processFeature(
      makeMultiPoint('mp', [
        [0, 0],
        [1, 1],
        [2, 2],
      ]),
      false,
    );
    manager.processFeature(makePoint('p', [3, 3]), false);
    manager.endFrame();

    // The shape is the same as Point, so they are gathered into one batch
    expect(calls).toHaveLength(1);
    expect(calls[0].points.map((p) => p.coord)).toEqual([
      [0, 0],
      [1, 1],
      [2, 2],
      [3, 3],
    ]);
  });

  it('puts each part of a MultiPolygon into the polygon batch with its part index', () => {
    const batches: SDFPolygonBatchData[][] = [];
    const sdfPolygonRenderer = {
      drawBatch: (polygons: SDFPolygonBatchData[]): void => {
        batches.push(polygons.map((p) => ({ ...p })));
      },
    } as unknown as SDFPolygonRenderer;

    const { renderer } = createPointInstanceRendererStub();
    const manager = createBatchManager({
      gl: {
        canvas: { width: 800, height: 600 },
        drawingBufferWidth: 800,
        drawingBufferHeight: 600,
      } as WebGL2RenderingContext,
      featureDrawer: createDrawer(),
      pointInstanceRenderer: renderer,
      sdfLineRenderer: {} as SDFLineRenderer,
      polygonBatchRenderer: {} as PolygonBatchRenderer,
      sdfPolygonRenderer,
    });
    manager.beginFrame({} as ProjectionData, 14);

    const multiPolygon: Feature = {
      id: 'mpoly',
      type: 'MultiPolygon',
      geometry: {
        type: 'MultiPolygon',
        coordinates: [
          [
            [
              [0, 0],
              [10, 0],
              [10, 10],
              [0, 0],
            ],
          ],
          [
            [
              [100, 100],
              [110, 100],
              [110, 110],
              [100, 100],
            ],
          ],
        ],
      },
      layerId: 'layer-1',
      properties: {},
      locked: false,
      visible: true,
      style: {},
    };

    manager.processFeature(multiPolygon, false);
    manager.endFrame();

    const polygons = batches.flat();
    expect(polygons).toHaveLength(2);
    // A part index is assigned so that the keys of the earcut cache do not collide
    expect(polygons.map((p) => p.featureId)).toEqual(['mpoly', 'mpoly']);
    expect(polygons.map((p) => p.partIndex)).toEqual([0, 1]);
    expect(polygons[1].coordinates[0][0]).toEqual([100, 100]);
  });

  it('shares the per-feature style across the parts of a MultiPoint', () => {
    const { manager, calls } = createManager();

    manager.processFeature(
      makeMultiPoint('mp', [
        [0, 0],
        [1, 1],
      ]),
      false,
    );
    manager.endFrame();

    const [first, second] = calls[0].points;
    expect(first.fillColor).toEqual(second.fillColor);
    expect(first.fillSize).toBe(second.fillSize);
  });
});

describe('the pure functions of the line batch', () => {
  const style: SDFStrokeStyle = {
    width: 3,
    color: [1, 0, 0.467, 1],
    opacity: 0.5,
    lineStyle: 'solid',
  };

  it('expands the color and opacity of the style into the item in toLineBatchItem', () => {
    const coords: [number, number][] = [
      [0, 0],
      [1, 1],
    ];

    const item = toLineBatchItem(coords, 'f1', style, 12);

    expect(item).toEqual({
      coords,
      featureId: 'f1',
      closed: false,
      strokeWidth: 3,
      createdZoom: 12,
      color: [1, 0, 0.467, 1],
      opacity: 0.5,
    });
  });

  it('does not share the color array of the style in toLineBatchItem', () => {
    const item = toLineBatchItem([], 'f1', style, 12);

    expect(item.color).not.toBe(style.color);
    expect(item.color).toEqual(style.color);
  });

  it('allows closed to be specified in toLineBatchItem', () => {
    expect(toLineBatchItem([], 'f1', style, 12, true).closed).toBe(true);
  });

  it('gives toLineBatchShape no color, only the dash kind', () => {
    const dashed: SDFStrokeStyle = { ...style, lineStyle: 'dashed', dashArray: [4, 2] };

    expect(toLineBatchShape(style)).toEqual({ lineStyle: 'solid' });
    expect(toLineBatchShape(dashed)).toEqual({ lineStyle: 'dashed', dashArray: [4, 2] });
  });

  it('drops the dash array from the shape for solid lines, as rendering does not use it', () => {
    const solidWithDashArray: SDFStrokeStyle = { ...style, dashArray: [4, 2] };

    expect(toLineBatchShape(solidWithDashArray)).toEqual({ lineStyle: 'solid' });
  });

  it('makes the batch key independent of color, opacity and line width', () => {
    const red: SDFStrokeStyle = { ...style, color: [1, 0, 0, 1], opacity: 1, width: 1 };
    const blue: SDFStrokeStyle = { ...style, color: [0, 0, 1, 1], opacity: 0.2, width: 8 };

    expect(lineBatchKey(toLineBatchShape(red))).toBe(lineBatchKey(toLineBatchShape(blue)));
  });

  it('gives a different batch key when the dash kind differs', () => {
    const solid = toLineBatchShape(style);
    const dashed = toLineBatchShape({ ...style, lineStyle: 'dashed' });
    const dotted = toLineBatchShape({ ...style, lineStyle: 'dotted' });
    const dashedCustom = toLineBatchShape({
      ...style,
      lineStyle: 'dashed',
      dashArray: [8, 4],
    });

    const keys = [solid, dashed, dotted, dashedCustom].map(lineBatchKey);
    expect(new Set(keys).size).toBe(4);
  });
});

describe('BatchManager line batches', () => {
  /** A stub that records the calls to drawAll */
  interface LineDrawAllCall {
    items: LineBatchItem[];
    shape: LineBatchShape;
  }

  function createLineManager(): {
    manager: ReturnType<typeof createBatchManager>;
    calls: LineDrawAllCall[];
    drawBatch: ReturnType<typeof vi.fn>;
  } {
    const calls: LineDrawAllCall[] = [];
    const drawBatch = vi.fn();
    const sdfLineRenderer = {
      beginDraw: vi.fn(),
      endDraw: vi.fn(),
      drawAll: (items: LineBatchItem[], shape: LineBatchShape): void => {
        // Copy it so that the record is not broken even if BatchManager reuses the array
        calls.push({ items: items.map((i) => ({ ...i })), shape: { ...shape } });
      },
      drawBatch,
    } as unknown as SDFLineRenderer;

    const { renderer } = createPointInstanceRendererStub();
    const manager = createBatchManager({
      gl: {
        canvas: { width: 800, height: 600 },
        drawingBufferWidth: 800,
        drawingBufferHeight: 600,
      } as WebGL2RenderingContext,
      featureDrawer: createDrawer(),
      pointInstanceRenderer: renderer,
      sdfLineRenderer,
      polygonBatchRenderer: { drawBatch: vi.fn() } as unknown as PolygonBatchRenderer,
      sdfPolygonRenderer: { drawBatch: vi.fn() } as unknown as SDFPolygonRenderer,
    });
    manager.beginFrame({} as ProjectionData, 14);

    return { manager, calls, drawBatch };
  }

  function makeLine(id: string, coords: [number, number][], style?: FeatureStyle): Feature {
    return {
      id,
      type: 'LineString',
      geometry: { type: 'LineString', coordinates: coords },
      layerId: 'layer-1',
      properties: {},
      style: style ?? {},
      locked: false,
      visible: true,
    };
  }

  const coordsA: [number, number][] = [
    [0, 0],
    [1, 1],
  ];
  const coordsB: [number, number][] = [
    [2, 2],
    [3, 3],
  ];
  const coordsC: [number, number][] = [
    [4, 4],
    [5, 5],
  ];

  it('puts lines of different colors in one batch, drawn with a single drawAll', () => {
    const { manager, calls } = createLineManager();

    manager.processFeature(makeLine('a', coordsA, { strokeColor: '#ff0000' }), false);
    manager.processFeature(makeLine('b', coordsB, { strokeColor: '#00ff00' }), false);
    manager.processFeature(makeLine('c', coordsC, { strokeColor: '#0000ff' }), false);
    manager.endFrame();

    expect(calls).toHaveLength(1);
    expect(calls[0].shape).toEqual({ lineStyle: 'solid' });
    expect(calls[0].items.map((i) => i.color)).toEqual([
      [1, 0, 0, 1],
      [0, 1, 0, 1],
      [0, 0, 1, 1],
    ]);
    // The coordinates keep the input order
    expect(calls[0].items.map((i) => i.featureId)).toEqual(['a', 'b', 'c']);
  });

  it('does not split the batch for different opacities and keeps them per item', () => {
    const { manager, calls } = createLineManager();

    manager.processFeature(
      makeLine('a', coordsA, { strokeColor: '#ff0000', strokeOpacity: 0.25 }),
      false,
    );
    manager.processFeature(makeLine('b', coordsB, { strokeColor: '#ff0000' }), false);
    manager.endFrame();

    expect(calls).toHaveLength(1);
    // getLineStringStrokeStyle folds the opacity into the alpha of the color
    expect(calls[0].items.map((i) => i.color[3])).toEqual([0.25, 1]);
    expect(calls[0].items.map((i) => i.opacity)).toEqual([1, 1]);
  });

  it('keeps width and createdZoom per item (no createdZoom means a negative fixed width)', () => {
    const { manager, calls } = createLineManager();

    manager.processFeature(makeLine('a', coordsA, { strokeWidth: 1 }), false);
    manager.processFeature(makeLine('b', coordsB, { strokeWidth: 8 }), false);
    manager.endFrame();

    // A feature that has no createdZoom is "constant in width on the screen", so it is
    // passed as a negative fixed width (the shader does not multiply by
    // 2^(zoom - createdZoom)). It looks the same as the former way of passing the draw-time
    // zoom as createdZoom, and it makes explicit that renderScale applies to it.
    expect(calls[0].items.map((i) => i.strokeWidth)).toEqual([-1, -8]);
    expect(calls[0].items.map((i) => i.createdZoom)).toEqual([14, 14]);
  });

  it('keeps the line width positive for a feature with createdZoom (it scales with zoom)', () => {
    const { manager, calls } = createLineManager();

    const feature = makeLine('a', coordsA, { strokeWidth: 3 });
    feature.properties = { ...(feature.properties ?? {}), 'maplibre-gl-draw:createdZoom': 12 };
    manager.processFeature(feature, false);
    manager.endFrame();

    expect(calls[0].items.map((i) => i.strokeWidth)).toEqual([3]);
    expect(calls[0].items.map((i) => i.createdZoom)).toEqual([12]);
  });

  it('does not call the old API drawBatch', () => {
    const { manager, drawBatch } = createLineManager();

    manager.processFeature(makeLine('a', coordsA, { strokeColor: '#ff0000' }), false);
    manager.processFeature(makeLine('b', coordsB, { strokeColor: '#00ff00' }), false);
    manager.endFrame();

    expect(drawBatch).not.toHaveBeenCalled();
  });

  it('puts the parts of a MultiLineString into the same batch as well', () => {
    const { manager, calls } = createLineManager();

    const multi: Feature = {
      id: 'ml',
      type: 'MultiLineString',
      geometry: { type: 'MultiLineString', coordinates: [coordsA, coordsB] },
      layerId: 'layer-1',
      properties: {},
      style: { strokeColor: '#ff0000' },
      locked: false,
      visible: true,
    };

    manager.processFeature(multi, false);
    manager.processFeature(makeLine('c', coordsC, { strokeColor: '#00ff00' }), false);
    manager.endFrame();

    expect(calls).toHaveLength(1);
    expect(calls[0].items).toHaveLength(3);
    expect(calls[0].items.map((i) => i.color)).toEqual([
      [1, 0, 0, 1],
      [1, 0, 0, 1],
      [0, 1, 0, 1],
    ]);
  });

  it('splits dashed lines into dashes on the CPU and stacks them per color as solid', () => {
    const { manager, calls } = createLineManager();

    manager.processFeature(
      makeLine(
        'a',
        [
          [0, 0],
          [0.05, 0],
        ],
        { strokeColor: '#ff0000', lineStyle: 'dashed' },
      ),
      false,
    );
    manager.processFeature(
      makeLine(
        'b',
        [
          [1, 1],
          [1.05, 1],
        ],
        { strokeColor: '#00ff00', lineStyle: 'dashed' },
      ),
      false,
    );
    manager.endFrame();

    // Dash pieces are drawn as solid lines, so different colors still form one batch
    expect(calls).toHaveLength(1);
    expect(calls[0].shape).toEqual({ lineStyle: 'solid' });
    const colors = calls[0].items.map((i) => i.color);
    expect(colors.length).toBeGreaterThan(2);
    expect(colors).toContainEqual([1, 0, 0, 1]);
    expect(colors).toContainEqual([0, 1, 0, 1]);
    // The order of the features is preserved
    expect(calls[0].items[0].featureId).toBe('a');
    expect(calls[0].items[calls[0].items.length - 1].featureId).toBe('b');
  });

  it('stacks the dashed outline of a Polygon per color, item by item, as well', () => {
    const { manager, calls } = createLineManager();

    function makeDashedPolygon(id: string, offset: number, color: string): Feature {
      return {
        id,
        type: 'Polygon',
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [offset, 0],
              [offset + 0.05, 0],
              [offset + 0.05, 0.05],
              [offset, 0],
            ],
          ],
        },
        layerId: 'layer-1',
        properties: {},
        style: { strokeColor: color, lineStyle: 'dashed' },
        locked: false,
        visible: true,
      };
    }

    manager.processFeature(makeDashedPolygon('p1', 0, '#ff0000'), false);
    manager.processFeature(makeDashedPolygon('p2', 1, '#00ff00'), false);
    manager.endFrame();

    expect(calls).toHaveLength(1);
    expect(calls[0].shape).toEqual({ lineStyle: 'solid' });
    const colors = calls[0].items.map((i) => i.color);
    expect(colors).toContainEqual([1, 0, 0, 1]);
    expect(colors).toContainEqual([0, 1, 0, 1]);
  });

  it('flushes on a batch type switch even when lines and points alternate', () => {
    const { manager, calls } = createLineManager();

    manager.processFeature(makeLine('a', coordsA, { strokeColor: '#ff0000' }), false);
    manager.processFeature(makePoint('p', [0, 0]), false);
    manager.processFeature(makeLine('b', coordsB, { strokeColor: '#00ff00' }), false);
    manager.endFrame();

    expect(calls).toHaveLength(2);
    expect(calls.map((c) => c.items.length)).toEqual([1, 1]);
  });
});

describe('BatchManager style rules of a layer', () => {
  const rule: StyleRule = {
    kind: 'categorical',
    property: 'type',
    map: { a: '#ff0000', b: '#00ff00' },
    other: '#0000ff',
  };

  const layer: Layer = {
    id: 'layer-1',
    name: 'Layer 1',
    visible: true,
    locked: false,
    opacity: 1,
    order: [],
    styleRule: rule,
  };

  function pointWith(id: string, properties: Record<string, unknown>): Feature {
    return { ...makePoint(id, [0, 0]), properties };
  }

  it('draws points colored by a rule in one batch per shape', () => {
    const { manager, calls } = createManager();
    manager.beginFrame({} as ProjectionData, 14, layer);

    manager.processFeature(pointWith('rule-a', { type: 'a' }), false);
    manager.processFeature(pointWith('rule-b', { type: 'b' }), false);
    // A point with no attribute takes the color of other
    manager.processFeature(pointWith('rule-none', {}), false);
    manager.endFrame();

    expect(calls).toHaveLength(1);
    const [first, second, third] = calls[0].points;
    expect(first.fillColor.slice(0, 3)).toEqual([1, 0, 0]);
    expect(second.fillColor.slice(0, 3)).toEqual([0, 1, 0]);
    expect(third.fillColor.slice(0, 3)).toEqual([0, 0, 1]);
  });

  it('does not apply the rules in a frame where no layer is passed', () => {
    const { manager, calls } = createManager();

    manager.processFeature(pointWith('no-layer', { type: 'a' }), false);
    manager.endFrame();

    const defaults = DEFAULT_FEATURE_STYLE_CONFIG.point.point;
    expect(calls[0].points[0].fillColor.slice(0, 3)).toEqual(defaults.fillColor.slice(0, 3));
  });
});

describe('BatchManager the set of renderers for retained mode', () => {
  /** Assemble a BatchManager with the given renderers */
  function createWith(renderers: {
    line?: Partial<SDFLineRenderer>;
    polygon?: Partial<SDFPolygonRenderer>;
    point?: Partial<PointInstanceRenderer>;
  }): ReturnType<typeof createBatchManager> {
    return createBatchManager({
      gl: {
        canvas: { width: 1280, height: 720 },
        drawingBufferWidth: 1280,
        drawingBufferHeight: 720,
      } as WebGL2RenderingContext,
      featureDrawer: createDrawer(),
      pointInstanceRenderer: (renderers.point ?? {}) as PointInstanceRenderer,
      sdfLineRenderer: (renderers.line ?? {}) as SDFLineRenderer,
      polygonBatchRenderer: {} as PolygonBatchRenderer,
      sdfPolygonRenderer: (renderers.polygon ?? {}) as SDFPolygonRenderer,
    });
  }

  it('returns undefined for renderers that do not support retained mode', () => {
    const manager = createWith({});

    expect(manager.getRetainedRenderers()).toBeUndefined();
  });

  it('returns undefined when even one of them is missing', () => {
    const manager = createWith({
      line: { buildRetainedBatch: vi.fn() } as unknown as Partial<SDFLineRenderer>,
      polygon: { buildRetained: vi.fn() } as unknown as Partial<SDFPolygonRenderer>,
    });

    expect(manager.getRetainedRenderers()).toBeUndefined();
  });

  it('returns the renderer set when all three are present (the result is reused)', () => {
    const manager = createWith({
      line: { buildRetainedBatch: vi.fn() } as unknown as Partial<SDFLineRenderer>,
      polygon: { buildRetained: vi.fn() } as unknown as Partial<SDFPolygonRenderer>,
      point: { buildRetained: vi.fn() } as unknown as Partial<PointInstanceRenderer>,
    });

    const set = manager.getRetainedRenderers();

    expect(set).toBeDefined();
    expect(set?.viewport()).toEqual([1280, 720]);
    expect(manager.getRetainedRenderers()).toBe(set);
  });
});

describe('BatchManager the instanced point shapes', () => {
  it('draws triangles and stars instanced, one batch per shape', () => {
    const drawer = createDrawer();
    const drawPointShape = vi.spyOn(drawer, 'drawPointShape').mockImplementation(() => {});
    let current: PointStyle['shape'] = 'triangle';
    vi.spyOn(drawer, 'getPointStyle').mockImplementation(() => ({
      ...DEFAULT_FEATURE_STYLE_CONFIG.point.point,
      shape: current,
    }));
    const { manager, calls } = createManager(drawer);

    manager.processFeature(makePoint('a', [0, 0]), false);
    current = 'star';
    manager.processFeature(makePoint('b', [0, 0]), false);
    current = 'icon';
    manager.processFeature(makePoint('c', [0, 0]), false);
    manager.endFrame();

    expect(calls.map((c) => c.shape)).toEqual(['triangle', 'star']);
    // 'icon' is not an instanced shape: it goes through the per-point renderer
    expect(drawPointShape).toHaveBeenCalledTimes(1);
  });
});

describe('BatchManager the opacity of the layer', () => {
  const LAYER_AT_HALF = {
    id: 'layer-1',
    name: 'layer-1',
    visible: true,
    locked: false,
    opacity: 0.5,
    order: [],
  } as Layer;

  function createOpacityManager(drawer: FeatureDrawer = createDrawer()) {
    const pointDrawAll = vi.fn();
    const lineDrawAll = vi.fn();
    const sdfPolygonDrawBatch = vi.fn();
    // The batch array is cleared after the draw, so the colors are copied out
    const fillColors: number[][] = [];
    const polygonDrawBatch = vi.fn((polygons: Array<{ color: number[] }>) => {
      for (const p of polygons) fillColors.push([...p.color]);
    });
    const manager = createBatchManager({
      gl: {
        canvas: { width: 800, height: 600 },
        drawingBufferWidth: 800,
        drawingBufferHeight: 600,
      } as WebGL2RenderingContext,
      featureDrawer: drawer,
      pointInstanceRenderer: { drawAll: pointDrawAll } as unknown as PointInstanceRenderer,
      sdfLineRenderer: {
        beginDraw: vi.fn(),
        endDraw: vi.fn(),
        drawAll: lineDrawAll,
      } as unknown as SDFLineRenderer,
      polygonBatchRenderer: { drawBatch: polygonDrawBatch } as unknown as PolygonBatchRenderer,
      sdfPolygonRenderer: { drawBatch: sdfPolygonDrawBatch } as unknown as SDFPolygonRenderer,
    });
    return { manager, pointDrawAll, lineDrawAll, sdfPolygonDrawBatch, fillColors };
  }

  const polygon = (id: string, style?: FeatureStyle): Feature => ({
    id,
    type: 'Polygon',
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 0],
        ],
      ],
    },
    layerId: 'layer-1',
    properties: {},
    style: style ?? {},
    locked: false,
    visible: true,
  });

  it('passes the opacity of the layer to every batch as a draw factor', () => {
    const h = createOpacityManager();
    h.manager.beginFrame({} as ProjectionData, 14, LAYER_AT_HALF);
    h.manager.processFeature(makePoint('p', [0, 0]), false);
    h.manager.processFeature(
      {
        id: 'l',
        type: 'LineString',
        geometry: {
          type: 'LineString',
          coordinates: [
            [0, 0],
            [1, 1],
          ],
        },
        layerId: 'layer-1',
        properties: {},
        locked: false,
        visible: true,
        style: {},
      },
      false,
    );
    h.manager.processFeature(polygon('g'), false);
    h.manager.endFrame();

    expect(h.pointDrawAll.mock.calls[0][3]).toEqual({ scale: 1, opacity: 0.5 });
    expect(h.lineDrawAll.mock.calls[0][4]).toEqual({ scale: 1, opacity: 0.5 });
    expect(h.sdfPolygonDrawBatch.mock.calls[0][4]).toEqual({ scale: 1, opacity: 0.5 });
  });

  it('multiplies it into the colors of the paths without a factor uniform', () => {
    const drawer = createDrawer();
    const drawPointShape = vi.spyOn(drawer, 'drawPointShape').mockImplementation(() => {});
    vi.spyOn(drawer, 'getPointStyle').mockImplementation(() => ({
      ...DEFAULT_FEATURE_STYLE_CONFIG.point.point,
      shape: 'icon',
    }));
    const h = createOpacityManager(drawer);
    h.manager.beginFrame({} as ProjectionData, 14, LAYER_AT_HALF);
    // A polygon with a dashed outline puts its fill on the fill-only batch (per-vertex colors)
    h.manager.processFeature(
      polygon('g', { fillColor: '#ff0000', fillOpacity: 0.8, lineStyle: 'dashed' }),
      false,
    );
    h.manager.processFeature(makePoint('p', [0, 0]), false);
    h.manager.endFrame();

    expect(h.fillColors[0][3]).toBeCloseTo(0.4);
    const style = drawPointShape.mock.calls[0][1];
    const defaults = DEFAULT_FEATURE_STYLE_CONFIG.point.point;
    expect(style.fillOpacity).toBeCloseTo(defaults.fillOpacity * 0.5);
    expect(style.strokeOpacity).toBeCloseTo(defaults.strokeOpacity * 0.5);
  });

  it('draws without a factor when the frame has no layer', () => {
    const h = createOpacityManager();
    h.manager.beginFrame({} as ProjectionData, 14);
    h.manager.processFeature(makePoint('p', [0, 0]), false);
    h.manager.endFrame();

    expect(h.pointDrawAll.mock.calls[0][3]).toEqual({ scale: 1, opacity: 1 });
  });
});
