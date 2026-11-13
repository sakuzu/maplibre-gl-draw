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
 * of the public writes. The record was written with the writes of the resources before they moved
 * to `draw.write`, on ceb8cda2; the verbs are written for `draw.write` since, and the record is
 * compared as it is (`__snapshots__/write-parity.jsonl`). What `draw.write` does otherwise is
 * written down with the record, by the scene that shows it.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { FeatureCollection, Geometry, Polygon } from 'geojson';
import { afterEach, describe, expect, it } from 'vitest';
import { orientRings } from '../geometry/simplify.js';
import { featuresInOrder, listedGroups, listedLayers } from '../store/feature-stream.js';
import { MemoryStore } from '../store/memory.js';
import type { Store } from '../store/store.js';
import { createTableStore } from '../store/table-memory.js';
import { createMapStub } from '../test-utils.js';
import type { Draw } from './draw.js';
import { createDraw } from './draw.js';
import { DrawError } from './errors.js';
import type { Change } from './events.js';
import type { FeatureInput, FeaturePatch } from './model.js';
import type { Placement, Transaction } from './write.js';

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

/**
 * The outcome of a write: a refusal of the state (`notEditable`, `locked`) is what the writes
 * returned `null` or `false` for before they moved to `draw.write`
 */
async function caught(run: () => Promise<unknown>): Promise<Outcome> {
  try {
    await run();
    return 'done';
  } catch (error) {
    if (error instanceof DrawError) {
      return error.code === 'notEditable' || error.code === 'locked'
        ? 'refused'
        : `error:${error.code}`;
    }
    throw error;
  }
}

const KEY = (name: string) => `maplibre-gl-draw:${name}`;

/** A feature of the scenes as a GeoJSON Feature */
function featureOf(input: Input): FeatureInput {
  const properties: Record<string, unknown> = { ...input.properties };
  if (input.layerId !== undefined) properties[KEY('layerId')] = input.layerId;
  if (input.groupId !== undefined) properties[KEY('groupId')] = input.groupId;
  if (input.geometry !== null && input.type !== input.geometry?.type) {
    properties[KEY('featureType')] = input.type;
  }
  if (input.style !== undefined) properties[KEY('style')] = input.style;
  if (input.visible !== undefined) properties[KEY('visible')] = input.visible;
  if (input.locked !== undefined) properties[KEY('locked')] = input.locked;
  return { type: 'Feature', id: input.id, geometry: input.geometry, properties } as FeatureInput;
}

/** A change of the scenes as a patch of `tx.features.update` */
function patchOf(patch: Patch): FeaturePatch {
  const properties: Record<string, unknown> = { ...patch.properties };
  if (patch.style !== undefined) properties[KEY('style')] = patch.style;
  if (patch.visible !== undefined) properties[KEY('visible')] = patch.visible;
  if (patch.locked !== undefined) properties[KEY('locked')] = patch.locked;
  return {
    ...(patch.geometry !== undefined && { geometry: patch.geometry }),
    ...(Object.keys(properties).length > 0 && { properties }),
    ...(patch.removeKeys !== undefined && { unset: { properties: patch.removeKeys } }),
  } as FeaturePatch;
}

/** Runs a write in a transaction */
type Run = (fn: (tx: Transaction) => Promise<unknown>) => Promise<unknown>;

/** The verbs on `draw.write`: each verb is one write, or a write of the transaction given */
function writesOf(draw: Draw, run: Run = (fn) => draw.write(fn)): Writes {
  const write = (fn: (tx: Transaction) => Promise<unknown>) => caught(() => run(fn));
  const w: Writes = {
    create: (input) => write((tx) => tx.features.create(featureOf(input))),
    createMany: (inputs) => write((tx) => tx.features.create(inputs.map(featureOf))),
    update: (id, patch) => write((tx) => tx.features.update(id, patchOf(patch))),
    updateMany: (entries) =>
      write((tx) =>
        tx.features.update(entries.map(({ id, patch }) => ({ id, patch: patchOf(patch) }))),
      ),
    delete: (id) => write((tx) => tx.features.delete(id)),
    deleteMany: (ids) => write((tx) => tx.features.delete(ids)),
    place: (ids, to) => write((tx) => tx.features.place(ids, to as Placement)),
    createLayer: (input) => write((tx) => tx.layers.create(input)),
    updateLayer: (id, patch) => write((tx) => tx.layers.update(id, patch)),
    deleteLayer: (id) => write((tx) => tx.layers.delete(id)),
    placeLayer: (id, above) => write((tx) => tx.layers.place(id, { below: above })),
    createGroup: (input) =>
      write((tx) => tx.groups.create({ id: input.id, name: input.name, members: input.members })),
    updateGroup: (id, patch) => write((tx) => tx.groups.update(id, patch)),
    deleteGroup: (id) => write((tx) => tx.groups.delete(id, { members: 'keep' })),
    placeGroup: (id, to) => write((tx) => tx.groups.place(id, to as Placement)),
    updateDocument: (patch) => write((tx) => tx.document.update(patch)),
    importGeoJSON: (collection, layerId) =>
      write((tx) => tx.import(collection, layerId ? { layer: layerId } : undefined)),
    union: (ids) => write((tx) => tx.features.union(ids)),
    difference: (id, others) => write((tx) => tx.features.difference(id, others)),
    intersection: (ids) => write((tx) => tx.features.intersection(ids)),
    split: (id, lineId) => write((tx) => tx.features.split(id, lineId)),
    buffer: (id, distanceMeters) => write((tx) => tx.features.buffer(id, distanceMeters)),
    together: (steps) =>
      write(async (tx) => {
        const inner = writesOf(draw, (fn) => fn(tx));
        const outcomes = await Promise.all(steps.map((step) => step(inner)));
        const failed = outcomes.find((outcome) => outcome !== 'done');
        if (failed) throw new Error(failed);
      }),
    deleteSelected: (ids) =>
      write((tx) => {
        draw.selection.set('feature', ids);
        return tx.features.delete(draw.selection.target);
      }),
    placeSelected: (ids, layerId) =>
      write((tx) => {
        draw.selection.set('feature', ids);
        return tx.features.place(draw.selection.target, { layerId });
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

/**
 * A line of the record as `draw.write` writes it: what changed on purpose since the record was
 * written, and nothing else.
 *
 * - The rings of a polygon are put in the right-hand rule as they are written (12-m14-114), where
 *   the writes kept them as they were given (a ring drawn clockwise, a GeoJSON polygon read)
 * - A GeoJSON source added is part of the commit of its transaction (`tx.import`): its source is
 *   that of the transaction, `local`, where a load was told with the source `load`
 */
function asWrittenNow(line: Record<string, unknown>): Record<string, unknown> {
  if (Array.isArray(line.told)) {
    return {
      ...line,
      told: line.told.map((told: { source: string }) =>
        told.source === 'load' ? { ...told, source: 'local' } : told,
      ),
    };
  }
  const document = line.document as { features: { geometry: Geometry }[] } | undefined;
  if (!document) return line;
  return {
    document: {
      ...document,
      features: document.features.map((feature) => ({
        ...feature,
        geometry: orientRings(feature.geometry),
      })),
    },
  };
}

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
    if (process.env.WRITE_PARITY_OUT) {
      writeFileSync(process.env.WRITE_PARITY_OUT, `${lines.join('\n')}\n`);
    }
    const expected = readFileSync(SNAPSHOT, 'utf8')
      .split('\n')
      .filter((line) => line !== '');
    expect(lines.length).toBe(expected.length);
    lines.forEach((line, i) => {
      expect(JSON.parse(line)).toEqual(asWrittenNow(JSON.parse(expected[i])));
    });
  });

  it('are taken back one step at a time, and made again', async () => {
    const failures: string[] = [];
    for (const scene of SCENES) {
      for (const [kind, makeStore] of KINDS) {
        if (kind === 'rows' && scene.rows !== true) continue;
        const store = makeStore();
        let next = 0;
        draw = createDraw(createMapStub().map, {
          store,
          initDefaultLayer: false,
          generateId: () => `n${++next}`,
        });
        const w = writesOf(draw);
        const empty = JSON.stringify(documentOf(store));
        await w.createLayer({ id: 'a', name: 'A' });
        await w.createLayer({ id: 'b', name: 'B' });
        await scene.run(w, async (_name, outcome) => {
          await outcome;
        });
        w.setReadOnly(false);
        const written = JSON.stringify(documentOf(store));
        let undone = 0;
        for (;;) {
          try {
            await draw.undo();
            undone++;
          } catch (error) {
            if ((error as DrawError).code !== 'invalidState') throw error;
            break;
          }
        }
        if (JSON.stringify(documentOf(store)) !== empty) {
          failures.push(`${scene.name} / ${kind}: undo (${undone} steps)`);
        }
        for (let i = 0; i < undone; i++) await draw.redo();
        if (JSON.stringify(documentOf(store)) !== written) {
          failures.push(`${scene.name} / ${kind}: redo`);
        }
        draw.destroy();
        draw = undefined;
      }
    }
    expect(failures).toEqual([]);
  });
});
