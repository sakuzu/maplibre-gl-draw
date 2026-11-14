// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Many groups created and deleted at once over an in-memory Store of rows (`groups.createMany`,
 * `groups.deleteMany`): the features that join or leave them are written in one write of the
 * tables, not one write per group, and the walks of the order read a few rows per group; the
 * items and the members are in the order creating and deleting the groups one at a time puts
 * them in
 */

import { RowSkips, RowTable } from '@sakuzu/kasane/render';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FeatureTablesWriter } from '../../api/tables.js';
import { featureTablesInternals } from '../../feature-table/feature-tables.js';
import type { Store } from '../../store/store.js';
import { createTableStore } from '../../store/table-memory.js';
import { writesOf } from '../../test-support/writes.js';
import { createMapStub } from '../../test-utils.js';
import type { Draw } from '../draw.js';
import type { GroupInput } from '../model.js';
import { createDrawOnEngine } from './create-draw.js';
import { createEngine } from './engine.js';

const instances: Draw[] = [];

/** An instance over a new Store of rows with a layer of `n` points */
function instance(n: number): { draw: Draw; store: Store; writer: FeatureTablesWriter } {
  const { store, writer } = createTableStore();
  const engine = createEngine(
    createMapStub().map,
    { store, initDefaultLayer: false },
    { deferDefaultMode: true },
  );
  const draw = createDrawOnEngine(engine, { store, initDefaultLayer: false });
  instances.push(draw);
  writesOf(draw).layers.create({ id: 'a', name: 'a' });
  writesOf(draw).features.createMany(
    Array.from({ length: n }, (_, i) => ({
      id: `f${i}`,
      type: 'Point' as const,
      layerId: 'a',
      geometry: { type: 'Point' as const, coordinates: [i * 0.0001, 0] },
    })),
  );
  return { draw, store, writer };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const draw of instances.splice(0)) draw.destroy();
});

/** The ids of the items of a layer, in their order (a group as its id) */
function items(store: Store, layerId = 'a'): string[] {
  const tables = store.tables;
  const view = tables?.get(layerId);
  if (!tables || !view) return [];
  const refs = view.listItems(0, view.itemCount);
  const groups = featureTablesInternals(tables)?.groups;
  return Array.from(refs.refs, (h, i) =>
    refs.types[i] === 0 ? (tables.getRowId(h) as string) : (groups?.idOf(h) as string),
  );
}

/** The ids of the members of each group of a layer, in their order */
function members(store: Store, layerId = 'a'): Record<string, string[]> {
  const tables = store.tables;
  const view = tables?.get(layerId);
  const groups = featureTablesInternals(tables)?.groups;
  const out: Record<string, string[]> = {};
  if (!tables || !view || !groups) return out;
  for (const group of store.listGroups()) {
    const handle = groups.handleOfId(group.id);
    out[group.id] = Array.from(
      view.listGroupMembers(handle, 0, view.countGroupMembers(handle)),
      (h) => tables.getRowId(h) as string,
    );
  }
  return out;
}

/**
 * Groups of a few features each, in a mixed order: some next to each other, members given out
 * of their order, a group whose features are all in another group (it goes to the front)
 */
function inputs(): GroupInput[] {
  return [
    { id: 'g0', members: ['f3', 'f1', 'f2'] },
    { id: 'g1', members: ['f4', 'f5'] },
    { id: 'g2', members: ['f9', 'f12'] },
    { id: 'g3', members: ['f7'] },
    { id: 'g4', members: ['f15', 'f0'] },
  ];
}

describe('many groups at once over a Store of rows', () => {
  it('puts the groups and their members where creating them one at a time puts them', () => {
    const many = instance(16);
    const one = instance(16);
    // A group whose features then join other groups (it is emptied and deleted)
    for (const { draw } of [many, one])
      writesOf(draw).groups.create({ id: 'old', members: ['f10', 'f11'] });
    const list = [...inputs(), { id: 'g5', members: ['f10', 'f11'] }];
    writesOf(many.draw).groups.createMany(list);
    for (const input of list) writesOf(one.draw).groups.create(input);
    expect(items(many.store)).toEqual(items(one.store));
    expect(members(many.store)).toEqual(members(one.store));
    expect(many.store.getGroup('old')).toBeUndefined();
  });

  it('puts the members where deleting the groups one at a time puts them', () => {
    const many = instance(16);
    const one = instance(16);
    for (const { draw } of [many, one]) writesOf(draw).groups.createMany(inputs());
    const ids = ['g3', 'g0', 'g1', 'g4'];
    writesOf(many.draw).groups.deleteMany(ids);
    for (const id of ids) writesOf(one.draw).groups.delete(id);
    expect(items(many.store)).toEqual(items(one.store));
    expect(members(many.store)).toEqual(members(one.store));
  });

  it('writes the members of many groups in one write, and reads a few rows per group', () => {
    const n = 2000;
    const { draw, writer } = instance(n);
    const apply = vi.spyOn(writer, 'writeRows');
    const ids = Array.from({ length: n / 2 }, (_, i) => `g${i}`);
    writesOf(draw).groups.createMany(
      ids.map((id, i) => ({ id, members: [`f${2 * i}`, `f${2 * i + 1}`] })),
    );
    expect(apply).toHaveBeenCalledTimes(1);
    apply.mockClear();
    const previous = vi.spyOn(RowTable.prototype, 'previousRow');
    const next = vi.spyOn(RowTable.prototype, 'nextRow');
    const down = vi.spyOn(RowSkips.prototype, 'lastAtOrBefore');
    const up = vi.spyOn(RowSkips.prototype, 'firstAtOrAfter');
    expect(writesOf(draw).groups.deleteMany(ids)).toBe(true);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(draw.groups.count()).toBe(0);
    // A row at a time would be about n * n / 2 rows: the members moved, read elsewhere, passed
    expect(previous.mock.calls.length + next.mock.calls.length).toBeLessThanOrEqual(8 * n);
    const skips = new Set([...down.mock.contexts, ...up.mock.contexts] as RowSkips[]);
    const steps = [...skips].reduce((sum, skip) => sum + skip.steps, 0);
    expect(steps).toBeLessThanOrEqual(16 * n);
  });
});
