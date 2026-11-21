// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What the values before a change keep, and the writes of the layer the values are written back
 * with:
 *
 * - The rows a change deleted go once the change is told when no subscriber asked for its values
 *   before; they stay while the values given to the subscribers keep them, until every one has
 *   let go of its values (`features.releaseValues`), and a listener that throws keeps nothing
 * - A row brought back (its deletion written 0), by the instance or by a change written to the
 *   Store directly, is told as created, in the change and with `feature.created`
 * - The layer writes values of rows as columns (the locked rows left out unless the locks are
 *   ignored, a row whose group is gone put at the front of its layer), places a group under a key
 *   of a layer, notes the place a deleted group had, and marks the changes of whole geometries
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createStore } from '../../store/built-in/create-store.js';
import type { FeatureRowField, Store } from '../../store/built-in/types.js';
import type { InstanceDocument } from '../../store/document-access.js';
import type { Group } from '../../store/types.js';
import { createMapStub } from '../../test-utils.js';
import type { Draw } from '../draw.js';
import type { DocumentChange } from '../events.js';
import type { FeatureValues } from '../model.js';
import { createDrawOnEngine } from './create-draw.js';
import { type ChangeSummary, summaryOfChange } from './document-access.js';
import { createEngine } from './engine.js';

let store: Store;
let draw: Draw;
let layer: InstanceDocument;

beforeEach(() => {
  store = createStore();
  const engine = createEngine(createMapStub().map, { store }, { deferDefaultMode: true });
  draw = createDrawOnEngine(engine, { store });
  engine.enterDefaultMode();
  layer = engine.context.store;
});

afterEach(() => {
  draw.destroy();
});

const point = (id: string, x = 0, more: Record<string, unknown> = {}) => ({
  id,
  type: 'Point' as const,
  geometry: { type: 'Point' as const, coordinates: [x, 0] },
  ...more,
});

/** Whether the Store still keeps a deleted row of an ID (for it to be brought back) */
const kept = (id: string): boolean => store.tables.findRow(id)?.deleted === true;

/** The summaries of the changes the layer tells from now on */
function summaries(): ChangeSummary[] {
  const out: ChangeSummary[] = [];
  layer.subscribe((change) => {
    const summary = summaryOfChange(change);
    if (summary) out.push(summary);
  });
  return out;
}

describe('the rows a change deleted', () => {
  it('go once the change is told when no subscriber asked for its values before', () => {
    draw.features.create(point('a'));
    draw.document.subscribe(() => {});
    draw.features.delete('a');
    expect(kept('a')).toBe(false);
  });

  it('stay until every subscriber that was given values lets go of them', () => {
    draw.features.create(point('a'));
    const first: FeatureValues[] = [];
    const second: FeatureValues[] = [];
    draw.document.subscribe(
      (change) => {
        if (change.previousValues) first.push(change.previousValues);
      },
      { previousValues: true },
    );
    const stop = draw.document.subscribe(
      (change) => {
        if (change.previousValues) second.push(change.previousValues);
      },
      { previousValues: true },
    );
    draw.features.delete('a');
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(kept('a')).toBe(true);
    // Unsubscribing lets go of nothing
    stop();
    expect(kept('a')).toBe(true);
    draw.features.releaseValues(first);
    // Twice is once
    draw.features.releaseValues(first);
    expect(kept('a')).toBe(true);
    draw.features.releaseValues(second);
    expect(kept('a')).toBe(false);
  });

  it('do not stay when the listener of the layer that reads the change throws', () => {
    draw.features.create(point('a'));
    layer.subscribe(() => {
      throw new Error('a listener that throws');
    });
    // Asked for, but the values are given to no subscriber
    const stop = draw.document.subscribe(() => {}, { previousValues: true });
    stop();
    const watched = draw.document.subscribe(() => {
      throw new Error('a subscriber that throws');
    });
    draw.features.delete('a');
    watched();
    expect(kept('a')).toBe(false);
  });

  it('stay for a subscriber that throws once it was given values, until it lets go of them', () => {
    draw.features.create(point('a'));
    const held: FeatureValues[] = [];
    draw.document.subscribe(
      (change) => {
        if (change.previousValues) held.push(change.previousValues);
        throw new Error('a subscriber that throws');
      },
      { previousValues: true },
    );
    draw.features.delete('a');
    expect(kept('a')).toBe(true);
    draw.features.releaseValues(held);
    expect(kept('a')).toBe(false);
  });
});

describe('a row brought back', () => {
  it('is told as created when a change written to the Store directly brings it back', () => {
    draw.features.create(point('a'));
    const held: FeatureValues[] = [];
    draw.document.subscribe(
      (change) => {
        if (change.previousValues) held.push(change.previousValues);
      },
      { previousValues: true },
    );
    draw.features.delete('a');
    const ref = store.tables.findRow('a')?.ref as number;
    const changes: DocumentChange[] = [];
    draw.on('document.changed', (change) => changes.push(change));
    const created: string[] = [];
    draw.on('feature.created', ({ feature }) => created.push(feature.id));
    store.transact(() => {
      store.writeRows({ rows: Int32Array.of(ref), fields: new Map(), deleted: Uint8Array.of(0) });
    }, 'remote');
    expect(draw.features.has('a')).toBe(true);
    expect(created).toEqual(['a']);
    expect(changes).toHaveLength(1);
    expect(changes[0].features.created.toArray()).toEqual(['a']);
    expect(changes[0].features.updated.count()).toBe(0);
  });

  it('is told as created when the layer brings it back', () => {
    draw.features.create(point('a'));
    draw.document.subscribe(() => {}, { previousValues: true });
    draw.features.delete('a');
    const ref = store.tables.findRow('a')?.ref as number;
    const layerId = draw.layers.list()[0].id;
    const created: string[] = [];
    draw.on('feature.created', ({ feature }) => created.push(feature.id));
    const written = layer.writeRowValues(layerId, {
      rows: Int32Array.of(ref),
      fields: new Map(),
      deleted: Uint8Array.of(0),
    });
    expect(Array.from(written)).toEqual([ref]);
    expect(created).toEqual(['a']);
    expect(draw.features.get('a')?.geometry).toEqual({ type: 'Point', coordinates: [0, 0] });
  });
});

describe('the writes of values of rows as columns', () => {
  /** The reference of the row of a feature */
  const refOf = (id: string) => store.tables.getRowRef(id) as number;

  it('writes the fields given, and leaves the locked rows unless the locks are ignored', () => {
    const layerId = draw.layers.list()[0].id;
    draw.features.createMany([point('a'), point('b', 1, { locked: true })]);
    const values = {
      rows: Int32Array.of(refOf('a'), refOf('b')),
      fields: new Map<FeatureRowField, unknown[]>([['properties:n', [1, 2]]]),
    };
    expect(Array.from(layer.writeRowValues(layerId, values))).toEqual([refOf('a')]);
    expect(draw.features.get('a')?.properties.n).toBe(1);
    expect(draw.features.get('b')?.properties.n).toBeUndefined();
    layer.writeRowValues(layerId, values, { ignoreLocks: true });
    expect(draw.features.get('b')?.properties.n).toBe(2);
  });

  it('puts a row whose group is gone at the front of its layer', () => {
    const layerId = draw.layers.list()[0].id;
    draw.features.createMany([point('a'), point('b', 1), point('c', 2)]);
    draw.groups.create({ id: 'g', featureIds: ['a'] });
    const at = refOf('a');
    const parentBefore = store.tables.readValues(Int32Array.of(at), ['parent']).fields;
    expect(parentBefore.get('parent')?.[0]).toBe('g');
    draw.groups.delete('g');
    layer.writeRowValues(layerId, {
      rows: Int32Array.of(at),
      fields: new Map<FeatureRowField, unknown[]>([
        ['parent', ['g']],
        ['orderKey', ['a0']],
      ]),
    });
    const items = draw.layers.listItemIds(layerId, { start: 0, end: 10 });
    expect(items[items.length - 1]).toBe('a');
    expect(draw.features.get('a')?.groupId).toBeUndefined();
  });
});

describe('the place of a group', () => {
  it('creates a group under a key of a layer, or moves one there with its features', () => {
    const layerId = draw.layers.list()[0].id;
    const other = draw.layers.create({ name: 'other' })?.id as string;
    draw.features.createMany([point('a'), point('b', 1)]);
    const values: Group = {
      id: 'g',
      layerId,
      name: 'the group',
      featureIds: [],
      visible: false,
      locked: true,
    };
    expect(layer.placeGroup(values, layerId, 'a5')).toBe(true);
    expect(store.getGroup('g')).toEqual(
      expect.objectContaining({ layerId, orderKey: 'a5', name: 'the group', locked: true }),
    );
    expect(draw.groups.get('g')).toEqual(
      expect.objectContaining({ name: 'the group', visible: false, locked: true, layerId }),
    );
    draw.groups.update('g', { locked: false });
    draw.features.move('b', { groupId: 'g' });
    expect(layer.placeGroup(values, other, 'a7')).toBe(true);
    expect(store.getGroup('g')).toEqual(
      expect.objectContaining({ layerId: other, orderKey: 'a7' }),
    );
    expect(draw.features.get('b')?.layerId).toBe(other);
  });

  it('is noted with the change that deletes it', () => {
    const layerId = draw.layers.list()[0].id;
    draw.features.createMany([point('a'), point('b', 1)]);
    draw.groups.create({ id: 'g', featureIds: ['a', 'b'] });
    const key = store.getGroup('g')?.orderKey;
    const seen = summaries();
    draw.groups.delete('g');
    const deleted = seen.find((summary) => summary.groupsDeleted.size > 0);
    expect(deleted?.groupsDeleted.get('g')).toEqual({ layerId, key });
  });
});

describe('the mark of the changes of whole geometries', () => {
  it('is on the changes of a move, and not on those of an update', async () => {
    draw.features.createMany([point('a'), point('b', 1)]);
    const seen = summaries();
    draw.features.update('a', { geometry: { type: 'Point', coordinates: [5, 5] } });
    await draw.features.translate(['a', 'b'], { from: [0, 0], to: [1, 0] });
    const update = seen[0];
    const moves = seen.slice(1).filter((summary) => summary.ids().updated.count() > 0);
    expect(update.wholeGeometry).toBe(false);
    expect(moves.length).toBeGreaterThan(0);
    expect(moves.every((summary) => summary.wholeGeometry)).toBe(true);
  });

  it('is on a transaction where a move is applied first and another feature is updated', async () => {
    draw.features.createMany([point('a'), point('b', 1), point('c', 2)]);
    const seen = summaries();
    let move: Promise<unknown> = Promise.resolve();
    draw.transact(() => {
      move = draw.features.translate(['a', 'c'], { from: [0, 0], to: [1, 0] });
      // The move is applied first to a, in the transaction, before a is written
      draw.features.update('a', { properties: { n: 1 } });
      draw.features.update('b', { geometry: { type: 'Point', coordinates: [5, 5] } });
    });
    const transaction = seen[0];
    expect(transaction.wholeGeometry).toBe(true);
    expect(transaction.ids().updated.has('b')).toBe(true);
    await move;
  });
});
