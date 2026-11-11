// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What the public writes do, written down once and compared after the writes move to another
 * shape
 *
 * Each scene makes a few writes of the document through the public writes of the instance, on a
 * Store of objects and on a Store of rows, and records after each one what it gave (done, refused
 * or the code of the error), the commits it told (`change`: where they came from, the IDs of what
 * changed and whether the document changed) and, at the end, the document as the Store holds it.
 * The writes are made through one small set of verbs (`Writes`), the only part that knows the shape
 * of the public writes: once the shape changes, the verbs are written again and the record is
 * compared as it is (`__snapshots__/write-parity.jsonl`).
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { FeatureCollection, Geometry, Polygon } from 'geojson';
import { afterEach, describe, expect, it } from 'vitest';
import { featuresInOrder, listedGroups, listedLayers } from '../store/feature-stream.js';
import { MemoryStore } from '../store/memory.js';
import type { Store } from '../store/store.js';
import { createTableStore } from '../store/table-memory.js';
import { createMapStub } from '../test-utils.js';
import type { Draw } from './draw.js';
import { createDraw } from './draw.js';
import { DrawError } from './errors.js';
import type { Change } from './events.js';

const SNAPSHOT = new URL('./__snapshots__/write-parity.jsonl', import.meta.url);

/** What a write gave: done, refused by the state, or failed with a code */
type Outcome = 'done' | 'refused' | `error:${string}`;

/** A feature to create, in the terms of the scenes */
interface Input {
  readonly id: string;
  readonly type: string;
  readonly geometry: Geometry;
  readonly layerId?: string;
  readonly groupId?: string;
  readonly properties?: Record<string, unknown>;
  readonly style?: Record<string, unknown>;
  readonly visible?: boolean;
  readonly locked?: boolean;
}

/** A change of a feature, in the terms of the scenes */
interface Patch {
  readonly geometry?: Geometry;
  readonly properties?: Record<string, unknown>;
  /** Keys of `properties` to remove */
  readonly removeKeys?: readonly string[];
  readonly style?: Record<string, unknown>;
  readonly visible?: boolean;
  readonly locked?: boolean;
}

/** Where to put features or a group */
type Place =
  | { readonly layerId: string }
  | { readonly groupId: string }
  | { readonly below: string }
  | { readonly above: string };

/** The verbs of the scenes: the only part that knows the shape of the public writes */
interface Writes {
  create(input: Input): Promise<Outcome>;
  createMany(inputs: readonly Input[]): Promise<Outcome>;
  update(id: string, patch: Patch): Promise<Outcome>;
  updateMany(entries: readonly { id: string; patch: Patch }[]): Promise<Outcome>;
  delete(id: string): Promise<Outcome>;
  deleteMany(ids: readonly string[]): Promise<Outcome>;
  place(ids: readonly string[], to: Place): Promise<Outcome>;
  createLayer(input: { id: string; name: string; locked?: boolean }): Promise<Outcome>;
  updateLayer(
    id: string,
    patch: { name?: string; visible?: boolean; locked?: boolean },
  ): Promise<Outcome>;
  deleteLayer(id: string): Promise<Outcome>;
  /** Puts the layer just above another */
  placeLayer(id: string, above: string): Promise<Outcome>;
  createGroup(input: { id: string; name: string; members: readonly string[] }): Promise<Outcome>;
  updateGroup(id: string, patch: { name?: string; locked?: boolean }): Promise<Outcome>;
  /** Deletes a group, its members kept */
  deleteGroup(id: string): Promise<Outcome>;
  placeGroup(id: string, to: Place): Promise<Outcome>;
  updateDocument(patch: { title?: string; description?: string }): Promise<Outcome>;
  importGeoJSON(collection: FeatureCollection, layerId?: string): Promise<Outcome>;
  union(ids: readonly string[]): Promise<Outcome>;
  difference(id: string, others: readonly string[]): Promise<Outcome>;
  intersection(ids: readonly string[]): Promise<Outcome>;
  split(id: string, lineId: string): Promise<Outcome>;
  buffer(id: string, distanceMeters: number): Promise<Outcome>;
  /** Several writes as one commit */
  together(steps: readonly ((w: Writes) => Promise<Outcome>)[]): Promise<Outcome>;
  /** Deletes the features selected */
  deleteSelected(ids: readonly string[]): Promise<Outcome>;
  /** Puts the features selected into a layer */
  placeSelected(ids: readonly string[], layerId: string): Promise<Outcome>;
  setReadOnly(value: boolean): void;
}

/** The outcome of a write that returns null or false when it is refused */
function outcomeOf(result: unknown): Outcome {
  return result === null || result === false ? 'refused' : 'done';
}

async function caught(run: () => unknown): Promise<Outcome> {
  try {
    return outcomeOf(await run());
  } catch (error) {
    if (error instanceof DrawError) return `error:${error.code}`;
    throw error;
  }
}

/** The patch of the scenes in the shape of `features.update` */
function patchOf(patch: Patch): Record<string, unknown> {
  const { removeKeys, ...rest } = patch;
  if (!removeKeys) return rest;
  return {
    ...rest,
    properties: {
      ...rest.properties,
      ...Object.fromEntries(removeKeys.map((key) => [key, undefined])),
    },
  };
}

/** A place in the terms of `ItemPlacement`: the container of a neighbor is read from it */
function placementOf(draw: Draw, to: Place): Record<string, unknown> {
  if ('layerId' in to || 'groupId' in to) return to;
  const neighbor = 'below' in to ? to.below : to.above;
  const item = draw.features.get(neighbor) ?? draw.groups.get(neighbor);
  const groupId = item && 'groupId' in item ? item.groupId : undefined;
  return { layerId: item?.layerId, ...(groupId ? { groupId } : {}), ...to };
}

/** The verbs on the public writes of the instance (`draw.features.create` and the rest) */
function writesOf(draw: Draw): Writes {
  const w: Writes = {
    create: (input) => caught(() => draw.features.create(input as never)),
    createMany: (inputs) => caught(() => draw.features.createMany(inputs as never)),
    update: (id, patch) => caught(() => draw.features.update(id, patchOf(patch) as never)),
    updateMany: (entries) =>
      caught(() =>
        draw.features.updateMany(
          entries.map(({ id, patch }) => ({ id, patch: patchOf(patch) as never })),
        ),
      ),
    delete: (id) => caught(() => draw.features.delete(id)),
    deleteMany: (ids) => caught(() => draw.features.deleteMany(ids)),
    place: (ids, to) => caught(() => draw.features.moveMany(ids, placementOf(draw, to) as never)),
    createLayer: (input) => caught(() => draw.layers.create(input)),
    updateLayer: (id, patch) => caught(() => draw.layers.update(id, patch)),
    deleteLayer: (id) => caught(() => draw.layers.delete(id)),
    placeLayer: (id, above) =>
      caught(() => {
        const order = draw.layers.getOrder().filter((other) => other !== id);
        order.splice(order.indexOf(above) + 1, 0, id);
        return draw.layers.reorder(order);
      }),
    createGroup: (input) =>
      caught(() =>
        draw.groups.create({ id: input.id, name: input.name, featureIds: input.members }),
      ),
    updateGroup: (id, patch) => caught(() => draw.groups.update(id, patch)),
    deleteGroup: (id) => caught(() => draw.groups.delete(id)),
    placeGroup: (id, to) => caught(() => draw.groups.move(id, placementOf(draw, to) as never)),
    updateDocument: (patch) => caught(() => draw.metadata.update(patch)),
    importGeoJSON: (collection, layerId) =>
      caught(() =>
        draw.document.load(collection, { mode: 'merge', ...(layerId ? { layerId } : {}) }),
      ),
    union: (ids) => caught(() => draw.features.union(ids)),
    difference: (id, others) => caught(() => draw.features.difference(id, others)),
    intersection: (ids) => caught(() => draw.features.intersection(ids)),
    split: (id, lineId) => caught(() => draw.features.split(id, lineId)),
    buffer: (id, distanceMeters) => caught(() => draw.features.buffer([id], { distanceMeters })),
    together: (steps) =>
      caught(async () => {
        const outcomes: Outcome[] = [];
        draw.transact(() => {
          for (const step of steps) {
            // The verbs of the old writes run in the task they are made in
            void step(w).then((outcome) => outcomes.push(outcome));
          }
        });
        await Promise.resolve();
        return outcomes.every((outcome) => outcome === 'done') ? true : null;
      }),
    deleteSelected: (ids) =>
      caught(() => {
        draw.selection.set('feature', ids);
        return draw.selection.delete();
      }),
    placeSelected: (ids, layerId) =>
      caught(() => {
        draw.selection.set('feature', ids);
        return draw.selection.move({ layerId });
      }),
    setReadOnly: (value) => draw.setReadOnly(value),
  };
  return w;
}

// ============================================================================
// The record
// ============================================================================

/** What a commit told, without what the later shape adds */
function toldOf(change: Change) {
  const ids = (list: {
    created: readonly string[];
    updated: readonly string[];
    deleted: readonly string[];
    placed: readonly string[];
  }) => ({
    created: [...list.created].sort(),
    updated: [...list.updated].sort(),
    deleted: [...list.deleted].sort(),
    placed: [...list.placed].sort(),
  });
  return {
    source: change.source,
    features: ids(change.features),
    layers: ids(change.layers),
    groups: ids(change.groups),
    document: change.document,
  };
}

/** The document as the Store holds it, read the same way whatever shape the public writes have */
function documentOf(store: Store) {
  const features = [...featuresInOrder(store)].map((feature) => ({
    id: feature.id,
    type: feature.type,
    geometry: feature.geometry,
    layerId: feature.layerId,
    groupId: feature.groupId ?? null,
    properties: feature.properties,
    style: feature.style,
    visible: feature.visible,
    locked: feature.locked,
  }));
  const layers = listedLayers(store).map((layer) => ({
    id: layer.id,
    name: layer.name,
    visible: layer.visible,
    locked: layer.locked,
    items: layer.items,
  }));
  const groups = listedGroups(store)
    .map((group) => ({
      id: group.id,
      name: group.name,
      layerId: group.layerId,
      visible: group.visible,
      locked: group.locked,
      featureIds: group.featureIds,
    }))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  return { order: store.getLayerOrder(), layers, groups, features, metadata: store.getMetadata() };
}

// ============================================================================
// The scenes
// ============================================================================

function square(x: number, y: number, size: number, clockwise = false): Polygon {
  const ring = [
    [x, y],
    [x + size, y],
    [x + size, y + size],
    [x, y + size],
    [x, y],
  ];
  return { type: 'Polygon', coordinates: [clockwise ? ring.reverse() : ring] };
}

function point(id: string, x: number, extra: Partial<Input> = {}): Input {
  return { id, type: 'Point', geometry: { type: 'Point', coordinates: [x, 0] }, ...extra };
}

function area(id: string, x: number, extra: Partial<Input> = {}): Input {
  return { id, type: 'Polygon', geometry: square(x, 0, 2), ...extra };
}

/** A scene: what it writes, on a document with the layers `a` and `b` */
interface Scene {
  readonly name: string;
  /** Whether it runs on a Store of rows as well */
  readonly rows?: boolean;
  run(w: Writes, step: (name: string, outcome: Promise<Outcome>) => Promise<void>): Promise<void>;
}

const SCENES: readonly Scene[] = [
  {
    name: 'a point created',
    rows: true,
    async run(w, step) {
      await step('create', w.create(point('p1', 1, { layerId: 'a', properties: { name: 'one' } })));
    },
  },
  {
    name: 'features created at once',
    rows: true,
    async run(w, step) {
      await step(
        'createMany',
        w.createMany([
          point('p1', 1, { layerId: 'a' }),
          {
            id: 'l1',
            type: 'LineString',
            geometry: {
              type: 'LineString',
              coordinates: [
                [0, 0],
                [1, 1],
              ],
            },
            layerId: 'a',
          },
          area('s1', 3, { layerId: 'b', style: { fillColor: '#ff0000' } }),
        ]),
      );
    },
  },
  {
    name: 'an area drawn clockwise',
    rows: true,
    async run(w, step) {
      await step(
        'create',
        w.create({ id: 'cw', type: 'Polygon', geometry: square(0, 0, 1, true), layerId: 'a' }),
      );
    },
  },
  {
    name: 'a feature updated key by key',
    rows: true,
    async run(w, step) {
      await step(
        'create',
        w.create(
          point('p1', 1, {
            layerId: 'a',
            properties: { name: 'one', n: 1 },
            style: { pointColor: '#000000', pointRadius: 4 },
          }),
        ),
      );
      await step('properties', w.update('p1', { properties: { n: 2, extra: true } }));
      await step('remove a key', w.update('p1', { removeKeys: ['name'] }));
      await step('style', w.update('p1', { style: { pointColor: '#ffffff' } }));
      await step('geometry', w.update('p1', { geometry: { type: 'Point', coordinates: [5, 5] } }));
      await step('hidden', w.update('p1', { visible: false }));
      await step('locked', w.update('p1', { locked: true }));
      await step('refused while locked', w.update('p1', { properties: { n: 3 } }));
      await step('unlocked', w.update('p1', { locked: false }));
    },
  },
  {
    name: 'features updated at once',
    rows: true,
    async run(w, step) {
      await step(
        'createMany',
        w.createMany([point('p1', 1, { layerId: 'a' }), point('p2', 2, { layerId: 'a' })]),
      );
      await step(
        'updateMany',
        w.updateMany([
          { id: 'p1', patch: { properties: { n: 1 } } },
          { id: 'p2', patch: { style: { pointRadius: 9 } } },
        ]),
      );
    },
  },
  {
    name: 'features deleted',
    rows: true,
    async run(w, step) {
      await step(
        'createMany',
        w.createMany([
          point('p1', 1, { layerId: 'a' }),
          point('p2', 2, { layerId: 'a' }),
          point('p3', 3, { layerId: 'b' }),
        ]),
      );
      await step('delete', w.delete('p1'));
      await step('deleteMany', w.deleteMany(['p2', 'p3']));
      await step('missing', w.delete('p1'));
    },
  },
  {
    name: 'features put elsewhere',
    rows: true,
    async run(w, step) {
      await step(
        'createMany',
        w.createMany([
          point('p1', 1, { layerId: 'a' }),
          point('p2', 2, { layerId: 'a' }),
          point('p3', 3, { layerId: 'a' }),
        ]),
      );
      await step('to another layer', w.place(['p1'], { layerId: 'b' }));
      await step('below another', w.place(['p3'], { below: 'p2' }));
      await step('above another', w.place(['p3'], { above: 'p2' }));
      await step('group', w.createGroup({ id: 'g1', name: 'G', members: ['p2'] }));
      await step('into the group', w.place(['p3'], { groupId: 'g1' }));
    },
  },
  {
    name: 'layers',
    rows: true,
    async run(w, step) {
      await step('create', w.createLayer({ id: 'c', name: 'C' }));
      await step('update', w.updateLayer('c', { name: 'Cee', visible: false }));
      await step('above another', w.placeLayer('a', 'c'));
      await step('point', w.create(point('p1', 1, { layerId: 'c' })));
      await step('delete with its features', w.deleteLayer('c'));
      await step('missing', w.updateLayer('c', { name: 'x' }));
    },
  },
  {
    name: 'groups',
    rows: true,
    async run(w, step) {
      await step(
        'createMany',
        w.createMany([
          point('p1', 1, { layerId: 'a' }),
          point('p2', 2, { layerId: 'a' }),
          point('p3', 3, { layerId: 'a' }),
        ]),
      );
      await step('create', w.createGroup({ id: 'g1', name: 'G', members: ['p1', 'p2'] }));
      await step('update', w.updateGroup('g1', { name: 'Gee' }));
      await step('above a feature', w.placeGroup('g1', { above: 'p3' }));
      await step('to another layer', w.placeGroup('g1', { layerId: 'b' }));
      await step('locked', w.updateGroup('g1', { locked: true }));
      await step('member refused', w.update('p1', { properties: { n: 1 } }));
      await step('unlocked', w.updateGroup('g1', { locked: false }));
      await step('delete keeping the members', w.deleteGroup('g1'));
    },
  },
  {
    name: 'the title and the description',
    async run(w, step) {
      await step('update', w.updateDocument({ title: 'T', description: 'D' }));
      await step('title', w.updateDocument({ title: 'T2' }));
    },
  },
  {
    name: 'GeoJSON added',
    rows: true,
    async run(w, step) {
      await step(
        'import',
        w.importGeoJSON(
          {
            type: 'FeatureCollection',
            features: [
              {
                type: 'Feature',
                id: 'g1',
                geometry: { type: 'Point', coordinates: [1, 2] },
                properties: { name: 'x' },
              },
              {
                type: 'Feature',
                geometry: square(0, 0, 1, true),
                properties: { 'maplibre-gl-draw:locked': true },
              },
            ],
          },
          'b',
        ),
      );
    },
  },
  {
    name: 'areas combined',
    async run(w, step) {
      await step(
        'createMany',
        w.createMany([
          area('s1', 0, { layerId: 'a' }),
          area('s2', 1, { layerId: 'a' }),
          area('s3', 10, { layerId: 'a' }),
          {
            id: 'cut',
            type: 'LineString',
            geometry: {
              type: 'LineString',
              coordinates: [
                [11, -1],
                [11, 3],
              ],
            },
            layerId: 'a',
          },
        ]),
      );
      await step('union', w.union(['s1', 's2']));
      await step('split', w.split('s3', 'cut'));
      await step('union of one', w.union(['s1']));
    },
  },
  {
    name: 'areas subtracted and intersected',
    async run(w, step) {
      await step(
        'createMany',
        w.createMany([
          area('s1', 0, { layerId: 'a' }),
          area('s2', 1, { layerId: 'a' }),
          area('s3', 0.5, { layerId: 'a' }),
        ]),
      );
      await step('difference', w.difference('s1', ['s2']));
      await step('intersection', w.intersection(['s2', 's3']));
    },
  },
  {
    name: 'a buffer',
    async run(w, step) {
      await step('create', w.create(point('p1', 1, { layerId: 'a' })));
      await step('buffer', w.buffer('p1', 1000));
    },
  },
  {
    name: 'several writes as one commit',
    rows: true,
    async run(w, step) {
      await step(
        'together',
        w.together([
          (x) => x.create(point('p1', 1, { layerId: 'a' })),
          (x) => x.create(point('p2', 2, { layerId: 'b' })),
          (x) => x.updateDocument({ title: 'both' }),
        ]),
      );
    },
  },
  {
    name: 'the selection deleted and put elsewhere',
    rows: true,
    async run(w, step) {
      await step(
        'createMany',
        w.createMany([
          point('p1', 1, { layerId: 'a' }),
          point('p2', 2, { layerId: 'a' }),
          point('p3', 3, { layerId: 'a' }),
        ]),
      );
      await step('put elsewhere', w.placeSelected(['p1', 'p2'], 'b'));
      await step('deleted', w.deleteSelected(['p2', 'p3']));
    },
  },
  {
    name: 'refused while read-only',
    rows: true,
    async run(w, step) {
      await step('create', w.create(point('p1', 1, { layerId: 'a' })));
      w.setReadOnly(true);
      await step('create', w.create(point('p2', 2, { layerId: 'a' })));
      await step('update', w.update('p1', { properties: { n: 1 } }));
      await step('delete', w.delete('p1'));
      await step('layer', w.createLayer({ id: 'c', name: 'C' }));
      w.setReadOnly(false);
      await step('create', w.create(point('p3', 3, { layerId: 'a' })));
    },
  },
  {
    name: 'refused on a locked layer',
    rows: true,
    async run(w, step) {
      await step('create', w.create(point('p1', 1, { layerId: 'a' })));
      await step('lock', w.updateLayer('a', { locked: true }));
      await step('update', w.update('p1', { properties: { n: 1 } }));
      await step('delete', w.delete('p1'));
      await step('place', w.place(['p1'], { layerId: 'b' }));
    },
  },
  {
    name: 'inputs of the wrong shape',
    rows: true,
    async run(w, step) {
      await step(
        'no geometry',
        w.create({ id: 'x', type: 'Point', geometry: null as never, layerId: 'a' }),
      );
      await step('missing layer', w.create(point('x', 1, { layerId: 'nothing' })));
      await step('taken ID', w.create(point('a', 1, { layerId: 'a' })));
      await step('create', w.create(point('p1', 1, { layerId: 'a' })));
      await step('taken ID of a feature', w.create(point('p1', 1, { layerId: 'a' })));
      await step('missing feature', w.update('nothing', { properties: { n: 1 } }));
    },
  },
];

// ============================================================================
// Running and comparing
// ============================================================================

let draw: Draw | undefined;

afterEach(() => {
  draw?.destroy();
  draw = undefined;
});

const KINDS: ReadonlyArray<readonly [string, () => Store]> = [
  ['objects', () => new MemoryStore()],
  ['rows', () => createTableStore().store],
];

async function record(scene: Scene, kind: string, makeStore: () => Store): Promise<string[]> {
  const store = makeStore();
  let next = 0;
  draw = createDraw(createMapStub().map, {
    store,
    initDefaultLayer: false,
    generateId: () => `n${++next}`,
  });
  const w = writesOf(draw);
  await w.createLayer({ id: 'a', name: 'A' });
  await w.createLayer({ id: 'b', name: 'B' });
  const told: ReturnType<typeof toldOf>[] = [];
  const stop = draw.on('change', (change) => told.push(toldOf(change)));
  const lines = [JSON.stringify({ scene: scene.name, store: kind })];
  await scene.run(w, async (name, outcome) => {
    const result = await outcome;
    lines.push(JSON.stringify({ step: name, outcome: result, told: told.splice(0) }));
  });
  stop();
  lines.push(JSON.stringify({ document: documentOf(store) }));
  draw.destroy();
  draw = undefined;
  return lines;
}

describe('the public writes', () => {
  it('do what they did', async () => {
    const lines: string[] = [];
    for (const scene of SCENES) {
      for (const [kind, makeStore] of KINDS) {
        if (kind === 'rows' && scene.rows !== true) continue;
        lines.push(...(await record(scene, kind, makeStore)));
      }
    }
    // Written once, on the shape before (`WRITE_PARITY=1`), and compared as it is after
    if (process.env.WRITE_PARITY === '1') {
      mkdirSync(new URL('.', SNAPSHOT), { recursive: true });
      writeFileSync(SNAPSHOT, `${lines.join('\n')}\n`);
    }
    const expected = readFileSync(SNAPSHOT, 'utf8')
      .split('\n')
      .filter((line) => line !== '');
    expect(lines.length).toBe(expected.length);
    lines.forEach((line, i) => {
      expect(JSON.parse(line)).toEqual(JSON.parse(expected[i]));
    });
  });
});
