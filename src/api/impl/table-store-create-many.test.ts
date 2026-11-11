// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Many features created at once over an in-memory Store of rows (`features.createMany`): the rows
 * of a layer are written in one write of the tables, not one write per feature (each write of a
 * new row reads every row the layer changed before it, so a write per feature costs the square
 * of their number), and they are what creating them one at a time makes: the same values, items
 * and members in the same order, the deleted rows kept created again where they were; the keys
 * of their order are made at once, and stay short
 */

import { utf8String } from '@sakuzu/tabane';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FeatureTablesWriter, RowField } from '../../api/tables.js';
import { featureTablesInternals } from '../../feature-table/feature-tables.js';
import type { Store } from '../../store/store.js';
import { createTableStore } from '../../store/table-memory.js';
import type { Feature } from '../../store/types.js';
import { createMapStub } from '../../test-utils.js';
import type { Draw } from '../draw.js';
import type { FeatureInput } from '../model.js';
import { createDrawOnEngine } from './create-draw.js';
import { createEngine } from './engine.js';

interface Instance {
  readonly draw: Draw;
  readonly store: Store;
  readonly writer: FeatureTablesWriter;
}

const instances: Draw[] = [];

/** An instance over a new Store of rows with two layers, two features in each and a group */
function instance(): Instance {
  const { store, writer } = createTableStore();
  const engine = createEngine(
    createMapStub().map,
    { store, initDefaultLayer: false },
    { deferDefaultMode: true },
  );
  const draw = createDrawOnEngine(engine, { store, initDefaultLayer: false });
  instances.push(draw);
  draw.layers.create({ id: 'a', name: 'a' });
  draw.layers.create({ id: 'b', name: 'b' });
  draw.features.createMany([point('a0', 'a', 0), point('a1', 'a', 1), point('b0', 'b', 2)]);
  draw.groups.create({ id: 'g', featureIds: ['a1'] });
  draw.features.create(point('a2', 'a', 3));
  return { draw, store, writer };
}

afterEach(() => {
  for (const draw of instances.splice(0)) draw.destroy();
});

function point(id: string, layerId: string, x: number, groupId?: string): FeatureInput {
  return {
    id,
    type: 'Point',
    layerId,
    ...(groupId !== undefined && { groupId }),
    geometry: { type: 'Point', coordinates: [x * 0.001, 0] },
    properties: { n: x, ...(x % 2 === 1 && { odd: true }) },
    ...(x % 3 === 0 && { style: { fillColor: '#ff0000' } }),
  };
}

/** Inputs of features spread over the two layers and the group, in an order that mixes them */
function inputs(n: number): FeatureInput[] {
  return Array.from({ length: n }, (_, i) =>
    point(`f${i}`, i % 3 === 0 ? 'b' : 'a', i + 10, i % 3 === 1 ? 'g' : undefined),
  );
}

/** The ids of the items of a layer, in their order (a group as its id) */
function items(store: Store, layerId: string): string[] {
  const tables = store.tables;
  const view = tables?.get(layerId);
  if (!tables || !view) return [];
  const refs = view.listItems(0, view.itemCount);
  const groups = featureTablesInternals(tables)?.groups;
  return Array.from(refs.handles, (h, i) =>
    refs.kinds[i] === 0 ? (tables.getRowId(h) as string) : (groups?.idOf(h) as string),
  );
}

/** The ids of the members of a group, in their order */
function members(store: Store, groupId: string): string[] {
  const tables = store.tables;
  const handle = featureTablesInternals(tables)?.groups.handleOfId(groupId) ?? -1;
  const view = tables?.get('a');
  if (!tables || !view || handle < 0) return [];
  return Array.from(view.listGroupMembers(handle, 0, view.countGroupMembers(handle)), (h) =>
    tables.getRowId(h),
  ) as string[];
}

/** The place of rows (their layer and group), as the tables hold them */
function places(store: Store, ids: readonly string[]): unknown[] {
  const internals = featureTablesInternals(store.tables);
  return ids.map((id) => {
    const handle = store.tables?.findRow(id);
    const at = handle === undefined ? null : internals?.placeOf(handle);
    if (!at) return null;
    const data = at.group.data;
    return { layerId: at.layer.layerId, group: data.groups[at.row] };
  });
}

/** The keys of the order of the rows of a layer (the key within its group for a member) */
function keysOf(store: Store, layerId: string): string[] {
  const tables = store.tables;
  const internals = featureTablesInternals(tables);
  const view = tables?.get(layerId);
  if (!tables || !view || !internals) return [];
  return Array.from(view.listRowHandles(0, view.rowCount), (handle) => {
    const at = internals.placeOf(handle);
    if (!at) return '';
    const data = at.group.data;
    return utf8String(data.keys, at.row);
  });
}

describe('many features created at once over a Store of rows', () => {
  it('writes the new rows of each layer in one write of the tables', () => {
    const { draw, writer } = instance();
    const apply = vi.spyOn(writer, 'apply');
    const created = draw.features.createMany(inputs(2000));
    expect(created).toHaveLength(2000);
    // One write per layer, whatever the number of features
    expect(apply).toHaveBeenCalledTimes(2);
    const rows = apply.mock.calls.reduce((sum, [patch]) => sum + patch.handles.length, 0);
    expect(rows).toBe(2000);
  });

  it('makes what creating the features one at a time makes', () => {
    const many = instance();
    const one = instance();
    for (const { draw } of [many, one]) {
      // Deleted here and kept: created again where it was
      draw.features.delete('a0');
    }
    const list = [...inputs(40), point('a0', 'a', 99)];
    many.draw.features.createMany(list);
    for (const input of list) one.draw.features.create(input);
    for (const layerId of ['a', 'b']) {
      expect(items(many.store, layerId)).toEqual(items(one.store, layerId));
    }
    expect(items(many.store, 'a')[0]).toBe('a0');
    expect(members(many.store, 'g')).toEqual(members(one.store, 'g'));
    const ids = list.map((input) => input.id as string);
    expect(places(many.store, ids)).toEqual(places(one.store, ids));
    expect(ids.map((id) => many.store.getFeature(id))).toEqual(
      ids.map((id) => one.store.getFeature(id)),
    );
  });

  it('makes the keys of the order of many features at once, short', () => {
    const { draw, store } = instance();
    const n = 20000;
    draw.features.createMany(Array.from({ length: n }, (_, i) => point(`k${i}`, 'b', i)));
    const keys = keysOf(store, 'b');
    expect(keys).toHaveLength(n + 1);
    // Made one after the other, the last of them would be 646 characters long
    expect(Math.max(...keys.map((key) => key.length))).toBeLessThanOrEqual(8);
    const sorted = [...keys].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    expect(keys).toEqual(sorted);
    expect(items(store, 'b').slice(1)).toEqual(Array.from({ length: n }, (_, i) => `k${i}`));
  });

  it('notifies the rows created once, in the order given in each layer', () => {
    const { draw, store } = instance();
    const changes: unknown[] = [];
    draw.on('change', (change) => changes.push(change));
    const list = inputs(30);
    draw.features.createMany(list);
    expect(changes).toHaveLength(1);
    const layers = (changes[0] as { rows: { layers: Map<string, { created: Int32Array }> } }).rows
      .layers;
    for (const layerId of ['a', 'b']) {
      const created = Array.from(layers.get(layerId)?.created ?? [], (handle) =>
        store.tables?.getRowId(handle),
      );
      expect(created).toEqual(
        list.filter((input) => input.layerId === layerId).map((input) => input.id),
      );
    }
  });

  it('creates none of the features when one cannot be created', () => {
    const { store } = instance();
    const feature = (id: string, layerId: string): Feature => ({
      id,
      type: 'Point',
      layerId,
      groupId: undefined,
      geometry: { type: 'Point', coordinates: [0, 0] },
      properties: {},
      style: {},
      visible: true,
      locked: false,
    });
    expect(() => store.createFeatures([feature('x', 'a'), feature('y', 'missing')])).toThrow();
    expect(() => store.createFeatures([feature('x', 'a'), feature('x', 'b')])).toThrow();
    expect(store.getFeature('x')).toBeUndefined();
    expect(store.tables?.findRow('x')).toBeUndefined();
  });

  it('writes no field a feature does not give for it', () => {
    const { draw, writer } = instance();
    const apply = vi.spyOn(writer, 'apply');
    draw.features.createMany([point('p', 'a', 1), point('q', 'a', 2)]);
    const [patch] = apply.mock.calls[0];
    const odd = patch.fields.get('properties:odd' as RowField);
    expect(odd).toEqual([true, undefined]);
  });
});
