// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `change` tells one commit as a whole, in the same shape over a Store of objects and a Store of
 * rows: a feature once, with what it was before the commit, a feature created and deleted in the
 * commit not at all, a feature put in another place alone as placed, and a change of the stacking
 * order of the layers by the layers alone
 */

import { afterEach, describe, expect, it } from 'vitest';
import { MemoryStore } from '../../store/memory.js';
import type { Store } from '../../store/store.js';
import { createTableStore } from '../../store/table-memory.js';
import { createMapStub } from '../../test-utils.js';
import type { Draw } from '../draw.js';
import { createDraw } from '../draw.js';
import type { Change } from '../events.js';
import type { Feature, Group } from '../model.js';

const opened: Draw[] = [];
afterEach(() => {
  for (const draw of opened.splice(0)) draw.destroy();
});

const point = (x: number, layerId?: string) => ({
  type: 'Point' as const,
  geometry: { type: 'Point' as const, coordinates: [x, x] },
  ...(layerId && { layerId }),
});

/** An instance over a Store of objects or of rows, with two layers, and the changes it tells */
function open(kind: 'objects' | 'rows') {
  let store: Store;
  if (kind === 'rows') {
    store = createTableStore().store;
    for (const id of ['a', 'b']) {
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
  } else {
    store = new MemoryStore();
    for (const id of ['a', 'b']) {
      store.createLayer({
        id,
        name: id,
        visible: true,
        locked: false,
        opacity: 1,
        items: [],
        styleRule: undefined,
        metadata: undefined,
      });
    }
  }
  const draw = createDraw(createMapStub().map, { store, initDefaultLayer: false });
  opened.push(draw);
  const changes: Change[] = [];
  const before: Array<Record<string, Feature | undefined>> = [];
  draw.on('change', (change) => {
    changes.push(change);
    const read: Record<string, Feature | undefined> = {};
    const { features } = change;
    for (const id of [...features.updated, ...features.deleted, ...features.placed]) {
      read[id] = change.previous(id);
    }
    before.push(read);
  });
  return { draw, changes, before };
}

const NONE = { created: [], updated: [], deleted: [], placed: [] };

describe.each(['objects', 'rows'] as const)('one commit over a Store of %s', (kind) => {
  it('tells a feature written twice once, with what it was before the commit', () => {
    const { draw, changes, before } = open(kind);
    const f = draw.features.create(point(1, 'a')) as Feature;
    const was = draw.features.get(f.id);
    changes.length = 0;
    before.length = 0;
    draw.transact(() => {
      draw.features.update(f.id, { properties: { n: 1 } });
      draw.features.update(f.id, { properties: { n: 2 } });
    });
    expect(changes).toHaveLength(1);
    expect(changes[0].features).toEqual({ ...NONE, updated: [f.id] });
    expect(before[0][f.id]).toEqual(was);
  });

  it('tells a feature written then deleted as deleted, with what it was before the commit', () => {
    const { draw, changes, before } = open(kind);
    const f = draw.features.create(point(1, 'a')) as Feature;
    const was = draw.features.get(f.id);
    changes.length = 0;
    before.length = 0;
    draw.transact(() => {
      draw.features.update(f.id, { properties: { n: 1 } });
      draw.features.delete(f.id);
    });
    expect(changes[0].features).toEqual({ ...NONE, deleted: [f.id] });
    expect(before[0][f.id]).toEqual(was);
  });

  it('tells a feature created then written as created, and one created then deleted not at all', () => {
    const { draw, changes } = open(kind);
    draw.features.create(point(0, 'a'));
    changes.length = 0;
    let created = '';
    let gone = '';
    draw.transact(() => {
      created = (draw.features.create(point(1, 'a')) as Feature).id;
      draw.features.update(created, { properties: { n: 1 } });
      gone = (draw.features.create(point(2, 'a')) as Feature).id;
      draw.features.delete(gone);
    });
    expect(changes).toHaveLength(1);
    expect(changes[0].features.created).toEqual([created]);
    for (const list of Object.values(changes[0].features)) expect(list).not.toContain(gone);
    expect(changes[0].features.updated).toEqual([]);
  });

  it('tells a feature put into another layer or group alone as placed, with its place before', () => {
    const { draw, changes, before } = open(kind);
    const f = draw.features.create(point(1, 'a')) as Feature;
    const g = draw.features.create(point(2, 'b')) as Feature;
    const group = draw.groups.create({ featureIds: [g.id] }) as Group;
    changes.length = 0;
    before.length = 0;
    draw.features.move(f.id, { layerId: 'b', below: null, above: group.id });
    expect(changes[0].features).toEqual({ ...NONE, placed: [f.id] });
    expect(before[0][f.id]?.layerId).toBe('a');
    draw.features.move(f.id, { layerId: 'b', groupId: group.id, below: null, above: g.id });
    expect(changes[1].features).toEqual({ ...NONE, placed: [f.id] });
    expect(before[1][f.id]?.groupId).toBeUndefined();
    expect(before[1][f.id]?.layerId).toBe('b');
  });

  it('tells features put in another place of their layer as placed alone', () => {
    const { draw, changes } = open(kind);
    const ids = [1, 2, 3, 4].map((x) => (draw.features.create(point(x, 'a')) as Feature).id);
    changes.length = 0;
    // The first and the third to the front, apart from each other
    draw.features.moveMany([ids[0], ids[2]], { layerId: 'a', below: ids[3], above: null });
    expect(changes).toHaveLength(1);
    expect(changes[0].features.updated).toEqual([]);
    // The moves the Store tells (the fewest that make the new order) name features of the layer
    expect(changes[0].features.placed.length).toBeGreaterThan(0);
    for (const id of changes[0].features.placed) expect(ids).toContain(id);
  });
});

describe('the stacking order of the layers', () => {
  it('lists the layers alone as placed, and tells another entry put in or out of it as a change of the document', () => {
    const { draw, changes } = open('objects');
    draw.datasets.add({ id: 'd', rows: [], order: 'layer-order' } as never);
    changes.length = 0;
    draw.layers.reorder(['a', 'b', 'd']);
    expect(changes).toHaveLength(1);
    expect(changes[0].layers.placed).toEqual([]);
    expect(changes[0].document).toBe(true);
    draw.layers.reorder(['b', 'a', 'd']);
    expect(changes[1].layers.placed).toHaveLength(1);
    expect(changes[1].layers.placed).not.toContain('d');
  });
});

describe.each(['objects', 'rows'] as const)(
  'the value of an observable over a Store of %s',
  (kind) => {
    it('is the same object while the value does not change, and a new one once it does', () => {
      const { draw } = open(kind);
      const f = draw.features.create(point(1, 'a')) as Feature;
      draw.selection.set('feature', [f.id]);
      draw.datasets.add({ id: 'd', rows: [] } as never);
      for (const observable of [
        draw.options,
        draw.datasets,
        draw.sketches,
        draw.selection,
        draw.mode,
        draw.hidden.hiddenIds,
        draw.vertexSelection,
        draw.rendered.changed,
      ] as const) {
        expect(observable.value).toBe(observable.value);
      }
      const options = draw.options.value;
      draw.options.update({ dragThreshold: 9 });
      expect(draw.options.value).not.toBe(options);
      expect(draw.options.value.dragThreshold).toBe(9);
      const datasets = draw.datasets.value;
      draw.datasets.add({ id: 'e', rows: [] } as never);
      expect(draw.datasets.value).not.toBe(datasets);
      expect(draw.datasets.value).toHaveLength(2);
    });
  },
);
