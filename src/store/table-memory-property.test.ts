// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The Store of rows against the Store of objects, written by the same operations at random
 *
 *
 * The operations of the Store (create, delete, the style, an attribute, the geometry, another
 * layer, a group), the edits in the middle of a drag and their end or undoing, and the selection
 * (holding and letting go of rows), a feature created and selected in one transaction among them,
 * are applied to both. After each:
 *
 * - every feature reads the same, in the same order (the order of the Store of objects; the rows
 *   of each layer, in its order, for the Store of rows)
 * - in every notification of the Store of rows, a row is in one kind of change only (a feature,
 *   or a row), the rows made features and no longer are not changes of the document, and a row
 *   deleted is never among the rows no longer held
 */

import { describe, expect, it } from 'vitest';
import { seededRandom } from '../test-utils.js';
import { MemoryStore } from './memory.js';
import type { Store } from './store.js';
import { createTableStore } from './table-memory.js';
import type { Feature, StoreChange } from './types.js';

const LAYERS = ['a', 'b'];

function layer(id: string) {
  return {
    id,
    name: id,
    visible: true,
    locked: false,
    opacity: 1,
    items: [],
    styleRule: undefined,
    metadata: undefined,
  };
}

/** The features of a Store in their order, as their values */
function contents(store: Store): unknown[] {
  const features: Feature[] = [];
  const tables = store.tables;
  if (tables) {
    for (const layerId of store.getLayerOrder()) {
      const cursor = tables.scan({ layerIds: [layerId] });
      for (let batch = cursor.next(); batch; batch = cursor.next()) {
        for (const handle of batch) {
          features.push(store.getFeature(tables.getRowId(handle) as string) as Feature);
        }
      }
    }
  } else {
    features.push(...store.listFeaturesInOrder());
  }
  return features.map((f) => ({
    id: f.id,
    type: f.type,
    layerId: f.layerId,
    groupId: f.groupId,
    geometry: f.geometry,
    style: f.style,
    properties: f.properties,
    visible: f.visible,
    locked: f.locked,
  }));
}

/** Checks the rules of a notification of the Store of rows */
function checkNotification(change: StoreChange, store: Store): void {
  const tables = store.tables;
  if (!tables) return;
  const kinds = new Map<string, string>();
  const put = (id: string, kind: string) => {
    expect(kinds.get(id), `${id} is in ${kinds.get(id)} and ${kind}`).toBeUndefined();
    kinds.set(id, kind);
  };
  for (const f of change.features?.created ?? []) put(f.id, 'features.created');
  for (const e of change.features?.deleted ?? []) put(e.id, 'features.deleted');
  // An update notified twice in one transaction (a drag frame and its end) is one kind
  const updated = new Set((change.features?.updated ?? []).map((e) => e.id));
  for (const id of updated) put(id, 'features.updated');
  for (const rows of change.rows?.layers.values() ?? []) {
    for (const list of [rows.created, rows.updated, rows.deleted]) {
      for (const handle of new Set(list)) put(tables.getRowId(handle) as string, 'rows');
    }
  }
  // A row deleted is never among the rows no longer held
  const deleted = new Set((change.features?.deleted ?? []).map((f) => f.id));
  for (const id of change.opened?.removed ?? []) expect(deleted.has(id)).toBe(false);
  // A row created and held is a feature created, not a row made a feature
  const created = new Set((change.features?.created ?? []).map((f) => f.id));
  for (const f of change.opened?.added ?? []) expect(created.has(f.id)).toBe(false);
}

describe('the Store of rows against the Store of objects', () => {
  it('reads the same after the same operations at random, and notifies each row once', () => {
    for (const seed of [1, 2, 3, 4]) {
      const random = seededRandom(seed);
      const objects = new MemoryStore();
      const rows = createTableStore().store;
      // A listener that throws is reported and does not stop the Store: the errors are kept
      const errors: unknown[] = [];
      rows.subscribe((change) => {
        try {
          checkNotification(change, rows);
        } catch (error) {
          errors.push(error);
        }
      });
      const both = (fn: (store: Store) => void) => {
        fn(objects);
        fn(rows);
      };
      // A group with a member that stays in it (an empty group is not kept)
      both((s) => {
        for (const id of LAYERS) s.createLayer(layer(id));
        s.createFeature({
          id: 'anchor',
          type: 'Point',
          geometry: { type: 'Point', coordinates: [0, 0] },
          layerId: 'a',
          groupId: undefined,
          properties: {},
          style: {},
          visible: true,
          locked: false,
        });
        s.createGroup({
          id: 'g',
          layerId: 'a',
          name: 'g',
          featureIds: ['anchor'],
          visible: true,
          locked: false,
        });
      });
      let next = 0;
      const live: string[] = [];
      const pick = () => live[Math.floor(random() * live.length)];
      const point = (id: string, layerId: string): Feature => ({
        id,
        type: 'Point',
        geometry: { type: 'Point', coordinates: [random(), random()] },
        layerId,
        groupId: undefined,
        properties: { n: next },
        style: {},
        visible: true,
        locked: false,
      });
      for (let step = 0; step < 150; step++) {
        const r = random();
        if (r < 0.2 || live.length < 3) {
          const id = `f${next++}`;
          const f = point(id, LAYERS[Math.floor(random() * 2)]);
          if (random() < 0.3) {
            // Created and selected in one transaction
            both((s) =>
              s.transact(() => {
                s.createFeature(f);
                s.setSelection('feature', [id]);
              }),
            );
          } else {
            both((s) => s.createFeature(f));
          }
          live.push(id);
        } else if (r < 0.3) {
          const id = pick();
          both((s) => s.deleteFeature(id));
          live.splice(live.indexOf(id), 1);
        } else if (r < 0.4) {
          const id = pick();
          const style = { pointColor: random() < 0.5 ? '#ff0000' : '#00ff00' };
          both((s) => s.updateFeature(id, { style }));
        } else if (r < 0.5) {
          const id = pick();
          const properties = { n: Math.floor(random() * 100), name: `x${step}` };
          both((s) => s.updateFeature(id, { properties }));
        } else if (r < 0.6) {
          const id = pick();
          const geometry = { type: 'Point' as const, coordinates: [random() * 5, random() * 5] };
          both((s) => s.updateFeature(id, { geometry }));
        } else if (r < 0.65) {
          const id = pick();
          const layerId = LAYERS[Math.floor(random() * 2)];
          both((s) => s.updateFeature(id, { layerId, groupId: undefined }));
        } else if (r < 0.7) {
          const id = pick();
          both((s) => s.updateFeature(id, { layerId: 'a', groupId: 'g' }));
        } else if (r < 0.85) {
          const ids = live.filter(() => random() < 0.2);
          both((s) => s.setSelection(ids.length > 0 ? 'feature' : null, ids));
        } else {
          // A drag of a feature selected: its middle, then its end or its undoing
          const id = pick();
          both((s) => s.setSelection('feature', [id]));
          const start = (objects.getFeature(id) as Feature).geometry;
          const frames = [1, 2, 3].map((k) => ({
            type: 'Point' as const,
            coordinates: [k + random(), k + random()],
          }));
          const end = random() < 0.5;
          both((s) => {
            s.updateFeature(id, { geometry: end ? frames[2] : start });
          });
        }
        if (JSON.stringify(contents(rows)) !== JSON.stringify(contents(objects))) {
          console.log(
            step,
            r,
            JSON.stringify(contents(rows).map((f) => (f as { id: string }).id)),
            JSON.stringify(contents(objects).map((f) => (f as { id: string }).id)),
          );
        }
        expect(contents(rows), `seed ${seed}, step ${step}`).toEqual(contents(objects));
        expect(errors, `seed ${seed}, step ${step}`).toEqual([]);
      }
    }
  });
});

/** The items of a layer of a Store of objects (its features outside a group and its groups) */
function itemsOf(store: Store, layerId: string): string[] {
  const layer = store.getLayer(layerId);
  return layer && layer.kind !== 'table' ? [...layer.items] : [];
}

describe('the Store of rows against the Store of objects, with the order', () => {
  it('reads the same after items put in other places, grouped and ungrouped at random', () => {
    for (const seed of [11, 12, 13, 14, 15]) {
      const random = seededRandom(seed);
      const objects = new MemoryStore();
      const rows = createTableStore().store;
      const errors: unknown[] = [];
      rows.subscribe((change) => {
        try {
          checkNotification(change, rows);
        } catch (error) {
          errors.push(error);
        }
      });
      const both = (fn: (store: Store) => void) => {
        fn(objects);
        fn(rows);
      };
      both((s) => {
        for (const id of LAYERS) s.createLayer(layer(id));
      });
      let next = 0;
      const feature = (id: string, layerId: string): Feature => ({
        id,
        type: 'Point',
        geometry: { type: 'Point', coordinates: [random(), random()] },
        layerId,
        groupId: undefined,
        properties: {},
        style: {},
        visible: true,
        locked: false,
      });
      for (let step = 0; step < 150; step++) {
        const r = random();
        const features = objects.listFeatures().map((f) => f.id);
        const groups = objects.listGroups().map((g) => g.id);
        const layerId = LAYERS[Math.floor(random() * 2)];
        const any = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)];
        if (r < 0.25 || features.length < 4) {
          const f = feature(`f${next++}`, layerId);
          both((s) => s.createFeature(f));
        } else if (r < 0.32) {
          const id = any(features);
          both((s) => s.deleteFeature(id));
        } else if (r < 0.6) {
          // Items put in a layer, just above an item, just below one, or at an end
          const loose = [...features.filter((id) => !objects.getFeature(id)?.groupId), ...groups];
          const moved = [...new Set([any(loose), any(loose)])].filter((id) => id !== undefined);
          const items = itemsOf(objects, layerId);
          const k = random();
          const to =
            k < 0.3
              ? { layerId, below: items.length > 0 ? any(items) : null }
              : k < 0.6
                ? { layerId, above: items.length > 0 ? any(items) : null }
                : k < 0.8
                  ? { layerId, below: null }
                  : { layerId, above: null };
          both((s) => s.moveItems(moved, to));
        } else if (r < 0.7 && groups.length > 0) {
          // Features put in a group, among its members
          const group = objects.getGroup(any(groups));
          if (!group || group.kind === 'table') continue;
          const loose = features.filter((id) => !objects.getFeature(id)?.groupId);
          if (loose.length === 0) continue;
          const id = any(loose);
          const to = { layerId: group.layerId, groupId: group.id, below: any(group.featureIds) };
          both((s) => s.moveItems([id], to));
        } else if (r < 0.8) {
          // Two features grouped
          // The first member the backmost: the group takes its place in both
          const loose = itemsOf(objects, 'a').filter((id) => objects.getFeature(id));
          if (loose.length < 2) continue;
          const members = [loose[0], loose[loose.length - 1]];
          const id = `g${next++}`;
          both((s) =>
            s.createGroup({
              id,
              layerId: 'a',
              name: id,
              featureIds: members,
              visible: true,
              locked: false,
            }),
          );
        } else if (r < 0.88 && groups.length > 0) {
          const id = any(groups);
          both((s) => s.deleteGroup(id));
        } else {
          // A member taken out of its group (its group goes when it is the last)
          const member = features.find((id) => objects.getFeature(id)?.groupId);
          if (!member) continue;
          both((s) => s.updateFeature(member, { groupId: undefined }));
        }
        expect(contents(rows), `seed ${seed}, step ${step}`).toEqual(contents(objects));
        expect(
          rows
            .listGroups()
            .map((g) => g.id)
            .sort(),
          `seed ${seed}, step ${step}`,
        ).toEqual(
          objects
            .listGroups()
            .map((g) => g.id)
            .sort(),
        );
        expect(errors, `seed ${seed}, step ${step}`).toEqual([]);
      }
    }
  });
});
