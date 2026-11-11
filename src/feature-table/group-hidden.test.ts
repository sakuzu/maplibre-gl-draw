// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A group shown or hidden hides the rows that name it, read from the row groups around them: for
 * members written into groups and taken out, rows deleted, next versions made, and keys of groups
 * going in. (The cuts of the row groups for groups given new keys are in the tests of Kasane.)
 */

import type { GroupHandle } from '@sakuzu/kasane';
import type { RowGroup, RowTable } from '@sakuzu/kasane/render';
import { describe, expect, it } from 'vitest';
import type { FeatureTables, RowField } from '../api/tables.js';
import { createTableStore } from '../store/table-memory.js';
import { isGroupHidden } from '../table/feature-row-columns.js';
import { FEATURE_TABLE_COLUMNS } from '../table/tabane/columns.js';
import { featureRowDataBuilder as createPageDataBuilder, seededRandom } from '../test-utils.js';
import { STATE_HIDDEN_GROUP } from './feature-row-states.js';
import { type FeatureTablesInternals, featureTablesInternals } from './feature-tables.js';

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
  const builder = createPageDataBuilder({ columns: FEATURE_TABLE_COLUMNS, targetRows: 64 });
  for (let i = 0; i < n; i++) {
    builder.addRow({
      id: `r${i}`,
      type: 'Point',
      geometry: { type: 'Point', coordinates: [i, 0] },
      key: `k${String(i).padStart(5, '0')}`,
    });
  }
  writer.addPages('rows', builder.finish());
  const tables = store.tables as FeatureTables;
  const internals = featureTablesInternals(tables) as FeatureTablesInternals;
  internals.addQueuedPages();
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
      writer.writeGroups({
        handles: Int32Array.of(internals.groups.handleOfId(id)),
        fields: new Map([['key', [`k${String(k * 100 + 50).padStart(5, '0')}`]]]),
      });
    });
  });
  internals.flushVersions();
  return { store, writer, tables, internals };
}

describe('a group shown or hidden', () => {
  it('hides the rows that name it, and only they', () => {
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
        store.transact(() => writer.writeRows({ handles, fields, deleted }), 'remote');
        if (step % 3 === 0) {
          internals.addQueuedPages();
          internals.flushVersions();
        }
        // New keys for some groups, which go in later
        const orders = new Map<GroupHandle, string>();
        for (const id of GROUPS) {
          if (random() < 0.4) orders.set(internals.groups.handleOfId(id), key());
        }
        const layer = internals.rowTable('rows') as RowTable;
        // A group shown or hidden: the rows that name it, and only they, are hidden with it
        if (random() < 0.3) {
          const id = GROUPS[Math.floor(random() * GROUPS.length)];
          const group = internals.groups.handleOfId(id);
          store.transact(
            () =>
              writer.writeGroups({
                handles: Int32Array.of(group),
                fields: new Map([['hidden', [!isGroupHidden(internals.groups, group)]]]),
              }),
            'remote',
          );
          const rowGroups: RowGroup[] = [];
          for (let g = 0; g < layer.groupCount; g++) rowGroups.push(layer.groupAt(g));
          if (layer.delta.group) rowGroups.push(layer.delta.group);
          for (const rowGroup of rowGroups) {
            for (let r = 0; r < rowGroup.data.length; r++) {
              const named = rowGroup.data.groups[r];
              const hidden = named >= 0 && isGroupHidden(internals.groups, named);
              expect((rowGroup.state[r] & STATE_HIDDEN_GROUP) !== 0, `seed ${seed}`).toBe(hidden);
            }
          }
        }
        // Sometimes the keys go in, their versions made now or later
        if (orders.size > 0 && random() < 0.4) {
          store.transact(
            () =>
              writer.writeGroups({
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
});
