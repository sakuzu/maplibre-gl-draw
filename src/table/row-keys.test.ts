// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The order of the rows of a layer: the key of the item, the id of the item, the key within the
 * group, the id of the row
 */

import { utf8ColumnFromStrings } from '@sakuzu/tabane';
import { describe, expect, it } from 'vitest';
import { compareRowKeys, type GroupKeySource, type RowKeySource } from './row-keys.js';

interface Row {
  id: string;
  key: string;
  group?: number;
  member?: string;
}

function source(rows: readonly Row[]): RowKeySource {
  return {
    ids: utf8ColumnFromStrings(rows.map((row) => row.id)),
    itemKeys: utf8ColumnFromStrings(rows.map((row) => row.key)),
    memberKeys: utf8ColumnFromStrings(rows.map((row) => row.member ?? '')),
    groups: Int32Array.from(rows.map((row) => row.group ?? -1)),
  };
}

function groupsOf(groups: ReadonlyArray<{ handle: number; id: string; key: string }>) {
  const entries = new Map(groups.map((group, i) => [group.handle, i]));
  const keys: GroupKeySource = {
    ids: utf8ColumnFromStrings(groups.map((group) => group.id)),
    keys: utf8ColumnFromStrings(groups.map((group) => group.key)),
    entryOf: (handle) => entries.get(handle) ?? -1,
  };
  return keys;
}

/** The ids of the rows in the order of the layer */
function ordered(rows: readonly Row[], groups: GroupKeySource | null = null): string[] {
  const keys = source(rows);
  return rows
    .map((_, i) => i)
    .sort((a, b) => compareRowKeys(keys, a, keys, b, groups))
    .map((i) => rows[i].id);
}

describe('compareRowKeys', () => {
  it('orders the rows by their keys, as bytes', () => {
    expect(
      ordered([
        { id: 'c', key: 'a1' },
        { id: 'a', key: 'a0' },
        { id: 'b', key: 'Zz' },
      ]),
    ).toEqual(['b', 'a', 'c']);
  });

  it('orders rows with the same key by their ids', () => {
    expect(
      ordered([
        { id: 'r2', key: 'a0' },
        { id: 'r10', key: 'a0' },
        { id: 'r1', key: 'a0' },
      ]),
    ).toEqual(['r1', 'r10', 'r2']);
  });

  it('puts the members of a group together at the key of the group, in their order', () => {
    const groups = groupsOf([{ handle: 7, id: 'g', key: 'a5' }]);
    expect(
      ordered(
        [
          { id: 'x', key: 'a1' },
          { id: 'm1', key: 'zz', group: 7, member: 'b' },
          { id: 'y', key: 'a9' },
          { id: 'm2', key: 'a0', group: 7, member: 'a' },
        ],
        groups,
      ),
    ).toEqual(['x', 'm2', 'm1', 'y']);
  });

  it('orders a group and a row with the same key by the ids of the items', () => {
    const groups = groupsOf([{ handle: 1, id: 'm', key: 'a5' }]);
    const rows: Row[] = [
      { id: 'z', key: 'a5' },
      { id: 'a', key: 'a5' },
      { id: 'member-2', key: 'q', group: 1, member: 'b' },
      { id: 'member-1', key: 'q', group: 1, member: 'a' },
    ];
    // The items: the row "a", the group "m", the row "z"
    expect(ordered(rows, groups)).toEqual(['a', 'member-1', 'member-2', 'z']);
  });

  it('moves the members when the key of the group changes, without writing the rows', () => {
    const rows: Row[] = [
      { id: 'x', key: 'a1' },
      { id: 'y', key: 'a9' },
      { id: 'm1', key: 'a0', group: 3, member: 'a' },
      { id: 'm2', key: 'a0', group: 3, member: 'b' },
    ];
    expect(ordered(rows, groupsOf([{ handle: 3, id: 'g', key: 'a5' }]))).toEqual([
      'x',
      'm1',
      'm2',
      'y',
    ]);
    expect(ordered(rows, groupsOf([{ handle: 3, id: 'g', key: 'b0' }]))).toEqual([
      'x',
      'y',
      'm1',
      'm2',
    ]);
  });

  it('orders the members with the same key within the group by their ids', () => {
    const groups = groupsOf([{ handle: 0, id: 'g', key: 'a' }]);
    expect(
      ordered(
        [
          { id: 'b', key: 'a', group: 0, member: 'k' },
          { id: 'a', key: 'a', group: 0, member: 'k' },
        ],
        groups,
      ),
    ).toEqual(['a', 'b']);
  });

  it('compares rows of two different sources', () => {
    const a = source([{ id: 'p', key: 'a2' }]);
    const b = source([
      { id: 'q', key: 'a1' },
      { id: 'r', key: 'a3' },
    ]);
    expect(compareRowKeys(a, 0, b, 0, null)).toBeGreaterThan(0);
    expect(compareRowKeys(a, 0, b, 1, null)).toBeLessThan(0);
    expect(compareRowKeys(a, 0, a, 0, null)).toBe(0);
  });

  it('throws when a row names a group it is not given', () => {
    const keys = source([
      { id: 'a', key: 'a', group: 5 },
      { id: 'b', key: 'b' },
    ]);
    expect(() => compareRowKeys(keys, 0, keys, 1, null)).toThrow();
    expect(() => compareRowKeys(keys, 0, keys, 1, groupsOf([]))).toThrow();
  });
});
