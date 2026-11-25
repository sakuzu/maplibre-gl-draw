// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The rows in view of a frame that draws the layers from their rows
 *
 * The box of a row compared with a range answers as the spatial index of the Store does (on
 * documents and ranges made at random, the ranges of a view across the antimeridian among them),
 * also after the writes that change a box. A frame never reads the set of the ids of the features
 * in view, whatever is drawn one at a time and whatever is selected, and the ids and the objects it
 * makes do not grow with the points. Across the antimeridian, the features selected are parted
 * between the copies, and framed on each, as they were by those ids.
 */

import type { Map as MapLibreMap } from 'maplibre-gl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDrawOnEngine } from '../../api/impl/create-draw.js';
import { createEngine } from '../../api/impl/engine.js';
import { checkDrawOptions, toEngineOptions } from '../../api/impl/options.js';
import { createStore } from '../../store/built-in/create-store.js';
import { type DrawnRows, drawnRowsOf } from '../../store/built-in/drawn-rows.js';
import { StoreSpatialIndex } from '../../store/spatial/store-spatial-index.js';
import type { BoundingBox, Feature } from '../../store/types.js';
import {
  countsOf,
  type createCountedInstance,
  createCountingGL,
  createCountingStore,
  createDrawingMapStub,
  expectNotProportional,
  gridPoints,
  workDuring,
} from '../../test-utils.js';
import { getTerrainDrapeDebug } from '../terrain/state.js';
import {
  type BoundingBoxCoords,
  computeBoundingBox,
  computeCombinedBoundingBox,
  hasZeroArea,
} from '../ui/selection-ui/index.js';
import { SelectionUIRenderer } from '../ui/selection-ui/renderer.js';
import { featureInRanges, getViewportCopies, ViewportFilter } from '../viewport.js';

type Instance = Pick<
  ReturnType<typeof createCountedInstance>,
  'draw' | 'engine' | 'map' | 'counts' | 'storeWork'
>;

const instances: Instance[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const instance of instances.splice(0)) instance.draw.destroy();
});

/** An instance on the counting GL, whose allocations succeed (the drape checks them) */
function instanceOf(): Instance {
  const counting = createCountingGL();
  const gl = new Proxy(counting.gl as object, {
    get(target, prop) {
      if (prop === 'getError') return () => Reflect.get(target, 'NO_ERROR');
      return Reflect.get(target, prop);
    },
  }) as WebGL2RenderingContext;
  const map = createDrawingMapStub(gl);
  const store = createStore();
  const counted = createCountingStore(store);
  const drawOptions = { store: counted.store };
  checkDrawOptions(drawOptions);
  const engine = createEngine(
    map.map as MapLibreMap,
    toEngineOptions(drawOptions, () => false),
    { deferDefaultMode: true },
  );
  const draw = createDrawOnEngine(engine, drawOptions);
  engine.enterDefaultMode();
  const instance = { draw, engine, map, counts: countsOf(store), storeWork: counted.work };
  instances.push(instance);
  return instance;
}

/** Draws frames until the drawing has no work left */
function settle(instance: Instance): void {
  for (let frame = 0; frame < 60; frame++) {
    instance.map.render();
    if (!instance.draw.hasPendingWork()) return;
  }
  throw new Error('the drawing still has work after 60 frames');
}

/** The IDs of the features made */
function idsOf(made: unknown): string[] {
  return (made as Array<{ id: string }>).map((feature) => feature.id);
}

/** Numbers from 0 to 1, the same for a seed */
function randomOf(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The reader of the rows of an instance */
function rowsOf(instance: Instance): DrawnRows {
  const rows = drawnRowsOf(instance.engine.context.store.getTables());
  if (!rows) throw new Error('the instance draws no rows');
  return rows;
}

/** The half extents of the features of the type `Sign`, as their feature type works them out */
const SIGN = { half: 0.5 };

/** A type that gives its box: that of its position and `SIGN.half`, and none when it is `bare` */
function addSigns(instance: Instance): void {
  instance.draw.extensions.featureTypes.add({
    type: 'Sign',
    geometry: 'Point',
    bbox(feature: { geometry: unknown; properties: Record<string, unknown> }) {
      const [x, y] = (feature.geometry as { coordinates: [number, number] }).coordinates;
      if (feature.properties.bare === true) return [Number.NaN, Number.NaN, Number.NaN, Number.NaN];
      return [x - SIGN.half, y - SIGN.half, x + SIGN.half, y + SIGN.half];
    },
    renderer: { onAdd() {}, draw() {}, onRemove() {} },
  } as never);
}

/** A feature made at random, at a longitude and a latitude */
function shapeOf(random: () => number, layerId: string, at: [number, number], type: string) {
  const to: [number, number] = [at[0] + random() / 2, at[1] + random() / 2];
  switch (type) {
    case 'LineString':
      return { type, layerId, geometry: { type: 'LineString', coordinates: [at, to] } };
    case 'Dashed':
      return {
        type: 'LineString',
        layerId,
        style: { lineStyle: 'dashed' },
        geometry: { type: 'LineString', coordinates: [at, to] },
      };
    case 'Polygon':
      return {
        type,
        layerId,
        geometry: { type: 'Polygon', coordinates: [[at, [to[0], at[1]], to, at]] },
      };
    case 'Circle':
      return {
        type,
        layerId,
        geometry: { type: 'Point', coordinates: at },
        properties: { 'maplibre-gl-draw:radiusMeters': random() * 50_000 },
      };
    case 'Image':
      return {
        type,
        layerId,
        geometry: { type: 'Point', coordinates: at },
        properties: {
          'maplibre-gl-draw:imageWidth': 100 + random() * 400,
          'maplibre-gl-draw:imageHeight': 100 + random() * 400,
          'maplibre-gl-draw:createdZoom': 8,
          'maplibre-gl-draw:rotation': random() * 360,
        },
      };
    case 'Sign':
      return {
        type,
        layerId,
        geometry: { type: 'Point', coordinates: at },
        properties: random() < 0.2 ? { bare: true } : {},
      };
    default:
      return { type: 'Point', layerId, geometry: { type: 'Point', coordinates: at } };
  }
}

const TYPES = ['Point', 'LineString', 'Dashed', 'Polygon', 'Circle', 'Image', 'Sign'];

describe('the box of a row compared with a range', () => {
  for (const seed of [1, 2, 3]) {
    it(`answers as the index does (document ${seed})`, () => {
      const random = randomOf(seed);
      const instance = instanceOf();
      const { draw, engine } = instance;
      const { store, spatialIndex } = engine.context;
      addSigns(instance);
      const layers = [0, 1].map((i) => draw.layers.create({ name: `l${i}` })?.id as string);
      const place = (): [number, number] => [random() * 360 - 180, random() * 160 - 80];
      const ids = layers.flatMap((layerId) =>
        idsOf(
          draw.features.createMany(
            Array.from({ length: 400 }, () =>
              shapeOf(random, layerId, place(), TYPES[Math.floor(random() * TYPES.length)]),
            ) as never,
          ),
        ),
      );
      draw.features.update(ids[3], { visible: false });
      draw.features.delete(ids[4]);
      // Before a frame is drawn
      const rows = rowsOf(instance);
      const scratch = new Float64Array(4);
      const pointIds = ids.filter((id) => draw.features.get(id)?.type === 'Point');

      const expectSame = (): void => {
        const ranges: BoundingBox[][] = [];
        for (let i = 0; i < 60; i++) {
          const [x, y] = place();
          const w = random() ** 3 * 200;
          const h = random() ** 3 * 100;
          ranges.push([{ minX: x, minY: y, maxX: x + w, maxY: y + h }]);
        }
        // A range whose edge a point touches, and a range that is a point
        for (let i = 0; i < 20; i++) {
          const id = pointIds[Math.floor(random() * pointIds.length)];
          const at = positionOf(instance, id);
          ranges.push(
            [{ minX: at[0], minY: at[1], maxX: at[0] + 30, maxY: at[1] + 30 }],
            [{ minX: at[0] - 30, minY: at[1] - 30, maxX: at[0], maxY: at[1] }],
            [{ minX: at[0], minY: at[1], maxX: at[0], maxY: at[1] }],
          );
        }
        // The edges of the boxes of circles, images and signs, and just past them
        for (const id of ids) {
          if (random() < 0.9) continue;
          const ref = rows.refOfId(id);
          const at = ref === undefined ? undefined : rows.placeOf(ref);
          if (!at || !rows.indexedBox(at.group, at.row, scratch)) continue;
          const [x0, y0, x1, y1] = scratch;
          ranges.push(
            [{ minX: x1, minY: y1, maxX: x1 + 1, maxY: y1 + 1 }],
            [{ minX: x0 - 1, minY: y0 - 1, maxX: x0, maxY: y0 }],
            [{ minX: x1 + 1e-9, minY: y0, maxX: x1 + 1, maxY: y1 }],
          );
        }
        // The views across the antimeridian, as one or two ranges
        for (const center of [180, -180, 179.5, -171]) {
          const map = {
            getBounds: () => boundsOf(center - 8, -20, center + 8, 20),
          } as unknown as Parameters<typeof getViewportCopies>[0];
          const copies = getViewportCopies(map, 2).map((copy) => copy.bounds);
          ranges.push(copies, ...copies.map((bounds) => [bounds]));
        }
        for (const range of ranges) {
          const found = new Set(range.flatMap((bounds) => spatialIndex.findInBounds(bounds)));
          const dbg = ids.filter(
            (id) => featureInRanges(rows, id, range, scratch) !== found.has(id),
          );
          if (dbg.length) {
            console.log(
              JSON.stringify(range),
              dbg.length,
              dbg.slice(0, 4).map((id) => {
                const p = rows.placeOf(rows.refOfId(id)!)!;
                const b = new Float64Array(4);
                rows.indexedBox(p.group, p.row, b);
                return [draw.features.get(id)?.type, ...b, found.has(id)];
              }),
            );
          }
          const met = ids.filter((id) => featureInRanges(rows, id, range, scratch));
          expect(met).toEqual(ids.filter((id) => found.has(id)));
          // The references read of a range are those of the same features
          for (const bounds of range) {
            const read: string[] = [];
            rows.forEachRowInBox(bounds, (ref) => read.push(rows.idOf(ref) as string));
            expect(read.sort()).toEqual([...store.findFeatureIdsInBox(bounds)].sort());
          }
        }
      };

      expectSame();
      // The boxes change with the rows written: in place, by a value, by a place, by a type
      const some = (type: string) =>
        ids.filter((id) => draw.features.get(id)?.type === type && random() < 0.3);
      for (const id of some('Circle')) {
        draw.features.update(id, {
          properties: { 'maplibre-gl-draw:radiusMeters': random() * 400_000 },
        });
      }
      for (const id of some('Image')) {
        draw.features.update(id, { geometry: { type: 'Point', coordinates: place() } });
      }
      for (const id of some('Sign')) draw.features.update(id, { properties: { bare: true } });
      for (const id of some('Point')) {
        draw.features.update(id, { geometry: { type: 'Point', coordinates: place() } });
      }
      draw.features.moveMany(some('Sign'), { layerId: layers[0] } as never);
      settle(instance);
      expectSame();
      // Rows written since the frame
      for (const id of [...some('Circle'), ...some('Image'), ...some('Point')]) {
        draw.features.update(id, { geometry: { type: 'Point', coordinates: place() } });
      }
      expectSame();
      // The extent of a type changes for a reason the Store does not see
      SIGN.half = 3;
      engine.context.spatialIndex.invalidateType('Sign');
      expectSame();
      SIGN.half = 0.5;
      engine.context.spatialIndex.invalidateType('Sign');
      engine.context.spatialIndex.setTileSize(256);
      expectSame();
    });
  }
});

/** The position of a point */
function positionOf(instance: Instance, id: string): [number, number] {
  const feature = instance.draw.features.get(id);
  if (feature?.geometry.type !== 'Point') throw new Error('no point');
  return feature.geometry.coordinates as [number, number];
}

/** The bounds of a map, as maplibre gives them */
function boundsOf(west: number, south: number, east: number, north: number) {
  return {
    getWest: () => west,
    getEast: () => east,
    getSouth: () => south,
    getNorth: () => north,
    getSouthWest: () => ({ lng: west, lat: south }),
    getNorthEast: () => ({ lng: east, lat: north }),
  };
}

/** The terrain of the map stub: four DEM tiles over the area it shows */
function putTerrain(instance: Instance): void {
  const keys = ['7/63/63', '7/64/63', '7/63/64', '7/64/64'];
  Object.assign(instance.map.map as object, {
    terrain: {
      exaggeration: 1,
      meshSize: 32,
      tileManager: {
        getRenderableTiles: () =>
          keys.map((key) => {
            const [z, x, y] = key.split('/').map(Number);
            return { tileID: { canonical: { x, y, z }, key, wrap: 0 } };
          }),
      },
      getTerrainData: (tileID: { key: string }) => ({
        texture: { id: tileID.key },
        u_terrain_matrix: new Float64Array(16).fill(1),
        u_terrain_unpack: [6553.6, 25.6, 0.1, 10000],
        u_terrain_dim: 512,
      }),
    },
    queryTerrainElevation: ([lng, lat]: [number, number]) => 100 + 40 * lng + 25 * lat,
    getZoom: () => 13,
  });
}

/** Whether the drape painted the last frame */
function drapeUsed(instance: Instance): boolean {
  return getTerrainDrapeDebug(instance.engine.customLayer.getTerrainContext()).used;
}

/** Puts the view of an instance across the antimeridian */
function putAcross(instance: Instance): void {
  Object.assign(instance.map.map as object, {
    getCenter: () => ({ lng: 180, lat: 0 }),
    getBounds: () => boundsOf(178, -3, 182, 3),
  });
}

/** Features of every type around a longitude, each side of it */
function mixed(random: () => number, layerId: string, count: number, around = 0) {
  return Array.from({ length: count }, (_, i) => {
    const x = around + random() * 1.6 - 0.8;
    const at: [number, number] = [x > 180 ? x - 360 : x, random() * 1.6 - 0.8];
    return shapeOf(random, layerId, at, TYPES[i % TYPES.length]);
  });
}

/** The reads of the ids in view */
function watchIds() {
  const spies = [
    vi.spyOn(ViewportFilter.prototype, 'getVisibleIds'),
    vi.spyOn(ViewportFilter.prototype, 'getVisibleIdsIn'),
    vi.spyOn(StoreSpatialIndex.prototype, 'findInBounds'),
  ];
  return () => spies.reduce((sum, spy) => sum + spy.mock.calls.length, 0);
}

describe('a frame that draws the layers from their rows', () => {
  const scenes: Array<[string, (instance: Instance) => void, number, number]> = [
    ['a flat map', () => {}, 0, 100],
    ['the terrain', putTerrain, 0, 100],
    ['two copies of the world, a few selected', putAcross, 180, 100],
    ['two copies of the world, many selected', putAcross, 180, 2_000],
  ];
  for (const [name, put, around, selected] of scenes) {
    it(`reads no set of the ids in view (${name})`, () => {
      const instance = instanceOf();
      const { draw } = instance;
      put(instance);
      addSigns(instance);
      const layerId = draw.layers.list()[0].id;
      const ids = idsOf(
        draw.features.createMany(mixed(randomOf(5), layerId, 2_100, around) as never),
      );
      draw.selection.set('feature', ids.slice(0, selected));
      const read = watchIds();
      settle(instance);
      instance.map.render();
      expect(read()).toBe(0);
      expect(drapeUsed(instance)).toBe(put === putTerrain);
      // What is drawn one at a time is drawn
      let drawn = 0;
      instance.engine.customLayer.getTableRenderer()?.forEachDrawnAtOnce(() => drawn++);
      expect(drawn).toBeGreaterThan(100);
    });
  }

  for (const surface of ['flat', 'terrain'] as const) {
    it(`makes as many ids and objects whatever the points are (${surface})`, () => {
      const work = new Map<number, { ids: number; objects: number }>();
      const measure = (size: number) => {
        const known = work.get(size);
        if (known) return known;
        const instance = instanceOf();
        const { draw } = instance;
        if (surface === 'terrain') putTerrain(instance);
        const points = draw.layers.create({ name: 'points' })?.id as string;
        const others = draw.layers.create({ name: 'others' })?.id as string;
        const random = randomOf(9);
        draw.features.createMany(
          mixed(random, others, 5 * 12).filter((f) => f.type !== 'Sign') as never,
        );
        draw.features.createMany(
          gridPoints(size).map((each) => ({ ...each, layerId: points })) as never,
        );
        settle(instance);
        expect(drapeUsed(instance)).toBe(surface === 'terrain');
        const idOf = vi.spyOn(rowsOf(instance), 'idOf');
        const before = instance.storeWork.calls.get('getRowId') ?? 0;
        // Panned: another range of the view in every frame
        const view = { x: 0 };
        Object.assign(instance.map.map as object, {
          getBounds: () => boundsOf(view.x - 1, -1, view.x + 1, 1),
        });
        const { objectsCreated } = workDuring(instance.counts, () => {
          view.x = 0.1;
          instance.map.render();
        });
        const ids =
          idOf.mock.calls.length + (instance.storeWork.calls.get('getRowId') ?? 0) - before;
        const result = { ids, objects: objectsCreated };
        work.set(size, result);
        return result;
      };
      expectNotProportional((size) => measure(size).ids, 'the ids made');
      expectNotProportional((size) => measure(size).objects, 'the objects made', { zero: true });
    });
  }

  it('makes nothing for the rows out of view, nor again for the rows whose box is given', () => {
    const instance = instanceOf();
    const { draw } = instance;
    const layerId = draw.layers.list()[0].id;
    const random = randomOf(3);
    // Images near and far, drawn one at a time
    const images = [0, 60].flatMap((x) =>
      Array.from({ length: 50 }, () => shapeOf(random, layerId, [x + random(), 0], 'Image')),
    );
    const ids = idsOf(draw.features.createMany(images as never));
    settle(instance);
    const drawn = new Set<string>();
    const renderer = instance.engine.customLayer.getTableRenderer();
    renderer?.forEachDrawnAtOnce((feature) => drawn.add(feature.id));
    expect([...drawn].sort()).toEqual(ids.slice(0, 50).sort());
    expect(workDuring(instance.counts, () => instance.map.render()).objectsCreated).toBe(0);
  });
});

describe('the features selected, on the copies of a view across the antimeridian', () => {
  /** The features selected by the ids found in the range of each copy, as they were parted */
  function parted(instance: Instance, features: Feature[]): Feature[][] {
    return getViewportCopies(instance.engine.map, 2).map(({ bounds }) => {
      const ids = new Set(instance.engine.context.spatialIndex.findInBounds(bounds));
      return features.filter((feature) => ids.has(feature.id));
    });
  }

  function documentOf(seed: number, count: number) {
    const instance = instanceOf();
    putAcross(instance);
    addSigns(instance);
    const random = randomOf(seed);
    const { draw } = instance;
    const layerId = draw.layers.list()[0].id;
    const ids = idsOf(draw.features.createMany(mixed(random, layerId, count, 180) as never));
    // Some out of the view of both
    const far = idsOf(draw.features.createMany(mixed(random, layerId, 70, 20) as never));
    const all = [...ids, ...far];
    draw.selection.set('feature', all);
    const features = all.map((id) => draw.features.get(id) as unknown as Feature);
    return { instance, all, features };
  }

  for (const seed of [21, 22]) {
    it(`are the ones found in the range of each, a few selected (document ${seed})`, () => {
      const { instance, features } = documentOf(seed, 350);
      settle(instance);
      const draws = vi.spyOn(SelectionUIRenderer.prototype, 'draw');
      instance.map.render();
      const copies = parted(instance, features);
      expect(copies).toHaveLength(2);
      const drawn = draws.mock.calls.map(([each]) => (each as Feature[]).map((f) => f.id));
      expect(drawn).toEqual(copies.map((each) => each.map((f) => f.id)));
      for (const each of copies) expect(each.length).toBeGreaterThan(0);
    });

    it(`are framed by the ones found in the range of each, many selected (document ${seed})`, () => {
      const { instance, features } = documentOf(seed, 1_750);
      settle(instance);
      const { extensions } = instance.engine.context.selectionScope;
      const draws = vi.spyOn(SelectionUIRenderer.prototype, 'drawMany');
      instance.map.render();
      const copies = parted(instance, features);
      expect(draws).toHaveBeenCalledTimes(2);
      copies.forEach((each, i) => {
        const [framed, bbox] = draws.mock.calls[i] as unknown as [Feature[], BoundingBoxCoords];
        expect(bbox).toEqual(computeCombinedBoundingBox(each, extensions));
        // The features framed from their features: the types drawn one at a time
        const oneByOne = each.filter((f) => f.type === 'Image' || f.type === 'Sign');
        expect(framed.map((f) => f.id).sort()).toEqual(oneByOne.map((f) => f.id).sort());
        expect(
          each.some((f) => {
            const box = computeBoundingBox(f, extensions);
            return box !== null && !hasZeroArea(box);
          }),
        ).toBe(true);
      });
    });
  }
});
