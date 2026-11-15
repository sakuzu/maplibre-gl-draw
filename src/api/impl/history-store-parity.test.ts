// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Undo, redo and the notifications of one commit over a Store of objects and a Store of rows
 *
 * Both Stores give the same result and the same notification: what a commit tells is the
 * difference between before it and after it, and taking it back and making it again puts the
 * document where it was before and after the commit.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryStore } from '../../store/memory.js';
import type { Store } from '../../store/store.js';
import { createTableStore } from '../../store/table-memory.js';
import { writesOf } from '../../test-support/writes.js';
import { createMapStub } from '../../test-utils.js';
import type { Draw } from '../draw.js';
import { createDraw } from '../draw.js';
import type { DocumentChange } from '../events.js';
import type { FeatureInput } from '../model.js';

const opened: Draw[] = [];
afterEach(() => {
  for (const draw of opened.splice(0)) draw.destroy();
});

const layerOf = (kind: 'objects' | 'rows', id: string) => ({
  id,
  name: id,
  visible: true,
  locked: false,
  opacity: 1,
  ...(kind === 'rows' ? { kind: 'table' as const } : { items: [] }),
  styleRule: undefined,
  metadata: undefined,
});

/** An instance over a Store of objects or of rows, with two layers, and what its Store tells */
function open(kind: 'objects' | 'rows') {
  const store: Store = kind === 'rows' ? createTableStore().store : new MemoryStore();
  for (const id of ['a', 'b']) store.createLayer(layerOf(kind, id));
  const draw = createDraw(createMapStub().map, { store, initDefaultLayer: false });
  opened.push(draw);
  const told: DocumentChange[] = [];
  draw.getStore().subscribe((change) => told.push(change));
  return { draw, store, told };
}

const point = (id: string, layerId: string): FeatureInput => ({
  type: 'Feature',
  id,
  geometry: { type: 'Point', coordinates: [1, 1] },
  properties: { 'maplibre-gl-draw:layerId': layerId },
});

/** Deletes features as a commit from elsewhere does */
function deleteElsewhere(draw: Draw, ids: readonly string[]): void {
  const writes = writesOf(draw);
  writes.transact(
    () => {
      for (const id of ids) writes.features.delete(id);
    },
    { source: 'remote' },
  );
}

/** Where everything is: the items of each layer, the members of each group */
function places(draw: Draw) {
  const out: Record<string, readonly string[]> = {};
  for (const layer of draw.layers.list()) {
    out[layer.id] = draw.layers.listItems(layer.id);
    for (const id of out[layer.id]) {
      if (draw.groups.get(id)) out[`${layer.id}/${id}`] = draw.groups.listMembers(id);
    }
  }
  return out;
}

describe.each(['objects', 'rows'] as const)('over a Store of %s', (kind) => {
  it('makes a feature created and put in a group in one commit again with redo', async () => {
    const { draw } = open(kind);
    await draw.write(async (tx) => {
      await tx.features.create([point('m1', 'a'), point('m2', 'a')]);
      await tx.groups.create({ id: 'g', name: 'g', members: ['m1'] });
    });
    const before = places(draw);
    await draw.write(async (tx) => {
      await tx.features.create(point('f', 'a'));
      await tx.features.place('f', { layerId: 'a', groupId: 'g' });
    });
    const after = places(draw);
    expect(after['a/g']).toContain('f');
    for (let round = 0; round < 2; round++) {
      await draw.undo();
      expect(draw.features.get('f')).toBeUndefined();
      expect(places(draw)).toEqual(before);
      await draw.redo();
      expect(draw.features.get('f')?.id).toBe('f');
      expect(places(draw)).toEqual(after);
    }
  });

  it('makes a feature created and put in another layer in one commit again with redo', async () => {
    const { draw } = open(kind);
    await draw.write((tx) => tx.features.create([point('b1', 'b'), point('b2', 'b')]));
    const before = places(draw);
    await draw.write(async (tx) => {
      await tx.features.create(point('f', 'a'));
      await tx.features.place('f', { layerId: 'b', above: 'b2' });
    });
    const after = places(draw);
    expect(after.b).toEqual(['b1', 'f', 'b2']);
    for (let round = 0; round < 2; round++) {
      await draw.undo();
      expect(draw.features.get('f')).toBeUndefined();
      expect(places(draw)).toEqual(before);
      await draw.redo();
      expect(draw.features.get('f')?.properties).toBeDefined();
      expect(places(draw)).toEqual(after);
    }
  });

  it('makes a feature created and put lower in its layer in one commit again with redo', async () => {
    const { draw } = open(kind);
    await draw.write((tx) => tx.features.create([point('a1', 'a'), point('a2', 'a')]));
    const before = places(draw);
    await draw.write(async (tx) => {
      await tx.features.create(point('f', 'a'));
      await tx.features.place('f', { layerId: 'a', above: 'a1' });
    });
    const after = places(draw);
    expect(after.a).toEqual(['f', 'a1', 'a2']);
    for (let round = 0; round < 2; round++) {
      await draw.undo();
      expect(places(draw)).toEqual(before);
      await draw.redo();
      expect(places(draw)).toEqual(after);
    }
  });

  it('makes a group deleted with its members and created again around a new feature again with redo', async () => {
    const { draw } = open(kind);
    await draw.write(async (tx) => {
      await tx.features.create([point('m1', 'a'), point('m2', 'a'), point('m3', 'a')]);
      await tx.groups.create({ id: 'g', name: 'before', members: ['m1', 'm2'] });
    });
    const before = places(draw);
    await draw.write(async (tx) => {
      await tx.groups.delete('g', { members: 'delete' });
      await tx.features.create(point('new', 'a'));
      await tx.groups.create({ id: 'g', name: 'after', members: ['new'] });
    });
    const after = places(draw);
    expect(after['a/g']).toEqual(['new']);
    for (let round = 0; round < 2; round++) {
      await draw.undo();
      expect(draw.groups.get('g')?.name).toBe('before');
      expect(places(draw)).toEqual(before);
      expect(draw.features.get('new')).toBeUndefined();
      await draw.redo();
      expect(draw.groups.get('g')?.name).toBe('after');
      expect(places(draw)).toEqual(after);
      expect(draw.features.get('m1')).toBeUndefined();
      expect(draw.features.get('m2')).toBeUndefined();
    }
  });

  it('makes no group again whose members were deleted elsewhere since, with undo and redo', async () => {
    const { draw } = open(kind);
    await draw.write(async (tx) => {
      await tx.features.create([point('m1', 'a'), point('m2', 'a')]);
      await tx.groups.create({ id: 'g', members: ['m1'] });
    });
    // The last member leaves: the group goes with it
    await draw.write((tx) => tx.features.place(['m1'], { layerId: 'a' }));
    expect(draw.groups.get('g')).toBeUndefined();
    deleteElsewhere(draw, ['m1']);
    await draw.undo();
    expect(draw.groups.list()).toEqual([]);
    expect(places(draw)).toEqual({ a: ['m2'], b: [] });
    // A group made around a feature deleted elsewhere after its undo: its redo makes none either
    await draw.write((tx) => tx.features.create(point('m3', 'b')));
    await draw.write((tx) => tx.groups.create({ id: 'h', members: ['m3'] }));
    await draw.undo();
    deleteElsewhere(draw, ['m3']);
    await draw.redo();
    expect(draw.groups.list()).toEqual([]);
  });

  it('makes a group again with the members still there, with undo', async () => {
    const { draw } = open(kind);
    await draw.write(async (tx) => {
      await tx.features.create([point('m1', 'a'), point('m2', 'a'), point('m3', 'a')]);
      await tx.groups.create({ id: 'g', members: ['m1', 'm2'] });
    });
    await draw.write((tx) => tx.groups.delete('g', { members: 'keep' }));
    deleteElsewhere(draw, ['m1']);
    await draw.undo();
    expect(draw.groups.listMembers('g')).toEqual(['m2']);
  });

  it('makes no group again over many rows whose members were deleted elsewhere, and one with a member left', async () => {
    const { draw, store } = open(kind);
    // Each look at the clock is 13 ms later: a restore of many rows writes one run of rows a task
    let clock = 0;
    const undoInSteps = async (): Promise<void> => {
      const spy = vi.spyOn(performance, 'now').mockImplementation(() => (clock += 13));
      try {
        const write = draw.undo();
        if (kind === 'rows') expect(store.slicedWritePending).toBe(true);
        await write;
      } finally {
        spy.mockRestore();
      }
    };
    const ids = Array.from({ length: 600 }, (_, i) => `p${i}`);
    await draw.write(async (tx) => {
      await tx.features.create(ids.map((id) => point(id, 'a')));
      await tx.groups.create({ id: 'g', members: ids });
    });
    await draw.write((tx) => tx.groups.delete('g', { members: 'keep' }));
    deleteElsewhere(draw, ids);
    await undoInSteps();
    expect(draw.groups.list()).toEqual([]);
    await draw.write(async (tx) => {
      await tx.features.create(ids.map((id) => point(`q${id}`, 'b')));
      await tx.groups.create({ id: 'h', members: ids.map((id) => `q${id}`) });
    });
    await draw.write((tx) => tx.groups.delete('h', { members: 'keep' }));
    deleteElsewhere(
      draw,
      ids.slice(0, -1).map((id) => `q${id}`),
    );
    await undoInSteps();
    expect(draw.groups.listMembers('h')).toEqual([`q${ids[ids.length - 1]}`]);
  });

  it('tells the metadata from before the commit, and undo puts it back there', async () => {
    const { draw, told } = open(kind);
    await draw.write((tx) => tx.document.update({ title: 'first' }));
    told.length = 0;
    await draw.write(async (tx) => {
      await tx.document.update({ title: 'middle' });
      await tx.document.update({ title: 'last' });
    });
    expect(told).toHaveLength(1);
    expect(told[0].metadata?.previous.title).toBe('first');
    expect(told[0].metadata?.metadata.title).toBe('last');
    for (let round = 0; round < 2; round++) {
      await draw.undo();
      expect(draw.document.title).toBe('first');
      await draw.redo();
      expect(draw.document.title).toBe('last');
    }
  });

  it('tells the order of the layers when a layer is created and deleted', async () => {
    const { draw, told } = open(kind);
    told.length = 0;
    await draw.write((tx) => tx.layers.create({ id: 'c', name: 'c' }));
    expect(told).toHaveLength(1);
    expect(told[0].layers?.orderChanged).toEqual({ order: ['a', 'b', 'c'], previous: ['a', 'b'] });
    told.length = 0;
    await draw.write((tx) => tx.layers.delete('a'));
    expect(told).toHaveLength(1);
    expect(told[0].layers?.orderChanged).toEqual({ order: ['b', 'c'], previous: ['a', 'b', 'c'] });
    await draw.undo();
    expect(draw.layers.list().map((layer) => layer.id)).toEqual(['a', 'b', 'c']);
    await draw.redo();
    expect(draw.layers.list().map((layer) => layer.id)).toEqual(['b', 'c']);
  });

  it('tells the order of the layers from before the commit when a layer is created at an index', async () => {
    const { draw, told } = open(kind);
    told.length = 0;
    await draw.write((tx) => tx.layers.create({ id: 'c', name: 'c', index: 0 }));
    expect(told).toHaveLength(1);
    expect(told[0].layers?.orderChanged).toEqual({ order: ['c', 'a', 'b'], previous: ['a', 'b'] });
    await draw.undo();
    expect(draw.layers.list().map((layer) => layer.id)).toEqual(['a', 'b']);
    await draw.redo();
    expect(draw.layers.list().map((layer) => layer.id)).toEqual(['c', 'a', 'b']);
  });
});
