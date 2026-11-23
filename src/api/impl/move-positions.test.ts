// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the position an item had before the change being told (`getItemPositionBefore` of
 * the layer over the Store, and the `from` of `feature.moved`, `group.moved` and
 * `groups.moved`): counted from the order now and what the change put in each container and took
 * out of it, never from a copy of the whole order before
 *
 * The counts are checked against the orders the test copies before each write, over sequences of
 * writes drawn at random: moves within a layer and between layers, into and out of groups, groups
 * made, ungrouped and moved, deletions and moves in one transaction, and changes written to the
 * Store directly, items of the same key among them.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createStore } from '../../store/built-in/create-store.js';
import { createOrderKeyBetween } from '../../store/built-in/order-keys.js';
import type { FeatureRowField, Store as RowStore } from '../../store/built-in/types.js';
import type { InstanceDocument, ItemPosition } from '../../store/document-access.js';
import type { Feature, Group } from '../../store/types.js';
import {
  createCountedInstance,
  createMapStub,
  expectNotProportional,
  gridPoints,
  workDuring,
} from '../../test-utils.js';
import type { Draw } from '../draw.js';
import type { DocumentChange, DrawEvents } from '../events.js';
import type { MoveTarget, Feature as PublicFeature } from '../model.js';
import { createDrawOnEngine } from './create-draw.js';
import { createDocumentAccess, summaryOfChange, watchChanges } from './document-access.js';
import { createEngine } from './engine.js';

/** A generator of numbers in [0, 1) from a seed, the same for the same seed */
function randomFrom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function point(id: string, layerId: string, groupId?: string): Feature {
  return {
    id,
    type: 'Point',
    geometry: { type: 'Point', coordinates: [0, 0] },
    layerId,
    groupId,
    properties: {},
    style: {},
    visible: true,
    locked: false,
  };
}

function group(id: string, layerId: string): Group {
  return { id, layerId, name: id, visible: true, locked: false };
}

/** The layer over a built-in Store, noting its changes in the words of the features */
function noted(): { doc: InstanceDocument; rows: RowStore } {
  const rows = createStore();
  const doc = createDocumentAccess(rows);
  watchChanges(doc, { wanted: () => true, deletedFeatures: () => false, asksValues: () => null });
  return { doc, rows };
}

const LAYERS = ['l1', 'l2', 'l3'];

/** Where every item of the document is: by ID, its container and its position there */
function placesOf(doc: InstanceDocument): Map<string, ItemPosition> {
  const out = new Map<string, ItemPosition>();
  for (const layerId of LAYERS) {
    if (!doc.getLayer(layerId)) continue;
    doc.listItemIds(layerId, 0, doc.countItems(layerId)).forEach((id, index) => {
      out.set(id, { containerId: layerId, index });
      if (!doc.getGroup(id)) return;
      doc.listGroupFeatureIds(id, 0, doc.countGroupFeatures(id)).forEach((member, at) => {
        out.set(member, { containerId: id, index: at });
      });
    });
  }
  return out;
}

/** The key of the order of an item: of its row, or of a group */
function keyOf(rows: RowStore, id: string): string {
  const groupOfId = rows.getGroup(id);
  if (groupOfId) return groupOfId.orderKey;
  const ref = rows.tables.getRowRef(id) as number;
  return String(
    rows.tables.readValues(Int32Array.of(ref), ['orderKey']).fields.get('orderKey')?.[0],
  );
}

/** Writes the place of a row to the Store directly */
function writePlace(rows: RowStore, id: string, parent: string | undefined, key: string): void {
  const ref = rows.tables.getRowRef(id) as number;
  const fields = new Map<FeatureRowField, unknown[]>([['orderKey', [key]]]);
  if (parent !== undefined) fields.set('parent', [parent]);
  rows.writeRows({ rows: Int32Array.of(ref), fields });
}

describe('the position before of every item, over writes drawn at random', () => {
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    it(`is the position the copy taken before each write has (seed ${seed})`, () => {
      const random = randomFrom(seed);
      const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)];
      const { doc, rows } = noted();
      for (const layerId of LAYERS) {
        doc.createLayer({
          id: layerId,
          name: layerId,
          visible: true,
          locked: false,
          opacity: 1,
        } as never);
      }
      let made = 0;
      const newId = (prefix: string) => `${prefix}${String(made++).padStart(3, '0')}`;
      for (let i = 0; i < 24; i++) doc.createFeature(point(newId('f'), LAYERS[i % 3]));

      let before = placesOf(doc);
      let checked = 0;
      let told = 0;
      const mismatches: string[] = [];
      doc.subscribe((change) => {
        const summary = summaryOfChange(change);
        if (!summary) return;
        told += 1;
        // The positions before are counted for a change that moves items
        if (summary.ids().moved.count() === 0 && summary.groupsMoved.size === 0) return;
        for (const [id, expected] of before) {
          const there = doc.getFeature(id) !== undefined || doc.getGroup(id) !== undefined;
          if (!there && !summary.groupsDeleted.has(id)) continue;
          const got = doc.getItemPositionBefore(id);
          checked += 1;
          if (got?.containerId !== expected.containerId || got.index !== expected.index) {
            mismatches.push(`${id}: ${JSON.stringify(got)} for ${JSON.stringify(expected)}`);
          }
        }
        // What the change created had no position before
        for (const id of summary.ids().created.iterate()) {
          if (doc.getItemPositionBefore(id) !== undefined) {
            mismatches.push(`${id}: a position for an item the change created`);
          }
        }
      });

      const features = () =>
        [...placesOf(doc).keys()].filter((id) => doc.getFeature(id) !== undefined);
      const groups = () => doc.listGroups().map((g) => g.id);
      const looseIn = (layerId: string) =>
        features().filter(
          (id) => doc.getFeature(id)?.layerId === layerId && !doc.getFeature(id)?.groupId,
        );
      const indexIn = (count: number) =>
        random() < 0.2 ? undefined : Math.floor(random() * (count + 1));

      const writes: Array<() => void> = [
        // Within a layer
        () => {
          const id = pick(features());
          const f = doc.getFeature(id) as Feature;
          if (f.groupId) {
            doc.moveFeatures([id], { kind: 'group', groupId: f.groupId, index: indexIn(5) });
          } else {
            doc.moveFeatures([id], {
              kind: 'layer',
              layerId: f.layerId,
              index: indexIn(doc.countItems(f.layerId)),
            });
          }
        },
        // To another layer, some at once
        () => {
          const ids = [pick(features()), pick(features())];
          const layerId = pick(LAYERS);
          doc.moveFeatures([...new Set(ids)], {
            kind: 'layer',
            layerId,
            index: indexIn(doc.countItems(layerId)),
          });
        },
        // Into a group
        () => {
          const list = groups();
          if (list.length === 0) return;
          const groupId = pick(list);
          doc.moveFeatures([pick(features())], {
            kind: 'group',
            groupId,
            index: indexIn(doc.countGroupFeatures(groupId)),
          });
        },
        // Out of a group
        () => {
          const grouped = features().filter((id) => doc.getFeature(id)?.groupId);
          if (grouped.length === 0) return;
          doc.moveFeatures([pick(grouped)], {
            kind: 'ungroup',
            index: random() < 0.5 ? 0 : undefined,
          });
        },
        // A group made with features of its layer
        () => {
          const layerId = pick(LAYERS);
          const loose = looseIn(layerId);
          if (loose.length < 2) return;
          doc.createGroupWith(group(newId('g'), layerId), [pick(loose), pick(loose)]);
        },
        // Ungrouped
        () => {
          const list = groups();
          if (list.length > 0) doc.deleteGroup(pick(list));
        },
        // A group moved, in its layer or to another
        () => {
          const list = groups().filter((id) => doc.countGroupFeatures(id) > 0);
          if (list.length === 0) return;
          const layerId = pick(LAYERS);
          doc.moveGroups([pick(list)], layerId, indexIn(doc.countItems(layerId)));
        },
        // A deletion and moves in one transaction
        () => {
          const list = features();
          if (list.length < 8) return;
          doc.transact(() => {
            doc.deleteFeature(pick(list));
            const left = features();
            const id = pick(left);
            const layerId = pick(LAYERS);
            doc.moveFeatures([id], { kind: 'layer', layerId, index: indexIn(3) });
            doc.moveFeatures([pick(left)], { kind: 'layer', layerId, index: 0 });
          });
        },
        // To the key of another item of its container, written to the Store directly
        () => {
          const id = pick(features());
          const f = doc.getFeature(id) as Feature;
          const container = f.groupId ?? f.layerId;
          const others = features().filter((other) => {
            const o = doc.getFeature(other) as Feature;
            return other !== id && (o.groupId ?? o.layerId) === container;
          });
          if (others.length === 0) return;
          rows.transact(() => writePlace(rows, id, undefined, keyOf(rows, pick(others))), 'remote');
        },
        // To another container, written to the Store directly, with a deletion
        () => {
          const list = features();
          if (list.length < 8) return;
          const id = pick(list);
          const targets = [...LAYERS, ...groups()];
          const parent = pick(targets);
          const members =
            doc.getGroup(parent) !== undefined
              ? doc.listGroupFeatureIds(parent, 0, doc.countGroupFeatures(parent))
              : doc.listItemIds(parent, 0, doc.countItems(parent));
          const key =
            members.length > 0 && random() < 0.5
              ? keyOf(rows, pick(members))
              : createOrderKeyBetween(
                  undefined,
                  members.length > 0 ? keyOf(rows, members[0]) : undefined,
                );
          const gone = pick(list.filter((other) => other !== id));
          rows.transact(() => {
            writePlace(rows, id, parent, key);
            const ref = rows.tables.getRowRef(gone) as number;
            rows.writeRows({
              rows: Int32Array.of(ref),
              fields: new Map(),
              deleted: Uint8Array.of(1),
            });
          }, 'remote');
        },
        // A group given the key of another item, written to the Store directly
        () => {
          const list = groups().filter((id) => doc.countGroupFeatures(id) > 0);
          if (list.length === 0) return;
          const id = pick(list);
          const layerId = (doc.getGroup(id) as Group).layerId;
          const items = doc.listItemIds(layerId, 0, doc.countItems(layerId));
          rows.transact(
            () => rows.updateGroup(id, { orderKey: keyOf(rows, pick(items)) }),
            'remote',
          );
        },
        // A group with no feature, which features join later
        () => {
          doc.createGroup(group(newId('g'), pick(LAYERS)));
        },
      ];

      for (let step = 0; step < 200; step++) {
        before = placesOf(doc);
        const toldBefore = told;
        pick(writes)();
        expect(told - toldBefore).toBeLessThanOrEqual(1);
      }
      expect(mismatches).toEqual([]);
      expect(checked).toBeGreaterThan(500);
    });
  }
});

describe('the position before, in the changes of a few writes', () => {
  /** The layer with the features `a` to `e` in l1, `x` and `y` in l2, and what it tells */
  function documentWith() {
    const { doc, rows } = noted();
    for (const id of ['l1', 'l2']) {
      doc.createLayer({ id, name: id, visible: true, locked: false, opacity: 1 } as never);
    }
    for (const id of ['a', 'b', 'c', 'd', 'e']) doc.createFeature(point(id, 'l1'));
    for (const id of ['x', 'y']) doc.createFeature(point(id, 'l2'));
    /** The positions before of the IDs given, asked while each change is told */
    const asked = (ids: readonly string[]) => {
      const out: Array<Record<string, ItemPosition | undefined>> = [];
      doc.subscribe((change) => {
        if (!summaryOfChange(change)) return;
        out.push(Object.fromEntries(ids.map((id) => [id, doc.getItemPositionBefore(id)])));
      });
      return out;
    };
    return { doc, rows, asked };
  }

  it('counts the items of the same key by their IDs', () => {
    const { doc, rows, asked } = documentWith();
    const told = asked(['a', 'b', 'c', 'd', 'e']);
    // d takes the key of b: b and d stand by their IDs, b behind d
    rows.transact(() => writePlace(rows, 'd', undefined, keyOf(rows, 'b')), 'remote');
    expect(doc.listItemIds('l1', 0, 5)).toEqual(['a', 'b', 'd', 'c', 'e']);
    expect(told[0]).toEqual({
      a: { containerId: 'l1', index: 0 },
      b: { containerId: 'l1', index: 1 },
      c: { containerId: 'l1', index: 2 },
      d: { containerId: 'l1', index: 3 },
      e: { containerId: 'l1', index: 4 },
    });
    // a takes the same key: a, b, d of one key
    rows.transact(() => writePlace(rows, 'a', undefined, keyOf(rows, 'b')), 'remote');
    expect(told[1]).toEqual({
      a: { containerId: 'l1', index: 0 },
      b: { containerId: 'l1', index: 1 },
      c: { containerId: 'l1', index: 3 },
      d: { containerId: 'l1', index: 2 },
      e: { containerId: 'l1', index: 4 },
    });
  });

  it('gives the features of a group ungrouped the group and their positions in it', () => {
    const { doc, asked } = documentWith();
    doc.createGroupWith(group('g', 'l1'), ['b', 'd', 'c']);
    const told = asked(['b', 'c', 'd', 'g']);
    doc.deleteGroup('g');
    expect(told).toEqual([
      {
        b: { containerId: 'g', index: 0 },
        d: { containerId: 'g', index: 1 },
        c: { containerId: 'g', index: 2 },
        g: { containerId: 'l1', index: 1 },
      },
    ]);
  });

  it('gives nothing for a feature the same change created and moved', () => {
    const { doc, asked } = documentWith();
    doc.createGroupWith(group('g', 'l1'), ['b', 'c']);
    const told = asked(['n', 'b', 'c']);
    doc.transact(() => {
      doc.createFeature(point('n', 'l2'));
      doc.moveFeatures(['n', 'b'], { kind: 'group', groupId: 'g', index: 0 });
    });
    expect(told).toEqual([
      { n: undefined, b: { containerId: 'g', index: 0 }, c: { containerId: 'g', index: 1 } },
    ]);
  });

  it('counts a feature deleted and created again with its ID where it was', () => {
    const { doc, asked } = documentWith();
    const told = asked(['c', 'd', 'x']);
    doc.transact(() => {
      doc.deleteFeature('c');
      doc.createFeature(point('c', 'l2'));
      doc.moveFeatures(['d'], { kind: 'layer', layerId: 'l2', index: 0 });
    });
    expect(doc.listItemIds('l2', 0, 4)).toEqual(['d', 'x', 'y', 'c']);
    expect(told).toEqual([
      {
        c: { containerId: 'l1', index: 2 },
        d: { containerId: 'l1', index: 3 },
        x: { containerId: 'l2', index: 0 },
      },
    ]);
  });

  it('is undefined outside the telling of a change', () => {
    const { doc } = documentWith();
    doc.moveFeatures(['a'], { kind: 'layer', layerId: 'l1' });
    expect(doc.getItemPositionBefore('a')).toBeUndefined();
  });
});

// ============================================================================
// The events
// ============================================================================

const draws: Draw[] = [];

afterEach(() => {
  for (const draw of draws.splice(0)) draw.destroy();
});

/** An instance over a built-in Store with five points in its layer and two in a group */
function instance() {
  const store = createStore();
  const engine = createEngine(createMapStub().map, { store }, { deferDefaultMode: true });
  const draw = createDrawOnEngine(engine, { store });
  engine.enterDefaultMode();
  draws.push(draw);
  const layerId = draw.layers.list()[0].id;
  const ids = ['a', 'b', 'c', 'd', 'e'].map(
    (id) =>
      (
        draw.features.create({
          id,
          type: 'Point',
          geometry: { type: 'Point', coordinates: [0, 0] },
        }) as PublicFeature
      ).id,
  );
  const groupId = draw.groups.create({ featureIds: ['d', 'e'], id: 'g' })?.id as string;
  return { draw, store, layerId, ids, groupId };
}

/** Where every item is now, by ID */
function positionsOf(
  draw: Draw,
  layerId: string,
): Map<string, { container: string; index: number }> {
  const out = new Map<string, { container: string; index: number }>();
  draw.layers.listItemIds(layerId, { start: 0, end: 1000 }).forEach((id, index) => {
    out.set(id, { container: layerId, index });
    if (!draw.groups.get(id)) return;
    draw.groups.listFeatureIds(id, { start: 0, end: 1000 }).forEach((member, at) => {
      out.set(member, { container: id, index: at });
    });
  });
  return out;
}

/** The container a target names */
function containerOf(target: MoveTarget): string | null {
  return 'layerId' in target ? target.layerId : target.groupId;
}

describe('the position a move came from, in the events', () => {
  it('is in groups.moved of document.changed with no listener of the moves', () => {
    const { draw, layerId, groupId } = instance();
    const items = () => draw.layers.listItemIds(layerId, { start: 0, end: 100 });
    const from = items().indexOf(groupId);
    const changes: DocumentChange[] = [];
    draw.on('document.changed', (change) => changes.push(change));
    draw.groups.move(groupId, { layerId, index: 0 });
    expect(changes[0].groups?.moved).toEqual([
      {
        id: groupId,
        group: expect.objectContaining({ id: groupId }),
        from: { layerId, index: from },
        to: { layerId, index: 0 },
      },
    ]);
  });

  it('is in groups.moved of draw.document.subscribe alone', () => {
    const { draw, layerId, groupId } = instance();
    const changes: DocumentChange[] = [];
    draw.document.subscribe((change) => changes.push(change));
    draw.groups.move(groupId, { layerId, index: 1 });
    expect(changes[0].groups?.moved?.[0].from).toEqual({ layerId, index: 3 });
    expect(changes[0].groups?.moved?.[0].to).toEqual({ layerId, index: 1 });
  });

  it('is not in the from of a feature the same change created', () => {
    const { draw, groupId } = instance();
    const moved: DrawEvents['feature.moved'][] = [];
    draw.on('feature.moved', (payload) => moved.push(payload));
    draw.transact(() => {
      const made = draw.features.create({
        id: 'n',
        type: 'Point',
        geometry: { type: 'Point', coordinates: [0, 0] },
      }) as PublicFeature;
      draw.features.move(made.id, { groupId, index: 0 });
      draw.features.move('a', { groupId, index: 0 });
    });
    const of = (id: string) => moved.find((payload) => payload.feature.id === id);
    expect(of('n')?.from).toEqual({ layerId: expect.any(String) });
    expect(of('a')?.from).toEqual({ layerId: expect.any(String), index: 0 });
  });

  it('is the position right before and after each change, when a listener writes the order', () => {
    const { draw, layerId, groupId } = instance();
    draw.groups.delete(groupId);
    const indexOf = (id: string) => positionsOf(draw, layerId).get(id)?.index as number;
    expect(draw.layers.listItemIds(layerId, { start: 0, end: 100 })).toEqual([
      'a',
      'b',
      'c',
      'd',
      'e',
    ]);
    const told: Array<{ id: string; from: MoveTarget; to: MoveTarget }> = [];
    const expected: Array<{ id: string; from: MoveTarget; to: MoveTarget }> = [];
    /** The positions right after the first change */
    const after = new Map<string, number>();
    draw.on('feature.moved', ({ feature, from, to }) => {
      told.push({ id: feature.id, from, to });
      if (after.size > 0) return;
      for (const id of ['d', 'e']) after.set(id, indexOf(id));
      // Written while the first change is told: a deletion, two changes that move one feature
      // each, and a deletion
      draw.features.delete('a');
      for (const id of ['c', 'e']) {
        const from = indexOf(id);
        draw.features.move(id, { layerId, index: 0 });
        expected.push({ id, from: { layerId, index: from }, to: { layerId, index: indexOf(id) } });
      }
      draw.features.delete('b');
    });
    // The first change moves two features to the back: d e a b c
    draw.features.moveMany(['d', 'e'], { layerId, index: 0 });
    expect(draw.layers.listItemIds(layerId, { start: 0, end: 100 })).toEqual(['e', 'c', 'd']);
    // Both moves of the first change, from the order right before and right after it
    expect(told.slice(0, 2)).toEqual([
      { id: 'd', from: { layerId, index: 3 }, to: { layerId, index: after.get('d') } },
      { id: 'e', from: { layerId, index: 4 }, to: { layerId, index: after.get('e') } },
    ]);
    expect(after).toEqual(
      new Map([
        ['d', 0],
        ['e', 1],
      ]),
    );
    // Each change written while the first was told, from the order right before and after it
    expect(told.slice(2)).toEqual(expected);
  });

  it('is the position the copy taken before each write has, in every event', () => {
    const { draw, store, layerId } = instance();
    const second = draw.layers.create({ name: 'Second' })?.id as string;
    for (let i = 0; i < 6; i++) {
      draw.features.create({
        id: `s${i}`,
        type: 'Point',
        geometry: { type: 'Point', coordinates: [0, 0] },
        layerId: second,
      });
    }
    const layerIds = [layerId, second];
    let before = new Map<string, { container: string; index: number }>();
    const copy = () => {
      before = new Map();
      for (const id of layerIds) for (const [k, v] of positionsOf(draw, id)) before.set(k, v);
    };
    const wrong: string[] = [];
    const check = (id: string, from: MoveTarget) => {
      const was = before.get(id);
      if (!was) {
        if (from.index !== undefined) wrong.push(`${id}: an index for an item not there before`);
        return;
      }
      if (containerOf(from) !== was.container || from.index !== was.index) {
        wrong.push(`${id}: ${JSON.stringify(from)} for ${JSON.stringify(was)}`);
      }
    };
    draw.on('feature.moved', ({ feature, from }) => check(feature.id, from));
    draw.on('group.moved', ({ group: moved, from }) => check(moved.id, from));
    draw.on('document.changed', (change) => {
      for (const entry of change.groups?.moved ?? []) check(entry.id, entry.from);
    });
    const random = randomFrom(7);
    const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)];
    const features = () => draw.features.list().map((f) => f.id);
    for (let step = 0; step < 120; step++) {
      copy();
      const id = pick(features());
      const choice = Math.floor(random() * 6);
      const groups = draw.groups.list().map((g) => g.id);
      if (choice === 0)
        draw.features.move(id, { layerId: pick(layerIds), index: Math.floor(random() * 6) });
      else if (choice === 1 && groups.length > 0)
        draw.features.move(id, { groupId: pick(groups), index: 0 });
      else if (choice === 2) draw.features.move(id, { groupId: null });
      else if (choice === 3 && groups.length > 0) {
        draw.groups.move(pick(groups), {
          layerId: pick(layerIds),
          index: Math.floor(random() * 4),
        });
      } else if (choice === 4 && groups.length > 0) {
        draw.groups.delete(pick(groups));
      } else if (choice === 5) {
        // The key of another feature, written to the Store directly
        const key = keyOf(store, pick(features()));
        store.transact(() => writePlace(store, id, undefined, key), 'remote');
      } else {
        const loose = features().filter((f) => !draw.features.get(f)?.groupId);
        const layerOf = (f: string) => draw.features.get(f)?.layerId;
        const one = pick(loose);
        const two = loose.find((f) => f !== one && layerOf(f) === layerOf(one));
        if (two) draw.groups.create({ featureIds: [one, two] });
      }
    }
    expect(wrong).toEqual([]);
  });
});

// ============================================================================
// The work
// ============================================================================

describe('the work of the positions before, which does not grow with the features', () => {
  /** An instance over `size` points in its layer, listened to as `listen` says */
  function counted(size: number, listen: (draw: Draw) => void) {
    const instance = createCountedInstance();
    draws.push(instance.draw);
    const ids = (instance.draw.features.createMany(gridPoints(size)) as PublicFeature[]).map(
      (f) => f.id,
    );
    listen(instance.draw);
    return { ...instance, ids, layerId: instance.draw.layers.list()[0].id };
  }

  const listenMoves = (draw: Draw) => draw.on('feature.moved', () => {});

  for (const [what, write] of [
    [
      'creating one feature',
      (draw: Draw) =>
        draw.features.create({ type: 'Point', geometry: { type: 'Point', coordinates: [0, 0] } }),
    ],
    [
      'moving one feature',
      (draw: Draw, ids: string[], layerId: string) =>
        draw.features.move(ids[7], { layerId, index: 3 }),
    ],
    ['deleting one feature', (draw: Draw, ids: string[]) => draw.features.delete(ids[7])],
  ] as const) {
    it(`reads as many rows and makes as many objects for ${what}`, () => {
      for (const kind of ['rowsTouched', 'objectsCreated'] as const) {
        expectNotProportional((size) => {
          const { draw, counts, ids, layerId } = counted(size, listenMoves);
          // Made beforehand at both sizes: the layer keeps 1,024 features made
          draw.features.get(ids[7]);
          return workDuring(counts, () => {
            (write as (draw: Draw, ids: string[], layerId: string) => void)(draw, ids, layerId);
          })[kind];
        }, `the ${kind} of ${what}`);
      }
    });
  }

  it('reads rows for 100 features moved in one transaction as for a few, whatever the features', () => {
    expectNotProportional((size) => {
      const { draw, counts, ids, layerId } = counted(size, listenMoves);
      return workDuring(counts, () => {
        draw.transact(() => {
          for (let i = 0; i < 100; i++) draw.features.move(ids[i * 3], { layerId, index: i });
        });
      }).rowsTouched;
    }, 'the rows read for 100 moves');
  });

  it('reads as many rows for a key written to the Store directly, with no listener', () => {
    expectNotProportional((size) => {
      const { store, counts, ids } = counted(size, () => {});
      const key = keyOf(store, ids[2]);
      return workDuring(counts, () => {
        store.transact(() => writePlace(store, ids[9], undefined, key), 'remote');
      }).rowsTouched;
    }, 'the rows read for one key written directly');
  });
});
