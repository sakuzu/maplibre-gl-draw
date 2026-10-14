// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `draw.selection` over features selected in bulk (`Selection.bulk`): the verbs act on the rows
 * of the selection and leave the document as the same verbs leave it over the same features
 * selected one by one (a property test over random documents and selections), the values before
 * written back (`features.restore`) put the document back as it was, and the gates of read-only
 * and the interaction lock refuse them and their undo. The selection is read a page at a time,
 * counted and selected whole without making a feature per row.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { DrawStore } from '../../store/draw-store.js';
import { TableContractStore } from '../../store/table-memory.js';
import type { StoreChange, Feature as StoredFeature } from '../../store/types.js';
import { createMapStub } from '../../test-utils.js';
import type { Draw } from '../draw.js';
import type { Feature, FeatureStyleSample, FeatureValues } from '../model.js';
import { createDrawOnEngine } from './create-draw.js';
import { createEngine } from './engine.js';

const draws: Draw[] = [];

afterEach(() => {
  for (const draw of draws.splice(0)) draw.destroy();
});

/** A random number generator of a seed (mulberry32) */
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

const STYLES: StoredFeature['style'][] = [
  {},
  { strokeColor: '#ff0000' },
  { strokeColor: '#00ff00', strokeWidth: 3 },
];

/** A random document: features of three types, some in groups, of a few styles */
function documentOf(seed: number, count: number) {
  const next = random(seed);
  const features: StoredFeature[] = [];
  const groups: Array<{ id: string; members: string[] }> = [
    { id: 'g1', members: [] },
    { id: 'g2', members: [] },
  ];
  for (let i = 0; i < count; i++) {
    const x = Math.round(next() * 1000) / 10;
    const y = Math.round(next() * 500) / 10;
    const kind = Math.floor(next() * 3);
    const geometry: StoredFeature['geometry'] =
      kind === 0
        ? { type: 'Point', coordinates: [x, y] }
        : kind === 1
          ? {
              type: 'LineString',
              coordinates: [
                [x, y],
                [x + 0.5, y + 0.25],
              ],
            }
          : {
              type: 'Polygon',
              coordinates: [
                [
                  [x, y],
                  [x + 1, y],
                  [x + 1, y + 1],
                  [x, y],
                ],
              ],
            };
    const id = `f${i}`;
    const group = next() < 0.3 ? groups[Math.floor(next() * 2)] : null;
    group?.members.push(id);
    features.push({
      id,
      type: geometry.type as StoredFeature['type'],
      geometry,
      layerId: 'l',
      groupId: group?.id,
      properties: next() < 0.5 ? { 'maplibre-gl-draw:createdZoom': 10 + (i % 3) } : { n: i },
      style: STYLES[Math.floor(next() * STYLES.length)],
      visible: true,
      locked: false,
    });
  }
  return { features, groups: groups.filter((group) => group.members.length > 0), next };
}

/** A draw over a Store of rows that opens at most `holdLimit` features for the selection */
function drawOf(seed: number, count: number, holdLimit: number) {
  const store = new DrawStore(new TableContractStore(), { holdLimit });
  for (const id of ['l', 'm']) {
    store.createLayer({
      id,
      name: id,
      visible: true,
      locked: false,
      opacity: 1,
      kind: 'table',
      styleRule: undefined,
      metadata: undefined,
    });
  }
  const { features, groups, next } = documentOf(seed, count);
  store.transact(() => {
    for (const feature of features) store.createFeature({ ...feature, groupId: undefined });
    for (const group of groups) {
      store.createGroup({
        id: group.id,
        layerId: 'l',
        name: group.id,
        visible: true,
        locked: false,
        featureIds: group.members,
      } as never);
    }
  });
  const engine = createEngine(
    createMapStub().map,
    { store, initDefaultLayer: false },
    { deferDefaultMode: true },
  );
  const draw = createDrawOnEngine(engine, { store, initDefaultLayer: false });
  engine.enterDefaultMode();
  draws.push(draw);
  const changes: StoreChange[] = [];
  draw.getStore().subscribe((change) => changes.push(change));
  return { draw, store, next, changes };
}

/** The document as it reads: the features and the order of the items, the groups numbered */
function snapshot(draw: Draw) {
  const names = new Map<string, string>();
  const nameOf = (id: string | undefined) => {
    if (id === undefined || id === 'g1' || id === 'g2' || draw.features.has(id)) return id;
    if (!names.has(id)) names.set(id, `group${names.size}`);
    return names.get(id);
  };
  const out: Record<string, unknown> = {};
  for (const layerId of ['l', 'm']) {
    const items = draw.layers.listItems(layerId).map((id) => {
      if (draw.features.has(id)) return id;
      return { group: nameOf(id), members: draw.groups.listMembers(id) };
    });
    out[layerId] = items;
  }
  const features: Record<string, unknown> = {};
  for (const feature of draw.features.list({}, { limit: 10_000 })) {
    features[feature.id] = { ...feature, groupId: nameOf(feature.groupId) };
  }
  out.features = features;
  return out;
}

/** A random selection of the features of the document, in stacking order */
function pick(draw: Draw, next: () => number, share: number): string[] {
  const all = draw.features.list({}, { limit: 10_000 }).map((feature) => feature.id);
  return all.filter(() => next() < share);
}

/** The same document twice: selected in bulk (holdLimit 3) and selected one by one */
function pair(seed: number, count = 60) {
  const bulk = drawOf(seed, count, 3);
  const single = drawOf(seed, count, 100_000);
  return { bulk, single };
}

describe('the verbs of the selection over features selected in bulk', () => {
  it('delete as over the same features selected one by one, and undo to the bit', () => {
    for (let seed = 1; seed <= 8; seed++) {
      const { bulk, single } = pair(seed);
      const ids = pick(bulk.draw, bulk.next, 0.5);
      if (ids.length <= 3) continue;
      const before = snapshot(bulk.draw);
      bulk.draw.selection.set('feature', ids);
      single.draw.selection.set('feature', ids);
      expect(bulk.draw.selection.get().bulk?.count).toBe(ids.length);
      expect(bulk.draw.selection.delete()).toBe(true);
      expect(single.draw.selection.delete()).toBe(true);
      expect(snapshot(bulk.draw)).toEqual(snapshot(single.draw));
      // The values before, written back, put the document back
      const previous = bulk.changes[bulk.changes.length - 1].previousValues as FeatureValues;
      const groupsDeleted = bulk.changes[bulk.changes.length - 1].groups?.deleted ?? [];
      bulk.draw.getStore().transact(() => {
        for (const group of groupsDeleted) bulk.draw.groups.restore(group.id);
        bulk.draw.features.restore(previous);
      });
      expect(snapshot(bulk.draw)).toEqual(before);
    }
  });

  it('change the style once per kind of feature, as the same patches one by one', () => {
    const make = (sample: FeatureStyleSample) =>
      sample.type === 'Point'
        ? null
        : {
            style: { strokeWidth: (sample.createdZoom ?? 0) + (sample.style.strokeColor ? 1 : 2) },
            properties: { changed: sample.type },
          };
    for (let seed = 10; seed <= 16; seed++) {
      const { bulk, single } = pair(seed);
      const ids = pick(bulk.draw, bulk.next, 0.6);
      if (ids.length <= 3) continue;
      const before = snapshot(bulk.draw);
      bulk.draw.selection.set('feature', ids);
      const kinds: FeatureStyleSample[] = [];
      expect(
        bulk.draw.selection.update((sample) => {
          kinds.push(sample);
          return make(sample);
        }),
      ).toBe(true);
      // One call per kind of feature, not per feature
      expect(kinds.length).toBeLessThan(ids.length);
      const patches = ids
        .map((id) => single.draw.features.get(id) as Feature)
        .map((feature) => ({
          id: feature.id,
          patch: make({
            type: feature.type,
            style: feature.style,
            createdZoom: feature.properties['maplibre-gl-draw:createdZoom'] as number | undefined,
          }),
        }))
        .filter((entry) => entry.patch !== null)
        .map((entry) => ({ id: entry.id, patch: entry.patch as NonNullable<typeof entry.patch> }));
      single.draw.features.updateMany(patches);
      expect(snapshot(bulk.draw)).toEqual(snapshot(single.draw));
      const previous = bulk.changes[bulk.changes.length - 1].previousValues as FeatureValues;
      bulk.draw.features.restore(previous);
      expect(snapshot(bulk.draw)).toEqual(before);
    }
  });

  it('group as the same features selected one by one in their order, and ungroup', () => {
    for (let seed = 20; seed <= 26; seed++) {
      const { bulk, single } = pair(seed);
      // Features in no group
      const ids = pick(bulk.draw, bulk.next, 0.5).filter(
        (id) => bulk.draw.features.get(id)?.groupId === undefined,
      );
      if (ids.length <= 3) continue;
      bulk.draw.selection.set('feature', ids);
      single.draw.selection.set('feature', ids);
      expect(bulk.draw.selection.group()).not.toBeNull();
      expect(single.draw.selection.group()).not.toBeNull();
      expect(snapshot(bulk.draw)).toEqual(snapshot(single.draw));
    }
    for (let seed = 30; seed <= 36; seed++) {
      const { bulk, single } = pair(seed);
      const ids = pick(bulk.draw, bulk.next, 0.7);
      if (ids.length <= 3) continue;
      bulk.draw.selection.set('feature', ids);
      single.draw.selection.set('feature', ids);
      // Out of their groups: the features of a group go just in front of it, in their order
      const moved = bulk.draw.selection.move({ groupId: null });
      expect(moved).toBe(single.draw.selection.move({ groupId: null }));
      expect(snapshot(bulk.draw)).toEqual(snapshot(single.draw));
    }
  });

  it('move to another layer in their order, and undo by the moves of the order', () => {
    for (let seed = 40; seed <= 46; seed++) {
      const { bulk, single } = pair(seed);
      const ids = pick(bulk.draw, bulk.next, 0.5);
      if (ids.length <= 3) continue;
      bulk.draw.selection.set('feature', ids);
      single.draw.selection.set('feature', ids);
      expect(bulk.draw.selection.move({ layerId: 'm' })).toBe(true);
      expect(single.draw.selection.move({ layerId: 'm' })).toBe(true);
      expect(snapshot(bulk.draw)).toEqual(snapshot(single.draw));
      expect(bulk.draw.selection.get().bulk?.layerIds).toEqual(['m']);
    }
  });

  it('are refused, with their undo, while read-only or under the interaction lock', () => {
    const { bulk } = pair(50);
    const ids = pick(bulk.draw, bulk.next, 0.6);
    bulk.draw.selection.set('feature', ids);
    bulk.draw.selection.update({ style: { strokeColor: '#123456' } });
    const previous = bulk.changes[bulk.changes.length - 1].previousValues as FeatureValues;
    const store = bulk.draw.getStore() as unknown as DrawStore;
    store.setReadOnly(true);
    const before = snapshot(bulk.draw);
    expect(bulk.draw.selection.delete()).toBe(false);
    expect(bulk.draw.selection.update({ style: { strokeColor: '#000000' } })).toBe(false);
    expect(bulk.draw.selection.move({ layerId: 'm' })).toBe(false);
    expect(bulk.draw.selection.group()).toBeNull();
    expect(bulk.draw.features.restore(previous)).toBeNull();
    expect(snapshot(bulk.draw)).toEqual(before);
    store.setReadOnly(false);
    store.setInteractionLock(true);
    expect(bulk.draw.selection.delete()).toBe(false);
    expect(bulk.draw.selection.update({ style: { strokeColor: '#000000' } })).toBe(false);
    expect(bulk.draw.selection.move({ layerId: 'm' })).toBe(false);
    expect(snapshot(bulk.draw)).toEqual(before);
  });

  it('refuse a patch that changes the geometry', () => {
    const { bulk } = pair(51);
    bulk.draw.selection.set('feature', pick(bulk.draw, bulk.next, 0.6));
    expect(() =>
      bulk.draw.selection.update({ geometry: { type: 'Point', coordinates: [0, 0] } }),
    ).toThrow(/geometry/);
  });

  it('read the selection a page at a time, count it, and select every feature of a filter', () => {
    const { bulk, single } = pair(52);
    expect(bulk.draw.selection.setAll({ type: 'Point' })).toBe(true);
    const points = bulk.draw.features.count({ type: 'Point' });
    expect(bulk.draw.selection.get().bulk?.count).toBe(points);
    expect(bulk.draw.selection.count()).toBe(points);
    expect(bulk.draw.selection.count({ groupId: 'g1' })).toBe(
      bulk.draw.features.count({ type: 'Point', groupId: 'g1' }),
    );
    expect(() => bulk.draw.selection.features()).toThrow(/limit/);
    const pages: string[] = [];
    let after: string | undefined;
    for (;;) {
      const page = bulk.draw.selection.features(undefined, { limit: 4, after });
      if (page.length === 0) break;
      pages.push(...page.map((feature) => feature.id));
      after = page[page.length - 1].id;
    }
    expect(pages).toEqual(
      bulk.draw.features.list({ type: 'Point' }, { limit: 10_000 }).map((feature) => feature.id),
    );
    // One by one: the same features
    expect(single.draw.selection.setAll({ type: 'Point' })).toBe(true);
    expect(single.draw.selection.features().map((feature) => feature.id)).toEqual(pages);
    expect(single.draw.selection.count()).toBe(points);
  });

  it('add and take out features, opening them once few enough, and restore a selection', () => {
    const { bulk } = pair(53);
    const ids = pick(bulk.draw, bulk.next, 0.5).slice(0, 6);
    bulk.draw.selection.set('feature', ids.slice(0, 4));
    const kept = bulk.draw.selection.get();
    expect(kept.bulk?.count).toBe(4);
    expect(bulk.draw.selection.add([ids[4]])).toBe(true);
    expect(bulk.draw.selection.get().bulk?.count).toBe(5);
    expect(bulk.draw.selection.remove(ids.slice(0, 3))).toBe(true);
    expect(bulk.draw.selection.get().ids).toEqual([ids[3], ids[4]]);
    expect(bulk.draw.selection.restore(kept)).toBe(true);
    expect(bulk.draw.selection.get().bulk?.count).toBe(4);
  });
});
