// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the retained-mode rendering of the Store features
 *
 * What is pinned down here is
 *
 * - The classification (which features can be retained and which go to immediate mode)
 * - That the run boundaries match the flush boundaries of immediate mode (the z-order)
 * - When a rebuild happens and when the GPU resources are released
 *
 * and not the GL calls themselves. The renderers are mocks that count.
 */

import type { ProjectionData } from 'maplibre-gl';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CustomFeatureHandler, CustomRendererDrawContext } from '../../extension/index.js';
import type { FeatureCoordinates } from '../../shared/types/model.js';
import { coordinatesOf, geometryFromCoordinates } from '../../shared/utils/coordinates.js';
import type { SpatialIndex } from '../../store/spatial/spatial-index.js';
import { RBushSpatialIndex } from '../../store/spatial/spatial-index.js';
import type { Store } from '../../store/store.js';
import type { BoundingBox, Coordinate, Feature, Layer } from '../../store/types.js';
import {
  createFeatureCompanionRegistry,
  type FeatureCompanionRegistry,
} from '../feature-companion.js';

/**
 * There is one companion drawing provider per draw instance. The tests recreate it every time.
 */
let companions: FeatureCompanionRegistry = createFeatureCompanionRegistry();

beforeEach(() => {
  companions = createFeatureCompanionRegistry();
});

import type { RetainedDrawFactors } from '../renderers/draw-factors.js';
import type { LineBatchItem, RetainedLineBatch } from '../renderers/line/line-types.js';
import type { SDFLineRenderer, SDFStrokeStyle } from '../renderers/line/sdf-line.js';
import type {
  PointInstanceDataFull,
  PointShape,
  RetainedPointBatch,
} from '../renderers/point/point-instance.js';
import type { PointStyle } from '../renderers/point/point-shape.js';
import type {
  RetainedPolygonBatch,
  SDFPolygonBatchData,
} from '../renderers/polygon/sdf-polygon.js';
import type { RetainedRendererSet, RetainedStyleResolver } from '../renderers/retained.js';
import type { BoundingBoxCoords } from '../ui/selection-ui/index.js';
import { createSelectionExtensionRegistry } from '../ui/selection-ui/index.js';
import {
  classifyFeature,
  computeCoordinateDiff,
  computeLineCoordSlots,
  STORE_CHUNK_TARGET,
  type StoreImmediateTarget,
  StoreRetainedCache,
  type StoreRetainedDrawDeps,
} from './store-retained.js';

// === Stub of the style resolution ===

/** Style that is swapped in per feature */
interface StyleSpec {
  /** Shape of the point ('icon' stands for a shape without instancing support) */
  pointShape?: PointShape | 'icon';
  lineStyle?: SDFStrokeStyle['lineStyle'];
  strokeWidth?: number;
  strokeOpacity?: number;
  /** Alpha of the fill */
  fillAlpha?: number;
}

/** Stub that can record the layer passed to the style resolution */
interface StubStyles {
  resolver: RetainedStyleResolver;
  /** The layer passed to getPointStyle / getLineStringStrokeStyle / getPolygonStyles */
  seenLayers: Array<Layer | undefined>;
}

function createStyles(specs: Record<string, StyleSpec> = {}): StubStyles {
  const seenLayers: Array<Layer | undefined> = [];
  const specOf = (feature: Feature | undefined): StyleSpec => (feature && specs[feature.id]) ?? {};

  const resolver: RetainedStyleResolver = {
    getPointStyle: (feature, layer): PointStyle => {
      seenLayers.push(layer);
      return {
        shape: (specOf(feature).pointShape ?? 'circle') as PointShape,
        size: 10,
        fillColor: [1, 0, 0, 1],
        fillOpacity: 1,
        strokeColor: [0, 0, 0, 1],
        strokeWidth: 1,
        strokeOpacity: 1,
      };
    },
    getLineStringStrokeStyle: (feature, layer): SDFStrokeStyle => {
      seenLayers.push(layer);
      const spec = specOf(feature);
      return {
        width: spec.strokeWidth ?? 2,
        color: [1, 0, 0, 1],
        opacity: spec.strokeOpacity ?? 1,
        lineStyle: spec.lineStyle ?? 'solid',
      };
    },
    getPolygonStyles: (feature, layer) => {
      seenLayers.push(layer);
      const spec = specOf(feature);
      return {
        fillColor: [0, 0, 1, spec.fillAlpha ?? 0.5],
        strokeStyle: {
          width: spec.strokeWidth ?? 2,
          color: [0, 0, 0, 1],
          opacity: spec.strokeOpacity ?? 1,
          lineStyle: spec.lineStyle ?? 'solid',
        },
      };
    },
  };

  return { resolver, seenLayers };
}

// === Mocks of the retained-mode renderers ===

/** Mock of a retained batch */
interface MockBatch {
  kind: 'polygon' | 'line' | 'point';
  /** Features that went onto the batch (a point only has a style, so just the count) */
  ids: string[];
  count: number;
  /** Widths pushed onto a line batch (a fixed width is negative) */
  widths: number[];
  origin: [number, number] | undefined;
}

/** Diff written into the coordinate texture */
interface MockPatch {
  batch: MockBatch;
  updates: Array<{ coordIndex: number; lngLat: [number, number] }>;
}

/**
 * A line renderer that also has the partial update of the coordinate texture
 *
 * The partial update is not included in RetainedLineRenderer (the Pick in
 * renderers/retained.ts), so it is added structurally and passed in, as on the implementation
 * side.
 */
type MockLineRenderer = RetainedRendererSet['line'] &
  Partial<Pick<SDFLineRenderer, 'patchRetainedBatchCoords'>>;

interface RendererProbe {
  renderers: RetainedRendererSet;
  built: MockBatch[];
  disposed: MockBatch[];
  drawn: MockBatch[];
  /** The opacity factor each retained draw was given (in the order of drawn) */
  drawnOpacity: number[];
  patched: MockPatch[];
  reset(): void;
}

/**
 * @param buildable Whether a retained batch can be built (false imitates a GPU alloc failure)
 * @param patchable Whether the partial update of the coordinate texture is supported
 */
function createRendererProbe(
  styles: RetainedStyleResolver,
  buildable = true,
  patchable = true,
): RendererProbe {
  let built: MockBatch[] = [];
  let disposed: MockBatch[] = [];
  let drawn: MockBatch[] = [];
  let drawnOpacity: number[] = [];
  let patched: MockPatch[] = [];
  const recordDraw = (batch: unknown, factors: RetainedDrawFactors | undefined): void => {
    drawn.push(batch as MockBatch);
    drawnOpacity.push(factors?.opacity ?? 1);
  };

  const record = (batch: MockBatch): MockBatch | null => {
    if (!buildable) return null;
    built.push(batch);
    return batch;
  };

  const line: MockLineRenderer = {
    buildRetainedBatch: (items: LineBatchItem[], _shape, options) =>
      record({
        kind: 'line',
        ids: items.map((item) => item.featureId),
        count: items.length,
        widths: items.map((item) => item.strokeWidth),
        origin: options?.origin,
      }) as unknown as RetainedLineBatch,
    drawRetainedBatch: (batch, _zoom, _projection, factors): void => {
      recordDraw(batch, factors);
    },
    disposeRetainedBatch: (batch): void => {
      disposed.push(batch as unknown as MockBatch);
    },
  };
  if (patchable) {
    line.patchRetainedBatchCoords = (batch, updates): void => {
      patched.push({ batch: batch as unknown as MockBatch, updates: [...updates] });
    };
  }

  const renderers: RetainedRendererSet = {
    polygon: {
      buildRetained: (polygons: SDFPolygonBatchData[], options) =>
        record({
          kind: 'polygon',
          ids: polygons.map((p) => p.featureId ?? ''),
          count: polygons.length,
          widths: polygons.map((p) => p.style.strokeWidth),
          origin: options?.origin,
        }) as unknown as RetainedPolygonBatch,
      drawRetained: (batch, _zoom, _projection, _viewport, factors): void => {
        recordDraw(batch, factors);
      },
      disposeRetained: (batch): void => {
        disposed.push(batch as unknown as MockBatch);
      },
    },
    line,
    point: {
      buildRetained: (points: PointInstanceDataFull[], _shape: PointShape, options) =>
        record({
          kind: 'point',
          ids: [],
          count: points.length,
          widths: [],
          origin: options?.origin,
        }) as unknown as RetainedPointBatch,
      drawRetained: (batch, _zoom, _projection, factors): void => {
        recordDraw(batch, factors);
      },
      disposeRetained: (batch): void => {
        disposed.push(batch as unknown as MockBatch);
      },
    },
    styles,
    viewport: (): [number, number] => [800, 600],
  };

  return {
    renderers,
    get built() {
      return built;
    },
    get disposed() {
      return disposed;
    },
    get drawn() {
      return drawn;
    },
    get drawnOpacity() {
      return drawnOpacity;
    },
    get patched() {
      return patched;
    },
    reset: (): void => {
      built = [];
      disposed = [];
      drawn = [];
      drawnOpacity = [];
      patched = [];
    },
  } as RendererProbe;
}

// === Stub of the Store ===

interface StubStore {
  store: Store;
  features: Feature[];
  hidden: Set<string>;
}

function createStore(features: Feature[]): StubStore {
  const hidden = new Set<string>();
  const list = [...features];

  const store = {
    getFeature: (id: string): Feature | undefined => list.find((f) => f.id === id),
    getOrderedFeatures: (): Feature[] => list.filter((f) => f.visible),
    isLocallyHidden: (id: string): boolean => hidden.has(id),
    getLocallyHidden: (): ReadonlySet<string> => hidden,
  } as unknown as Store;

  return { store, features: list, hidden };
}

// === Stub of the immediate-mode draw target ===

interface ImmediateProbe {
  target: StoreImmediateTarget;
  /** The order in which things were actually painted (endFrame emits the batch) */
  paintLog: string[];
  /** Number of beginFrame calls */
  frames: number;
}

function createImmediateProbe(paintLog: string[]): ImmediateProbe {
  let pending: string[] = [];
  const probe = {
    paintLog,
    frames: 0,
  } as ImmediateProbe;

  probe.target = {
    beginFrame: (): void => {
      probe.frames++;
      pending = [];
    },
    processFeature: (feature: Feature): boolean => {
      pending.push(feature.id);
      return false;
    },
    endFrame: (): void => {
      for (const id of pending) paintLog.push(id);
      pending = [];
    },
  };

  return probe;
}

// === Building the features ===

const LINE_COORDS: Coordinate[] = [
  [0, 0],
  [1, 1],
];
const RING: Coordinate[] = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 1],
];

function makeFeature(id: string, type: Feature['type'], extra: Partial<Feature> = {}): Feature {
  let coordinates: FeatureCoordinates;
  switch (type) {
    case 'LineString':
    case 'Freehand':
      coordinates = LINE_COORDS;
      break;
    case 'MultiLineString':
      coordinates = [LINE_COORDS];
      break;
    case 'Polygon':
      coordinates = [RING];
      break;
    case 'MultiPolygon':
      coordinates = [[RING]];
      break;
    case 'MultiPoint':
      coordinates = [
        [0, 0],
        [1, 1],
      ];
      break;
    default:
      coordinates = [0, 0];
  }

  return {
    id,
    type,
    geometry: geometryFromCoordinates(type, coordinates),
    layerId: 'layer-1',
    properties: {},
    locked: false,
    visible: true,
    style: {},
    ...extra,
  } as Feature;
}

const PROJECTION = {} as unknown as ProjectionData;
const LAYER: Layer = {
  id: 'layer-1',
  name: 'layer-1',
  order: [],
  visible: true,
} as unknown as Layer;

/** The selection extension points of the draw instance the harness draws with */
const harnessExtensions = createSelectionExtensionRegistry();

/** Builds the whole drawing set (the retained-mode mocks + the immediate-mode stub) */
function createHarness(
  features: Feature[],
  specs: Record<string, StyleSpec> = {},
  options: {
    customTypes?: string[];
    buildable?: boolean;
    patchable?: boolean;
    visibleIds?: readonly string[];
    /**
     * Looks up the visible ids from a real spatial index (queried with the bbox passed to draw)
     *
     * The getVisibleIds of render.ts goes through ViewportFilter and calls
     * spatialIndex.findInBounds(the expanded viewport). Use this when the same two-stage thinning
     * as the application (chunk bbox → per feature) is to be exercised.
     */
    spatialIndex?: SpatialIndex;
  } = {},
) {
  const styles = createStyles(specs);
  const probe = createRendererProbe(
    styles.resolver,
    options.buildable ?? true,
    options.patchable ?? true,
  );
  const stub = createStore(features);
  const paintLog: string[] = [];
  const immediate = createImmediateProbe(paintLog);

  const customRenderers = new Map<string, CustomFeatureHandler['renderer']>();
  for (const type of options.customTypes ?? []) {
    customRenderers.set(type, {
      draw: (feature: { id: string }): void => {
        paintLog.push(feature.id);
      },
    } as unknown as CustomFeatureHandler['renderer']);
  }

  // The set of visible ids (passed only when specified). The number of calls is counted too, to
  // match the memoization on the render.ts side.
  const visible = { calls: 0 };
  const visibleIds = options.visibleIds;
  /** The expanded viewport passed to the most recent draw (the range of the index query) */
  let lastBounds: BoundingBox | undefined;
  const spatialIndex = options.spatialIndex;

  let getVisibleIds: (() => ReadonlySet<string>) | undefined;
  if (spatialIndex) {
    getVisibleIds = (): ReadonlySet<string> => {
      visible.calls++;
      return new Set(lastBounds ? spatialIndex.findInBounds(lastBounds) : []);
    };
  } else if (visibleIds !== undefined) {
    getVisibleIds = (): ReadonlySet<string> => {
      visible.calls++;
      return new Set(visibleIds);
    };
  }

  const deps: StoreRetainedDrawDeps = {
    renderers: probe.renderers,
    batchManager: immediate.target,
    customRenderers,
    companions,
    customRendererContext: {} as unknown as CustomRendererDrawContext,
    getVisibleIds,
  };

  const cache = new StoreRetainedCache(stub.store, { extensions: harnessExtensions });

  const draw = (viewportBounds?: BoundingBox, zoom = 14, layer: Layer = LAYER): void => {
    lastBounds = viewportBounds;
    cache.beginFrame(companions);
    cache.drawLayer('layer-1', layer, PROJECTION, zoom, deps, viewportBounds);
  };

  return { cache, deps, probe, stub, styles, paintLog, immediate, visible, draw };
}

// === Classification ===

describe('classifyFeature', () => {
  const empty = new Map<string, unknown>();

  it('a solid line is line, dashed and dotted lines are immediate', () => {
    const styles = createStyles({
      dashed: { lineStyle: 'dashed' },
      dotted: { lineStyle: 'dotted' },
    });

    expect(
      classifyFeature(makeFeature('solid', 'LineString'), styles.resolver, empty, companions),
    ).toBe('line');
    expect(
      classifyFeature(makeFeature('dashed', 'LineString'), styles.resolver, empty, companions),
    ).toBe('immediate');
    expect(
      classifyFeature(makeFeature('dotted', 'LineString'), styles.resolver, empty, companions),
    ).toBe('immediate');
    // Freehand / MultiLineString are treated as lines too
    expect(
      classifyFeature(makeFeature('solid', 'Freehand'), styles.resolver, empty, companions),
    ).toBe('line');
    expect(
      classifyFeature(makeFeature('solid', 'MultiLineString'), styles.resolver, empty, companions),
    ).toBe('line');
  });

  it('points split runs per shape, a shape without instancing support is immediate', () => {
    const styles = createStyles({
      circle: { pointShape: 'circle' },
      square: { pointShape: 'square' },
      triangle: { pointShape: 'triangle' },
      star: { pointShape: 'star' },
      icon: { pointShape: 'icon' },
    });

    expect(
      classifyFeature(makeFeature('circle', 'Point'), styles.resolver, empty, companions),
    ).toBe('point-circle');
    expect(
      classifyFeature(makeFeature('square', 'Point'), styles.resolver, empty, companions),
    ).toBe('point-square');
    expect(
      classifyFeature(makeFeature('triangle', 'Point'), styles.resolver, empty, companions),
    ).toBe('point-triangle');
    expect(classifyFeature(makeFeature('star', 'Point'), styles.resolver, empty, companions)).toBe(
      'point-star',
    );
    expect(classifyFeature(makeFeature('icon', 'Point'), styles.resolver, empty, companions)).toBe(
      'immediate',
    );
    expect(
      classifyFeature(makeFeature('circle', 'MultiPoint'), styles.resolver, empty, companions),
    ).toBe('point-circle');
  });

  it('a polygon with a solid outline or only a fill is polygon, a dashed one immediate', () => {
    const styles = createStyles({
      'fill-only': { strokeOpacity: 0 },
      dashed: { lineStyle: 'dashed' },
      // If the outline is transparent, even a dashed one can be retained as fill only
      'dashed-no-stroke': { lineStyle: 'dashed', strokeOpacity: 0 },
    });

    expect(
      classifyFeature(makeFeature('solid', 'Polygon'), styles.resolver, empty, companions),
    ).toBe('polygon');
    expect(
      classifyFeature(makeFeature('fill-only', 'Polygon'), styles.resolver, empty, companions),
    ).toBe('polygon');
    expect(
      classifyFeature(makeFeature('dashed', 'Polygon'), styles.resolver, empty, companions),
    ).toBe('immediate');
    expect(
      classifyFeature(
        makeFeature('dashed-no-stroke', 'Polygon'),
        styles.resolver,
        empty,
        companions,
      ),
    ).toBe('polygon');
    expect(
      classifyFeature(makeFeature('solid', 'MultiPolygon'), styles.resolver, empty, companions),
    ).toBe('polygon');
    expect(
      classifyFeature(makeFeature('solid', 'Circle'), styles.resolver, empty, companions),
    ).toBe('polygon');
  });

  it('Image and unknown kinds are immediate', () => {
    const styles = createStyles();

    expect(classifyFeature(makeFeature('img', 'Image'), styles.resolver, empty, companions)).toBe(
      'immediate',
    );
    expect(
      classifyFeature(
        makeFeature('marker', 'Marker' as Feature['type']),
        styles.resolver,
        empty,
        companions,
      ),
    ).toBe('immediate');
  });

  it('a kind registered as a custom type is immediate', () => {
    const styles = createStyles();
    const customTypes = new Map<string, unknown>([['Point', {}]]);

    // Even a type that could be retained as a point goes to immediate drawing once registered
    expect(classifyFeature(makeFeature('p', 'Point'), styles.resolver, new Map(), companions)).toBe(
      'point-circle',
    );
    expect(
      classifyFeature(makeFeature('p', 'Point'), styles.resolver, customTypes, companions),
    ).toBe('immediate');
  });

  it('the layer is passed to the style resolution (needed to evaluate the style rules)', () => {
    const styles = createStyles();

    classifyFeature(makeFeature('l', 'LineString'), styles.resolver, empty, companions, LAYER);
    classifyFeature(makeFeature('p', 'Point'), styles.resolver, empty, companions, LAYER);
    classifyFeature(makeFeature('g', 'Polygon'), styles.resolver, empty, companions, LAYER);

    expect(styles.seenLayers).toEqual([LAYER, LAYER, LAYER]);
  });
});

// === Run splitting and chunking ===

describe('run splitting', () => {
  it('cuts a run where the classification changes (matching the immediate flush)', () => {
    const h = createHarness([
      makeFeature('l1', 'LineString'),
      makeFeature('l2', 'LineString'),
      makeFeature('p1', 'Point'),
      makeFeature('l3', 'LineString'),
    ]);

    h.draw();

    // 3 batches: 2 lines / 1 point / 1 line
    expect(h.probe.built.map((b) => b.kind)).toEqual(['line', 'point', 'line']);
    expect(h.probe.built[0].ids).toEqual(['l1', 'l2']);
    expect(h.probe.built[1].count).toBe(1);
    expect(h.probe.built[2].ids).toEqual(['l3']);
    // The draw order stays the original draw order
    expect(h.probe.drawn).toEqual(h.probe.built);
  });

  it('a change of the point shape cuts a run', () => {
    const h = createHarness(
      [makeFeature('c1', 'Point'), makeFeature('s1', 'Point'), makeFeature('c2', 'Point')],
      { s1: { pointShape: 'square' } },
    );

    h.draw();

    expect(h.probe.built.map((b) => b.kind)).toEqual(['point', 'point', 'point']);
    expect(h.probe.built.map((b) => b.count)).toEqual([1, 1, 1]);
  });

  it('features that cannot be retained get their own run and are drawn immediately', () => {
    const h = createHarness(
      [
        makeFeature('l1', 'LineString'),
        makeFeature('dash', 'LineString'),
        makeFeature('l2', 'LineString'),
      ],
      { dash: { lineStyle: 'dashed' } },
    );

    h.draw();

    expect(h.probe.built.map((b) => b.ids)).toEqual([['l1'], ['l2']]);
    expect(h.paintLog).toEqual(['dash']);
  });

  it('a fill-only polygon and one with a solid outline end up in the same run', () => {
    const h = createHarness(
      [makeFeature('g1', 'Polygon'), makeFeature('g2', 'Polygon'), makeFeature('g3', 'Polygon')],
      { g2: { strokeOpacity: 0 } },
    );

    h.draw();

    expect(h.probe.built).toHaveLength(1);
    expect(h.probe.built[0].ids).toEqual(['g1', 'g2', 'g3']);
  });

  it('a chunk is split at the upper limit of features', () => {
    const features: Feature[] = [];
    for (let i = 0; i < STORE_CHUNK_TARGET + 3; i++) {
      features.push(makeFeature(`l${i}`, 'LineString'));
    }
    const h = createHarness(features);

    h.draw();

    expect(h.probe.built).toHaveLength(2);
    expect(h.probe.built[0].count).toBe(STORE_CHUNK_TARGET);
    expect(h.probe.built[1].count).toBe(3);
  });

  it('the origin of a chunk is the center of its extent', () => {
    const h = createHarness([
      makeFeature('l1', 'LineString', {
        geometry: {
          type: 'LineString',
          coordinates: [
            [10, 20],
            [11, 21],
          ],
        },
      }),
    ]);

    h.draw();

    expect(h.probe.built[0].origin).toEqual([10.5, 20.5]);
  });
});

// === The origin and the view ===

describe('the origin of a chunk seen at high zoom', () => {
  /** Tokyo and Osaka in one chunk: the extent is about 4 degrees wide */
  const tokyoOsaka = (): Feature[] => [
    makeFeature('tokyo', 'LineString', {
      geometry: {
        type: 'LineString',
        coordinates: [
          [139.7, 35.68],
          [139.71, 35.69],
        ],
      },
    }),
    makeFeature('osaka', 'LineString', {
      geometry: {
        type: 'LineString',
        coordinates: [
          [135.5, 34.69],
          [135.51, 34.7],
        ],
      },
    }),
  ];
  /** A view of about 1000 px around Osaka at zoom 22 */
  const osakaView: BoundingBox = { minX: 135.5, minY: 34.69, maxX: 135.5002, maxY: 34.6902 };

  it('builds the chunk again around the view when the error would exceed 0.1 px', () => {
    const h = createHarness(tokyoOsaka());
    h.draw(undefined, 10);
    expect(h.probe.built).toHaveLength(1);

    h.probe.reset();
    h.draw(osakaView, 22);

    expect(h.probe.built).toHaveLength(1);
    const origin = h.probe.built[0].origin as [number, number];
    expect(origin[0]).toBeCloseTo(135.5001, 6);
    expect(origin[1]).toBeCloseTo(34.6901, 6);
    // The rebuilt batch is what is drawn in the same frame
    expect(h.probe.drawn).toEqual([h.probe.built[0]]);
  });

  it('keeps the batch while the view stays near the origin', () => {
    const h = createHarness(tokyoOsaka());
    h.draw(osakaView, 22);
    h.probe.reset();

    h.draw({ ...osakaView, minX: 135.5001, maxX: 135.5003 }, 22);
    h.draw(osakaView, 22);

    expect(h.probe.built).toEqual([]);
  });

  it('does not rebuild at low zoom, where the error is far below a pixel', () => {
    const h = createHarness(tokyoOsaka());
    h.draw(undefined, 10);
    h.probe.reset();

    h.draw(osakaView, 14);

    expect(h.probe.built).toEqual([]);
  });

  it('keeps the origin chosen for the view when the chunk is rebuilt for a data change', () => {
    const h = createHarness(tokyoOsaka());
    h.draw(osakaView, 22);
    const origin = h.probe.built[h.probe.built.length - 1]?.origin;
    h.probe.reset();

    const target = h.stub.features[0];
    h.cache.applyChanges({
      features: { updated: [{ id: target.id, feature: target, previous: { ...target } }] },
    });
    h.draw(osakaView, 22);

    expect(h.probe.built.map((b) => b.origin)).toEqual([origin]);
  });
});

// === z-order ===

describe('z-order', () => {
  it('retained batches and immediate drawing alternate in the original draw order', () => {
    const order: string[] = [];
    const h = createHarness(
      [makeFeature('g1', 'Polygon'), makeFeature('img', 'Image'), makeFeature('l1', 'LineString')],
      {},
    );

    // The retained batch draws and the immediate-mode paints are recorded in one list
    const renderers = h.deps.renderers;
    const note = (batch: unknown): void => {
      order.push(`retained:${(batch as MockBatch).ids.join(',')}`);
    };
    renderers.polygon.drawRetained = note as typeof renderers.polygon.drawRetained;
    renderers.line.drawRetainedBatch = note as typeof renderers.line.drawRetainedBatch;
    h.deps.batchManager = {
      beginFrame: (): void => {},
      processFeature: (feature: Feature): boolean => {
        order.push(`immediate:${feature.id}`);
        return false;
      },
      endFrame: (): void => {},
    };

    h.draw();

    expect(order).toEqual(['retained:g1', 'immediate:img', 'retained:l1']);
  });

  it('a custom type is drawn through the immediate path after the batch is flushed', () => {
    const h = createHarness(
      [
        makeFeature('l1', 'LineString'),
        makeFeature('marker', 'Marker' as Feature['type']),
        makeFeature('l2', 'LineString'),
      ],
      {},
      { customTypes: ['Marker'] },
    );

    h.draw();

    expect(h.probe.built.map((b) => b.ids)).toEqual([['l1'], ['l2']]);
    expect(h.paintLog).toEqual(['marker']);
  });

  it('the blend state is re-established right after a custom type is drawn', () => {
    // An external renderer of a custom type may come back having
    // rewritten the blend function. Left alone, everything drawn later in the same frame (the
    // layers that follow, the datasets) would be composited wrongly, so it is
    // re-established right after control comes back.
    const h = createHarness(
      [makeFeature('marker', 'Marker' as Feature['type'])],
      {},
      { customTypes: ['Marker'] },
    );
    const order: string[] = [];
    h.deps.customRenderers.set('Marker', {
      draw: (): void => {
        order.push('custom');
      },
    } as unknown as CustomFeatureHandler['renderer']);
    h.deps.restoreBlendState = (): void => {
      order.push('restore');
    };

    h.draw();

    expect(order).toEqual(['custom', 'restore']);
  });

  it('nothing is re-established in a frame without a custom type', () => {
    const h = createHarness([makeFeature('l1', 'LineString')], {});
    let restored = 0;
    h.deps.restoreBlendState = (): void => {
      restored++;
    };

    h.draw();

    expect(restored).toBe(0);
  });
});

// === Fixed width ===

describe('fixed width (features without createdZoom)', () => {
  it('lines go onto the same batch with a negative width', () => {
    const h = createHarness(
      [
        makeFeature('fixed', 'LineString'),
        makeFeature('scaled', 'LineString', { properties: { createdZoom: 12 } }),
      ],
      { fixed: { strokeWidth: 3 }, scaled: { strokeWidth: 4 } },
    );

    h.draw();

    // They are mixed in one batch and only the fixed width is negative
    expect(h.probe.built).toHaveLength(1);
    expect(h.probe.built[0].widths).toEqual([-3, 4]);
  });

  it('the outline of a polygon also goes onto the same batch with a negative width', () => {
    const h = createHarness(
      [
        makeFeature('fixed', 'Polygon'),
        makeFeature('scaled', 'Polygon', { properties: { createdZoom: 12 } }),
      ],
      { fixed: { strokeWidth: 3 }, scaled: { strokeWidth: 4 } },
    );

    h.draw();

    expect(h.probe.built).toHaveLength(1);
    expect(h.probe.built[0].widths).toEqual([-3, 4]);
  });

  it('the width of a polygon without an outline stays 0', () => {
    const h = createHarness([makeFeature('fill', 'Polygon')], { fill: { strokeOpacity: 0 } });

    h.draw();

    expect(h.probe.built[0].widths).toEqual([0]);
  });
});

// === Rebuilding and invalidation ===

describe('rebuilding', () => {
  it('the batch is not rebuilt on the second frame when nothing changed', () => {
    const h = createHarness([makeFeature('l1', 'LineString')]);

    h.draw();
    expect(h.probe.built).toHaveLength(1);

    h.probe.reset();
    h.draw();

    expect(h.probe.built).toHaveLength(0);
    expect(h.probe.drawn).toHaveLength(1);
  });

  it('a change of the coordinates alone rebuilds only the chunk in question', () => {
    const features: Feature[] = [];
    for (let i = 0; i < STORE_CHUNK_TARGET + 2; i++) {
      features.push(makeFeature(`l${i}`, 'LineString'));
    }
    const h = createHarness(features);
    h.draw();
    expect(h.probe.built).toHaveLength(2);

    const target = h.stub.features[STORE_CHUNK_TARGET];
    h.probe.reset();
    h.cache.applyChanges({
      features: { updated: [{ id: target.id, feature: target, previous: { ...target } }] },
    });
    h.draw();

    // Only the second chunk is released and rebuilt
    expect(h.probe.disposed).toHaveLength(1);
    expect(h.probe.built).toHaveLength(1);
    expect(h.probe.built[0].ids[0]).toBe(target.id);
    expect(h.probe.drawn).toHaveLength(2);
  });

  it('a change of the style reference rebuilds the whole layer', () => {
    const h = createHarness([makeFeature('l1', 'LineString'), makeFeature('l2', 'LineString')]);
    h.draw();

    const target = h.stub.features[0];
    const previous = { ...target };
    target.style = { strokeColor: '#ff0000' };

    h.probe.reset();
    h.cache.applyChanges({ features: { updated: [{ id: target.id, feature: target, previous }] } });
    h.draw();

    expect(h.probe.disposed).toHaveLength(1);
    expect(h.probe.built).toHaveLength(1);
  });

  it('moving a layer rebuilds both the source and the destination', () => {
    const features = [
      makeFeature('a', 'LineString'),
      makeFeature('b', 'LineString', { layerId: 'layer-2' }),
    ];
    const h = createHarness(features);
    h.draw();
    h.cache.drawLayer('layer-2', undefined, PROJECTION, 14, h.deps);
    expect(h.probe.built).toHaveLength(2);

    const target = h.stub.features[0];
    const previous = { ...target };
    target.layerId = 'layer-2';

    h.probe.reset();
    h.cache.applyChanges({ features: { updated: [{ id: target.id, feature: target, previous }] } });

    // The GPU resources of both layers are released
    expect(h.probe.disposed).toHaveLength(2);
  });

  it('reordering within a layer rebuilds that layer', () => {
    const h = createHarness([makeFeature('l1', 'LineString')]);
    h.draw();

    h.probe.reset();
    h.cache.applyChanges({ layerReorder: { layerId: 'layer-1', order: [], previous: [] } });

    expect(h.probe.disposed).toHaveLength(1);

    h.draw();
    expect(h.probe.built).toHaveLength(1);
  });

  it('updating or deleting a layer rebuilds that layer', () => {
    const h = createHarness([makeFeature('l1', 'LineString')]);
    h.draw();

    h.probe.reset();
    h.cache.applyChanges({
      layers: { updated: [{ id: 'layer-1', layer: LAYER, previous: LAYER }] },
    });
    expect(h.probe.disposed).toHaveLength(1);
  });

  it('multiplies the opacity of the layer into every retained draw as a factor', () => {
    const h = createHarness([
      makeFeature('g1', 'Polygon'),
      makeFeature('l1', 'LineString'),
      makeFeature('p1', 'Point'),
    ]);
    h.draw(undefined, 14, { ...LAYER, opacity: 0.4 });

    expect(h.probe.drawn.map((b) => b.kind)).toEqual(['polygon', 'line', 'point']);
    expect(h.probe.drawnOpacity).toEqual([0.4, 0.4, 0.4]);
  });

  it('keeps the batches when only the opacity of the layer changes', () => {
    const h = createHarness([makeFeature('l1', 'LineString'), makeFeature('p1', 'Point')]);
    const previous: Layer = { ...LAYER, opacity: 1 };
    h.draw(undefined, 14, previous);

    h.probe.reset();
    const layer: Layer = { ...previous, opacity: 0.3 };
    h.cache.applyChanges({ layers: { updated: [{ id: 'layer-1', layer, previous }] } });
    h.draw(undefined, 14, layer);

    expect(h.probe.disposed).toHaveLength(0);
    expect(h.probe.built).toHaveLength(0);
    expect(h.probe.drawnOpacity).toEqual([0.3, 0.3]);

    // Any other change alongside the opacity still rebuilds the layer
    h.cache.applyChanges({
      layers: {
        updated: [
          { id: 'layer-1', layer: { ...layer, opacity: 1, visible: false }, previous: layer },
        ],
      },
    });
    expect(h.probe.disposed).toHaveLength(2);
  });

  it('reordering between layers does not discard the cache', () => {
    const h = createHarness([makeFeature('l1', 'LineString')]);
    h.draw();

    h.probe.reset();
    h.cache.applyChanges({
      layers: { orderChanged: { order: ['layer-1'], previous: ['layer-1'] } },
    });
    h.draw();

    expect(h.probe.disposed).toHaveLength(0);
    expect(h.probe.built).toHaveLength(0);
  });

  it('changes of the selection, the mode or the UI state do not discard the cache', () => {
    const h = createHarness([makeFeature('l1', 'LineString')]);
    h.draw();

    h.probe.reset();
    h.cache.applyChanges({ uiStateChanged: true });
    h.cache.applyChanges({
      selection: { type: 'feature', ids: ['l1'], previousType: null, previousIds: [] },
    });
    h.draw();

    expect(h.probe.disposed).toHaveLength(0);
    expect(h.probe.built).toHaveLength(0);
  });

  it('a change of a group rebuilds every layer', () => {
    const features = [
      makeFeature('a', 'LineString'),
      makeFeature('b', 'LineString', { layerId: 'layer-2' }),
    ];
    const h = createHarness(features);
    h.draw();
    h.cache.drawLayer('layer-2', undefined, PROJECTION, 14, h.deps);

    h.probe.reset();
    h.cache.applyChanges({ groupReorder: { groupId: 'g', featureIds: [], previous: [] } });

    expect(h.probe.disposed).toHaveLength(2);
  });

  it('an update that changes the classification disagrees and rebuilds the layer', () => {
    const specs: Record<string, StyleSpec> = { l1: { lineStyle: 'solid' } };
    const h = createHarness([makeFeature('l1', 'LineString')], specs);
    h.draw();
    expect(h.probe.built.map((b) => b.kind)).toEqual(['line']);

    // Create the situation where the style rule evaluation changed through properties and the
    // line became dashed
    const target = h.stub.features[0];
    specs.l1 = { lineStyle: 'dashed' };

    h.probe.reset();
    h.cache.applyChanges({
      features: { updated: [{ id: target.id, feature: target, previous: { ...target } }] },
    });
    h.draw();

    // No retained batch is built and it falls back to immediate mode
    expect(h.probe.built).toHaveLength(0);
    expect(h.paintLog).toEqual(['l1']);
  });
});

describe('local visibility', () => {
  it('every cache is discarded when the hidden set changes', () => {
    const h = createHarness([makeFeature('l1', 'LineString'), makeFeature('l2', 'LineString')]);
    h.draw();
    expect(h.probe.built).toHaveLength(1);

    // The Store updates the same Set in place, so a reference comparison cannot notice it
    h.stub.hidden.add('l1');

    h.probe.reset();
    h.draw();

    expect(h.probe.disposed).toHaveLength(1);
    expect(h.probe.built).toHaveLength(1);
    // A hidden feature does not go onto the batch
    expect(h.probe.built[0].ids).toEqual(['l2']);
  });

  it('nothing is rebuilt when the hidden set does not change', () => {
    const h = createHarness([makeFeature('l1', 'LineString')]);
    h.stub.hidden.add('other');
    h.draw();

    h.probe.reset();
    h.draw();

    expect(h.probe.disposed).toHaveLength(0);
    expect(h.probe.built).toHaveLength(0);
  });
});

describe('releasing the GPU resources', () => {
  it('dispose releases every retained batch', () => {
    const features = [
      makeFeature('l1', 'LineString'),
      makeFeature('p1', 'Point'),
      makeFeature('g1', 'Polygon'),
    ];
    const h = createHarness(features);
    h.draw();
    expect(h.probe.built).toHaveLength(3);

    h.cache.dispose();

    expect(h.probe.disposed).toHaveLength(3);
    expect(h.probe.disposed.map((b) => b.kind).sort()).toEqual(['line', 'point', 'polygon']);
  });

  it('drawing after dispose rebuilds the batches', () => {
    const h = createHarness([makeFeature('l1', 'LineString')]);
    h.draw();
    h.cache.dispose(h.deps.renderers);

    h.probe.reset();
    h.draw();

    expect(h.probe.built).toHaveLength(1);
  });
});

describe('when a retained batch cannot be built', () => {
  it('it draws in immediate mode and tries to rebuild on the next frame', () => {
    const h = createHarness(
      [makeFeature('l1', 'LineString'), makeFeature('l2', 'LineString')],
      {},
      {
        buildable: false,
      },
    );

    h.draw();
    expect(h.probe.drawn).toHaveLength(0);
    expect(h.paintLog).toEqual(['l1', 'l2']);

    h.draw();
    // It tries to rebuild every frame and keeps drawing in immediate mode meanwhile
    expect(h.paintLog).toEqual(['l1', 'l2', 'l1', 'l2']);
  });
});

describe('passing the layer around', () => {
  it('the layer is passed to the style resolution and to the frame of the batch', () => {
    const h = createHarness([makeFeature('img', 'Image')]);

    h.draw();

    // A frame is opened with the layer even for an immediate chunk
    expect(h.immediate.frames).toBeGreaterThan(0);
  });
});

describe('viewport thinning', () => {
  /** Around the origin (contains LINE_COORDS / RING) */
  const NEAR: BoundingBox = { minX: -1, minY: -1, maxX: 2, maxY: 2 };
  /** A range far away from the origin (contains FAR_RING) */
  const FAR: BoundingBox = { minX: 100, minY: 40, maxX: 110, maxY: 50 };

  const FAR_RING: Coordinate[] = [
    [104, 44],
    [106, 44],
    [106, 46],
    [104, 46],
  ];

  it('the chunk bbox is computed at build time and non-intersecting chunks skipped', () => {
    const h = createHarness([
      makeFeature('near-line', 'LineString'),
      makeFeature('far-poly', 'Polygon', {
        geometry: geometryFromCoordinates('Polygon', [FAR_RING]),
      }),
    ]);

    h.draw(NEAR);

    // Both chunks are built (the contents of a batch do not depend on the camera)
    expect(h.probe.built).toHaveLength(2);
    // Only the near one is drawn
    expect(h.probe.drawn.map((b) => b.ids)).toEqual([['near-line']]);

    h.probe.reset();
    h.draw(FAR);

    expect(h.probe.built).toHaveLength(0);
    expect(h.probe.drawn.map((b) => b.ids)).toEqual([['far-poly']]);
  });

  it('every chunk is drawn when no viewport is passed', () => {
    const h = createHarness([
      makeFeature('near-line', 'LineString'),
      makeFeature('far-poly', 'Polygon', {
        geometry: geometryFromCoordinates('Polygon', [FAR_RING]),
      }),
    ]);

    h.draw();

    expect(h.probe.drawn.map((b) => b.ids)).toEqual([['near-line'], ['far-poly']]);
  });

  it('a chunk without a bbox (no coordinates) is always drawn', () => {
    const h = createHarness(
      [
        makeFeature('marker', 'Marker', {
          geometry: geometryFromCoordinates('Marker', [] as unknown as Coordinate),
        }),
      ],
      {},
      { customTypes: ['Marker'] },
    );

    h.draw(FAR);

    expect(h.paintLog).toEqual(['marker']);
  });

  it('an immediate chunk is thinned by the viewport too', () => {
    const h = createHarness(
      [
        makeFeature('near-line', 'LineString'),
        makeFeature('far-dashed', 'LineString', {
          geometry: geometryFromCoordinates('LineString', FAR_RING),
        }),
      ],
      { 'far-dashed': { lineStyle: 'dashed' } },
    );

    h.draw(NEAR);
    expect(h.paintLog).toEqual([]);

    h.draw(FAR);
    expect(h.paintLog).toEqual(['far-dashed']);
  });

  it('a rebuild updates the bbox (judged at the position after the move)', () => {
    const h = createHarness([makeFeature('l1', 'LineString')]);
    h.draw(NEAR);
    expect(h.probe.drawn).toHaveLength(1);

    const target = h.stub.features[0];
    const previous = { ...target };
    target.geometry = geometryFromCoordinates(target.type, FAR_RING);

    h.cache.applyChanges({ features: { updated: [{ id: target.id, feature: target, previous }] } });

    h.probe.reset();
    h.draw(NEAR);
    expect(h.probe.drawn).toHaveLength(0);

    h.probe.reset();
    h.draw(FAR);
    expect(h.probe.drawn).toHaveLength(1);
  });

  it('the bbox of a Circle expands by the radius', () => {
    // A radius of 200 km ≒ 1.8 degrees. The center is the origin.
    const h = createHarness([
      makeFeature('c1', 'Circle', { properties: { radiusMeters: 200000 } }),
    ]);

    // A range that does not contain the center but touches the circle
    h.draw({ minX: 1, minY: -0.1, maxX: 1.5, maxY: 0.1 });
    expect(h.probe.drawn).toHaveLength(1);

    // Outside the circle
    h.probe.reset();
    h.draw({ minX: 5, minY: -0.1, maxX: 6, maxY: 0.1 });
    expect(h.probe.drawn).toHaveLength(0);
  });

  /**
   * A custom type whose coordinates is a single anchor and whose body spreads around it
   *
   * A minimal model of a feature drawn as a box around one anchor. It is registered in the
   * extension registry the harness draws with (one draw instance).
   */
  const ANCHORED_TYPE = 'AnchoredBox';

  // Register a calculator that returns a rectangle spreading 2 degrees in each direction
  harnessExtensions.registerBoundingBox(ANCHORED_TYPE, (feature): BoundingBoxCoords => {
    const [lng, lat] = coordinatesOf(feature) as Coordinate;
    return {
      topLeft: [lng - 2, lat + 2],
      topRight: [lng + 2, lat + 2],
      bottomRight: [lng + 2, lat - 2],
      bottomLeft: [lng - 2, lat - 2],
      center: [lng, lat],
    };
  });

  it('a custom type is drawn while its rectangle touches, even with the anchor out', () => {
    const h = createHarness(
      [makeFeature('marker', ANCHORED_TYPE)],
      {},
      {
        customTypes: [ANCHORED_TYPE],
      },
    );

    // A range that does not contain the anchor (the origin) but touches the rectangle (±2
    // degrees). It corresponds to putting the center of the map inside a huge box of that type.
    h.draw({ minX: 1, minY: -0.5, maxX: 1.5, maxY: 0.5 });
    expect(h.paintLog).toEqual(['marker']);
  });

  it('a custom type is thinned away when even its rectangle is out of range', () => {
    const h = createHarness(
      [makeFeature('marker', ANCHORED_TYPE)],
      {},
      {
        customTypes: [ANCHORED_TYPE],
      },
    );

    h.draw({ minX: 5, minY: -0.5, maxX: 6, maxY: 0.5 });
    expect(h.paintLog).toEqual([]);
  });

  /**
   * Goes through the same two-stage thinning as the application (chunk bbox → spatial index)
   *
   * The bug in the field was that "such a box disappears entirely once the center of the map
   * enters it". So that the stage responsible is not mistaken for the other one, the same type is
   * registered in both registries and a real RBushSpatialIndex is placed in the rendering path
   * before checking.
   *
   * - The spatial index side = setCustomBoundingBoxCalculator (what a custom feature handler
   *   passes as getBoundingBox)
   * - The chunk bbox side = the selection bounding box registry (what it likewise passes as
   *   getSelectionBoundingBox; already registered for ANCHORED_TYPE)
   */
  it('draws a box whose anchor is out of view through index and chunk bbox alike', () => {
    const anchor: Coordinate = [139.74717, 35.64188];
    /** A rectangle spreading 0.3433 degrees in each direction (= 4000px @ z12) */
    const halfDeg = 0.3433;

    const spatialIndex = new RBushSpatialIndex();
    spatialIndex.setCustomBoundingBoxCalculator(ANCHORED_TYPE, (feature) => {
      const [lng, lat] = coordinatesOf(feature) as Coordinate;
      return {
        minX: lng - halfDeg,
        minY: lat - halfDeg,
        maxX: lng + halfDeg,
        maxY: lat + halfDeg,
      };
    });

    const marker = makeFeature('marker', ANCHORED_TYPE, {
      geometry: geometryFromCoordinates(ANCHORED_TYPE, anchor),
    });
    spatialIndex.insert(marker);

    const h = createHarness([marker], {}, { customTypes: [ANCHORED_TYPE], spatialIndex });

    // The expanded viewport corresponding to the pose that reproduces the field case (z12, the
    // camera 0.35 degrees east of the anchor). It does not contain the anchor (139.74717) but
    // touches the eastern edge of the rectangle (140.0905).
    const expanded: BoundingBox = {
      minX: 139.8637,
      minY: 35.5252,
      maxX: 140.3306,
      maxY: 35.7586,
    };

    // The index returns the box for this range (= the index is not what decides it)
    expect(spatialIndex.findInBounds(expanded)).toEqual(['marker']);

    // It passes the chunk bbox stage and reaches the custom renderer
    h.draw(expanded);
    expect(h.paintLog).toEqual(['marker']);
    expect(h.visible.calls).toBe(1);
  });

  it('the bbox of an Image expands by its displayed size', () => {
    // 100px square at createdZoom 4 ≒ ±2.2 degrees. The anchor is the origin.
    const h = createHarness([
      makeFeature('img', 'Image', {
        properties: { imageWidth: 100, imageHeight: 100, createdZoom: 4 },
      }),
    ]);

    h.draw({ minX: 1, minY: -0.5, maxX: 1.5, maxY: 0.5 });
    expect(h.paintLog).toEqual(['img']);

    h.paintLog.length = 0;
    h.draw({ minX: 5, minY: -0.5, maxX: 6, maxY: 0.5 });
    expect(h.paintLog).toEqual([]);
  });
});

describe('per-feature thinning of the immediate chunks', () => {
  /** A range that contains every feature */
  const ALL: BoundingBox = { minX: -10, minY: -10, maxX: 10, maxY: 10 };

  const NEAR_COORDS: Coordinate[] = [
    [0, 0],
    [1, 1],
  ];
  const OFF_COORDS: Coordinate[] = [
    [2, 2],
    [3, 3],
  ];

  /** Two dashed lines that go into the same chunk (both touch viewportBounds) */
  const dashedPair = (): Feature[] => [
    makeFeature('d-visible', 'LineString', {
      geometry: geometryFromCoordinates('LineString', NEAR_COORDS),
    }),
    makeFeature('d-offscreen', 'LineString', {
      geometry: geometryFromCoordinates('LineString', OFF_COORDS),
    }),
  ];
  const DASHED_SPECS: Record<string, StyleSpec> = {
    'd-visible': { lineStyle: 'dashed' },
    'd-offscreen': { lineStyle: 'dashed' },
  };

  it('a feature that is not in the visible set is not drawn immediately', () => {
    const h = createHarness(dashedPair(), DASHED_SPECS, { visibleIds: ['d-visible'] });

    h.draw(ALL);

    expect(h.paintLog).toEqual(['d-visible']);
  });

  it('an immediate chunk of a custom type is thinned too', () => {
    const h = createHarness(
      [
        makeFeature('t-visible', 'Sticker', {
          geometry: { type: 'Point', coordinates: [0, 0] as unknown as Coordinate },
        }),
        makeFeature('t-offscreen', 'Sticker', {
          geometry: { type: 'Point', coordinates: [3, 3] as unknown as Coordinate },
        }),
      ],
      {},
      { customTypes: ['Sticker'], visibleIds: ['t-visible'] },
    );

    h.draw(ALL);

    expect(h.paintLog).toEqual(['t-visible']);
  });

  it('everything is drawn when getVisibleIds is not passed', () => {
    const h = createHarness(dashedPair(), DASHED_SPECS);

    h.draw(ALL);

    expect(h.paintLog).toEqual(['d-visible', 'd-offscreen']);
  });

  it('nothing is thinned without viewportBounds (getVisibleIds is not called)', () => {
    const h = createHarness(dashedPair(), DASHED_SPECS, { visibleIds: ['d-visible'] });

    h.draw();

    expect(h.paintLog).toEqual(['d-visible', 'd-offscreen']);
    expect(h.visible.calls).toBe(0);
  });

  it('a retained chunk is not thinned by the visible set (a batch cannot be split)', () => {
    const h = createHarness(
      [
        makeFeature('r-visible', 'LineString', {
          geometry: geometryFromCoordinates('LineString', NEAR_COORDS),
        }),
        makeFeature('r-offscreen', 'LineString', {
          geometry: geometryFromCoordinates('LineString', OFF_COORDS),
        }),
      ],
      {},
      { visibleIds: ['r-visible'] },
    );

    h.draw(ALL);

    expect(h.probe.drawn.map((b) => b.ids)).toEqual([['r-visible', 'r-offscreen']]);
  });

  it('getVisibleIds is not called in a frame that draws no immediate chunk', () => {
    const h = createHarness(
      [
        makeFeature('solid', 'LineString', {
          geometry: geometryFromCoordinates('LineString', NEAR_COORDS),
        }),
        makeFeature('dashed', 'LineString', {
          geometry: geometryFromCoordinates('LineString', OFF_COORDS),
        }),
      ],
      { dashed: { lineStyle: 'dashed' } },
      { visibleIds: ['solid', 'dashed'] },
    );

    // A viewport where only the dashed chunk falls out of range
    h.draw({ minX: -1, minY: -1, maxX: 1.5, maxY: 1.5 });
    expect(h.visible.calls).toBe(0);

    // It is looked up once in a frame where the dashed chunk touches the view
    h.draw(ALL);
    expect(h.visible.calls).toBe(1);
  });
});

// === Incremental update of a vertex drag ===

describe('computeCoordinateDiff', () => {
  const base: Coordinate[] = [
    [0, 0],
    [1, 1],
    [2, 2],
  ];

  it('an empty array when there is no change', () => {
    expect(computeCoordinateDiff(base, [...base], 8)).toEqual([]);
  });

  it('returns the indices of the vertices that moved', () => {
    const next: Coordinate[] = [...base];
    next[1] = [9, 9];

    expect(computeCoordinateDiff(base, next, 8)).toEqual([1]);
  });

  it('several moved vertices are returned together', () => {
    const next: Coordinate[] = [
      [5, 5],
      [1, 1],
      [7, 7],
    ];

    expect(computeCoordinateDiff(base, next, 8)).toEqual([0, 2]);
  });

  it('a different reference with the same value counts as not moved', () => {
    const next: Coordinate[] = base.map((c) => [c[0], c[1]]);

    expect(computeCoordinateDiff(base, next, 8)).toEqual([]);
  });

  it('a vertex with the same reference is skipped without its value (fast path)', () => {
    // If the values were looked at, NaN would not equal NaN, but the same reference skips it
    const shared: Coordinate = [Number.NaN, Number.NaN];

    expect(computeCoordinateDiff([shared], [shared], 8)).toEqual([]);
  });

  it('a change beyond the upper limit is null (not handled as a diff)', () => {
    const prev: Coordinate[] = [];
    const next: Coordinate[] = [];
    for (let i = 0; i < 12; i++) {
      prev.push([i, i]);
      next.push([i + 1, i]);
    }

    expect(computeCoordinateDiff(prev, next, 8)).toBeNull();
    // Exactly up to the upper limit can still be a diff
    expect(computeCoordinateDiff(prev.slice(0, 8), next.slice(0, 8), 8)).toHaveLength(8);
  });

  it('null when the number of vertices differs', () => {
    expect(computeCoordinateDiff(base, base.slice(0, 2), 8)).toBeNull();
    expect(computeCoordinateDiff(base.slice(0, 2), base, 8)).toBeNull();
  });
});

describe('computeLineCoordSlots', () => {
  const threeCoords: Coordinate[] = [
    [0, 0],
    [1, 1],
    [2, 2],
  ];

  it('LineString / Freehand are recorded with the running coordinate count as offset', () => {
    const slots = computeLineCoordSlots([
      makeFeature('l1', 'LineString', {
        geometry: geometryFromCoordinates('LineString', threeCoords),
      }),
      makeFeature('l2', 'Freehand'),
      makeFeature('l3', 'LineString'),
    ]);

    expect(slots.get('l1')).toEqual({ offset: 0, count: 3 });
    expect(slots.get('l2')).toEqual({ offset: 3, count: 2 });
    expect(slots.get('l3')).toEqual({ offset: 5, count: 2 });
  });

  it('a MultiLineString is not recorded, but the offset advances by its coordinates', () => {
    const slots = computeLineCoordSlots([
      makeFeature('m1', 'MultiLineString', {
        geometry: geometryFromCoordinates('MultiLineString', [threeCoords, threeCoords]),
      }),
      makeFeature('l1', 'LineString'),
    ]);

    expect(slots.has('m1')).toBe(false);
    expect(slots.get('l1')).toEqual({ offset: 6, count: 2 });
  });

  it('a feature with fewer than 2 vertices is not pushed, so the offset stays', () => {
    const slots = computeLineCoordSlots([
      makeFeature('short', 'LineString', {
        geometry: { type: 'LineString', coordinates: [[0, 0]] as Coordinate[] },
      }),
      makeFeature('empty', 'LineString', {
        geometry: geometryFromCoordinates('LineString', [] as Coordinate[]),
      }),
      makeFeature('l1', 'LineString'),
    ]);

    expect(slots.has('short')).toBe(false);
    expect(slots.has('empty')).toBe(false);
    expect(slots.get('l1')).toEqual({ offset: 0, count: 2 });
  });
});

describe('incremental update of a vertex drag', () => {
  /** Moves vertices and emits them in the shape of an update notification of the Store */
  function moveVertices(
    h: ReturnType<typeof createHarness>,
    id: string,
    moves: Array<[number, Coordinate]>,
    extra: Partial<Feature> = {},
  ): void {
    const target = h.stub.features.find((f) => f.id === id) as Feature;
    // Just like updateFeature of the Store, the feature before the change is passed as previous
    // (the array elements of the vertices that do not move share their references)
    const previous = { ...target };
    const coords = [...(coordinatesOf(target) as Coordinate[])];
    for (const [index, coord] of moves) coords[index] = coord;
    target.geometry = geometryFromCoordinates(target.type, coords);
    Object.assign(target, extra);

    h.cache.applyChanges({ features: { updated: [{ id, feature: target, previous }] } });
  }

  /** A line with n vertices */
  function longLine(id: string, n: number): Feature {
    const coords: Coordinate[] = [];
    for (let i = 0; i < n; i++) coords.push([i * 0.001, i * 0.001]);
    return makeFeature(id, 'LineString', { geometry: { type: 'LineString', coordinates: coords } });
  }

  it('moving one vertex rewrites a texel before drawing instead of rebuilding', () => {
    const h = createHarness([makeFeature('l1', 'LineString'), makeFeature('l2', 'LineString')]);
    h.draw();

    h.probe.reset();
    moveVertices(h, 'l2', [[1, [5, 6]]]);
    h.draw();

    expect(h.probe.disposed).toHaveLength(0);
    expect(h.probe.built).toHaveLength(0);
    // It is the second vertex of the second line, so the serial index in the texture is 3
    expect(h.probe.patched).toHaveLength(1);
    expect(h.probe.patched[0].updates).toEqual([{ coordIndex: 3, lngLat: [5, 6] }]);
    expect(h.probe.patched[0].batch).toBe(h.probe.drawn[0]);
  });

  it('the same patch is not applied twice on the next frame', () => {
    const h = createHarness([makeFeature('l1', 'LineString')]);
    h.draw();
    moveVertices(h, 'l1', [[0, [3, 3]]]);
    h.draw();

    h.probe.reset();
    h.draw();

    expect(h.probe.patched).toHaveLength(0);
    expect(h.probe.drawn).toHaveLength(1);
  });

  it('moving several vertices is gathered into a single call', () => {
    const h = createHarness([longLine('l1', 5)]);
    h.draw();

    h.probe.reset();
    moveVertices(h, 'l1', [
      [1, [7, 7]],
      [3, [8, 8]],
    ]);
    h.draw();

    expect(h.probe.built).toHaveLength(0);
    expect(h.probe.patched).toHaveLength(1);
    expect(h.probe.patched[0].updates).toEqual([
      { coordIndex: 1, lngLat: [7, 7] },
      { coordIndex: 3, lngLat: [8, 8] },
    ]);
  });

  it('the chunk is rebuilt when more vertices than the upper limit moved', () => {
    const h = createHarness([longLine('l1', 20)]);
    h.draw();

    const moves: Array<[number, Coordinate]> = [];
    for (let i = 0; i < 9; i++) moves.push([i, [10 + i, 10]]);

    h.probe.reset();
    moveVertices(h, 'l1', moves);
    h.draw();

    expect(h.probe.patched).toHaveLength(0);
    expect(h.probe.disposed).toHaveLength(1);
    expect(h.probe.built).toHaveLength(1);
  });

  it('an update that changes the number of vertices rebuilds the chunk', () => {
    const h = createHarness([makeFeature('l1', 'LineString')]);
    h.draw();

    const target = h.stub.features[0];
    const previous = { ...target };
    target.geometry = geometryFromCoordinates(target.type, [
      ...(coordinatesOf(target) as Coordinate[]),
      [2, 2],
    ]);

    h.probe.reset();
    h.cache.applyChanges({ features: { updated: [{ id: 'l1', feature: target, previous }] } });
    h.draw();

    expect(h.probe.patched).toHaveLength(0);
    expect(h.probe.built).toHaveLength(1);
  });

  it('an update where no vertex moved is rebuilt instead of diffed (conservative)', () => {
    const h = createHarness([makeFeature('l1', 'LineString')]);
    h.draw();

    const target = h.stub.features[0];

    h.probe.reset();
    h.cache.applyChanges({
      features: { updated: [{ id: 'l1', feature: target, previous: { ...target } }] },
    });
    h.draw();

    expect(h.probe.patched).toHaveLength(0);
    expect(h.probe.built).toHaveLength(1);
  });

  it('a MultiLineString is rebuilt instead of being a target of the diff', () => {
    const h = createHarness([makeFeature('m1', 'MultiLineString')]);
    h.draw();

    const target = h.stub.features[0];
    const previous = { ...target };
    target.geometry = geometryFromCoordinates(target.type, [
      [
        [0, 0],
        [3, 3],
      ],
    ]);

    h.probe.reset();
    h.cache.applyChanges({ features: { updated: [{ id: 'm1', feature: target, previous }] } });
    h.draw();

    expect(h.probe.patched).toHaveLength(0);
    expect(h.probe.built).toHaveLength(1);
  });

  it('an update that also changes properties is rebuilt (the rules may change)', () => {
    const h = createHarness([makeFeature('l1', 'LineString')]);
    h.draw();

    h.probe.reset();
    moveVertices(h, 'l1', [[0, [3, 3]]], { properties: { name: 'x' } });
    h.draw();

    expect(h.probe.patched).toHaveLength(0);
    expect(h.probe.built).toHaveLength(1);
  });

  it('it rebuilds with a renderer that does not support the partial update', () => {
    const h = createHarness([makeFeature('l1', 'LineString')], {}, { patchable: false });
    h.draw();

    h.probe.reset();
    moveVertices(h, 'l1', [[0, [3, 3]]]);
    h.draw();

    expect(h.probe.patched).toHaveLength(0);
    expect(h.probe.built).toHaveLength(1);
  });

  it('the bbox of the chunk expands to the destination (it survives the thinning)', () => {
    const h = createHarness([makeFeature('l1', 'LineString')]);
    h.draw({ minX: -1, minY: -1, maxX: 2, maxY: 2 });

    h.probe.reset();
    moveVertices(h, 'l1', [[1, [50, 50]]]);
    // A viewport containing the destination (it does not touch the original bbox). At a zoom
    // where the origin 50 degrees away still leaves less than 0.1 px, so the batch is kept
    h.draw({ minX: 49, minY: 49, maxX: 51, maxY: 51 }, 10);

    expect(h.probe.built).toHaveLength(0);
    expect(h.probe.drawn).toHaveLength(1);
    expect(h.probe.patched).toHaveLength(1);
  });

  it('patches accumulate off-screen and are applied on the frame it comes in view', () => {
    const h = createHarness([makeFeature('l1', 'LineString')]);
    h.draw();

    h.probe.reset();
    moveVertices(h, 'l1', [[1, [1.5, 1.5]]]);
    // Neither drawing nor applying happens with a viewport the chunk does not touch
    h.draw({ minX: 100, minY: 40, maxX: 110, maxY: 50 });
    expect(h.probe.patched).toHaveLength(0);

    h.draw({ minX: -1, minY: -1, maxX: 2, maxY: 2 });
    expect(h.probe.patched).toHaveLength(1);
    expect(h.probe.patched[0].updates).toEqual([{ coordIndex: 1, lngLat: [1.5, 1.5] }]);
  });

  it('the queued patches are dropped for a chunk that is going to be rebuilt', () => {
    const h = createHarness([makeFeature('l1', 'LineString'), makeFeature('l2', 'LineString')]);
    h.draw();

    h.probe.reset();
    moveVertices(h, 'l1', [[0, [3, 3]]]);
    // Another feature of the same chunk gets a change that cannot be a diff (a vertex added)
    const other = h.stub.features[1];
    const previous = { ...other };
    other.geometry = geometryFromCoordinates(other.type, [
      ...(coordinatesOf(other) as Coordinate[]),
      [4, 4],
    ]);
    h.cache.applyChanges({
      features: { updated: [{ id: 'l2', feature: other, previous }] },
    });
    h.draw();

    // The rebuild produces the truth, so the patch is not applied
    expect(h.probe.built).toHaveLength(1);
    expect(h.probe.patched).toHaveLength(0);
  });
});

// === Companion drawing (feature companion) ===

describe('companion drawing (feature companion)', () => {
  /** Registers a provider that gives the features with the given ids a companion */
  function registerCompanion(ownerIds: string[], onDraw?: (id: string) => void): () => void {
    return companions.register({
      id: 'p1',
      has: (feature) => ownerIds.includes(feature.id),
      draw: (feature) => onDraw?.(feature.id),
      hitTest: () => null,
      onCompanionClick: () => {},
    });
  }

  afterEach(() => {
    companions = createFeatureCompanionRegistry();
  });

  it('a feature with a companion is split out into an immediate chunk (not retained)', () => {
    registerCompanion(['l2']);
    const h = createHarness(
      [
        makeFeature('l1', 'LineString'),
        makeFeature('l2', 'LineString'),
        makeFeature('l3', 'LineString'),
      ],
      {},
    );

    h.draw();

    // Only l2 goes to immediate drawing; the lines before and after stay on the retained batch
    expect(h.probe.built.map((b) => b.ids)).toEqual([['l1'], ['l3']]);
    expect(h.paintLog).toEqual(['l2']);
  });

  it('the draw of a companion is called even when drawing through the retained cache', () => {
    // A regression test for a regression seen in the field. In retained mode a feature goes onto
    // a chunk of a retained batch, so if the classification (classifyFeature) overlooks the
    // companion it is not split out into an immediate chunk and draw is never called, that is,
    // the line is not drawn at all.
    const drawn: string[] = [];
    registerCompanion(['l1'], (id) => drawn.push(id));
    const h = createHarness([makeFeature('l1', 'LineString'), makeFeature('l2', 'LineString')], {});

    h.draw();
    expect(drawn).toEqual(['l1']);

    // It keeps being called on the second frame too (with the chunk cache in effect)
    h.draw();
    expect(drawn).toEqual(['l1', 'l1']);
  });

  it('a provider of another instance registry is not called (no phantom drawing)', () => {
    // There is one registry per draw instance. A provider closes over its own Store, so sharing
    // one would let the hidden renderers of print, thumbnails and previews cut in with
    // the geometry of their own Store.
    const mine: string[] = [];
    const theirs: string[] = [];
    registerCompanion(['l1'], (id) => mine.push(id));

    // The registry of another instance (with the same feature ids = the same document open)
    const other = createFeatureCompanionRegistry();
    other.register({
      id: 'p1',
      has: () => true,
      draw: (feature) => theirs.push(feature.id),
      hitTest: () => null,
      onCompanionClick: () => {},
    });

    const h = createHarness([makeFeature('l1', 'LineString')], {});
    h.draw();

    expect(mine).toEqual(['l1']);
    expect(theirs).toEqual([]);
  });

  it('the batch is flushed right before the feature itself and then drawn (one z below)', () => {
    const order: string[] = [];
    registerCompanion(['l1'], (id) => order.push(`companion:${id}`));
    const h = createHarness([makeFeature('l1', 'LineString')], {});
    h.deps.batchManager = {
      beginFrame: (): void => {
        order.push('begin');
      },
      processFeature: (feature: Feature): boolean => {
        order.push(`feature:${feature.id}`);
        return false;
      },
      endFrame: (): void => {
        order.push('end');
      },
    };

    h.draw();

    // begin(immediate chunk) → end(flush) → companion → begin(reopen) → body → end
    expect(order).toEqual(['begin', 'end', 'companion:l1', 'begin', 'feature:l1', 'end']);
  });

  it('the blend state is re-established right after a companion is drawn', () => {
    const order: string[] = [];
    registerCompanion(['l1'], () => order.push('companion'));
    const h = createHarness([makeFeature('l1', 'LineString')], {});
    h.deps.restoreBlendState = (): void => {
      order.push('restore');
    };

    h.draw();

    expect(order).toEqual(['companion', 'restore']);
  });

  it('the classification of a chunk is redone when the registration changes', () => {
    const h = createHarness([makeFeature('l1', 'LineString')], {});

    // Before the registration it is a retained batch
    h.draw();
    expect(h.probe.built.map((b) => b.ids)).toEqual([['l1']]);
    expect(h.paintLog).toEqual([]);

    h.probe.reset();
    const unregister = registerCompanion(['l1']);
    h.draw();

    expect(h.probe.built).toEqual([]);
    expect(h.paintLog).toEqual(['l1']);

    // Unregistering brings the retained batch back
    h.probe.reset();
    unregister();
    h.draw();

    expect(h.probe.built.map((b) => b.ids)).toEqual([['l1']]);
  });

  it('with no provider registered it behaves as before (the frame is untouched)', () => {
    const order: string[] = [];
    const h = createHarness([makeFeature('img', 'Image')], {});
    h.deps.restoreBlendState = (): void => {
      order.push('restore');
    };

    h.draw();

    expect(order).toEqual([]);
  });
});
