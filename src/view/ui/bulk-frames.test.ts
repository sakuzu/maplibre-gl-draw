// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The selection UI of a selection of many features, drawn from the rows
 *
 * A few features selected (as many as the layer keeps features of) get their frames and handles
 * one by one, as before. More get the frames of their rows in one draw per row group that holds a
 * row selected, the frames of the features drawn one at a time from those features, and the frame
 * of all of them with its handles as for several features. The frame of a row is the frame of its
 * feature (the margin on the map plane, the extent of the marker of a point), and the frame of all
 * of them spans every feature selected, the locked ones too. What the frames hold on the GPU is in
 * the ledger, and goes when the selection goes, when the GPU side goes and when the instance is
 * destroyed.
 */

import type { Map as MapLibreMap } from 'maplibre-gl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDrawOnEngine } from '../../api/impl/create-draw.js';
import { createEngine } from '../../api/impl/engine.js';
import { checkDrawOptions, toEngineOptions } from '../../api/impl/options.js';
import { DEFAULT_SELECTION_CONFIG } from '../../shared/config/selection.js';
import { applyMarginToBoundingBox, createCoordinateTransform } from '../../shared/math/index.js';
import { createStore } from '../../store/built-in/create-store.js';
import { FEATURES_KEPT } from '../../store/document-access.js';
import type { Feature } from '../../store/types.js';
import {
  createCountedInstance,
  createCountingGL,
  createDrawingMapStub,
  gridPoints,
} from '../../test-utils.js';
import type { DrawnRowGroup } from '../layer/table-retained.js';
import {
  type BulkFrameRows,
  BulkFramesRenderer,
  buildBulkFramesVertexSource,
  buildFrameInstances,
  rowFrameCorners,
} from './bulk-frames.js';
import { SelectionHandlesRenderer } from './handles.js';
import { computeBoundingBox, computeCombinedBoundingBox } from './selection-ui/bounding-box.js';
import { SelectionUIRenderer } from './selection-ui/renderer.js';

type Instance = ReturnType<typeof createCountedInstance>;

const instances: Instance[] = [];

afterEach(() => {
  for (const instance of instances.splice(0)) {
    if (!instance.engine.isDestroyed()) instance.draw.destroy();
  }
  vi.restoreAllMocks();
});

function instanceOf(): Instance {
  const instance = createCountedInstance();
  instances.push(instance);
  return instance;
}

/** Draws frames until the drawing has no work left */
function settle(instance: Pick<Instance, 'map' | 'draw'>): void {
  for (let frame = 0; frame < 30; frame++) {
    instance.map.render();
    if (!instance.draw.hasPendingWork()) return;
  }
  throw new Error('the drawing still has work after 30 frames');
}

/** `count` features of the grid: a point, a line and an area in turn */
function shapes(count: number) {
  const step = 2 / Math.ceil(Math.sqrt(count)) / 3;
  return gridPoints(count).map(({ geometry }, i) => {
    const [x, y] = geometry.coordinates;
    if (i % 3 === 0) return { type: 'Point', geometry };
    if (i % 3 === 1) {
      return {
        type: 'LineString',
        geometry: {
          type: 'LineString',
          coordinates: [
            [x, y],
            [x + step, y + step],
          ],
        },
      };
    }
    return {
      type: 'Polygon',
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [x, y],
            [x + step, y],
            [x, y + step],
            [x, y],
          ],
        ],
      },
    };
  });
}

/** The IDs of the features made */
function idsOf(made: unknown): string[] {
  return (made as Array<{ id: string }>).map((feature) => feature.id);
}

/** What the renderers of the selection UI are called with while frames are drawn */
function watchSelectionUI() {
  const groups = vi.spyOn(BulkFramesRenderer.prototype, 'drawGroups');
  const few = vi.spyOn(SelectionUIRenderer.prototype, 'draw');
  const many = vi.spyOn(SelectionUIRenderer.prototype, 'drawMany');
  const resize = vi.spyOn(SelectionHandlesRenderer.prototype, 'drawResizeHandles');
  const rotate = vi.spyOn(SelectionHandlesRenderer.prototype, 'drawRotateHandle');
  const bulk = new Set<BulkFramesRenderer>();
  return {
    /** The renderers of the frames of the rows seen so far */
    get bulk(): ReadonlySet<BulkFramesRenderer> {
      for (const context of groups.mock.contexts) bulk.add(context as BulkFramesRenderer);
      return bulk;
    },
    groups,
    few,
    many,
    resize,
    rotate,
    clear(): void {
      for (const context of groups.mock.contexts) bulk.add(context as BulkFramesRenderer);
      for (const spy of [groups, few, many, resize, rotate]) spy.mockClear();
    },
  };
}

/** The draws the frames of the rows made, of every renderer seen */
function bulkDraws(seen: ReadonlySet<BulkFramesRenderer>): number {
  let draws = 0;
  for (const renderer of seen) draws += renderer.draws;
  return draws;
}

/** The row groups drawn of a layer, read from the drawing of the rows */
function drawnGroupsOf(instance: Instance, layerId?: string): DrawnRowGroup[] {
  const renderer = instance.engine.customLayer.getTableRenderer();
  if (!renderer) throw new Error('the instance draws no rows');
  const out: DrawnRowGroup[] = [];
  renderer.forEachDrawnGroup((group) => {
    if (layerId === undefined || group.layerId === layerId) out.push(group);
  });
  return out;
}

describe('a few features selected', () => {
  it('get their frames and handles one by one, as before', () => {
    const instance = instanceOf();
    const ids = idsOf(instance.draw.features.createMany(shapes(30) as never));
    settle(instance);
    const ui = watchSelectionUI();
    instance.draw.selection.set('feature', ids.slice(0, 3));
    instance.map.render();
    expect(ui.few).toHaveBeenCalledTimes(1);
    expect((ui.few.mock.calls[0][0] as Feature[]).map((f) => f.id)).toEqual(ids.slice(0, 3));
    expect(ui.many).not.toHaveBeenCalled();
    expect(bulkDraws(ui.bulk)).toBe(0);
    expect(ui.resize).toHaveBeenCalledTimes(1);
  });

  it(`are as many as ${FEATURES_KEPT.toLocaleString('en')} at most`, () => {
    const instance = instanceOf();
    const ids = idsOf(instance.draw.features.createMany(gridPoints(FEATURES_KEPT + 1) as never));
    settle(instance);
    const ui = watchSelectionUI();
    instance.draw.selection.set('feature', ids.slice(0, FEATURES_KEPT));
    instance.map.render();
    expect(ui.few).toHaveBeenCalledTimes(1);
    expect(ui.many).not.toHaveBeenCalled();
    ui.clear();
    instance.draw.selection.set('feature', ids);
    instance.map.render();
    expect(ui.few).not.toHaveBeenCalled();
    expect(ui.many).toHaveBeenCalledTimes(1);
  });
});

describe('many features selected', () => {
  it('get the frames of their rows in one draw per row group that holds a row selected', () => {
    const instance = instanceOf();
    const a = idsOf(instance.draw.features.createMany(shapes(5_000) as never));
    const layerA = instance.draw.features.get(a[0])?.layerId as string;
    const layerB = instance.draw.layers.create({ name: 'b' })?.id as string;
    instance.draw.features.createMany(
      shapes(3_000).map((each) => ({ ...each, layerId: layerB })) as never,
    );
    settle(instance);
    const ui = watchSelectionUI();
    instance.draw.selection.set('feature', { layerIds: [layerA] });
    instance.map.render();
    const groupsA = drawnGroupsOf(instance, layerA).filter((g) => g.group.data.length > 0);
    expect(groupsA.length).toBeGreaterThan(1);
    expect(bulkDraws(ui.bulk)).toBe(groupsA.length);
    // The next frame draws them again, one draw per group, and nothing of the other layer
    const before = bulkDraws(ui.bulk);
    instance.map.render();
    expect(bulkDraws(ui.bulk) - before).toBe(groupsA.length);
    const calls = ui.groups.mock.calls;
    const selected = calls[calls.length - 1][3] as ReadonlySet<unknown>;
    for (const group of drawnGroupsOf(instance, layerB)) {
      expect(selected.has(group.group)).toBe(false);
    }
  });

  it('get the frames of the rows of a layer selected as a layer', () => {
    const instance = instanceOf();
    const ids = idsOf(instance.draw.features.createMany(shapes(2_000) as never));
    const layerId = instance.draw.features.get(ids[0])?.layerId as string;
    settle(instance);
    const ui = watchSelectionUI();
    instance.draw.selection.set('layer', [layerId]);
    instance.map.render();
    expect(ui.few).not.toHaveBeenCalled();
    expect(bulkDraws(ui.bulk)).toBe(drawnGroupsOf(instance, layerId).length);
  });

  it('instance only the rows the drawing of the rows draws, each from the origin of its group', () => {
    const instance = instanceOf();
    instance.draw.extensions.featureTypes.add({
      type: 'pin',
      geometry: 'Point',
      renderer: { onAdd() {}, draw() {}, onRemove() {} },
    } as never);
    const ids = idsOf(
      instance.draw.features.createMany([
        ...shapes(1_500),
        { type: 'pin', geometry: { type: 'Point', coordinates: [0.5, 0.5] } },
      ] as never),
    );
    settle(instance);
    const ui = watchSelectionUI();
    instance.draw.selection.set('feature', ids);
    instance.map.render();
    const rows = ui.groups.mock.calls[0][1] as BulkFrameRows;
    const [entry] = drawnGroupsOf(instance);
    const built = buildFrameInstances(entry.group, rows, (row) => entry.drawnAtOnce(row));
    // Every point, line and area, and not the feature of the custom type
    expect(built.count).toBe(1_500);
    // The first row framed is at the origin
    expect(Array.from(built.data.subarray(0, 2))).toEqual([0, 0]);
    const reader = rows.reader;
    for (let i = 0; i < built.count; i++) {
      const row = built.data[i * 8 + 4];
      expect(reader.typeOf(entry.group, row)).not.toBe('pin');
    }
  });

  it('frame a row as the frame of its feature: the margin on the map plane', () => {
    const transform = createCoordinateTransform({
      project: () => ({ x: 0, y: 0 }),
      unproject: () => ({ lng: 0, lat: 0 }),
    } as unknown as MapLibreMap);
    const features: Feature[] = [
      polygonAt([139.7, 35.6], 0.01),
      polygonAt([-70, -50], 0.3),
      polygonAt([10, 0], 0.001),
      {
        ...polygonAt([20, 60], 0.01),
        type: 'LineString',
        geometry: {
          type: 'LineString',
          coordinates: [
            [20, 60],
            [20.02, 60],
          ],
        },
      },
      {
        ...polygonAt([5, 45], 0),
        type: 'Circle',
        geometry: { type: 'Point', coordinates: [5, 45] },
        properties: { 'maplibre-gl-draw:radiusMeters': 250 },
      },
    ];
    for (const zoom of [3, 10.5, 17]) {
      for (const feature of features) {
        const bbox = computeBoundingBox(feature);
        if (!bbox) throw new Error('no box');
        const margin = DEFAULT_SELECTION_CONFIG.boundingBox.margin;
        const expected = applyMarginToBoundingBox(bbox, margin, transform, zoom);
        const corners = rowFrameCorners(
          [bbox.topLeft[0], bbox.bottomRight[1], bbox.bottomRight[0], bbox.topLeft[1]],
          margin,
          zoom,
        );
        const want = [
          expected.topLeft,
          expected.topRight,
          expected.bottomRight,
          expected.bottomLeft,
        ];
        for (let i = 0; i < 4; i++) {
          expect(corners[i][0]).toBeCloseTo(want[i][0], 9);
          expect(corners[i][1]).toBeCloseTo(want[i][1], 9);
        }
      }
    }
  });

  it('frame a point by the extent of its marker, as the frame of its feature', () => {
    const instance = instanceOf();
    const ids = idsOf(
      instance.draw.features.createMany(
        gridPoints(1_200).map((each, i) => ({
          ...each,
          style: { pointRadius: 4 + (i % 5) * 3 },
        })) as never,
      ),
    );
    settle(instance);
    const ui = watchSelectionUI();
    instance.draw.selection.set('feature', ids);
    instance.map.render();
    const rows = ui.groups.mock.calls[0][1] as BulkFrameRows;
    const [entry] = drawnGroupsOf(instance);
    const built = buildFrameInstances(entry.group, rows, () => false);
    const extensions = instance.engine.context.selectionScope.extensions;
    const sizes = new Set<number>();
    for (let i = 0; i < built.count; i++) {
      const row = built.data[i * 8 + 4];
      const id = rows.reader.idOf(rows.reader.refOf(entry.group, row)) as string;
      const extent = extensions.resolvePointFrameExtent(
        instance.draw.features.get(id) as unknown as Feature,
      );
      expect(built.data[i * 8 + 5]).toBe(Math.fround(extent.halfWidth));
      expect(built.data[i * 8 + 6]).toBe(Math.fround(extent.halfHeight));
      expect(built.data[i * 8 + 7]).toBe(1);
      sizes.add(extent.halfWidth);
    }
    // The markers of five sizes give frames of five sizes
    expect(sizes.size).toBe(5);
  });

  it('frame every feature selected and draw the handles over all of them', () => {
    const instance = instanceOf();
    const ids = idsOf(instance.draw.features.createMany(shapes(2_000) as never));
    settle(instance);
    const ui = watchSelectionUI();
    instance.draw.selection.set('feature', ids);
    instance.map.render();
    expect(ui.many).toHaveBeenCalledTimes(1);
    const bbox = ui.many.mock.calls[0][1];
    const all = ids.map((id) => instance.draw.features.get(id) as unknown as Feature);
    expect(bbox).toEqual(computeCombinedBoundingBox(all));
    expect(ui.resize).toHaveBeenCalledTimes(1);
    expect(ui.rotate).toHaveBeenCalledTimes(1);
    expect(ui.resize.mock.calls[0][0]).toEqual(bbox);
  });

  it('span the locked features too, and draw no handle when one is locked', () => {
    const instance = instanceOf();
    const ids = idsOf(instance.draw.features.createMany(shapes(2_000) as never));
    const far = idsOf(
      instance.draw.features.createMany([
        { type: 'Point', geometry: { type: 'Point', coordinates: [5, 5] } },
      ] as never),
    );
    instance.draw.features.update(far[0], { locked: true });
    settle(instance);
    const ui = watchSelectionUI();
    instance.draw.selection.set('feature', [...ids, ...far]);
    instance.map.render();
    const bbox = ui.many.mock.calls[0][1];
    expect(bbox?.topRight).toEqual([5, 5]);
    expect(ui.resize).not.toHaveBeenCalled();
    expect(ui.rotate).not.toHaveBeenCalled();
  });

  it('draw no handle when every feature selected is a point', () => {
    const instance = instanceOf();
    const ids = idsOf(instance.draw.features.createMany(gridPoints(2_000) as never));
    settle(instance);
    const ui = watchSelectionUI();
    instance.draw.selection.set('feature', ids);
    instance.map.render();
    expect(ui.many).toHaveBeenCalledTimes(1);
    expect(ui.resize).not.toHaveBeenCalled();
  });

  it('frame the features drawn one at a time from their features', () => {
    const instance = instanceOf();
    instance.draw.extensions.featureTypes.add({
      type: 'pin',
      geometry: 'Point',
      renderer: { onAdd() {}, draw() {}, onRemove() {} },
    } as never);
    const ids = idsOf(
      instance.draw.features.createMany([
        ...gridPoints(1_500),
        { type: 'pin', geometry: { type: 'Point', coordinates: [0.25, 0.25] } },
      ] as never),
    );
    settle(instance);
    const ui = watchSelectionUI();
    instance.draw.selection.set('feature', ids);
    instance.map.render();
    const framed = ui.many.mock.calls[0][0] as readonly Feature[];
    expect(framed.map((f) => f.type)).toEqual(['pin']);
  });

  it('read the rows selected once, not in a frame that changes nothing', () => {
    const instance = instanceOf();
    const ids = idsOf(instance.draw.features.createMany(shapes(2_000) as never));
    settle(instance);
    const ui = watchSelectionUI();
    instance.draw.selection.set('feature', ids);
    instance.map.render();
    const [renderer] = ui.bulk;
    const readings = renderer.selection.readings;
    instance.map.render();
    instance.map.render();
    expect(renderer.selection.readings).toBe(readings);
    instance.draw.features.update(ids[1], { locked: true });
    instance.map.render();
    expect(renderer.selection.readings).toBe(readings + 1);
  });
});

describe('the frames of the rows on the GPU', () => {
  it('read the mark of a row selected and draw nothing for a row without it', () => {
    const source = buildBulkFramesVertexSource('', '');
    expect(source).toContain('rowStateSelected(state)');
    expect(source).toContain('if (rowStateHidden(state) || !rowStateSelected(state))');
  });

  it('go when the selection goes', () => {
    const instance = instanceOf();
    const ids = idsOf(instance.draw.features.createMany(shapes(2_000) as never));
    settle(instance);
    const ledger = instance.engine.customLayer.getGpuLedger();
    const held = ledger.snapshot();
    const ui = watchSelectionUI();
    instance.draw.selection.set('feature', ids);
    instance.map.render();
    const [renderer] = ui.bulk;
    expect(renderer.heldObjects).toBeGreaterThan(0);
    expect(ledger.snapshot().objects).toBeGreaterThan(held.objects);
    ui.clear();
    instance.draw.selection.clear();
    instance.map.render();
    expect(bulkDraws(ui.bulk)).toBeGreaterThan(0);
    expect(ui.groups).not.toHaveBeenCalled();
    expect(ui.many).not.toHaveBeenCalled();
    expect(renderer.heldObjects).toBe(0);
    expect(ledger.snapshot().objects).toBe(held.objects);
    // The buffers of the frames drawn on the CPU keep their size; those of the rows went
    expect(ledger.snapshot().byPart.rows).toBe(held.byPart.rows);
  });

  it('go with the GPU side, and with the instance, nothing left behind', () => {
    for (const end of ['gpu', 'destroy'] as const) {
      const instance = instanceOf();
      const ids = idsOf(instance.draw.features.createMany(shapes(2_000) as never));
      settle(instance);
      const ui = watchSelectionUI();
      instance.draw.selection.set('feature', ids);
      instance.map.render();
      const [renderer] = ui.bulk;
      expect(renderer.heldObjects).toBeGreaterThan(0);
      const ledger = instance.engine.customLayer.getGpuLedger();
      if (end === 'gpu') instance.engine.customLayer.destroyGpu();
      else instance.draw.destroy();
      expect(renderer.heldObjects).toBe(0);
      expect(ledger.snapshot().leakedObjects).toBe(0);
      expect(ledger.snapshot().objects).toBe(0);
      vi.restoreAllMocks();
    }
  });
});

describe('what the frames of the rows hold on the GPU', () => {
  /** An instance on a GL that keeps the objects it makes and the bytes given to them */
  function trackedInstance() {
    const counting = createCountingGL();
    const live = new Map<object, string>();
    const bytes = new Map<object, number>();
    let bound: object | null = null;
    const gl = new Proxy(counting.gl, {
      get(target, prop) {
        const value = Reflect.get(target, prop);
        if (typeof prop !== 'string' || typeof value !== 'function') return value;
        return (...args: unknown[]) => {
          const result = (value as (...a: unknown[]) => unknown)(...args);
          if (prop.startsWith('create') && result && typeof result === 'object') {
            live.set(result, prop.slice('create'.length));
          } else if (prop.startsWith('delete') && args[0]) {
            live.delete(args[0] as object);
            bytes.delete(args[0] as object);
          } else if (prop === 'bindBuffer') {
            bound = (args[1] as object | null) ?? null;
          } else if (prop === 'bufferData' && bound) {
            const data = args[1] as { byteLength?: number } | number;
            bytes.set(bound, typeof data === 'number' ? data : (data.byteLength ?? 0));
          }
          return result;
        };
      },
    }) as WebGL2RenderingContext;
    const map = createDrawingMapStub(gl);
    const store = createStore();
    checkDrawOptions({ store });
    const engine = createEngine(
      map.map as MapLibreMap,
      toEngineOptions({ store }, () => false),
      {
        deferDefaultMode: true,
      },
    );
    const draw = createDrawOnEngine(engine, { store });
    engine.enterDefaultMode();
    return { gl, live, bytes, map, draw, engine };
  }

  it('is recorded in the ledger of the instance, as a part of the rows, bytes and all', () => {
    const tracked = trackedInstance();
    try {
      const ids = idsOf(tracked.draw.features.createMany(shapes(5_000) as never));
      settle(tracked);
      const before = new Set(tracked.live.keys());
      tracked.draw.selection.set('feature', ids);
      tracked.map.render();
      const ledger = tracked.engine.customLayer.getGpuLedger();
      const made = [...tracked.live.keys()].filter((object) => !before.has(object));
      expect(made.length).toBeGreaterThan(0);
      for (const object of made) {
        expect(ledger.holds(object)).toBe(true);
        expect(ledger.partOf(object)).toBe('rows');
      }
      const madeBytes = made.reduce((sum, object) => sum + (tracked.bytes.get(object) ?? 0), 0);
      expect(madeBytes).toBeGreaterThan(0);
      expect(ledger.audit()).toBe(true);
    } finally {
      tracked.draw.destroy();
    }
  });

  it('is not refused at the limit, and what is held outside the rows stays under it', () => {
    const tracked = trackedInstance();
    try {
      const ledger = tracked.engine.customLayer.getGpuLedger();
      ledger.limitBytes = ledger.floorBytes;
      const ids = idsOf(tracked.draw.features.createMany(shapes(5_000) as never));
      settle(tracked);
      const draws = vi.spyOn(BulkFramesRenderer.prototype, 'drawGroups');
      // After every allocation, what is held outside the rows is under the limit
      const record = ledger.record.bind(ledger);
      let over = 0;
      vi.spyOn(ledger, 'record').mockImplementation((...args) => {
        record(...args);
        if (ledger.outsideRowBytes > ledger.limitBytes) over++;
      });
      tracked.draw.selection.set('feature', ids);
      tracked.map.render();
      tracked.map.render();
      expect(draws.mock.results.some((result) => (result.value as number) > 0)).toBe(true);
      expect(over).toBe(0);
      expect(ledger.audit()).toBe(true);
    } finally {
      tracked.draw.destroy();
    }
  });
});

/** A square area of a side, its south west corner at a place */
function polygonAt(at: [number, number], side: number): Feature {
  const [x, y] = at;
  return {
    id: `area-${x}-${y}`,
    type: 'Polygon',
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [x, y],
          [x + side, y],
          [x + side, y + side],
          [x, y + side],
          [x, y],
        ],
      ],
    },
    layerId: 'layer',
    groupId: undefined,
    properties: {},
    style: {},
    visible: true,
    locked: false,
  };
}
