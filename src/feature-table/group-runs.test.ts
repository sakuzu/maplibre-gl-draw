// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The cuts of the row groups of a layer for groups of features given new keys (`groupRunCuts`)
 * are the cuts made by reading every row of the layer (kept here as the reference): for members
 * written into groups and taken out, rows deleted, next versions made, and keys of groups still
 * going in; and they read the row groups around the members and their places, not every row. A
 * group shown or hidden hides the rows that name it, read from the row groups around them.
 */

import { describe, expect, it, vi } from 'vitest';
import type { FeatureTables, RowField } from '../api/tables.js';
import { createTableStore } from '../store/table-memory.js';
import { createRowBlockDataBuilder } from '../table/row-group-builder.js';
import { compareRowKeys } from '../table/row-keys.js';
import { FEATURE_TABLE_COLUMNS } from '../table/tabane/columns.js';
import { seededRandom } from '../test-utils.js';
import { type FeatureTablesInternals, featureTablesInternals } from './feature-tables.js';
import { groupRunCuts } from './group-runs.js';
import type { GroupTable } from './group-table.js';
import type { LayerTable, RowGroup } from './layer-table.js';
import { STATE_HIDDEN_GROUP } from './row-state.js';
import type { GroupHandle } from './types.js';

/** The cuts made by reading every row of the layer (the reference) */
function referenceCuts(
  layer: LayerTable,
  orders: ReadonlyMap<GroupHandle, string>,
  groups: GroupTable,
): { cuts: Map<RowGroup, Set<number>>; members: boolean } {
  const cuts = new Map<RowGroup, Set<number>>();
  const cut = (group: RowGroup, row: number): void => {
    if (row <= 0 || row >= group.data.length) return;
    let set = cuts.get(group);
    if (!set) {
      set = new Set();
      cuts.set(group, set);
    }
    set.add(row);
  };
  const members: Array<{ group: RowGroup; row: number }> = [];
  for (let g = 0; g < layer.groupCount; g++) {
    const group = layer.groupAt(g);
    const data = group.data;
    let run = -1;
    for (let r = 0; r <= data.length; r++) {
      const inside = r < data.length && orders.has(data.groups[r]);
      if (inside && run < 0) {
        run = r;
        members.push({ group, row: r });
        cuts.set(group, cuts.get(group) ?? new Set());
        cut(group, r);
      } else if (!inside && run >= 0) {
        cut(group, r);
        run = -1;
      } else if (inside && data.groups[r] !== data.groups[r - 1]) {
        cut(group, r);
        members.push({ group, row: r });
      }
    }
  }
  if (members.length === 0) return { cuts, members: false };
  const keys = groups.withOrders(orders);
  for (const member of members) {
    let placed = false;
    for (let g = 0; g < layer.groupCount && !placed; g++) {
      const group = layer.groupAt(g);
      const data = group.data;
      for (let r = 0; r < data.length; r++) {
        if (orders.has(data.groups[r])) continue;
        if (compareRowKeys(member.group.data, member.row, data, r, keys) < 0) {
          if (r > 0 && !orders.has(data.groups[r - 1])) cut(group, r);
          placed = true;
          break;
        }
      }
    }
  }
  return { cuts, members: true };
}

/** The cuts as they compare: the cuts of each row group by its handle */
function comparable(result: { cuts: Map<RowGroup, Set<number>>; members: boolean }) {
  return {
    members: result.members,
    cuts: [...result.cuts]
      .map(([group, rows]) => [group.handle, [...rows].sort((a, b) => a - b)] as const)
      .sort((a, b) => a[0] - b[0]),
  };
}

const GROUPS = ['g0', 'g1', 'g2', 'g3', 'g4'];

function setup(n: number) {
  const { store, writer } = createTableStore();
  store.createLayer({
    id: 'rows',
    name: 'rows',
    visible: true,
    locked: false,
    opacity: 1,
    kind: 'table',
    metadata: undefined,
    styleRule: undefined,
  });
  const builder = createRowBlockDataBuilder({ columns: FEATURE_TABLE_COLUMNS, targetRows: 64 });
  for (let i = 0; i < n; i++) {
    builder.addRow({
      id: `r${i}`,
      type: 'Point',
      geometry: { type: 'Point', coordinates: [i, 0] },
      key: `k${String(i).padStart(5, '0')}`,
    });
  }
  writer.addRowBlocks('rows', builder.finish());
  const tables = store.tables as FeatureTables;
  const internals = featureTablesInternals(tables) as FeatureTablesInternals;
  internals.addQueuedRowBlocks();
  store.transact(() => {
    GROUPS.forEach((id, k) => {
      store.createGroup({
        id,
        layerId: 'rows',
        name: id,
        kind: 'table',
        visible: true,
        locked: false,
      });
      // A key among the keys of the rows
      writer.applyGroups({
        handles: Int32Array.of(internals.groups.handleOfId(id)),
        fields: new Map([['key', [`k${String(k * 100 + 50).padStart(5, '0')}`]]]),
      });
    });
  });
  internals.flushVersions();
  return { store, writer, tables, internals };
}

describe('groupRunCuts', () => {
  it('cuts the row groups as reading every row of the layer cuts them', () => {
    for (const seed of [1, 2, 3, 4]) {
      const random = seededRandom(seed);
      const { store, writer, tables, internals } = setup(600);
      const key = () => `k${String(Math.floor(random() * 700)).padStart(5, '0')}`;
      for (let step = 0; step < 60; step++) {
        // Rows there
        const there: number[] = [];
        const cursor = tables.scan({ layerIds: ['rows'] });
        for (let batch = cursor.next(); batch; batch = cursor.next()) there.push(...batch);
        const handles = Int32Array.from(
          new Set(Array.from({ length: 8 }, () => there[Math.floor(random() * there.length)])),
        );
        const r = random();
        let fields: Map<RowField, unknown[]> = new Map();
        let deleted: Uint8Array | undefined;
        if (r < 0.5) {
          fields = new Map<RowField, unknown[]>([
            ['parent', Array.from(handles, () => GROUPS[Math.floor(random() * GROUPS.length)])],
            ['key', Array.from(handles, () => key())],
          ]);
        } else if (r < 0.65) {
          fields = new Map<RowField, unknown[]>([['parent', Array.from(handles, () => 'rows')]]);
        } else if (r < 0.75) {
          deleted = new Uint8Array(handles.length).fill(1);
        } else {
          fields = new Map<RowField, unknown[]>([['key', Array.from(handles, () => key())]]);
        }
        store.transact(() => writer.apply({ handles, fields, deleted }), 'remote');
        if (step % 3 === 0) {
          internals.addQueuedRowBlocks();
          internals.flushVersions();
        }
        // New keys for some groups, compared before they go in
        const orders = new Map<GroupHandle, string>();
        for (const id of GROUPS) {
          if (random() < 0.4) orders.set(internals.groups.handleOfId(id), key());
        }
        const layer = internals.layerTable('rows') as LayerTable;
        expect(comparable(groupRunCuts(layer, orders, internals.groups)), `seed ${seed}`).toEqual(
          comparable(referenceCuts(layer, orders, internals.groups)),
        );
        // A group shown or hidden: the rows that name it, and only they, are hidden with it
        if (random() < 0.3) {
          const id = GROUPS[Math.floor(random() * GROUPS.length)];
          const group = internals.groups.handleOfId(id);
          store.transact(
            () =>
              writer.applyGroups({
                handles: Int32Array.of(group),
                fields: new Map([['hidden', [internals.groups.isVisible(group)]]]),
              }),
            'remote',
          );
          const rowGroups: RowGroup[] = [];
          for (let g = 0; g < layer.groupCount; g++) rowGroups.push(layer.groupAt(g));
          if (layer.delta.group) rowGroups.push(layer.delta.group);
          for (const rowGroup of rowGroups) {
            for (let r = 0; r < rowGroup.data.length; r++) {
              const named = rowGroup.data.groups[r];
              const hidden = named >= 0 && !internals.groups.isVisible(named);
              expect((rowGroup.state[r] & STATE_HIDDEN_GROUP) !== 0, `seed ${seed}`).toBe(hidden);
            }
          }
        }
        // Sometimes the keys go in, their versions made now or later
        if (orders.size > 0 && random() < 0.4) {
          store.transact(
            () =>
              writer.applyGroups({
                handles: Int32Array.from(orders.keys()),
                fields: new Map([['key', [...orders.values()]]]),
              }),
            'remote',
          );
          if (random() < 0.5) internals.flushVersions();
        }
      }
    }
  });

  it('reads the row groups around the members, not every row of the layer', () => {
    const counts: number[] = [];
    for (const n of [2_000, 20_000]) {
      const { store, writer, tables, internals } = setup(n);
      // 20 members spread over the layer, in their group once its next versions are made
      const handles = Int32Array.from(
        { length: 20 },
        (_, k) => tables.findRow(`r${Math.floor((k * n) / 20)}`) as number,
      );
      store.transact(
        () =>
          writer.apply(
            {
              handles,
              fields: new Map<RowField, unknown[]>([
                ['parent', Array.from(handles, () => 'g1')],
                ['key', Array.from(handles, (_, k) => `m${k}`)],
              ]),
            },
            {},
          ),
        'remote',
      );
      internals.flushVersions();
      const layer = internals.layerTable('rows') as LayerTable;
      const orders = new Map([[internals.groups.handleOfId('g1'), 'k00000']]);
      const spy = vi.spyOn(layer, 'groupAt');
      expect(groupRunCuts(layer, orders, internals.groups).members).toBe(true);
      counts.push(spy.mock.calls.length);
      spy.mockRestore();
    }
    // The row groups are read by searches: a few more for ten times as many
    expect(counts[1]).toBeLessThanOrEqual(counts[0] * 2);
  });
});
