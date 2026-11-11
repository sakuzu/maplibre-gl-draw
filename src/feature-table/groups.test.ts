// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The groups of features written (`writer.applyGroups`)
 *
 * - A new group, and rows that join it
 * - A new key of a group puts its members, which follow each other at the place of the group, in
 *   their new order: the row groups are cut at the runs of the members and at their new place,
 *   no row is written, and the order before is read until the version is swapped in
 * - A version of a row group being made is dropped by a reorder of its rows, and a version made
 *   with the keys before a reorder is dropped when it comes to be swapped
 * - A reorder still waiting is made again with its keys and the new ones
 * - A group hidden hides its members, the ones of the delta too
 * - A group deleted is taken out once no row names it
 * - Writes, reorders and versions at random: every read gives the reference
 */

import type { GroupVersion, TableWorkBudget } from '@sakuzu/kasane/engine';
import { describe, expect, it } from 'vitest';
import type { TableGroupField, TableGroupPatch } from '../api/tables.js';
import {
  expectTablesMatch,
  referenceKey as key,
  type ReferenceRow,
  ReferenceRows,
  randomReference,
  randomRowWrites,
  rowPatch,
  seededRandom,
  tablesOfReference,
} from '../test-utils.js';
import { STATE_HIDDEN_GROUP } from './feature-row-states.js';
import type { FeatureTablesInternals } from './feature-tables.js';

/** A patch of groups */
function groupPatch(
  handles: number[],
  fields: Partial<Record<TableGroupField, unknown[]>>,
  deleted?: number[],
): TableGroupPatch {
  return {
    handles: Int32Array.from(handles),
    fields: new Map(Object.entries(fields) as Array<[TableGroupField, unknown[]]>),
    deleted: deleted ? Uint8Array.from(deleted) : undefined,
  };
}

const ONE_STEP: TableWorkBudget = { canStep: () => true, step: (work) => work(Infinity) };

/** Points, every tenth one a member of the group `g` */
function withMembers(count: number): ReferenceRows {
  const reference = new ReferenceRows();
  reference.groups.set('g', { order: key(30_500), layerId: 'a', visible: true });
  for (let i = 0; i < count; i++) {
    const member = i % 10 === 3;
    reference.rows.set(`p${i}`, {
      id: `p${i}`,
      layerId: 'a',
      type: 'Point',
      geometry: { type: 'Point', coordinates: [i, 0] },
      order: key(i * 1000),
      groupId: member ? 'g' : undefined,
      member: member ? key(i) : '',
      style: {},
      properties: {},
      visible: true,
      locked: false,
      deleted: false,
    });
  }
  return reference;
}

/** A side that draws the rows, whose GPU side is up when the test says */
function gate(internals: FeatureTablesInternals) {
  let open = false;
  internals.attachReceiver({ uploaded: () => open, swapped: () => {}, dropped: () => {} });
  return {
    open(on = true): void {
      open = on;
    },
  };
}

describe('the groups of features written', () => {
  it('make a new group, and rows join it', () => {
    const reference = withMembers(20);
    const setup = tablesOfReference(reference, ['a'], 8);
    const { tables, writer, internals, groupHandleOf } = setup;
    writer.applyGroups(groupPatch([7], { id: ['h'], key: [key(5500)], parent: ['a'] }));
    reference.groups.set('h', { order: key(5500), layerId: 'a', visible: true });
    const handles = ['p1', 'p2'].map((id) => tables.findRow(id) as number);
    writer.apply(rowPatch(handles, { parent: ['h', 'h'], key: [key(1), key(2)] }));
    for (const id of ['p1', 'p2']) {
      Object.assign(reference.rows.get(id) as ReferenceRow, {
        groupId: 'h',
        member: key(Number(id.slice(1))),
      });
    }
    const handleOf = (id: string) => (id === 'h' ? 7 : groupHandleOf(id));
    expectTablesMatch(tables, reference, ['a'], handleOf);
    internals.flushVersions();
    expectTablesMatch(tables, reference, ['a'], handleOf);
    expect(() => writer.applyGroups(groupPatch([8], { id: ['x'] }))).toThrow(/needs its key/);
  });

  it('put the members in their new order, read in the order before until swapped in', () => {
    const reference = withMembers(60);
    const setup = tablesOfReference(reference, ['a'], 8);
    const { tables, writer, internals, groupHandleOf } = setup;
    const sides = gate(internals);
    const before = Array.from(tables.get('a')?.listRowHandles(0, 100) ?? []);
    const keysBefore = internals
      .rowTable('a')
      ?.rowOrder()
      .groups.map((group) => group.data.keys);
    writer.applyGroups(groupPatch([groupHandleOf('g')], { key: [key(55_500)] }));
    // Until swapped in, the order before
    expect(Array.from(tables.get('a')?.listRowHandles(0, 100) ?? [])).toEqual(before);
    expect(internals.builtVersions('a').some((v) => v.orders !== null)).toBe(true);
    sides.open();
    internals.swapVersions();
    (reference.groups.get('g') as { order: string }).order = key(55_500);
    expectTablesMatch(tables, reference, ['a'], groupHandleOf);
    // No row was written, nor put in the delta
    expect(internals.deltaRowCount()).toBe(0);
    expect(keysBefore?.length).toBeGreaterThan(0);
  });

  it('drop a version being made of a row group they cut, and remake a reorder waiting', () => {
    const reference = withMembers(60);
    const setup = tablesOfReference(reference, ['a'], 8);
    const { tables, writer, internals, groupHandleOf } = setup;
    const sides = gate(internals);
    // A version of the group of p3 being made
    writer.apply(rowPatch([tables.findRow('p4') as number], { key: [key(4500)] }));
    (reference.rows.get('p4') as ReferenceRow).order = key(4500);
    internals.flushVersions();
    const made = internals.builtVersions('a');
    expect(made.length).toBeGreaterThan(0);
    // Two reorders, the second one before the first is swapped in
    writer.applyGroups(groupPatch([groupHandleOf('g')], { key: [key(55_500)] }));
    writer.applyGroups(groupPatch([groupHandleOf('g')], { key: [key(10_500)] }));
    expect(made.every((v: GroupVersion) => v.status === 'dropped')).toBe(true);
    expect(internals.builtVersions('a').filter((v) => v.orders !== null)).toHaveLength(1);
    sides.open();
    internals.flushVersions();
    (reference.groups.get('g') as { order: string }).order = key(10_500);
    expectTablesMatch(tables, reference, ['a'], groupHandleOf);
    expect(internals.deltaRowCount()).toBe(0);
  });

  it('hide the members of a group hidden, the ones of the delta too', () => {
    const reference = withMembers(30);
    const setup = tablesOfReference(reference, ['a'], 8);
    const { tables, writer, internals, groupHandleOf } = setup;
    const p13 = tables.findRow('p13') as number;
    writer.apply(rowPatch([p13], { key: [key(99)] }));
    expect(internals.placeOf(p13)?.group.delta).toBe(true);
    writer.applyGroups(groupPatch([groupHandleOf('g')], { hidden: [true] }));
    const drawn = Array.from(tables.get('a')?.listDrawnRows([-1, -1, 100, 1]) ?? []);
    expect(
      drawn
        .map((h) => tables.getRowId(h))
        .filter((id) => ['p3', 'p13', 'p23'].includes(id as string)),
    ).toEqual([]);
    const place = internals.placeOf(p13);
    expect(place && (place.group.state[place.row] & STATE_HIDDEN_GROUP) !== 0).toBe(true);
    writer.applyGroups(groupPatch([groupHandleOf('g')], { hidden: [false] }));
    expect(Array.from(tables.get('a')?.listDrawnRows([-1, -1, 100, 1]) ?? [])).toHaveLength(30);
  });

  it('take a group out once no row names it', () => {
    const reference = withMembers(20);
    const setup = tablesOfReference(reference, ['a'], 8);
    const { tables, writer, internals, groupHandleOf } = setup;
    const g = groupHandleOf('g');
    writer.applyGroups(groupPatch([g], {}, [1]));
    expect(internals.groups.has(g)).toBe(true);
    const members = ['p3', 'p13'].map((id) => tables.findRow(id) as number);
    writer.apply(rowPatch(members, { parent: ['a', 'a'] }));
    internals.flushVersions();
    writer.applyGroups(groupPatch([g], {}, [1]));
    expect(internals.groups.has(g)).toBe(false);
  });

  it('read every row as the reference while writes, reorders and versions go on at random', () => {
    for (const seed of [51, 52, 53]) {
      const random = seededRandom(seed);
      const layerIds = ['a', 'b'];
      const reference = randomReference(random, 100, layerIds);
      const setup = tablesOfReference(reference, layerIds, 8);
      const { tables, writer, internals, groupHandleOf } = setup;
      let open = false;
      internals.attachReceiver({ uploaded: () => open, swapped: () => {}, dropped: () => {} });
      const writes = randomRowWrites(random, { ...setup, reference, layerIds });
      const pending = new Map<string, string>();
      let applied = 0;
      for (let step = 0; step < 200; step++) {
        const pick = random();
        if (pick < 0.55) writes.step(step);
        else if (pick < 0.65) {
          const id = random() < 0.5 ? 'ga' : 'gb';
          const order = key(random() * 1e6);
          writer.applyGroups(groupPatch([groupHandleOf(id)], { key: [order] }));
          pending.set(id, order);
        } else if (pick < 0.8) internals.advanceVersions(ONE_STEP);
        else {
          open = random() < 0.7;
          internals.swapVersions();
          open = false;
        }
        // The keys of the groups are read once their reorder is swapped in
        for (const [id, order] of pending) {
          if (internals.groups.orderOf(groupHandleOf(id)) === order) {
            (reference.groups.get(id) as { order: string }).order = order;
            pending.delete(id);
            applied++;
          }
        }
        if (step % 10 === 9) expectTablesMatch(tables, reference, layerIds, groupHandleOf);
      }
      expect(applied).toBeGreaterThan(2);
      open = true;
      internals.flushVersions();
      for (const [id, order] of pending) {
        (reference.groups.get(id) as { order: string }).order = order;
      }
      expect(internals.deltaRowCount()).toBe(0);
      expectTablesMatch(tables, reference, layerIds, groupHandleOf);
    }
  });
});
