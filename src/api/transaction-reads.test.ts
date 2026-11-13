// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The reads of a transaction over the whole document read its writes over the document committed:
 * what they read once its function ends is what the instance reads once it is committed, the
 * order included (a feature created, put elsewhere, deleted, a group made, taken apart or put
 * elsewhere, the result of an operation on areas, a layer created or put elsewhere)
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTableStore } from '../store/table-memory.js';
import { createMapStub } from '../test-utils.js';
import type { Draw } from './draw.js';
import { createDraw } from './draw.js';
import type { Transaction } from './write.js';

let draw: Draw;

const LAYER = 'maplibre-gl-draw:layerId';
const GROUP = 'maplibre-gl-draw:groupId';

function point(id: string, x: number, layerId = 'l', groupId?: string) {
  return {
    type: 'Feature' as const,
    id,
    geometry: { type: 'Point' as const, coordinates: [x, 0] },
    properties: { [LAYER]: layerId, ...(groupId && { [GROUP]: groupId }) },
  };
}

function square(id: string, x: number) {
  return {
    type: 'Feature' as const,
    id,
    geometry: {
      type: 'Polygon' as const,
      coordinates: [
        [
          [x, 0],
          [x + 2, 0],
          [x + 2, 2],
          [x, 2],
          [x, 0],
        ],
      ],
    },
    properties: { [LAYER]: 'l' },
  };
}

/** What the reads over the whole document read, through the reads given */
function readWhole(reads: Pick<Draw, 'features' | 'layers' | 'groups'>): unknown {
  const { features, layers, groups } = reads;
  const layerIds = layers.getOrder().filter((id) => layers.has(id));
  return {
    list: features
      .list({}, { limit: 1000 })
      .map((f) => [f.id, f.properties[LAYER], f.properties[GROUP] ?? null]),
    count: features.count(),
    byLayer: layerIds.map((id) => features.count({ layerId: id })),
    shown: features.count({ shown: true }),
    bbox: features.bbox(),
    page: features.list({}, { limit: 3, after: features.list({}, { limit: 2 })[1]?.id }),
    order: layerIds,
    layers: layers.list().map((layer) => layer.id),
    items: layerIds.map((id) => layers.listItems(id)),
    itemCounts: layerIds.map((id) => layers.countItems(id)),
    groups: groups.list().map((group) => group.id),
    members: groups.list().map((group) => groups.listMembers(group.id)),
  };
}

/** Writes, reads over the whole document at the end of the function, and compares once committed */
async function sameOnceCommitted(fn: (tx: Transaction) => Promise<unknown>): Promise<void> {
  let inside: unknown;
  await draw.write(async (tx) => {
    await fn(tx);
    inside = readWhole(tx);
  });
  expect(inside).toEqual(readWhole(draw));
}

describe('the reads of a transaction over the whole document', () => {
  beforeEach(async () => {
    let next = 0;
    draw = createDraw(createMapStub().map, {
      // Past two features, a selection holds its rows in bulk
      store: createTableStore({ selectionIdsLimit: 2 }).store,
      generateId: () => `n${++next}`,
      initDefaultLayer: false,
    });
    await draw.write(async (tx) => {
      await tx.layers.create({ id: 'l', name: 'l' });
      await tx.layers.create({ id: 'm', name: 'm' });
      await tx.features.create(Array.from({ length: 12 }, (_, i) => point(`p${i}`, i)));
      await tx.groups.create({ id: 'g', name: 'g', members: ['p2', 'p3', 'p4'] });
      await tx.features.create([square('s0', 20), square('s1', 21)]);
    });
  });

  afterEach(() => {
    draw.destroy();
  });

  it('read the document as it is before any write', async () => {
    await sameOnceCommitted(async () => {});
  });

  it('read the features created, at the front of their layer and of their group', async () => {
    await sameOnceCommitted(async (tx) => {
      await tx.features.create(point('a', 1));
      await tx.features.create(point('b', 2, 'm'));
      await tx.features.create(point('c', 3, 'l', 'g'));
      await tx.features.create(point('d', 4));
    });
  });

  it('leave out the features deleted, and read the ones changed', async () => {
    await sameOnceCommitted(async (tx) => {
      await tx.features.delete(['p1', 'p3']);
      await tx.features.update('p5', { properties: { 'app:n': 1 } });
      await tx.features.update('p6', { properties: { 'maplibre-gl-draw:visible': false } });
    });
  });

  it('read the features put in another layer, by an item, in a group and out of it', async () => {
    await sameOnceCommitted(async (tx) => {
      await tx.features.place(['p0', 'p7'], { layerId: 'm' });
      await tx.features.place(['p8'], { below: 'p1' });
      await tx.features.place(['p9'], { above: 'p1' });
      await tx.features.place(['p10'], { groupId: 'g' });
      await tx.features.place(['p3'], { layerId: 'l', below: 'g' });
    });
  });

  it('read a group made where its frontmost member was, and one taken apart', async () => {
    await sameOnceCommitted(async (tx) => {
      await tx.groups.create({ id: 'h', name: 'h', members: ['p5', 'p9', 'p7'] });
      await tx.groups.delete('g', { members: 'keep' });
    });
  });

  it('read a group deleted with its members, and one put in another layer', async () => {
    await sameOnceCommitted(async (tx) => {
      await tx.groups.create({ id: 'h', name: 'h', members: ['p6', 'p8'] });
      await tx.groups.place('h', { layerId: 'm' });
      await tx.groups.delete('g', { members: 'delete' });
    });
  });

  it('read the result of an operation on areas in the place of its input', async () => {
    await sameOnceCommitted(async (tx) => {
      await tx.features.union(['s0', 's1']);
    });
  });

  it('read the layers created and put in another place of the stacking order', async () => {
    await sameOnceCommitted(async (tx) => {
      await tx.layers.create({ id: 'k', name: 'k', index: 0 });
      await tx.layers.place('l', { above: 'k' });
      await tx.features.create(point('a', 1, 'k'));
    });
  });

  it('read the features selected in bulk put in another layer', async () => {
    draw.selection.set('feature', ['p0', 'p5', 'p6', 'p9']);
    const target = draw.selection.target;
    await sameOnceCommitted(async (tx) => {
      await tx.features.place(target, { layerId: 'm' });
    });
  });

  it('read the features selected in bulk put in a group, changed and deleted', async () => {
    draw.selection.set('feature', ['p0', 'p5', 'p6', 'p9']);
    const target = draw.selection.target;
    await sameOnceCommitted(async (tx) => {
      await tx.features.place(target, { groupId: 'g' });
    });
    draw.selection.set('feature', ['p1', 'p7', 'p8']);
    const other = draw.selection.target;
    await sameOnceCommitted(async (tx) => {
      await tx.features.update(other, { properties: { 'maplibre-gl-draw:visible': false } });
    });
    await sameOnceCommitted(async (tx) => {
      await tx.features.delete(other);
    });
  });

  it('read many writes one after the other', async () => {
    await sameOnceCommitted(async (tx) => {
      await tx.features.create(point('a', 1, 'l', 'g'));
      await tx.features.place(['a', 'p0'], { layerId: 'm' });
      await tx.groups.create({ id: 'h', name: 'h', members: ['a', 'p0'] });
      await tx.features.delete('p11');
      await tx.features.place(['p10'], { below: 'h' });
      await tx.features.create(point('b', 2, 'm', 'h'));
    });
  });
});
