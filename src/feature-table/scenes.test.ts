// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Scenes of the deltas and the versions at their edges
 *
 * - Every group of a layer due at once: the versions held at once stay within their bytes, and
 *   every group gets its next version over the frames
 * - A group whose rows all left is taken out
 * - A layer of rows of its delta only gets its first group
 * - A row deleted keeps its key through the versions (it is not dropped yet)
 */

import type { TableWorkBudget } from '@sakuzu/kasane/render';
import { byteColumnFromStrings } from '@sakuzu/tabane';
import { describe, expect, it } from 'vitest';
import {
  expectTablesMatch,
  referenceKey as key,
  type ReferenceRow,
  ReferenceRows,
  rowPatch,
  tablesOfReference,
} from '../test-utils.js';

const ONE_STEP: TableWorkBudget = { canStep: () => true, step: (work) => work(Infinity) };

/** Points in a row, one per key every 1,000 */
function pointsReference(count: number): ReferenceRows {
  const reference = new ReferenceRows();
  for (let i = 0; i < count; i++) {
    reference.rows.set(`p${i}`, {
      id: `p${i}`,
      layerId: 'a',
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

describe('the deltas and the versions at their edges', () => {
  it('hold the versions of a whole layer due at once within their bytes', () => {
    // 20 groups of 550 rows (a version merges two), every one due
    const reference = pointsReference(22_000 / 2);
    const setup = tablesOfReference(reference, ['a'], 550);
    const { tables, writer, internals, groupHandleOf } = setup;
    const table = internals.rowTable('a');
    expect(table?.groupCount).toBe(20);
    let open = false;
    internals.attachReceiver({ uploaded: () => open, swapped: () => {}, dropped: () => {} });
    // A row of every group to the next one
    for (let g = 0; g < 20; g++) {
      const id = `p${g * 550 + 5}`;
      const order = `${key((g * 550 + 549) * 1000)}x`;
      writer.writeRows(rowPatch([tables.getRowRef(id) as number], { key: [order] }));
      (reference.rows.get(id) as ReferenceRow).order = order;
    }
    // The bytes of three versions at once: the others wait for the ones held
    internals.setPendingVersionBytes(3 * 550 * 2 * 342);
    for (let i = 0; i < 10; i++) internals.rebuild(ONE_STEP);
    expect(internals.versionStats().mostPending).toBeLessThanOrEqual(3);
    expectTablesMatch(tables, reference, ['a'], groupHandleOf);
    open = true;
    for (let i = 0; i < 60 && internals.hasPendingWork; i++) {
      internals.rebuild(ONE_STEP);
      internals.swap();
    }
    expect(internals.versionStats().mostPending).toBeLessThanOrEqual(3);
    expect(internals.deltaRowCount()).toBe(0);
    expectTablesMatch(tables, reference, ['a'], groupHandleOf);
  });

  it('take out a group whose rows all left', () => {
    const reference = pointsReference(3000);
    const setup = tablesOfReference(reference, ['a'], 1100);
    const { tables, writer, internals, groupHandleOf } = setup;
    expect(internals.rowTable('a')?.groupCount).toBe(3);
    // The rows of the middle group to the ranges of the others
    const ids = Array.from({ length: 1100 }, (_, i) => `p${1100 + i}`);
    const orders = ids.map(
      (_, i) => `${key(i % 2 === 0 ? 5000 : 2_500_000)}${String(i).padStart(5, '0')}`,
    );
    writer.writeRows(
      rowPatch(
        ids.map((id) => tables.getRowRef(id) as number),
        { key: orders },
      ),
    );
    ids.forEach((id, i) => {
      (reference.rows.get(id) as ReferenceRow).order = orders[i];
    });
    internals.flushVersions();
    expect(internals.deltaRowCount()).toBe(0);
    const table = internals.rowTable('a');
    const sizes = Array.from(
      { length: table?.groupCount ?? 0 },
      (_, g) => table?.groupAt(g).data.length,
    );
    expect(sizes.reduce((a, b) => (a ?? 0) + (b ?? 0), 0)).toBe(3000);
    expect(sizes).not.toContain(0);
    expectTablesMatch(tables, reference, ['a'], groupHandleOf);
  });

  it('give a layer of rows of its delta only its first group, and keep deleted rows', () => {
    const reference = pointsReference(10);
    const setup = tablesOfReference(reference, ['a'], 4);
    const { tables, writer, internals, groupHandleOf } = setup;
    const [fresh] = writer.allocateRowRefs(byteColumnFromStrings(['alone']));
    writer.writeRows(
      rowPatch([fresh], {
        type: ['Point'],
        parent: ['b'],
        geometry: [{ type: 'Point', coordinates: [1, 1] }],
        key: [key(1)],
      }),
    );
    reference.rows.set('alone', {
      ...(reference.rows.get('p0') as ReferenceRow),
      id: 'alone',
      layerId: 'b',
      geometry: { type: 'Point', coordinates: [1, 1] },
      order: key(1),
    });
    writer.writeRows(rowPatch([tables.getRowRef('p3') as number], {}, [1]));
    (reference.rows.get('p3') as ReferenceRow).deleted = true;
    internals.flushVersions();
    expect(internals.rowTable('b')?.groupCount).toBe(1);
    expect(internals.deltaRowCount()).toBe(0);
    expectTablesMatch(tables, reference, ['a', 'b'], groupHandleOf);
  });
});
