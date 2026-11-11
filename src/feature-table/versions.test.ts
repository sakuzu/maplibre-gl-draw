// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The next versions of the row groups
 *
 * - The next versions take the rows of the deltas, and every read stays the same
 * - A version waits for every side that draws the rows; the writes made meanwhile are kept: the
 *   rows of the delta written after it started stay in the delta, and the values written in place
 *   of its groups are written again into it
 * - A row moved from one group to another is read once whichever of the two goes first, and the
 *   other one hands it over when it goes
 * - A version grown past twice the targets is cut into groups of the target sizes at once; a
 *   small group is merged with its neighbor
 * - A version merged in the Worker of the host whose groups of features changed their keys
 *   meanwhile is dropped, and made again
 * - The rows moved far and the values written in place past the limit make their groups due
 * - Writes of every kind at random, with the versions started, built and swapped at random
 *   between them: every read of the tables gives the reference
 */

import { describe, expect, it } from 'vitest';
import type { FeatureTablesWorker } from '../api/tables.js';
import {
  mergeRowBlockData,
  type RowBlockDataMerge,
  type RowBlockMerge,
} from '../table/row-group-merge.js';
import type { RowBlockData } from '../table/row-group-types.js';
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
import { STATE_HIDDEN_WAIT } from './feature-row-states.js';
import type { FeatureTablesInternals } from './feature-tables.js';
import type { TableWorkBudget } from './types.js';
import type { GroupVersion, GroupVersionReceiver } from './versions.js';

/** A budget of `steps` steps */
function steps(n: number): TableWorkBudget {
  let left = n;
  return {
    canStep: () => left > 0,
    step: (work) => {
      left--;
      return work(Number.POSITIVE_INFINITY);
    },
  };
}

/** A side that draws the rows, whose GPU side is up when the test says */
function gate(internals: FeatureTablesInternals) {
  const allowed = new Set<GroupVersion>();
  let all = false;
  const swapped: GroupVersion[] = [];
  const receiver: GroupVersionReceiver = {
    uploaded: (version) => all || allowed.has(version),
    swapped: (version) => swapped.push(version),
    dropped: () => {},
  };
  internals.attachReceiver(receiver);
  return {
    swapped,
    allow(version: GroupVersion): void {
      allowed.add(version);
    },
    allowAll(on = true): void {
      all = on;
    },
  };
}

/** Points in a row, one per key */
function pointsReference(count: number, layerId = 'a'): ReferenceRows {
  const reference = new ReferenceRows();
  for (let i = 0; i < count; i++) {
    reference.rows.set(`p${i}`, {
      id: `p${i}`,
      layerId,
      type: 'Point',
      geometry: { type: 'Point', coordinates: [i, 0] },
      order: key(i * 1000),
      groupId: undefined,
      member: '',
      style: {},
      properties: {},
      visible: true,
      locked: false,
      deleted: false,
    });
  }
  return reference;
}

describe('the next versions of the row groups', () => {
  it('take the rows of the deltas, every read staying the same', () => {
    for (const seed of [1, 2, 3]) {
      const random = seededRandom(seed);
      const layerIds = ['a', 'b'];
      const reference = randomReference(random, 120, layerIds);
      const setup = tablesOfReference(reference, layerIds, 8);
      const { tables, internals, groupHandleOf } = setup;
      const writes = randomRowWrites(random, { ...setup, reference, layerIds });
      for (let step = 0; step < 100; step++) writes.step(step);
      expect(internals.deltaRowCount()).toBeGreaterThan(0);
      expectTablesMatch(tables, reference, layerIds, groupHandleOf);
      internals.flushVersions();
      expect(internals.deltaRowCount()).toBe(0);
      expect(internals.hasPendingWork).toBe(false);
      expectTablesMatch(tables, reference, layerIds, groupHandleOf);
      // No row is read from a copy waiting for another group
      for (const layerId of layerIds) {
        const table = internals.layerTable(layerId);
        for (let g = 0; g < (table?.groupCount ?? 0); g++) {
          const group = table?.groupAt(g);
          expect(group?.state.every((state) => (state & STATE_HIDDEN_WAIT) === 0)).toBe(true);
        }
      }
    }
  });

  it('keep the writes made while they wait for the GPU side', () => {
    const reference = pointsReference(32);
    const { tables, writer, internals, groupHandleOf } = tablesOfReference(reference, ['a'], 8);
    const sides = gate(internals);
    const at = (id: string) => tables.findRow(id) as number;
    // p3 to the range of the second group
    writer.apply(rowPatch([at('p3')], { key: [key(9500)] }));
    (reference.rows.get('p3') as ReferenceRow).order = key(9500);
    for (let i = 0; i < 4; i++) internals.advanceVersions(steps(10));
    const [version] = internals.builtVersions('a');
    expect(version).toBeDefined();
    // Written while it waits: a value in place of a row of its group, the row of the delta it
    // took written again, and a new row of the delta in its range
    writer.apply(rowPatch([at('p9')], { 'properties:name': ['kept'] }));
    (reference.rows.get('p9') as ReferenceRow).properties = { name: 'kept' };
    writer.apply(rowPatch([at('p3')], { key: [key(9600)] }));
    (reference.rows.get('p3') as ReferenceRow).order = key(9600);
    writer.apply(rowPatch([at('p12')], { key: [key(10_500)] }));
    (reference.rows.get('p12') as ReferenceRow).order = key(10_500);
    expectTablesMatch(tables, reference, ['a'], groupHandleOf);
    for (const v of internals.builtVersions('a')) sides.allow(v);
    internals.swapVersions();
    expect(sides.swapped.length).toBeGreaterThan(0);
    // The rows of the delta written after it started stay there
    expect(internals.deltaRowCount()).toBe(2);
    expectTablesMatch(tables, reference, ['a'], groupHandleOf);
    expect(tables.get('a')?.getRowValue(at('p9'), 'name')).toBe('kept');
    // The next versions take them
    sides.allowAll();
    internals.flushVersions();
    expect(internals.deltaRowCount()).toBe(0);
    expectTablesMatch(tables, reference, ['a'], groupHandleOf);
  });

  it('read a row moved from one group to another once, whichever group goes first', () => {
    for (const first of ['from', 'to', 'both'] as const) {
      // Groups of more than a quarter of the target: not merged with their neighbors
      const reference = pointsReference(3300);
      const { tables, writer, internals, groupHandleOf } = tablesOfReference(
        reference,
        ['a'],
        1100,
      );
      const sides = gate(internals);
      const at = (id: string) => tables.findRow(id) as number;
      // p2 (group 0) to the range of group 1, p1200 (group 1) to the range of group 0
      writer.apply(rowPatch([at('p2'), at('p1200')], { key: [key(1_500_500), key(4500)] }));
      (reference.rows.get('p2') as ReferenceRow).order = key(1_500_500);
      (reference.rows.get('p1200') as ReferenceRow).order = key(4500);
      // The groups are not small: the versions are of one group each
      for (let i = 0; i < 4; i++) internals.advanceVersions(steps(10));
      const versions = internals.builtVersions('a');
      const table = internals.layerTable('a');
      const of = (g: number) =>
        versions.find((v) => v.replaces.some((group) => group === table?.groupAt(g)));
      const fromVersion = of(0) as GroupVersion;
      const toVersion = of(1) as GroupVersion;
      expect(fromVersion).toBeDefined();
      expect(toVersion).toBeDefined();
      if (first === 'both') {
        sides.allow(fromVersion);
        sides.allow(toVersion);
        internals.swapVersions();
      } else {
        sides.allow(first === 'from' ? fromVersion : toVersion);
        internals.swapVersions();
        expectTablesMatch(tables, reference, ['a'], groupHandleOf);
        // Both rows are still read from the delta: one waits for the group not swapped, the
        // other one comes into it
        expect(internals.deltaRowCount()).toBe(2);
        sides.allow(first === 'from' ? toVersion : fromVersion);
        internals.swapVersions();
      }
      expectTablesMatch(tables, reference, ['a'], groupHandleOf);
      expect(internals.deltaRowCount()).toBe(0);
      expect(internals.placeOf(at('p2'))?.group.delta).toBe(false);
      expect(internals.placeOf(at('p1200'))?.group.delta).toBe(false);
    }
  });

  it('cut a version grown past twice the targets at once, and merge a small group', () => {
    const reference = pointsReference(10);
    const { tables, writer, internals, groupHandleOf } = tablesOfReference(reference, ['a'], 4);
    const table = internals.layerTable('a');
    expect(table?.groupCount).toBe(3);
    // 9,000 new rows within the range of the middle group (between p5 and p6): into the delta,
    // and the next version of the group cut into groups of the target rows
    const ids = Array.from({ length: 9000 }, (_, i) => `n${i}`);
    const handles = writer.allocateHandles(utfColumn(ids));
    writer.apply(
      rowPatch(Array.from(handles), {
        type: ids.map(() => 'Point'),
        parent: ids.map(() => 'a'),
        geometry: ids.map((_, i) => ({ type: 'Point', coordinates: [i, 1] })),
        key: ids.map((_, i) => `${key(5000)}${String(i).padStart(5, '0')}`),
      }),
    );
    expect(internals.deltaRowCount()).toBe(9000);
    ids.forEach((id, i) => {
      reference.rows.set(id, {
        id,
        layerId: 'a',
        type: 'Point',
        geometry: { type: 'Point', coordinates: [i, 1] },
        order: `${key(5000)}${String(i).padStart(5, '0')}`,
        groupId: undefined,
        member: '',
        style: {},
        properties: {},
        visible: true,
        locked: false,
        deleted: false,
      });
    });
    internals.flushVersions();
    expect(internals.deltaRowCount()).toBe(0);
    const sizes = Array.from(
      { length: table?.groupCount ?? 0 },
      (_, g) => table?.groupAt(g).data.length,
    );
    // The small groups merged with their neighbors, the large version cut at 4,096 rows
    expect(sizes.every((n) => (n ?? 0) <= 4096)).toBe(true);
    expect(sizes.filter((n) => n === 4096).length).toBe(2);
    expect(sizes.reduce((a, b) => (a ?? 0) + (b ?? 0), 0)).toBe(9010);
    expectTablesMatch(tables, reference, ['a'], groupHandleOf);
  });

  it('drop a version merged in the Worker whose groups of features changed their keys', async () => {
    const pending: Array<{ merge: RowBlockMerge; resolve: (groups: RowBlockData[]) => void }> = [];
    const worker: FeatureTablesWorker = {
      merge: (merge) =>
        new Promise((resolve) => {
          pending.push({ merge: structuredClone(merge), resolve });
          expect(Array.isArray(merge.groups)).toBe(true);
        }),
      build: () => Promise.resolve([]),
    };
    const reference = pointsReference(9000);
    reference.groups.set('g', { order: key(4_000_500), layerId: 'a', visible: true });
    for (let i = 10; i < 14; i++) {
      Object.assign(reference.rows.get(`p${i}`) as ReferenceRow, { groupId: 'g', member: key(i) });
    }
    const setup = tablesOfReference(reference, ['a'], 20_000, { worker });
    const { tables, writer, internals, groupHandleOf } = setup;
    const at = (id: string) => tables.findRow(id) as number;
    writer.apply(rowPatch([at('p100')], { key: [key(100_500)] }));
    (reference.rows.get('p100') as ReferenceRow).order = key(100_500);
    internals.flushVersions();
    expect(pending).toHaveLength(1);
    // The key of the group changes before the merge comes back
    internals.groups.setOrder(groupHandleOf('g'), key(7_000_500));
    (reference.groups.get('g') as { order: string }).order = key(7_000_500);
    pending[0].resolve(
      mergeRowBlockData({ ...(pending[0].merge as RowBlockDataMerge), groups: internals.groups }),
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(internals.builtVersions('a')).toHaveLength(0);
    expect(internals.versionStats().swapped).toBe(0);
    // Made again, with the keys as they are now
    internals.flushVersions();
    expect(pending).toHaveLength(2);
    pending[1].resolve(
      mergeRowBlockData({ ...(pending[1].merge as RowBlockDataMerge), groups: internals.groups }),
    );
    await Promise.resolve();
    await Promise.resolve();
    internals.swapVersions();
    expect(internals.versionStats().swapped).toBe(1);
    expect(internals.deltaRowCount()).toBe(0);
    expectTablesMatch(tables, reference, ['a'], groupHandleOf);
  });

  it('make a group due when many of its rows moved far, or its values written hold too much', () => {
    const reference = pointsReference(600);
    const { tables, writer, internals, groupHandleOf } = tablesOfReference(reference, ['a'], 600);
    const table = internals.layerTable('a');
    const handles = Array.from({ length: 200 }, (_, i) => tables.findRow(`p${i}`) as number);
    writer.apply(
      rowPatch(handles, {
        geometry: handles.map((_, i) => ({ type: 'Point', coordinates: [i, 50] })),
      }),
    );
    for (let i = 0; i < 200; i++) {
      (reference.rows.get(`p${i}`) as ReferenceRow).geometry = {
        type: 'Point',
        coordinates: [i, 50],
      };
    }
    expect(internals.movedRowCount()).toBe(200);
    internals.flushVersions();
    expect(internals.movedRowCount()).toBe(0);
    expect(table?.groupAt(0).unindexedCount).toBe(0);
    expectTablesMatch(tables, reference, ['a'], groupHandleOf);
    const found = tables.get('a')?.listDrawnRows([10.5, 49, 12.5, 51]);
    expect(Array.from(found ?? []).map((h) => tables.getRowId(h))).toEqual(['p11', 'p12']);
  });

  it('read every row as the reference while writes and versions go on at random', () => {
    for (const seed of [31, 32, 33, 34]) {
      const random = seededRandom(seed);
      const layerIds = ['a', 'b'];
      const reference = randomReference(random, 100, layerIds);
      const setup = tablesOfReference(reference, layerIds, 8);
      const { tables, internals, groupHandleOf } = setup;
      const sides = gate(internals);
      const writes = randomRowWrites(random, { ...setup, reference, layerIds });
      for (let step = 0; step < 200; step++) {
        const pick = random();
        if (pick < 0.6) writes.step(step);
        else if (pick < 0.8) internals.advanceVersions(steps(1 + Math.floor(random() * 3)));
        else {
          for (const version of internals.builtVersions(random() < 0.5 ? 'a' : 'b')) {
            if (random() < 0.6) sides.allow(version);
          }
          internals.swapVersions();
        }
        if (step % 8 === 7) expectTablesMatch(tables, reference, layerIds, groupHandleOf);
      }
      expect(internals.versionStats().swapped).toBeGreaterThan(5);
      sides.allowAll();
      internals.flushVersions();
      expect(internals.deltaRowCount()).toBe(0);
      expectTablesMatch(tables, reference, layerIds, groupHandleOf);
    }
  });
});

function utfColumn(ids: readonly string[]) {
  const encoder = new TextEncoder();
  const parts = ids.map((id) => encoder.encode(id));
  const offsets = new Int32Array(ids.length + 1);
  for (let i = 0; i < parts.length; i++) offsets[i + 1] = offsets[i] + parts[i].length;
  const bytes = new Uint8Array(offsets[ids.length]);
  parts.forEach((part, i) => {
    bytes.set(part, offsets[i]);
  });
  return { offsets, bytes };
}
