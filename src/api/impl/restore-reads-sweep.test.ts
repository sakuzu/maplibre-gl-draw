// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The same list of edits and writings back, drawn at random from a seed, under several sets of
 * subscribers and listeners
 *
 * - After every step, the layer and the group of every feature, however it is read, are those of
 *   its row in the Store, nothing is read of a feature that is not there, and nothing not there is
 *   told as created, updated or moved; the other values are those another instance over the same
 *   Store reads
 * - Whoever asks for the values before, what is read of the document is the same, and so are the
 *   events, but for the values before and, in `feature.updated`, the fields of the feature before
 *   other than its layer and its group
 *
 * The edits are drawn from the rows of the Store, so that what is read does not change them. Some
 * of them are written to the Store directly, as a change made outside the instance is: the
 * layers, the groups (a group put in another layer takes its members with it), the places of rows,
 * new rows and their deletion. In the lists over many features the layer keeps none of the
 * features edited made.
 */

import { describe, expect, it } from 'vitest';
import { createStore } from '../../store/built-in/create-store.js';
import { compareKeys, createOrderKeyBetween } from '../../store/built-in/order-keys.js';
import type { FeatureRowField, Store } from '../../store/built-in/types.js';
import { createMapStub } from '../../test-utils.js';
import type { DocumentSubscribeOptions } from '../document.js';
import type { Draw } from '../draw.js';
import type { DrawEvents } from '../events.js';
import type { FeatureInput, FeaturePatch, FeatureValues, MoveTarget } from '../model.js';
import { createDraw } from './create-draw.js';

const LISTS = 150;
const STEPS = 30;
/** The lists over features that are not kept made, and the features read to let go of them */
const LISTS_NOT_KEPT = 20;
const OTHERS = 1_100;

/** A generator of numbers in [0, 1) from a seed, the same for the same seed */
function randomFrom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ============================================================================
// What is compared
// ============================================================================

/** A set of subscribers and listeners */
interface Watching {
  name: string;
  /** What the subscriber asks the values before of (null: no subscriber) */
  asks: DocumentSubscribeOptions['previousValues'] | null;
  listens: boolean;
}

const ALL: Watching = { name: 'all', asks: true, listens: false };
const OWN: Watching = { name: 'own', asks: ['local'], listens: false };
const OWN_LISTENED: Watching = { name: 'own, listened to', asks: ['local'], listens: true };
const ALL_LISTENED: Watching = { name: 'all, listened to', asks: true, listens: true };
const NONE: Watching = { name: 'none', asks: null, listens: false };

const EVENTS = [
  'feature.created',
  'feature.updated',
  'feature.deleted',
  'feature.moved',
  'group.moved',
  'group.created',
  'group.updated',
  'group.deleted',
  'layer.created',
  'layer.updated',
  'layer.deleted',
  'layer.reordered',
  'document.changed',
] as const satisfies readonly (keyof DrawEvents)[];

/** A value with its keys in order, the sets of IDs as sorted lists, without the values before */
function plain(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(plain);
  const object = value as Record<string, unknown>;
  if (typeof object.iterate === 'function') return [...object.iterate()].sort();
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(object).sort()) {
    if (object[key] !== undefined && key !== 'previousValues') out[key] = plain(object[key]);
  }
  return out;
}

/** One event told: its payload, and the IDs it names of features that are there */
interface Told {
  text: string;
  there: string[];
  /** The feature it tells as updated */
  updated?: string;
}

function toldOf(name: (typeof EVENTS)[number], payload: unknown): Told {
  const value = plain(payload) as Record<string, unknown>;
  const id = (value.feature as { id: string } | undefined)?.id;
  if (name === 'feature.updated') {
    const { layerId, groupId } = value.previous as { layerId: string; groupId?: string };
    value.previous = { layerId, groupId };
  }
  const there: string[] = [];
  if (name === 'feature.created') there.push(id as string);
  if (name === 'document.changed') {
    const ids = value.features as Record<'created' | 'updated' | 'moved', string[]>;
    there.push(...ids.created, ...ids.updated, ...ids.moved);
  }
  return {
    text: JSON.stringify([name, value]),
    there,
    ...(name === 'feature.updated' && { updated: id }),
  };
}

/** What one run of a list gave */
interface Run {
  /** What was read that is not in the Store */
  wrong: string[];
  steps: { edit: string; result: string; told: string[] }[];
  document: string;
  /** The writings back of another source that put a feature in another layer or group */
  placesBack: number;
  /** The writings back that told a feature as updated more than once, or updated and deleted */
  overlaps: number;
  /** The groups with members put in another layer by a write to the Store directly */
  groupsMoved: number;
}

// ============================================================================
// A run of a list
// ============================================================================

interface ListOptions {
  seed: number;
  watching: Watching;
  restores: boolean;
  /** Whether the features edited are never kept made */
  notKept: boolean;
}

/** A row as the edits are drawn from: where its feature is, and its type */
interface Row {
  layerId: string;
  groupId: string | undefined;
  type: string;
}

const LAYERS = ['first', 'second'];
const KEYS = ['k1', 'k2', 'k3'];

async function runList({ seed, watching, restores, notKept }: ListOptions): Promise<Run> {
  let ids = 0;
  let features = 0;
  let groups = 0;
  const options = { generateId: () => `x${ids++}`, initDefaultLayer: false };
  const store: Store = createStore();
  const draw: Draw = createDraw(createMapStub().map, { store, ...options });
  for (const id of LAYERS) draw.layers.create({ id, name: id });
  const others = Array.from({ length: notKept ? OTHERS : 0 }, (_, i) => `z${i}`);
  if (notKept) {
    draw.layers.create({ id: 'others', name: 'others' });
    draw.features.createMany(
      others.map((id) => ({
        id,
        type: 'Point',
        geometry: { type: 'Point', coordinates: [0, 0] },
        layerId: 'others',
      })),
    );
  }
  /** Lets go of the features the layer keeps made, but those of the third layer */
  const letGo = (): void => {
    for (const id of others) draw.features.get(id);
  };
  // Half of the lists read every feature after each step, which keeps it made
  const reads = !notKept && seed % 2 === 0;
  const run: Run = {
    wrong: [],
    steps: [],
    document: '',
    placesBack: 0,
    overlaps: 0,
    groupsMoved: 0,
  };

  // The values before of the changes of this client, whoever asks for more
  const values: { given: FeatureValues; placed: boolean }[] = [];
  let told: Told[] = [];
  if (watching.asks !== null) {
    draw.document.subscribe(
      ({ source, previousValues }) => {
        if (source === 'local' && previousValues)
          values.push({ given: previousValues, placed: false });
      },
      { previousValues: watching.asks },
    );
  }
  if (watching.listens) {
    for (const name of EVENTS) draw.on(name, (payload) => told.push(toldOf(name, payload)));
  }

  const rowsNow = (): Map<string, Row> => {
    const out = new Map<string, Row>();
    for (const layerId of LAYERS) {
      const view = store.tables.get(layerId);
      if (!view || view.rowCount === 0) continue;
      const refs = view.listRowRefs(0, view.rowCount);
      const { fields } = store.tables.readValues(refs, ['parent', 'type']);
      refs.forEach((ref, i) => {
        const parent = String(fields.get('parent')?.[i]);
        const group = store.getGroup(parent);
        out.set(store.tables.getRowId(ref) as string, {
          layerId: group ? group.layerId : parent,
          groupId: group ? parent : undefined,
          type: String(fields.get('type')?.[i]),
        });
      });
    }
    return out;
  };
  /** The layers of the edits that are there (one written to the Store directly may be gone) */
  const layersThere = (): string[] => LAYERS.filter((id) => store.getLayer(id) !== undefined);
  const groupsNow = (): string[] =>
    store
      .listGroups()
      .map(({ id }) => id)
      .sort();

  /** What the instance reads that is not in the Store */
  const check = (edit: string, wroteBack: boolean): void => {
    const rows = rowsNow();
    const wrong = (what: string) => run.wrong.push(`${watching.name}: ${edit}: ${what}`);
    const compare = (
      how: string,
      read: Iterable<{ id: string; layerId: string; groupId?: string }>,
    ): void => {
      const seen = new Set<string>();
      for (const { id, layerId, groupId } of read) {
        if (layerId === 'others') continue;
        seen.add(id);
        const row = rows.get(id);
        if (!row) wrong(`${how} gives ${id}, which is not there`);
        else if (row.layerId !== layerId || row.groupId !== groupId) {
          wrong(`${how} ${id} ${layerId}/${groupId}, not ${row.layerId}/${row.groupId}`);
        }
      }
      for (const id of rows.keys()) if (!seen.has(id)) wrong(`${how} does not give ${id}`);
    };
    for (let i = 0; i < features; i++) {
      if (!rows.has(`f${i}`) && draw.features.get(`f${i}`)) wrong(`get f${i}, not there`);
    }
    if (reads) {
      compare(
        'get',
        [...rows.keys()].flatMap((id) => draw.features.get(id) ?? []),
      );
    }
    compare('iterate', draw.features.iterate());
    compare('toJSON', draw.document.toJSON().features);
    for (const event of told) {
      for (const id of event.there) if (!rows.has(id)) wrong(`told of ${id}: ${event.text}`);
    }
    if (wroteBack) {
      // The other values, as another instance over the Store reads them
      const another = createDraw(createMapStub().map, { store, ...options });
      const textOf = (instance: Draw): string[] =>
        layersThere().flatMap((layerId) =>
          [...instance.features.iterate({ layerId })].map((f) => JSON.stringify(plain(f))),
        );
      const here = textOf(draw);
      textOf(another).forEach((text, i) => {
        if (here[i] !== text) wrong(`${here[i]}, not ${text}`);
      });
      another.destroy();
    }
  };

  const setUp = randomFrom(seed);
  const feature = (random: () => number): FeatureInput => {
    const line = random() < 0.5;
    const at = () => Math.round(random() * 1000) / 1000;
    const properties: Record<string, number> = {};
    for (const key of KEYS) if (random() < 0.6) properties[key] = Math.floor(random() * 100);
    return {
      id: `f${features++}`,
      ...(line
        ? {
            type: 'LineString',
            geometry: { type: 'LineString', coordinates: [0, 1, 2].map((x) => [x, at()]) },
          }
        : { type: 'Point', geometry: { type: 'Point', coordinates: [at(), at()] } }),
      layerId: LAYERS[Math.floor(random() * 2)],
      properties,
      style: random() < 0.5 ? { pointColor: '#000000' } : {},
    };
  };
  for (let i = 0, count = 4 + Math.floor(setUp() * 5); i < count; i++) {
    draw.features.create(feature(setUp));
  }
  values.length = 0;
  told = [];
  letGo();

  for (let step = 0; step < STEPS; step++) {
    const random = randomFrom(seed * 1000 + step);
    const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)];
    const rows = rowsNow();
    const there = [...rows.keys()].sort();
    const groupIds = groupsNow();
    /** The edit of the step, and the values it writes back */
    let edit: { name: string; run: () => unknown } | null = null;
    let written: typeof values = [];
    let source: string | undefined;
    /** Whether the edit is written to the Store directly */
    let direct = false;

    if (random() < 0.35) {
      const oldest = random() < 0.5;
      const count = 1 + Math.floor(random() * 3);
      source = random() < 0.3 ? undefined : 'back';
      const exceptProperties = random() < 0.3 ? [pick(KEYS)] : undefined;
      written = oldest ? values.slice(0, count) : values.slice(-count);
      if (written.length > 1 && random() < 0.3) written.splice(1, 1);
      const given = written.map((value) => value.given);
      if (restores && given.length > 0) {
        edit = {
          name: `restore ${given.length} ${source} ${exceptProperties}`,
          run: () =>
            draw.features.restore(given, {
              ...(source && { source }),
              ...(exceptProperties && { exceptProperties }),
            }),
        };
      }
    } else if (random() < 0.3) {
      direct = true;
      edit = storeEdit();
    } else {
      edit = drawEdit();
    }
    if (!edit) continue;

    const mark = values.length;
    let result: string;
    try {
      result = JSON.stringify(plain(await edit.run()));
    } catch (error) {
      const { code } = error as { code?: string };
      if (!code) throw error;
      result = `threw ${code}`;
    }
    const after = rowsNow();
    const placed = [...rows].some(([id, row]) => {
      const now = after.get(id);
      return now && (now.layerId !== row.layerId || now.groupId !== row.groupId);
    });
    for (const value of values.slice(mark)) value.placed = placed;
    if (written.length > 0 && restores) {
      if (source === 'back' && placed && written.some((value) => value.placed)) run.placesBack += 1;
      const updated = told.flatMap((event) => event.updated ?? []);
      const twice = new Set(updated).size < updated.length;
      if (twice || updated.some((id) => !after.has(id))) run.overlaps += 1;
      for (const value of written) values.splice(values.indexOf(value), 1);
    }
    const name = `seed ${seed} step ${step}: ${edit.name}`;
    check(name, (written.length > 0 && restores) || direct);
    run.steps.push({ edit: name, result, told: told.map(({ text }) => text) });
    told = [];
    letGo();

    function drawEdit(): { name: string; run: () => unknown } | null {
      const kind = pick([
        ...['create', 'update', 'update', 'delete', 'move', 'move', 'move', 'order', 'moveMany'],
        ...['group', 'group', 'ungroup', 'moveGroup', 'orderGroup', 'groupSelection'],
        ...['ungroupSelection', 'updateAll', 'translate', 'deleteMany'],
      ]);
      const as = (what: string, run: () => unknown) => ({ name: `${kind} ${what}`, run });
      if (there.length === 0 || kind === 'create') {
        if (there.length >= 12) return null;
        const input = feature(random);
        return as(`${input.id}`, () => draw.features.create(input));
      }
      const id = pick(there);
      const row = rows.get(id) as Row;
      const some = there.filter(() => random() < 0.4).slice(0, 4);
      if (some.length === 0) some.push(id);
      const index = random() < 0.6 ? { index: Math.floor(random() * 4) } : {};
      const layerId = pick(LAYERS);
      const groupId = groupIds.length > 0 ? pick(groupIds) : undefined;
      const colorOf = () =>
        `#${Math.floor(random() * 0xffffff)
          .toString(16)
          .padStart(6, '0')}`;
      const patchOf = (type?: string): FeaturePatch => {
        const what = random();
        if (what < 0.35) {
          const value = random() < 0.15 ? undefined : Math.floor(random() * 1000);
          return { properties: { [pick(KEYS)]: value } };
        }
        if (what < 0.7 || type === undefined) {
          const key = pick(['pointColor', 'strokeColor']);
          return { style: { [key]: random() < 0.1 ? undefined : colorOf() } };
        }
        const at = () => Math.round(random() * 1000) / 1000;
        return {
          geometry:
            type === 'Point'
              ? { type: 'Point', coordinates: [at(), at()] }
              : { type: 'LineString', coordinates: [0, 1, 2].map((x) => [x, at()]) },
        };
      };
      switch (kind) {
        case 'update': {
          const patch = patchOf(row.type);
          return as(`${id} ${JSON.stringify(patch)}`, () => draw.features.update(id, patch));
        }
        case 'updateAll': {
          const patch = patchOf();
          return as(`${some} ${JSON.stringify(patch)}`, () => draw.features.updateAll(some, patch));
        }
        case 'translate':
          return as(`${some}`, () =>
            draw.features.translate(some, { from: [0, 0], to: [0.125, 0.25] }),
          );
        case 'delete':
          return as(id, () => draw.features.delete(id));
        case 'deleteMany':
          return as(`${some.slice(0, 2)}`, () => draw.features.deleteMany(some.slice(0, 2)));
        case 'order': {
          const container = row.groupId ? { groupId: row.groupId } : { layerId: row.layerId };
          const to = { ...container, index: Math.floor(random() * 5) };
          return as(`${id} ${JSON.stringify(to)}`, () => draw.features.move(id, to));
        }
        case 'move':
        case 'moveMany': {
          const where = random();
          let to: MoveTarget = { groupId: null };
          if (where < 0.4) to = { layerId, ...index };
          else if (where < 0.75 && groupId !== undefined) to = { groupId, ...index };
          return kind === 'move'
            ? as(`${id} ${JSON.stringify(to)}`, () => draw.features.move(id, to))
            : as(`${some} ${JSON.stringify(to)}`, () => draw.features.moveMany(some, to));
        }
        case 'group':
        case 'groupSelection': {
          const members = there
            .filter((member) => {
              const place = rows.get(member) as Row;
              return place.layerId === layerId && (!place.groupId || random() < 0.3);
            })
            .slice(0, 3);
          if (members.length < 2 || groupIds.length >= 3) return null;
          if (kind === 'group') {
            const input = { id: `g${groups++}`, featureIds: members };
            return as(`${input.id} ${members}`, () => draw.groups.create(input));
          }
          return as(`${members}`, () => {
            draw.selection.set('feature', members);
            return draw.selection.group();
          });
        }
        default: {
          if (groupId === undefined) return null;
          if (kind === 'ungroup') return as(groupId, () => draw.groups.delete(groupId));
          if (kind === 'ungroupSelection') {
            return as(groupId, () => {
              draw.selection.set('group', [groupId]);
              return draw.selection.ungroup();
            });
          }
          const to =
            kind === 'moveGroup'
              ? { layerId, ...index }
              : {
                  layerId: store.getGroup(groupId)?.layerId ?? layerId,
                  index: Math.floor(random() * 4),
                };
          return as(`${groupId} ${JSON.stringify(to)}`, () => draw.groups.move(groupId, to));
        }
      }
    }

    /** A write to the Store directly, as a change made outside the instance is written */
    function storeEdit(): { name: string; run: () => unknown } | null {
      const kind = pick([
        ...['layer', 'layer', 'deleteLayer', 'group', 'group', 'moveGroup', 'moveGroup'],
        ...['orderGroup', 'ungroup', 'place', 'place', 'place', 'order', 'create', 'delete'],
      ]);
      const as = (what: string, write: () => unknown) => ({
        name: `store ${kind} ${what}`,
        run: () => store.transact(write, 'remote'),
      });
      const layers = layersThere();
      /** The rows there of a layer, at random */
      const rowsOf = (layerId: string, most: number): string[] => {
        const of = there.filter((id) => rows.get(id)?.layerId === layerId);
        return of.filter(() => random() < 0.5).slice(0, most);
      };
      /** A key of a new place among the items of a layer or a group, at random */
      const keyIn = (container: string, taken: string[] = []): string => {
        const keys = [...taken];
        for (const layerId of layers) {
          const view = store.tables.get(layerId);
          if (!view || view.rowCount === 0) continue;
          const refs = view.listRowRefs(0, view.rowCount);
          const { fields } = store.tables.readValues(refs, ['parent', 'orderKey']);
          refs.forEach((_, i) => {
            if (String(fields.get('parent')?.[i]) === container) {
              keys.push(String(fields.get('orderKey')?.[i]));
            }
          });
        }
        for (const group of store.listGroups()) {
          if (group.layerId === container) keys.push(group.orderKey);
        }
        keys.sort(compareKeys);
        const at = Math.floor(random() * (keys.length + 1));
        const behind = keys[at - 1];
        const front = keys[at];
        return behind !== undefined && behind === front
          ? createOrderKeyBetween(keys[keys.length - 1], undefined)
          : createOrderKeyBetween(behind, front);
      };
      /** Writes the places of rows of one layer: in `parent`, or in their own container */
      const place = (ids: string[], parent: string | null): void => {
        const refs = Int32Array.from(ids, (id) => store.tables.getRowRef(id) as number);
        const keys: string[] = [];
        for (const id of ids) {
          const row = rows.get(id) as Row;
          keys.push(keyIn(parent ?? row.groupId ?? row.layerId, keys));
        }
        const fields = new Map<FeatureRowField, unknown[]>([['orderKey', keys]]);
        if (parent !== null)
          fields.set(
            'parent',
            ids.map(() => parent),
          );
        store.writeRows({ rows: refs, fields });
      };
      switch (kind) {
        case 'layer': {
          const gone = LAYERS.find((id) => !layers.includes(id));
          if (gone !== undefined) {
            const layer = { id: gone, name: gone, visible: true, locked: false, opacity: 1 };
            return as(gone, () =>
              store.createLayer({ ...layer, styleRule: undefined, metadata: undefined }),
            );
          }
          const id = pick(layers);
          const name = `${id} ${step}`;
          return as(`${id} ${name}`, () => store.updateLayer(id, { name }));
        }
        case 'deleteLayer': {
          if (layers.length === 0 || random() < 0.5) return null;
          const id = pick(layers);
          return as(id, () => store.deleteLayer(id));
        }
        case 'group': {
          if (layers.length === 0 || groupIds.length >= 3) return null;
          const layerId = pick(layers);
          const members = rowsOf(layerId, 3);
          if (members.length === 0) return null;
          const id = `g${groups++}`;
          return as(`${id} ${layerId} ${members}`, () => {
            const orderKey = keyIn(layerId);
            store.createGroup({ id, name: id, visible: true, locked: false, layerId, orderKey });
            place(members, id);
          });
        }
        case 'moveGroup':
        case 'orderGroup': {
          if (groupIds.length === 0) return null;
          const id = pick(groupIds);
          const layerId =
            kind === 'moveGroup' && layers.length > 0
              ? pick(layers)
              : (store.getGroup(id)?.layerId as string);
          const moves = layerId !== store.getGroup(id)?.layerId;
          if (moves && there.some((member) => rows.get(member)?.groupId === id)) {
            run.groupsMoved += 1;
          }
          return as(`${id} ${layerId}`, () => {
            const orderKey = keyIn(layerId);
            return kind === 'moveGroup'
              ? store.updateGroup(id, { layerId, orderKey })
              : store.updateGroup(id, { orderKey });
          });
        }
        case 'ungroup': {
          if (groupIds.length === 0) return null;
          const id = pick(groupIds);
          const group = store.getGroup(id);
          if (!group) return null;
          const members = there.filter((member) => rows.get(member)?.groupId === id);
          return as(`${id} ${members}`, () => {
            if (members.length > 0) place(members, group.layerId);
            return store.deleteGroup(id);
          });
        }
        case 'place':
        case 'order': {
          if (layers.length === 0) return null;
          const ids = rowsOf(pick(layers), 3);
          if (ids.length === 0) return null;
          if (kind === 'order') return as(`${ids}`, () => place(ids, null));
          const parent = pick([...layers, ...groupIds]);
          return as(`${ids} ${parent}`, () => place(ids, parent));
        }
        case 'create': {
          if (there.length >= 12 || layers.length === 0) return null;
          const parent = pick([...layers, ...groupIds]);
          const id = `f${features++}`;
          const coordinates = Float64Array.of(Math.round(random() * 1000) / 1000, 0.5);
          return as(`${id} ${parent}`, () =>
            store.createRows({
              ids: [id],
              fields: new Map<FeatureRowField, unknown[]>([
                ['type', ['Point']],
                ['parent', [parent]],
                ['orderKey', [keyIn(parent)]],
                ['properties:k1', [Math.floor(random() * 100)]],
              ]),
              geometry: {
                types: Uint8Array.of(0),
                coordinates,
                valuesPerPosition: 2,
                partStarts: Int32Array.of(0, 1),
                ringStarts: Int32Array.of(0, 1),
                positionStarts: Int32Array.of(0, 1),
              },
            }),
          );
        }
        default: {
          if (layers.length === 0) return null;
          const ids = rowsOf(pick(layers), 2);
          if (ids.length === 0) return null;
          const refs = Int32Array.from(ids, (id) => store.tables.getRowRef(id) as number);
          return as(`${ids}`, () =>
            store.writeRows({
              rows: refs,
              fields: new Map(),
              deleted: new Uint8Array(refs.length).fill(1),
            }),
          );
        }
      }
    }
  }

  const { created: _created, modified: _modified, ...json } = draw.document.toJSON();
  run.document = JSON.stringify(
    plain({
      features: layersThere().map((layerId) => [...draw.features.iterate({ layerId })]),
      items: layersThere().map((id) => draw.layers.listItemIds(id, { start: 0, end: 100 })),
      members: groupsNow().map((id) => draw.groups.listFeatureIds(id, { start: 0, end: 100 })),
      groups: draw.groups.list(),
      layers: draw.layers.list(),
      json,
    }),
  );
  draw.destroy();
  return run;
}

/** Runs a list under each set: nothing read that is not in the Store, the same in every set */
async function compareSets(
  list: Omit<ListOptions, 'watching'>,
  sets: readonly Watching[],
): Promise<{ wrong: string[]; runs: Map<Watching, Run> }> {
  const runs = new Map<Watching, Run>();
  for (const watching of sets) runs.set(watching, await runList({ ...list, watching }));
  const wrong: string[] = [];
  const [baseline] = runs.values();
  for (const [{ name }, run] of runs) {
    wrong.push(...run.wrong.slice(0, 2));
    run.steps.forEach(({ edit, result }, i) => {
      const other = baseline.steps[i];
      if (edit !== other?.edit || result !== other.result) {
        wrong.push(`${name}: ${edit} gave ${result}, not ${other?.edit} ${other?.result}`);
      }
    });
    if (run.document !== baseline.document) {
      wrong.push(
        `${name}: seed ${list.seed}: the document is ${run.document}, not ${baseline.document}`,
      );
    }
  }
  const own = runs.get(OWN_LISTENED);
  const all = runs.get(ALL_LISTENED);
  own?.steps.forEach(({ edit, told }, i) => {
    const asked = all?.steps[i]?.told ?? [];
    const at = told.findIndex((text, k) => text !== asked[k]);
    if (at >= 0 || told.length !== asked.length) {
      wrong.push(`${edit}: told ${told[at]}, not ${asked[at]} (${told.length}, ${asked.length})`);
    }
  });
  return { wrong: wrong.slice(0, 4), runs };
}

describe('the lists of edits under several sets of subscribers', () => {
  const sets = [ALL, OWN, OWN_LISTENED, ALL_LISTENED];

  it('read as the Store and tell the same, the writings back included', {
    timeout: 300_000,
  }, async () => {
    let placesBack = 0;
    let overlaps = 0;
    let groupsMoved = 0;
    const wrong: string[] = [];
    for (let seed = 1; seed <= LISTS; seed++) {
      const result = await compareSets({ seed, restores: true, notKept: false }, sets);
      wrong.push(...result.wrong);
      placesBack += result.runs.get(OWN_LISTENED)?.placesBack ?? 0;
      overlaps += result.runs.get(OWN_LISTENED)?.overlaps ?? 0;
      groupsMoved += result.runs.get(OWN_LISTENED)?.groupsMoved ?? 0;
    }
    expect(wrong).toEqual([]);
    expect(placesBack).toBeGreaterThan(0);
    expect(overlaps).toBeGreaterThan(0);
    expect(groupsMoved).toBeGreaterThan(0);
  });

  it('read as with no subscriber at all, without a writing back', {
    timeout: 300_000,
  }, async () => {
    const wrong: string[] = [];
    for (let seed = 1; seed <= LISTS; seed++) {
      const list = { seed, restores: false, notKept: false };
      wrong.push(...(await compareSets(list, [NONE, ...sets])).wrong);
    }
    expect(wrong).toEqual([]);
  });

  it('read as the Store and tell the same for features not kept made', {
    timeout: 300_000,
  }, async () => {
    let placesBack = 0;
    let groupsMoved = 0;
    const wrong: string[] = [];
    for (let seed = 1; seed <= LISTS_NOT_KEPT; seed++) {
      const result = await compareSets({ seed, restores: true, notKept: true }, sets);
      wrong.push(...result.wrong);
      placesBack += result.runs.get(OWN_LISTENED)?.placesBack ?? 0;
      groupsMoved += result.runs.get(OWN_LISTENED)?.groupsMoved ?? 0;
    }
    expect(wrong).toEqual([]);
    expect(placesBack).toBeGreaterThan(0);
    expect(groupsMoved).toBeGreaterThan(0);
  });
});
