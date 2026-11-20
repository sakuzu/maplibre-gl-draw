// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The moves, rotations and scalings of any number of features (`features.translate`, `rotate`
 * and `scale`):
 *
 * - They follow the rules of every bulk edit: the parts and their number, an ID that names
 *   nothing, a feature deleted or locked meanwhile, read-only and destroy, `draw.transact`, and a
 *   write of a few features that touches a feature first
 * - The built-in computation gives, over a few hundred meters, nearly what the plane of Web
 *   Mercator of the published version gives (the gaps allowed are written in each test), and over
 *   tens of kilometers keeps the distances on the ground, which that plane does not
 * - The computation set is the last one still there, the one set when the edit starts; one that
 *   does not compute the operation, or a wrong input, rejects with `invalidInput` and changes
 *   nothing; it is given the number of the operation in every call
 * - A rotation of a single feature of a Point geometry with a field of rotation turns about its
 *   position; two features, or a point without such a field, turn about the center given
 * - The fields of rotation, direction and size a type declares follow their rules, and a feature
 *   without them starts from 0 and 1; a definition that overrides a built-in type gives its
 *   fields to the features it takes, and without fields leaves those of the built-in type
 * - 100,000 features of every kind are written with the values the computation gives each
 *   feature alone, their heights kept
 * - One call of the computation makes as many objects for 1,000 features as for 10,000, and a
 *   part writes no more rows for 10,000 features than for 1,000
 */

import type { Geometry, Position } from 'geojson';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Draw } from '../api/draw.js';
import { DrawError } from '../api/errors.js';
import type { DocumentChange } from '../api/events.js';
import type { FeatureTypeDefinition } from '../api/extension/feature-type.js';
import type { EditCounts } from '../api/features.js';
import { bulkEditsOf } from '../api/impl/bulk-edits.js';
import { createDrawOnEngine } from '../api/impl/create-draw.js';
import { createDocumentAccess } from '../api/impl/document-access.js';
import { createEngine, type Engine } from '../api/impl/engine.js';
import { toEngineOptions } from '../api/impl/options.js';
import { haversineDistanceMeters } from '../geometry/distance.js';
import { applyBuiltInTransform, createBuiltInTransform } from '../shared/math/enu-transform.js';
import { fromPlane, toPlane } from '../shared/math/mercator-plane.js';
import type {
  TransformInput,
  TransformOperation,
  TransformOutput,
  TransformProvider,
} from '../shared/types/model.js';
import { createStore } from '../store/built-in/create-store.js';
import type { FeatureRowField, GeometryColumn, Store } from '../store/built-in/types.js';
import {
  countsOf,
  createMapStub,
  expectNotProportional,
  expectPartsWithin,
  runInParts,
} from '../test-utils.js';
import { createFieldsResolver, readTransformRun, type TransformDeps } from './bulk-transform.js';

let clock = 0;
let store: Store;
let engine: Engine;
let draw: Draw;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  clock = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  store = createStore();
  engine = createEngine(
    createMapStubLike(),
    toEngineOptions({ store }, () => false),
    { deferDefaultMode: true },
  );
  draw = createDrawOnEngine(engine, { store });
  engine.enterDefaultMode();
});

afterEach(() => {
  draw.destroy();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// ----------------------------------------------------------------------------
// Tools
// ----------------------------------------------------------------------------

/** The map of the tests, as the engine takes it */
function createMapStubLike(): Parameters<typeof createEngine>[0] {
  return createMapStub().map as unknown as Parameters<typeof createEngine>[0];
}

/** Records what a promise settles with */
function settled<T>(promise: Promise<T>): { value?: T; error?: unknown; done: boolean } {
  const out: { value?: T; error?: unknown; done: boolean } = { done: false };
  promise.then(
    (value) => {
      out.value = value;
      out.done = true;
    },
    (error: unknown) => {
      out.error = error;
      out.done = true;
    },
  );
  return out;
}

/** Runs every task until none is left */
const allTasks = () => vi.runAllTimersAsync();

/** Runs an edit to its end and returns its counts */
async function finish(promise: Promise<EditCounts | null>): Promise<EditCounts | null> {
  const run = settled(promise);
  await allTasks();
  if (!run.done) throw new Error('the edit did not end');
  if (run.error) throw run.error;
  return run.value as EditCounts | null;
}

/** The code of the error a promise rejects with */
async function rejection(promise: Promise<unknown>): Promise<string | undefined> {
  const run = settled(promise);
  await allTasks();
  return run.error instanceof DrawError ? run.error.code : undefined;
}

/** Creates a feature and returns its ID */
function create(input: Parameters<Draw['features']['create']>[0]): string {
  const feature = draw.features.create(input);
  if (!feature) throw new Error('not created');
  return feature.id;
}

/** A point */
const point = (lon: number, lat: number, properties: Record<string, unknown> = {}) =>
  create({ type: 'Point', geometry: { type: 'Point', coordinates: [lon, lat] }, properties });

/** An image of 100 × 50 pixels at a point */
const image = (lon: number, lat: number, properties: Record<string, unknown> = {}) =>
  create({
    type: 'Image',
    geometry: { type: 'Point', coordinates: [lon, lat] },
    properties: {
      'maplibre-gl-draw:imageWidth': 100,
      'maplibre-gl-draw:imageHeight': 50,
      'maplibre-gl-draw:createdZoom': 14,
      ...properties,
    },
  });

/** A square area `size` degrees wide from its south-west corner */
function square(west: number, south: number, size: number): string {
  const ring = [
    [west, south],
    [west + size, south],
    [west + size, south + size],
    [west, south + size],
    [west, south],
  ];
  return create({ type: 'Polygon', geometry: { type: 'Polygon', coordinates: [ring] } });
}

/** Points along the equator; their IDs */
function points(count: number): string[] {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) ids.push(point(i * 0.001, 0));
  return ids;
}

/** The geometry of a feature */
const geometryOf = (id: string): Geometry => {
  const geometry = draw.features.get(id)?.geometry;
  if (!geometry) throw new Error(`no feature ${id}`);
  return geometry;
};

/** The position of a point */
const xyOf = (id: string): Position => {
  const geometry = geometryOf(id);
  if (geometry.type !== 'Point') throw new Error(`${id} is not a point`);
  return geometry.coordinates;
};

/** The outer ring of an area */
const ringOf = (id: string): Position[] => {
  const geometry = geometryOf(id);
  if (geometry.type !== 'Polygon') throw new Error(`${id} is not an area`);
  return geometry.coordinates[0];
};

/** An attribute of a feature */
const attributeOf = (id: string, key: string): unknown => draw.features.get(id)?.properties[key];

/** The changes `document.changed` gives from now on */
function documentChanges(): DocumentChange[] {
  const out: DocumentChange[] = [];
  draw.on('document.changed', (change) => out.push(change));
  return out;
}

/** The built-in computation, taking `ms` per feature on the clock of the tests */
function slowBuiltIn(ms: number, name = 'slow'): TransformProvider & { calls: TransformInput[] } {
  const builtIn = createBuiltInTransform();
  const calls: TransformInput[] = [];
  return {
    name,
    calls,
    accepts: (operation) => builtIn.accepts(operation),
    apply(operation, input, output) {
      calls.push(input);
      clock += ms * input.featureCount;
      builtIn.apply(operation, input, output);
    },
  };
}

/** A computation of the tests that moves every position `dx` degrees east, whatever it is asked */
function shiftBy(dx: number, name: string): TransformProvider & { calls: number[] } {
  const calls: number[] = [];
  return {
    name,
    calls,
    accepts: () => true,
    apply(_operation, input, output) {
      calls.push(input.operationId);
      output.coordinates.set(input.coordinates);
      for (let p = 0; p < input.coordinates.length; p += input.valuesPerPosition) {
        output.coordinates[p] = (input.coordinates[p] as number) + dx;
      }
      if (input.rotationDegrees && output.rotationDegrees) {
        output.rotationDegrees.set(input.rotationDegrees);
      }
      if (input.bearingDegrees && output.bearingDegrees) {
        output.bearingDegrees.set(input.bearingDegrees);
      }
      if (input.size && output.size) output.size.set(input.size);
    },
  };
}

/** The renderer of a feature type of the tests, which draws nothing */
const renderer = { onAdd() {}, draw() {}, onRemove() {} };

/** The distance on the ground between two positions (m) */
const ground = (a: Position, b: Position): number =>
  haversineDistanceMeters([a[0], a[1]], [b[0], b[1]]);

/** The positions moved as the published version moved them: the differences added */
function addedDifference(positions: Position[], from: Position, to: Position): Position[] {
  return positions.map((p) => [p[0] + to[0] - from[0], p[1] + to[1] - from[1]]);
}

/** The positions turned about a center in the plane of Web Mercator (the published version) */
function planeRotation(positions: Position[], center: Position, degrees: number): Position[] {
  const [cx, cy] = toPlane([center[0], center[1]]);
  const t = (degrees * Math.PI) / 180;
  return positions.map((p) => {
    const [x, y] = toPlane([p[0], p[1]]);
    const dx = x - cx;
    const dy = y - cy;
    return fromPlane(
      cx + dx * Math.cos(t) - dy * Math.sin(t),
      cy + dx * Math.sin(t) + dy * Math.cos(t),
    );
  });
}

/** The positions scaled from a point in the plane of Web Mercator (the published version) */
function planeScaling(positions: Position[], center: Position, k: number): Position[] {
  const [cx, cy] = toPlane([center[0], center[1]]);
  return positions.map((p) => {
    const [x, y] = toPlane([p[0], p[1]]);
    return fromPlane(cx + (x - cx) * k, cy + (y - cy) * k);
  });
}

/** The largest distance on the ground between the positions of two lists (m) */
const largestGap = (a: Position[], b: Position[]): number =>
  Math.max(...a.map((p, i) => ground(p, b[i] as Position)));

const TOKYO: Position = [139.767, 35.681];
const SAPPORO: Position = [141.35, 43.06];

// ----------------------------------------------------------------------------
// The rules of every bulk edit
// ----------------------------------------------------------------------------

describe('a move, a rotation and a scaling, as bulk edits', () => {
  it('write in parts of one operation, each a change, and resolve with the counts', async () => {
    const ids = points(40);
    const slow = slowBuiltIn(5);
    draw.extensions.setTransformProvider(slow);
    const changes = documentChanges();
    const counts = (await finish(
      draw.features.translate(ids, { from: [0, 0], to: [0.01, 0] }),
    )) as EditCounts;
    expect(counts).toEqual({
      operationId: expect.any(Number),
      changedCount: 40,
      lockedCount: 0,
      missingCount: 0,
      stopped: false,
    });
    const own = changes.filter((change) => change.operationId === counts.operationId);
    expect(own.length).toBeGreaterThan(1);
    expect(own.map((change) => change.hasMoreParts)).toEqual([
      ...own.slice(0, -1).map(() => true),
      false,
    ]);
    expect(own.reduce((sum, change) => sum + change.features.updated.count(), 0)).toBe(40);
    expect(ids.every((id) => Math.abs(xyOf(id)[0] - (ids.indexOf(id) * 0.001 + 0.01)) < 1e-9)).toBe(
      true,
    );
  });

  it('count an ID that names nothing, once, and leave out an ID given again', async () => {
    const [a, b] = points(2);
    const counts = await finish(
      draw.features.rotate([a, a, 'none', 'none'], {
        center: [1, 0],
        counterclockwiseDegrees: 90,
      }),
    );
    expect(counts).toEqual(
      expect.objectContaining({ changedCount: 1, missingCount: 1, lockedCount: 0 }),
    );
    expect(xyOf(b)).toEqual([0.001, 0]);
  });

  it('leave a locked feature as it is and count it, and a feature deleted meanwhile out', async () => {
    const ids = points(60);
    draw.features.update(ids[1], { locked: true });
    draw.extensions.setTransformProvider(slowBuiltIn(10));
    const run = settled(
      draw.features.scale(ids, {
        center: [0, 1],
        eastFactor: 2,
        northFactor: 2,
        sizeFactor: 2,
      }),
    );
    await vi.runOnlyPendingTimersAsync();
    // Locked and deleted from outside the instance while the edit writes, before it reaches them
    const lockedRef = store.tables.getRowRef(ids[50]) as number;
    store.writeRows({ rows: Int32Array.of(lockedRef), fields: new Map([['locked', [true]]]) });
    const ref = store.tables.getRowRef(ids[59]) as number;
    store.writeRows({ rows: Int32Array.of(ref), fields: new Map(), deleted: Uint8Array.of(1) });
    await allTasks();
    expect(run.value).toEqual(
      expect.objectContaining({
        changedCount: 57,
        lockedCount: 2,
        missingCount: 0,
        stopped: false,
      }),
    );
    expect(xyOf(ids[1])).toEqual([0.001, 0]);
    expect(xyOf(ids[50])).toEqual([0.05, 0]);
    expect(xyOf(ids[5])[1]).toBeCloseTo(-1, 3);
  });

  it('are refused with null when the document is read-only or every feature is locked', async () => {
    const ids = points(2);
    draw.setReadOnly(true);
    expect(await finish(draw.features.translate(ids, { from: [0, 0], to: [1, 0] }))).toBeNull();
    draw.setReadOnly(false);
    for (const id of ids) draw.features.update(id, { locked: true });
    expect(
      await finish(draw.features.rotate(ids, { center: [0, 0], counterclockwiseDegrees: 10 })),
    ).toBeNull();
    expect(xyOf(ids[1])).toEqual([0.001, 0]);
  });

  it('stop when the document turns read-only, the parts written staying, and reject on destroy', async () => {
    const ids = points(30);
    draw.extensions.setTransformProvider(slowBuiltIn(10));
    const run = settled(draw.features.translate(ids, { from: [0, 0], to: [0, 0.01] }));
    await vi.runOnlyPendingTimersAsync();
    draw.setReadOnly(true);
    await allTasks();
    const counts = run.value as EditCounts;
    expect(counts.stopped).toBe(true);
    expect(counts.changedCount).toBeGreaterThan(0);
    expect(counts.changedCount).toBeLessThan(30);
    expect(xyOf(ids[0])[1]).toBeCloseTo(0.01, 6);
    expect(xyOf(ids[29])[1]).toBe(0);
    draw.setReadOnly(false);
    const second = settled(draw.features.translate(ids, { from: [0, 0], to: [0, 0.01] }));
    await vi.runOnlyPendingTimersAsync();
    draw.destroy();
    await allTasks();
    expect(second.error).toBeInstanceOf(DrawError);
    expect((second.error as DrawError).code).toBe('invalidState');
  });

  it('make the change of the draw.transact they are started in their first part', async () => {
    const ids = points(3);
    const changes = documentChanges();
    let run: { value?: EditCounts | null; done: boolean } = { done: false };
    draw.transact(() => {
      draw.features.update(ids[0], { properties: { name: 'first' } });
      run = settled(draw.features.translate(ids, { from: [0, 0], to: [1, 0] }));
    });
    await allTasks();
    const counts = run.value as EditCounts;
    expect(changes[0].operationId).toBe(counts.operationId);
    expect(changes[0].hasMoreParts).toBe(true);
    expect(changes[changes.length - 1].hasMoreParts).toBe(false);
    expect(xyOf(ids[2])[0]).toBeCloseTo(1.002, 9);
  });

  it('are applied first to a feature a write of this client touches, and once', async () => {
    const ids = points(4);
    const run = settled(draw.features.translate(ids, { from: [0, 0], to: [0.5, 0] }));
    // Before the first part: the write reads the feature after the move
    draw.features.update(ids[3], { properties: { name: 'last' } });
    expect(xyOf(ids[3])[0]).toBeCloseTo(0.503, 9);
    await allTasks();
    expect(xyOf(ids[3])[0]).toBeCloseTo(0.503, 9);
    expect(attributeOf(ids[3], 'name')).toBe('last');
    expect((run.value as EditCounts).changedCount).toBe(4);
  });

  it('are applied first to a feature the drag of a handle of its type writes', async () => {
    // A pin keeps its rotation under `angle`, and the drag of its grip writes `pulled`: the patch
    // is merged into the attributes the pin has when it is read
    const pin: FeatureTypeDefinition = {
      type: 'pin',
      geometry: 'Point',
      renderer,
      transformFields: { rotationDegreesKey: 'angle' },
      handles: (feature) => [
        {
          id: 'grip',
          position: (feature.geometry as { coordinates: Position }).coordinates,
          kind: 'grip',
        },
      ],
      onHandleDrag: (_feature, _handle, event) => ({ properties: { pulled: event.lngLat[0] } }),
    };
    draw.extensions.featureTypes.add(pin);
    const ids = [
      ...points(3),
      create({ type: 'pin', geometry: { type: 'Point', coordinates: [1, 1] } }),
    ];
    const pinId = ids[3];
    const run = settled(draw.features.rotate(ids, { center: [0, 0], counterclockwiseDegrees: 30 }));
    const provider = engine.context.selectionScope.auxiliaryHandles.list()[0];
    const drag = (type: 'dragstart' | 'dragmove' | 'dragend', lng: number) => ({
      type,
      point: { x: 0, y: 0 },
      lngLat: { lng, lat: 1 },
      originalEvent: {} as MouseEvent,
      modifiers: { shift: false, ctrl: false, alt: false, meta: false },
      dragStartPoint: { x: 0, y: 0 },
      dragStartLngLat: { lng: 1, lat: 1 },
    });
    expect(
      provider.onHandleDragStart(
        { providerId: provider.id, handleId: 'grip', featureId: pinId },
        drag('dragstart', 1) as never,
      ),
    ).toBe(true);
    provider.onHandleDragEnd(drag('dragend', 2) as never);
    // The rotation was applied to the pin before the patch was merged and written
    expect(attributeOf(pinId, 'angle')).toBe(30);
    expect(attributeOf(pinId, 'pulled')).toBe(2);
    const turned = xyOf(pinId);
    expect(turned[0]).not.toBeCloseTo(1, 3);
    await allTasks();
    expect(xyOf(pinId)).toEqual(turned);
    expect(attributeOf(pinId, 'angle')).toBe(30);
    // The point at the center does not move, and is not counted
    expect((run.value as EditCounts).changedCount).toBe(3);
  });
});

// ----------------------------------------------------------------------------
// The built-in computation, through the edits
// ----------------------------------------------------------------------------

describe('the built-in computation of the edits', () => {
  it('gives over a few hundred meters nearly what the plane of the published version gives', async () => {
    // About 300 m across. Allowed: 0.1 m for the move and the scaling, 1 m for the rotation (the
    // flattening of the earth, which the plane of Web Mercator does not have)
    const size = 0.003;
    const id = square(TOKYO[0], TOKYO[1], size);
    const before = ringOf(id);
    const to: Position = [TOKYO[0] + 0.001, TOKYO[1] + 0.0005];
    await finish(draw.features.translate([id], { from: TOKYO, to }));
    expect(largestGap(ringOf(id), addedDifference(before, TOKYO, to))).toBeLessThan(0.1);
    const moved = ringOf(id);
    const center: Position = [to[0] + size / 2, to[1] + size / 2];
    await finish(draw.features.rotate([id], { center, counterclockwiseDegrees: 30 }));
    expect(largestGap(ringOf(id), planeRotation(moved, center, 30))).toBeLessThan(1);
    const turned = ringOf(id);
    await finish(
      draw.features.scale([id], { center, eastFactor: 2, northFactor: 2, sizeFactor: 2 }),
    );
    expect(largestGap(ringOf(id), planeScaling(turned, center, 2))).toBeLessThan(0.1);
  });

  it('keeps the distances on the ground over tens of kilometers, unlike the published version', async () => {
    // 50 km on each side, moved from Tokyo to Sapporo: the published version shrinks it east to
    // west by about a tenth. Allowed here: 0.2 % of each side
    const size = 0.45;
    const id = square(TOKYO[0], TOKYO[1], size);
    const before = ringOf(id);
    const sides = (ring: Position[]) => [ground(ring[0], ring[1]), ground(ring[1], ring[2])];
    await finish(draw.features.translate([id], { from: TOKYO, to: SAPPORO }));
    const after = ringOf(id);
    sides(after).forEach((side, i) => {
      expect(Math.abs(side / (sides(before)[i] as number) - 1)).toBeLessThan(0.002);
    });
    const published = addedDifference(before, TOKYO, SAPPORO);
    expect(sides(published)[0] / (sides(before)[0] as number)).toBeLessThan(0.92);
    expect(largestGap(after, published)).toBeGreaterThan(1000);
  });

  it('moves across the ±180 degree meridian the way the numbers of from and to say', async () => {
    const id = point(179.6, 0);
    await finish(draw.features.translate([id], { from: [179.5, 0], to: [180.5, 0] }));
    expect(xyOf(id)[0]).toBeCloseTo(180.6, 9);
    await finish(draw.features.translate([id], { from: [180.5, 0], to: [-179.5, 0] }));
    expect(xyOf(id)[0]).toBeCloseTo(-179.4, 9);
  });

  it('rejects a point that is not finite or has a latitude outside -90 to 90, a wrong angle or factor, and changes nothing', async () => {
    const id = point(1, 1);
    const changes = documentChanges();
    const wrong: (() => Promise<unknown>)[] = [
      () => draw.features.translate([id], { from: [0, 91], to: [0, 0] }),
      () => draw.features.translate([id], { from: [0, 0], to: [Number.NaN, 0] }),
      () => draw.features.translate([id], { from: [0, 0] } as never),
      () => draw.features.rotate([id], { center: [0, -90.5], counterclockwiseDegrees: 10 }),
      () =>
        draw.features.rotate([id], {
          center: [0, 0],
          counterclockwiseDegrees: Number.POSITIVE_INFINITY,
        }),
      () =>
        draw.features.scale([id], {
          center: [0, 95],
          eastFactor: 2,
          northFactor: 2,
          sizeFactor: 2,
        }),
      () =>
        draw.features.scale([id], { center: [0, 0], eastFactor: 0, northFactor: 2, sizeFactor: 2 }),
      () =>
        draw.features.scale([id], {
          center: [0, 0],
          eastFactor: 2,
          northFactor: -1,
          sizeFactor: 2,
        }),
      () =>
        draw.features.scale([id], {
          center: [0, 0],
          eastFactor: 2,
          northFactor: 2,
          sizeFactor: Number.NaN,
        }),
      () => draw.features.translate([1] as never, { from: [0, 0], to: [1, 0] }),
    ];
    for (const call of wrong) expect(await rejection(call())).toBe('invalidInput');
    expect(xyOf(id)).toEqual([1, 1]);
    expect(changes).toEqual([]);
  });
});

// ----------------------------------------------------------------------------
// The computations set
// ----------------------------------------------------------------------------

describe('the computation an edit uses', () => {
  it('is the last one set that is still there, and the built-in one when none is left', async () => {
    const id = point(0, 0);
    const lower = shiftBy(1, 'lower');
    const upper = shiftBy(10, 'upper');
    draw.extensions.setTransformProvider(lower);
    const removeUpper = draw.extensions.setTransformProvider(upper);
    await finish(draw.features.translate([id], { from: [0, 0], to: [5, 0] }));
    expect(xyOf(id)).toEqual([10, 0]);
    removeUpper();
    await finish(draw.features.translate([id], { from: [0, 0], to: [5, 0] }));
    expect(xyOf(id)).toEqual([11, 0]);
    expect(upper.calls).toHaveLength(1);
    expect(lower.calls).toHaveLength(1);
  });

  it('is the one set when the edit starts, for every part of it', async () => {
    const ids = points(20);
    const first = slowBuiltIn(10, 'first');
    draw.extensions.setTransformProvider(first);
    const run = settled(draw.features.translate(ids, { from: [0, 0], to: [0, 1] }));
    await vi.runOnlyPendingTimersAsync();
    const second = shiftBy(100, 'second');
    draw.extensions.setTransformProvider(second);
    await allTasks();
    expect((run.value as EditCounts).changedCount).toBe(20);
    expect(second.calls).toEqual([]);
    expect(first.calls.length).toBeGreaterThan(1);
  });

  it('rejects with invalidInput when it does not compute the operation, and changes nothing', async () => {
    const id = point(0, 0);
    const refusing: TransformProvider = {
      name: 'plane',
      accepts: (operation) => operation.kind !== 'rotate',
      apply: shiftBy(1, 'plane').apply,
    };
    draw.extensions.setTransformProvider(refusing);
    const changes = documentChanges();
    expect(
      await rejection(draw.features.rotate([id], { center: [0, 0], counterclockwiseDegrees: 5 })),
    ).toBe('invalidInput');
    expect(xyOf(id)).toEqual([0, 0]);
    expect(changes).toEqual([]);
    // A move it computes is written
    await finish(draw.features.translate([id], { from: [0, 0], to: [0, 0] }));
    expect(xyOf(id)).toEqual([1, 0]);
  });

  it('is given the number of the operation in every call, also for a feature touched first in a transaction', async () => {
    const ids = points(20);
    const slow = slowBuiltIn(10);
    draw.extensions.setTransformProvider(slow);
    const run = settled(draw.features.translate(ids, { from: [0, 0], to: [0, 1] }));
    // The fn of draw.transact writes a feature the edit has not reached: the edit is applied to
    // it inside that transaction, whose number is another
    draw.transact(() => {
      draw.features.update(ids[19], { properties: { name: 'touched' } });
    });
    await allTasks();
    const counts = run.value as EditCounts;
    expect(slow.calls.length).toBeGreaterThan(2);
    expect(slow.calls.every((input) => input.operationId === counts.operationId)).toBe(true);
    expect(slow.calls[0].featureCount).toBe(1);
    expect(xyOf(ids[19])[1]).toBeCloseTo(1, 6);
  });

  it('is given arrays, one call for the features of a batch in one layer', async () => {
    const ids = points(5);
    const slow = slowBuiltIn(0);
    draw.extensions.setTransformProvider(slow);
    await finish(draw.features.translate(ids, { from: [0, 0], to: [1, 0] }));
    expect(slow.calls).toHaveLength(1);
    const [input] = slow.calls;
    expect(input.featureCount).toBe(5);
    expect(input.coordinates).toBeInstanceOf(Float64Array);
    expect(Array.from(input.positionStarts)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(input.rotationDegrees).toBeNull();
    expect(input.size).toBeNull();
    expect(input.isScaledUniformly).toBeNull();
  });
});

// ----------------------------------------------------------------------------
// The center of a rotation of a single point
// ----------------------------------------------------------------------------

describe('a rotation of a single feature of a Point geometry', () => {
  it('turns an image alone about its position, and two images about the center given', async () => {
    const one = image(10, 10, { 'maplibre-gl-draw:rotation': 15 });
    await finish(draw.features.rotate([one], { center: [0, 0], counterclockwiseDegrees: 90 }));
    expect(xyOf(one)).toEqual([10, 10]);
    expect(attributeOf(one, 'maplibre-gl-draw:rotation')).toBe(105);
    const other = image(11, 10);
    await finish(
      draw.features.rotate([one, other], { center: [10.5, 10], counterclockwiseDegrees: 90 }),
    );
    expect(xyOf(one)[1]).toBeLessThan(9.6);
    expect(attributeOf(one, 'maplibre-gl-draw:rotation')).toBe(195);
    expect(attributeOf(other, 'maplibre-gl-draw:rotation')).toBe(90);
  });

  it('turns an image alone about its position after the edit being written is applied to it', async () => {
    const ids = points(40);
    const one = image(1, 0);
    draw.extensions.setTransformProvider(slowBuiltIn(5));
    const move = settled(draw.features.translate([...ids, one], { from: [0, 0], to: [0, 0.5] }));
    await vi.runOnlyPendingTimersAsync();
    // The move has not reached the image yet when the rotation starts
    const turn = settled(
      draw.features.rotate([one], { center: [0, 0], counterclockwiseDegrees: 90 }),
    );
    await allTasks();
    expect((move.value as EditCounts).changedCount).toBe(41);
    expect((turn.value as EditCounts).changedCount).toBe(1);
    expect(xyOf(one)[0]).toBeCloseTo(1, 3);
    expect(xyOf(one)[1]).toBeCloseTo(0.5, 3);
    expect(attributeOf(one, 'maplibre-gl-draw:rotation')).toBe(90);
  });

  it('turns a point alone about its position once the edits started before it have moved it', async () => {
    const ids = points(40);
    const one = image(1, 0, { 'maplibre-gl-draw:rotation': 10 });
    draw.extensions.setTransformProvider(slowBuiltIn(5));
    const all = [...ids, one];
    // Two moves of every feature, one after the other, and then a rotation of the image alone
    const north = settled(draw.features.translate(all, { from: [0, 0], to: [0, 0.5] }));
    const east = settled(draw.features.translate(all, { from: [0, 0], to: [0.5, 0] }));
    const turn = settled(
      draw.features.rotate([one], { center: [0, 0], counterclockwiseDegrees: 90 }),
    );
    await allTasks();
    expect((north.value as EditCounts).changedCount).toBe(41);
    expect((east.value as EditCounts).changedCount).toBe(41);
    expect((turn.value as EditCounts).changedCount).toBe(1);
    // Where the two moves put it: only its rotation changes
    expect(xyOf(one)[0]).toBeCloseTo(1.5, 3);
    expect(xyOf(one)[1]).toBeCloseTo(0.5, 3);
    expect(attributeOf(one, 'maplibre-gl-draw:rotation')).toBe(100);
  });

  it('turns a point without a field of rotation about the center given', async () => {
    const id = point(1, 0);
    await finish(draw.features.rotate([id], { center: [0, 0], counterclockwiseDegrees: 90 }));
    expect(xyOf(id)[0]).toBeCloseTo(0, 6);
    expect(xyOf(id)[1]).toBeGreaterThan(0.99);
  });

  it('turns a point of a type with a field of rotation about its position, the center being settled before the computation', async () => {
    draw.extensions.featureTypes.add({
      type: 'sign',
      geometry: 'Point',
      renderer,
      transformFields: { rotationDegreesKey: 'angle' },
    });
    const id = create({ type: 'sign', geometry: { type: 'Point', coordinates: [3, 4] } });
    const seen: TransformOperation[] = [];
    const builtIn = createBuiltInTransform();
    draw.extensions.setTransformProvider({
      name: 'seen',
      accepts: (operation) => {
        seen.push(operation);
        return builtIn.accepts(operation);
      },
      apply: builtIn.apply,
    });
    await finish(draw.features.rotate([id], { center: [0, 0], counterclockwiseDegrees: 45 }));
    expect(seen).toEqual([{ kind: 'rotate', center: [3, 4], counterclockwiseDegrees: 45 }]);
    expect(xyOf(id)).toEqual([3, 4]);
    expect(attributeOf(id, 'angle')).toBe(45);
  });
});

// ----------------------------------------------------------------------------
// The fields of rotation, direction and size
// ----------------------------------------------------------------------------

describe('the fields a type declares', () => {
  const sign: FeatureTypeDefinition = {
    type: 'sign',
    geometry: 'Point',
    renderer,
    transformFields: {
      rotationDegreesKey: 'angle',
      bearingDegreesKey: 'facing',
      sizeKey: 'k',
      isScaledUniformly: true,
    },
  };

  it('add the angle to the rotation and take it from the direction, within [0, 360), and multiply the size', async () => {
    draw.extensions.featureTypes.add(sign);
    const a = create({
      type: 'sign',
      geometry: { type: 'Point', coordinates: [0.01, 0] },
      properties: { angle: 350, facing: 10, k: 2 },
    });
    const b = create({ type: 'sign', geometry: { type: 'Point', coordinates: [0.02, 0] } });
    await finish(draw.features.rotate([a, b], { center: [0, 0], counterclockwiseDegrees: 20 }));
    expect([attributeOf(a, 'angle'), attributeOf(a, 'facing')]).toEqual([10, 350]);
    // Without its keys a feature starts from 0
    expect([attributeOf(b, 'angle'), attributeOf(b, 'facing')]).toEqual([20, 340]);
    await finish(
      draw.features.scale([a, b], { center: [0, 0], eastFactor: 5, northFactor: 1, sizeFactor: 3 }),
    );
    // Without its key a feature starts from 1
    expect([attributeOf(a, 'k'), attributeOf(b, 'k')]).toEqual([6, 3]);
  });

  it('move a feature that keeps its shape by sizeFactor along both axes', async () => {
    draw.extensions.featureTypes.add({
      type: 'board',
      geometry: 'Polygon',
      renderer,
      transformFields: { isScaledUniformly: true },
    });
    const ring = [
      [0.001, 0.001],
      [0.002, 0.001],
      [0.002, 0.002],
      [0.001, 0.001],
    ];
    const board = create({ type: 'board', geometry: { type: 'Polygon', coordinates: [ring] } });
    const plain = create({ type: 'Polygon', geometry: { type: 'Polygon', coordinates: [ring] } });
    await finish(
      draw.features.scale([board, plain], {
        center: [0, 0],
        eastFactor: 3,
        northFactor: 1,
        sizeFactor: 2,
      }),
    );
    expect(ringOf(board)[2][0]).toBeCloseTo(0.004, 7);
    expect(ringOf(board)[2][1]).toBeCloseTo(0.004, 7);
    expect(ringOf(plain)[2][0]).toBeCloseTo(0.006, 7);
    expect(ringOf(plain)[2][1]).toBeCloseTo(0.002, 7);
  });

  it('are the only keys written: a feature of a type without them keeps its keys', async () => {
    const id = square(0, 0, 0.001);
    draw.features.update(id, { properties: { 'maplibre-gl-draw:rotation': 5, angle: 7 } });
    await finish(draw.features.rotate([id], { center: [0, 0], counterclockwiseDegrees: 30 }));
    expect(attributeOf(id, 'maplibre-gl-draw:rotation')).toBe(5);
    expect(attributeOf(id, 'angle')).toBe(7);
  });

  it('of the built-in types are the rotation and the scale of an image and the radius of a circle', async () => {
    const picture = image(0.001, 0, { 'maplibre-gl-draw:scale': 1.5 });
    const circle = create({
      type: 'Circle',
      geometry: { type: 'Point', coordinates: [0.002, 0] },
      properties: { 'maplibre-gl-draw:radiusMeters': 40 },
    });
    await finish(
      draw.features.scale([picture, circle], {
        center: [0, 0],
        eastFactor: 3,
        northFactor: 1,
        sizeFactor: 2,
      }),
    );
    expect(attributeOf(picture, 'maplibre-gl-draw:scale')).toBe(3);
    expect(attributeOf(circle, 'maplibre-gl-draw:radiusMeters')).toBe(80);
    // They keep their shape: their positions move by sizeFactor
    expect(xyOf(picture)[0]).toBeCloseTo(0.002, 7);
    expect(xyOf(circle)[0]).toBeCloseTo(0.004, 7);
    await finish(
      draw.features.rotate([picture, circle], { center: [0, 0], counterclockwiseDegrees: 30 }),
    );
    expect(attributeOf(picture, 'maplibre-gl-draw:rotation')).toBe(30);
    expect(attributeOf(circle, 'maplibre-gl-draw:rotation')).toBeUndefined();
  });
});

describe('a definition that overrides a built-in type', () => {
  it('leaves the fields of the built-in type to the features it takes when it declares none', async () => {
    draw.extensions.featureTypes.override({ type: 'Image', geometry: 'Point', renderer });
    const a = image(0.001, 0);
    const b = image(0.002, 0);
    await finish(draw.features.rotate([a, b], { center: [0, 0], counterclockwiseDegrees: 40 }));
    expect(attributeOf(a, 'maplibre-gl-draw:rotation')).toBe(40);
  });

  it('gives the features it takes its own fields in place of all those of the built-in type', async () => {
    draw.extensions.featureTypes.override({
      type: 'Image',
      geometry: 'Point',
      renderer,
      appliesTo: (feature) => feature.properties.kind === 'arrow',
      transformFields: { bearingDegreesKey: 'facing' },
    });
    const arrow = image(0.001, 0, {
      kind: 'arrow',
      facing: 90,
      'maplibre-gl-draw:rotation': 10,
      'maplibre-gl-draw:scale': 2,
    });
    const photo = image(0.002, 0, { 'maplibre-gl-draw:rotation': 10 });
    await finish(
      draw.features.rotate([arrow, photo], { center: [0, 0], counterclockwiseDegrees: 30 }),
    );
    expect(attributeOf(arrow, 'facing')).toBe(60);
    expect(attributeOf(arrow, 'maplibre-gl-draw:rotation')).toBe(10);
    // The feature it does not take keeps the built-in type entirely
    expect(attributeOf(photo, 'maplibre-gl-draw:rotation')).toBe(40);
    await finish(
      draw.features.scale([arrow, photo], {
        center: [0, 0],
        eastFactor: 2,
        northFactor: 2,
        sizeFactor: 4,
      }),
    );
    expect(attributeOf(arrow, 'maplibre-gl-draw:scale')).toBe(2);
    expect(attributeOf(photo, 'maplibre-gl-draw:scale')).toBe(4);
  });
});

describe('the fields of a feature type definition', () => {
  it('are refused with invalidInput when they do not have the shape of the contract', () => {
    const wrong = [
      { transformFields: 'angle' },
      { transformFields: { rotationDegreesKey: 3 } },
      { transformFields: { sizeKey: '' } },
      { transformFields: { isScaledUniformly: 'yes' } },
    ];
    for (const fields of wrong) {
      const add = () =>
        draw.extensions.featureTypes.add({
          type: 'wrong',
          geometry: 'Point',
          renderer,
          ...fields,
        } as unknown as FeatureTypeDefinition);
      expect(add).toThrow(DrawError);
      expect(draw.extensions.featureTypes.has('wrong')).toBe(false);
    }
  });
});

// ----------------------------------------------------------------------------
// 100,000 features
// ----------------------------------------------------------------------------

/** A random generator of a fixed seed (mulberry32) */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The kinds of the rows of the document of 100,000 features */
const KINDS = ['Point', 'LineString', 'Polygon', 'Circle', 'Image'] as const;

/**
 * `count` features of every kind written to the Store at once, in a layer of positions of three
 * values (a height): points, lines, areas, circles with a radius and images with a rotation and
 * a scale, some points with a rotation of their own; their IDs
 */
function manyFeatures(count: number, seed: number): string[] {
  store.createLayer(
    {
      id: 'many',
      name: 'many',
      visible: true,
      locked: false,
      opacity: 1,
      styleRule: undefined,
      metadata: undefined,
    } as Parameters<Store['createLayer']>[0],
    { valuesPerPosition: 3 },
  );
  const next = random(seed);
  const ids: string[] = [];
  const types: string[] = [];
  const geometryTypes = new Uint8Array(count);
  const partStarts = new Int32Array(count + 1);
  const ringStarts = new Int32Array(count + 1);
  const positionStarts: number[] = [0];
  const coordinates: number[] = [];
  const rotation: unknown[] = [];
  const scale: unknown[] = [];
  const radius: unknown[] = [];
  let height = 0;
  for (let i = 0; i < count; i++) {
    const kind = KINDS[Math.floor(next() * KINDS.length)];
    const x = 139 + next() * 0.2;
    const y = 35 + next() * 0.2;
    const at = (dx: number, dy: number) => coordinates.push(x + dx, y + dy, ++height);
    ids.push(`f${i}`);
    types.push(kind);
    if (kind === 'LineString') {
      geometryTypes[i] = 1;
      at(0, 0);
      at(0.01, 0.003);
    } else if (kind === 'Polygon') {
      geometryTypes[i] = 2;
      at(0, 0);
      const closing = height;
      at(0.01, 0);
      at(0.01, 0.01);
      // The ring is closed: its last position is its first, height included
      coordinates.push(x, y, closing);
    } else {
      geometryTypes[i] = 0;
      at(0, 0);
    }
    partStarts[i + 1] = i + 1;
    ringStarts[i + 1] = i + 1;
    positionStarts.push(coordinates.length / 3);
    rotation.push(kind === 'Image' || next() < 0.2 ? Math.round(next() * 90) : undefined);
    scale.push(kind === 'Image' ? 1 + (i % 10) / 10 : undefined);
    radius.push(kind === 'Circle' ? 50 + (i % 100) : undefined);
  }
  const fields = new Map<FeatureRowField, unknown[]>([
    ['type', types],
    ['parent', ids.map(() => 'many')],
    ['orderKey', ids.map((_, i) => `k${String(i).padStart(7, '0')}`)],
    ['visible', ids.map(() => true)],
    ['locked', ids.map(() => false)],
    ['style', ids.map(() => ({}))],
    ['properties:maplibre-gl-draw:rotation', rotation],
    ['properties:maplibre-gl-draw:scale', scale],
    ['properties:maplibre-gl-draw:radiusMeters', radius],
    ['properties:maplibre-gl-draw:imageWidth', types.map((t) => (t === 'Image' ? 10 : undefined))],
    ['properties:maplibre-gl-draw:imageHeight', types.map((t) => (t === 'Image' ? 10 : undefined))],
  ]);
  const geometry: GeometryColumn = {
    types: geometryTypes,
    coordinates: Float64Array.from(coordinates),
    valuesPerPosition: 3,
    partStarts,
    ringStarts,
    positionStarts: Int32Array.from(positionStarts),
  };
  if (!store.createRows({ ids, fields, geometry })) throw new Error('not created');
  return ids;
}

/** The values a feature has after an operation, computed for it alone */
function aloneAfter(
  operation: TransformOperation,
  feature: { type: string; geometry: Geometry; properties: Record<string, unknown> },
): { positions: number[]; rotation: unknown; size: unknown } {
  const positions = (feature.geometry as { coordinates: unknown }).coordinates;
  const flat: number[] = [];
  const walk = (value: unknown): void => {
    const list = value as unknown[];
    if (typeof list[0] === 'number') flat.push(...(list as number[]));
    else for (const item of list) walk(item);
  };
  walk(positions);
  const image = feature.type === 'Image';
  const circle = feature.type === 'Circle';
  const rotationKey = 'maplibre-gl-draw:rotation';
  const sizeKey = image ? 'maplibre-gl-draw:scale' : 'maplibre-gl-draw:radiusMeters';
  const start = (value: unknown, otherwise: number) =>
    typeof value === 'number' ? value : otherwise;
  const input: TransformInput = {
    operationId: 1,
    featureCount: 1,
    coordinates: Float64Array.from(flat),
    valuesPerPosition: 3,
    positionStarts: Int32Array.of(0, flat.length / 3),
    rotationDegrees: Float64Array.of(
      image ? start(feature.properties[rotationKey], 0) : Number.NaN,
    ),
    bearingDegrees: null,
    size: Float64Array.of(image || circle ? start(feature.properties[sizeKey], 1) : Number.NaN),
    isScaledUniformly: Uint8Array.of(image || circle ? 1 : 0),
  };
  const output: TransformOutput = {
    coordinates: new Float64Array(flat.length),
    rotationDegrees: new Float64Array(1),
    bearingDegrees: null,
    size: new Float64Array(1),
  };
  applyBuiltInTransform(operation, input, output);
  return {
    positions: Array.from(output.coordinates),
    rotation: image ? output.rotationDegrees?.[0] : feature.properties[rotationKey],
    size: image || circle ? output.size?.[0] : feature.properties[sizeKey],
  };
}

/** The positions of a feature, flattened */
function flatPositions(geometry: Geometry): number[] {
  const flat: number[] = [];
  const walk = (value: unknown): void => {
    const list = value as unknown[];
    if (typeof list[0] === 'number') flat.push(...(list as number[]));
    else for (const item of list) walk(item);
  };
  walk((geometry as { coordinates: unknown }).coordinates);
  return flat;
}

describe('100,000 features of every kind', () => {
  it('are written with the values the computation gives each feature alone, their heights kept', async () => {
    const ids = manyFeatures(100_000, 7);
    const operations: TransformOperation[] = [
      { kind: 'rotate', center: [139.1, 35.1], counterclockwiseDegrees: 17 },
      {
        kind: 'scale',
        center: [139.21, 35.21],
        eastFactor: 1.4,
        northFactor: 0.8,
        sizeFactor: 1.2,
      },
      { kind: 'translate', from: [139, 35], to: [139.1, 35.2] },
    ];
    // Every 997th feature is checked against the computation of it alone
    const sample = ids.filter((_, i) => i % 997 === 0);
    for (const operation of operations) {
      const before = sample.map((id) => {
        const feature = draw.features.get(id);
        if (!feature) throw new Error(`no feature ${id}`);
        return aloneAfter(operation, feature);
      });
      const run =
        operation.kind === 'rotate'
          ? draw.features.rotate({ layerIds: ['many'] }, operation)
          : operation.kind === 'scale'
            ? draw.features.scale({ layerIds: ['many'] }, operation)
            : draw.features.translate({ layerIds: ['many'] }, operation);
      const counts = (await finish(run)) as EditCounts;
      expect(counts.changedCount).toBe(100_000);
      sample.forEach((id, i) => {
        const feature = draw.features.get(id);
        if (!feature) throw new Error(`no feature ${id}`);
        const expected = before[i];
        expect(flatPositions(feature.geometry)).toEqual(expected.positions);
        expect(feature.properties['maplibre-gl-draw:rotation']).toEqual(expected.rotation);
        const sizeKey =
          feature.type === 'Image' ? 'maplibre-gl-draw:scale' : 'maplibre-gl-draw:radiusMeters';
        expect(feature.properties[sizeKey]).toEqual(expected.size);
      });
    }
    // The heights are those the features were made with, in order
    const heights = flatPositions(geometryOf(ids[99_999])).filter((_, k) => k % 3 === 2);
    expect(heights.every((h) => Number.isInteger(h) && h > 0)).toBe(true);
  }, 120_000);

  it('leave a locked feature as it is, and are refused when every one is locked', async () => {
    const ids = manyFeatures(2_000, 3);
    draw.features.update(ids[3], { locked: true });
    const before = flatPositions(geometryOf(ids[3]));
    const counts = await finish(
      draw.features.translate({ layerIds: ['many'] }, { from: [139, 35], to: [140, 36] }),
    );
    expect(counts).toEqual(expect.objectContaining({ changedCount: 1_999, lockedCount: 1 }));
    expect(flatPositions(geometryOf(ids[3]))).toEqual(before);
    draw.layers.update('many', { locked: true });
    expect(
      await finish(
        draw.features.rotate(
          { layerIds: ['many'] },
          {
            center: [139, 35],
            counterclockwiseDegrees: 1,
          },
        ),
      ),
    ).toBeNull();
  });
});

// ----------------------------------------------------------------------------
// The work that does not grow with the features
// ----------------------------------------------------------------------------

/** The objects reachable from a value, typed arrays included, each once */
function objectsIn(value: unknown, seen = new Set<object>()): number {
  if (typeof value !== 'object' || value === null || seen.has(value)) return 0;
  seen.add(value);
  if (ArrayBuffer.isView(value)) return 1;
  let count = 1;
  for (const item of Object.values(value)) count += objectsIn(item, seen);
  return count;
}

describe('one call of the computation', () => {
  it('makes as many objects for 10,000 features as for 1,000, and is given no object per feature', () => {
    const scene = (size: number, measure: 'counted' | 'reachable'): number => {
      store = createStore();
      const ids = manyFeaturesIn(store, size);
      const layer = createDocumentAccess(store);
      const deps: TransformDeps = {
        layer: {
          getFeature: () => undefined,
          readFeatureValues: layer.readFeatureValues,
          updateFeature: () => false,
        },
        counts: countsOf(store),
        typeOf: () => undefined,
      };
      const counts = countsOf(store);
      const before = counts.objectsCreated;
      const run = readTransformRun(deps, ids, 0, createFieldsResolver(deps), 1);
      createBuiltInTransform().apply(
        { kind: 'rotate', center: [139.1, 35.1], counterclockwiseDegrees: 17 },
        run.input,
        run.output,
      );
      if (measure === 'counted') return counts.objectsCreated - before;
      return objectsIn(run.input) + objectsIn(run.output);
    };
    expectNotProportional((size) => scene(size, 'counted'), 'the objects counted');
    const reachable = expectNotProportional(
      (size) => scene(size, 'reachable'),
      'the objects given to the computation',
    );
    expect(reachable.large).toBe(reachable.small);
  });
});

/** `count` images and areas written to a Store at once in the layer `many`; their IDs */
function manyFeaturesIn(target: Store, count: number): string[] {
  const saved = store;
  store = target;
  try {
    return manyFeatures(count, 11);
  } finally {
    store = saved;
  }
}

describe('a part of a move', () => {
  it('writes no more rows for 10,000 features than for 1,000', async () => {
    const largest: number[] = [];
    for (const size of [1_000, 10_000]) {
      draw.destroy();
      store = createStore();
      engine = createEngine(
        createMapStubLike(),
        toEngineOptions({ store }, () => false),
        {
          deferDefaultMode: true,
        },
      );
      draw = createDrawOnEngine(engine, { store });
      engine.enterDefaultMode();
      manyFeatures(size, 5);
      draw.extensions.setTransformProvider(slowBuiltIn(0.05));
      const parts = await runInParts({
        counts: countsOf(store),
        run: () =>
          draw.features.translate({ layerIds: ['many'] }, { from: [139, 35], to: [139.01, 35] }),
      });
      // 0.05 ms a feature: about 1,000 rows in a part of 50 ms
      expectPartsWithin(parts, 1_100);
      largest.push(Math.max(...parts.parts));
    }
    expect(largest[1]).toBeLessThanOrEqual(1_100);
    expect(bulkEditsOf(draw)).toBeDefined();
  });
});
