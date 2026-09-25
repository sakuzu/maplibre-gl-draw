// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * N scaling regression test of load
 *
 * Verifies that draw.load (a native bulk import) stays linear in the number of features,
 * not by the absolute time but by "the ratio of the elapsed time when N is multiplied by
 * 4". To be robust against differences between machines, the threshold is 8x, halfway
 * between linear (4x) and quadratic (16x), and it fails if it goes back to quadratic.
 *
 * The measured path is shaped the same as in a browser. That is, the EventBridge is
 * connected, and for each public event "an idempotent subscriber that scans the whole
 * store every time" (the equivalent of recomputing a list in the application) is wired
 * up. A bulk import used to have the EventBridge expand 1 flush into N per-feature
 * events, and the subscriber scanned O(N) for each one, O(N^2) in total. This was made
 * linear by the folding of the events of a silent bulk flush and by the destructive
 * appending of the store's accumulation. The purpose of this test is to detect that
 * regression.
 *
 * One more test is placed here, which looks at whether the membership decision of
 * layer.order is O(1) with the store alone (see the describe below).
 */

import { describe, expect, it } from 'vitest';
import type { Context } from '../api/context.js';
import { createImportExportAPI } from '../api/import-export/index.js';
import { EventEmitterImpl } from '../shared/utils/event-emitter.js';
import { EventBridgeImpl } from './event-bridge.js';
import { MemoryStore } from './memory.js';
import { RBushSpatialIndex } from './spatial/spatial-index.js';
import type { Data, Feature, Group, Layer } from './types.js';

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Deterministically generates native Data holding N features (multiple layers, some
// groups, a mix of types).
function generate(count: number): Data {
  const rand = mulberry32(count * 2654435761);
  const layerCount = Math.min(12, Math.max(4, Math.round(count / 1500)));
  const layers: Layer[] = Array.from({ length: layerCount }, (_, i) => ({
    id: `layer-${i}`,
    name: `layer ${i}`,
    visible: true,
    locked: false,
    opacity: 1,
    order: [],
  }));
  const features: Feature[] = [];
  const perLayer: string[][] = Array.from({ length: layerCount }, () => []);
  for (let i = 0; i < count; i++) {
    const r = rand();
    const type: Feature['type'] =
      r < 0.45 ? 'Point' : r < 0.7 ? 'LineString' : r < 0.9 ? 'Polygon' : 'Circle';
    const center: [number, number] = [139 + rand(), 35 + rand()];
    let coordinates: Feature['coordinates'] = center;
    const extra: Record<string, unknown> = {};
    if (type === 'LineString') coordinates = [center, [center[0] + 0.001, center[1]]];
    else if (type === 'Polygon')
      coordinates = [
        [center, [center[0] + 0.001, center[1]], [center[0], center[1] + 0.001], center],
      ];
    else if (type === 'Circle') extra.radiusMeters = 100;
    const li = i % layerCount;
    const id = `f-${i}`;
    features.push({
      id,
      type,
      coordinates,
      layerId: `layer-${li}`,
      properties: { ...extra, name: `n ${i}` },
      locked: false,
      visible: true,
    });
    perLayer[li].push(id);
  }
  const groups: Group[] = [];
  let seq = 0;
  for (let li = 0; li < layerCount; li++) {
    const ids = perLayer[li];
    const target = Math.floor(ids.length * 0.15);
    let cursor = 0;
    const groupIds: string[] = [];
    while (cursor < target) {
      const size = Math.min(3 + Math.floor(rand() * 6), target - cursor);
      if (size < 2) break;
      const members = ids.slice(cursor, cursor + size);
      const gid = `g-${seq++}`;
      for (const m of members) {
        const f = features.find((x) => x.id === m);
        if (f) f.groupId = gid;
      }
      groups.push({ id: gid, name: gid, featureIds: members, locked: false, visible: true });
      groupIds.push(gid);
      cursor += size;
    }
    layers[li].order = [...groupIds, ...ids.slice(cursor)];
  }
  return { version: '2.0.0', layers, layerOrder: layers.map((l) => l.id), groups, features };
}

// Measurement equivalent to a browser: wires up the EventBridge plus an O(N) idempotent
// subscriber on every public event, and returns the elapsed time of 1 load. Because the
// minimum is taken to resist noise, it returns the time of a single run and the caller
// repeats it.
function measureLoadOnce(data: Data): number {
  const store = new MemoryStore();
  const spatialIndex = new RBushSpatialIndex();
  store.createLayer({
    id: 'default-layer',
    name: 'L',
    visible: true,
    locked: false,
    opacity: 1,
    order: [],
  });
  let c = 0;
  const context = {
    store,
    spatialIndex,
    generateFeatureId: () => `x-${c++}`,
    getCurrentLayerId: () => 'default-layer',
    autoNameGenerator: { generateName: () => undefined },
  } as unknown as Context;
  const api = createImportExportAPI(context);

  const emitter = new EventEmitterImpl();
  const bridge = new EventBridgeImpl(store, emitter);
  bridge.start();
  // An O(N) idempotent subscriber equivalent to recomputing a list in the frontend. If
  // the folding breaks it is called N times and becomes quadratic.
  const emitLike = () => {
    let acc = 0;
    for (const f of store.getAllFeatures()) acc += f.id.length;
    if (acc < 0) throw new Error('unreachable');
  };
  for (const ev of [
    'feature.create',
    'feature.update',
    'feature.delete',
    'layer.create',
    'layer.update',
    'layer.delete',
    'group.create',
    'group.update',
    'group.delete',
    'metadata.change',
  ] as const) {
    emitter.on(ev, emitLike);
  }

  const start = performance.now();
  void api.load(data);
  const elapsed = performance.now() - start;
  bridge.stop();
  return elapsed;
}

function minLoadMs(data: Data, reps: number): number {
  let best = Number.POSITIVE_INFINITY;
  for (let k = 0; k < reps; k++) {
    const t = measureLoadOnce(data);
    if (t < best) best = t;
  }
  return best;
}

describe('load scaling (regression prevention)', () => {
  it('keeps the load time under 8 times even when N is multiplied by 4 (not quadratic)', () => {
    const small = generate(1000);
    const large = generate(4000);

    // Warm-up (to exclude the outliers of JIT / the first compilation).
    measureLoadOnce(small);
    measureLoadOnce(large);

    const tSmall = minLoadMs(small, 5);
    const tLarge = minLoadMs(large, 5);

    const ratio = tLarge / tSmall;
    // About 4x if linear. About 16x if quadratic. If it exceeds 8x it is regarded as a
    // quadratic regression and fails.
    expect(ratio).toBeLessThan(8);
  });
});

/**
 * A regression test that the membership decision of layer.order is O(1).
 *
 * When N is varied, terms unrelated to the membership decision, such as the growth of the
 * Map and GC, grow along with it, and the time ratio easily picks up noise. So it is made
 * a comparison of shapes at the same N: "putting the same N into 1 layer vs spreading it
 * over K layers". The number of createFeature calls and the amount of what is produced
 * are the same in both, so only the cost of the decision makes the difference.
 *
 * If the decision is a scan of the order array (O(k)), then 1 layer is N^2/2 and K layers
 * is N^2/(2K), so the ratio is about K times. With an index (a Set), both are O(N) and
 * the ratio is about 1 time.
 */
const ORDER_SCALING_N = 20000;
const ORDER_SCALING_LAYERS = 20;

// The elapsed time (in ms) of putting N features evenly into layerCount layers.
// The layers are created with an empty order, and each insertion appends to the order
// (the equivalent of a geojson import).
function measureSpreadMs(layerCount: number): number {
  const store = new MemoryStore();
  for (let i = 0; i < layerCount; i++) {
    store.createLayer({
      id: `L${i}`,
      name: `L${i}`,
      visible: true,
      locked: false,
      opacity: 1,
      order: [],
    });
  }

  const start = performance.now();
  store.transact(() => {
    for (let i = 0; i < ORDER_SCALING_N; i++) {
      store.createFeature({
        id: `f-${i}`,
        type: 'Point',
        coordinates: [0, 0],
        layerId: `L${i % layerCount}`,
        properties: {},
        locked: false,
        visible: true,
      });
    }
  }, 'silent');
  return performance.now() - start;
}

function minSpreadMs(layerCount: number, reps: number): number {
  let best = Number.POSITIVE_INFINITY;
  for (let k = 0; k < reps; k++) {
    const t = measureSpreadMs(layerCount);
    if (t < best) best = t;
  }
  return best;
}

describe('scaling of the membership decision of layer.order (regression prevention)', () => {
  it('does not change the elapsed time much between 1 layer and many, for the same count', () => {
    // Warm-up (to exclude the outliers of JIT).
    measureSpreadMs(1);
    measureSpreadMs(ORDER_SCALING_LAYERS);

    const single = minSpreadMs(1, 5);
    const spread = minSpreadMs(ORDER_SCALING_LAYERS, 5);

    const ratio = single / spread;
    // About 1x with an O(1) decision (up to about 1.5x because of the difference in array
    // reallocation). If it goes back to scanning the order it becomes about 20x
    // (= the number of layers). The threshold is 4x, halfway between them.
    expect(ratio).toBeLessThan(4);
  });
});
