// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The rows with companions kept for the hit testing of a layer held as rows
 *
 * A write asks again only the rows it changed, whatever the number of rows of the layer, and
 * what is kept stays what walking every row of the layer finds, over writes of every kind.
 */

import { utf8ColumnFromStrings } from '@sakuzu/tabane';
import { describe, expect, it } from 'vitest';
import type { LayerTableView, RowField, RowValues, TableGroupField } from '../../api/tables.js';
import type { FeatureTablesInternals } from '../../feature-table/feature-tables.js';
import type { LayerTable } from '../../feature-table/layer-table.js';
import { rowFeatureToRead, rowHasGeometry } from '../../feature-table/row-read.js';
import { createRowBlockDataBuilder } from '../../table/row-group-builder.js';
import {
  feature,
  orderKey,
  randomReference,
  randomReferenceRow,
  randomRowWrites,
  referenceKey,
  rowOfFeature,
  rowPatch,
  seededRandom,
  tablesOfFeatures,
  tablesOfReference,
} from '../../test-utils.js';
import {
  createFeatureCompanionRegistry,
  type FeatureCompanionProvider,
  type FeatureCompanionRegistry,
} from '../../view/feature-companion.js';
import { companionRowsOf } from './companion-rows.js';

/**
 * A provider of a callout for each row with a number in its attribute `callout`, answered from
 * the rows; it counts the rows it is asked about
 */
function registerCallouts(companions: FeatureCompanionRegistry, id = 'callouts') {
  const asked = { rows: 0 };
  const provider: FeatureCompanionProvider = {
    id,
    has: (f) => typeof f.properties.callout === 'number',
    hasRow: (view: LayerTableView, handle: number) => {
      asked.rows++;
      return typeof view.getRowValue(handle, 'callout') === 'number';
    },
    draw: () => {},
    hitTest: () => null,
    onCompanionClick: () => {},
  };
  const unregister = companions.register(provider);
  return { asked, unregister };
}

/**
 * The rows with companions as walking every row of the layer in its order finds them: the rows
 * read with a geometry and a number in their attribute `callout`
 */
function walked(internals: FeatureTablesInternals, table: LayerTable): string[] {
  const order = table.rowOrder();
  const out: string[] = [];
  for (let i = 0; i < order.handles.length; i++) {
    const group = order.groups[i];
    const row = order.rows[i];
    if (!rowHasGeometry(group, row)) continue;
    const read = rowFeatureToRead(internals.readContext, table.layerId, group, row);
    if (typeof read.properties.callout === 'number') out.push(read.id);
  }
  return out;
}

/** The ids of the rows with companions kept, in their order, checked against their groups */
function kept(
  internals: FeatureTablesInternals,
  table: LayerTable,
  companions: FeatureCompanionRegistry,
): string[] {
  const found = companionRowsOf(internals, table, companions);
  const ids: string[] = [];
  let count = 0;
  for (let i = 0; i < found.rows.length; i++) {
    const group = found.groups[i];
    const row = found.rows[i];
    expect(found.byGroup.get(group)).toContain(row);
    ids.push(rowFeatureToRead(internals.readContext, table.layerId, group, row).id);
  }
  for (const rows of found.byGroup.values()) count += rows.length;
  expect(count).toBe(found.rows.length);
  return ids;
}

describe('the rows with companions of a layer held as rows', () => {
  it('asks again only the rows written, not the rows of the layer', () => {
    const count = 100_000;
    const callouts = new Set([10, 20_000, 40_000, 60_000, 99_000]);
    const features = Array.from({ length: count }, (_, i) =>
      feature(
        `p${i}`,
        'Point',
        [i % 200, Math.floor(i / 200)],
        callouts.has(i) ? { properties: { callout: 1 } } : {},
      ),
    );
    const { internals, table, tables, writer } = tablesOfFeatures('l', features, 4096);
    const companions = createFeatureCompanionRegistry();
    const { asked } = registerCallouts(companions);
    const handleOf = (id: string): number => tables.findRow(id) as number;
    const ids = (): string[] => kept(internals, table, companions);
    const expectWalked = (): void => {
      expect(ids()).toEqual(walked(internals, table));
    };

    // Found once, from every row
    expect(ids()).toEqual(['p10', 'p20000', 'p40000', 'p60000', 'p99000']);
    expect(asked.rows).toBe(count);

    // Kept while nothing is written
    asked.rows = 0;
    for (let i = 0; i < 10; i++) ids();
    expect(asked.rows).toBe(0);

    // A row moved in place
    writer.apply(
      rowPatch([handleOf('p500')], { geometry: [{ type: 'Point', coordinates: [1, 1] }] }),
    );
    asked.rows = 0;
    expectWalked();
    expect(asked.rows).toBe(1);

    // A row given a callout, and one whose callout is taken off
    writer.apply(rowPatch([handleOf('p30000')], { 'property:callout': [2] }));
    asked.rows = 0;
    expect(ids()).toEqual(['p10', 'p20000', 'p30000', 'p40000', 'p60000', 'p99000']);
    expect(asked.rows).toBe(1);
    writer.apply(rowPatch([handleOf('p40000')], { 'property:callout': [undefined] }));
    asked.rows = 0;
    expect(ids()).toEqual(['p10', 'p20000', 'p30000', 'p60000', 'p99000']);
    expect(asked.rows).toBe(1);

    // Rows written by many writes before the next hit: each asked once
    for (let i = 0; i < 20; i++) {
      writer.apply(
        rowPatch([handleOf(`p${70_000 + (i % 4)}`)], {
          geometry: [{ type: 'Point', coordinates: [i, 2] }],
        }),
      );
    }
    asked.rows = 0;
    expectWalked();
    expect(asked.rows).toBe(4);

    // A row deleted
    writer.apply(rowPatch([handleOf('p60000')], {}, [1]));
    asked.rows = 0;
    expectWalked();
    expect(asked.rows).toBe(1);

    // A row put at another place of the order (it comes into the delta), and a row of the delta
    // written in place
    writer.apply(rowPatch([handleOf('p20000')], { order: [`${orderKey(50_000)}a`] }));
    asked.rows = 0;
    expect(ids()).toEqual(['p10', 'p30000', 'p20000', 'p60000', 'p99000']);
    expect(asked.rows).toBe(1);
    writer.apply(rowPatch([handleOf('p20000')], { 'property:callout': [undefined] }));
    asked.rows = 0;
    expect(ids()).toEqual(['p10', 'p30000', 'p60000', 'p99000']);
    expect(asked.rows).toBe(1);

    // The undo of the writes of a row
    const p10 = handleOf('p10');
    const write = rowPatch([p10], { 'property:callout': [undefined] }, [1]);
    const undo = internals.readValues(write);
    writer.apply(write);
    asked.rows = 0;
    expect(ids()).toEqual(['p30000', 'p60000', 'p99000']);
    writer.apply(undo);
    expect(ids()).toEqual(['p10', 'p30000', 'p60000', 'p99000']);
    expect(asked.rows).toBe(2);
  });

  it('stays what walking every row finds, over writes of every kind', () => {
    const layerIds = ['a', 'b'];
    for (let seed = 1; seed <= 12; seed++) {
      const random = seededRandom(seed);
      const reference = randomReference(random, 240, layerIds);
      for (const row of reference.rows.values()) {
        if (random() < 0.15) row.properties = { ...row.properties, callout: 1 };
      }
      const { tables, writer, internals, groupHandleOf } = tablesOfReference(
        reference,
        layerIds,
        8,
      );
      const writes = randomRowWrites(random, { tables, writer, internals, reference, layerIds });
      const companions = createFeatureCompanionRegistry();
      registerCallouts(companions);
      let second: (() => void) | null = null;
      /** The writes that can be undone, the last one last */
      const undos: RowValues[] = [];
      const write = (patch: RowValues): void => {
        undos.push(internals.readValues(patch));
        writer.apply(patch);
      };
      const someRow = (): number | undefined => {
        const ids = [...reference.rows.keys()];
        return tables.findRow(ids[Math.floor(random() * ids.length)]);
      };
      let blocks = 0;
      const check = (step: number): void => {
        for (const layerId of layerIds) {
          const table = internals.layerTable(layerId);
          if (!table) continue;
          expect(kept(internals, table, companions), `seed ${seed}, step ${step}`).toEqual(
            walked(internals, table),
          );
        }
      };
      check(-1);
      for (let step = 0; step < 160; step++) {
        const pick = random();
        if (pick < 0.4) {
          // Geometries, styles, attributes, keys, layers, groups, new rows, deletions, shown,
          // rows put into the delta
          writes.step(step);
        } else if (pick < 0.6) {
          // A callout given or taken off
          const handle = someRow();
          if (handle !== undefined) {
            write(rowPatch([handle], { 'property:callout': [random() < 0.5 ? 1 : undefined] }));
          }
        } else if (pick < 0.68) {
          // A row deleted or written again with its key moved
          const handle = someRow();
          if (handle !== undefined) {
            if (random() < 0.5) write(rowPatch([handle], {}, [1]));
            else write(rowPatch([handle], { order: [referenceKey(random() * 1e6)] }));
          }
        } else if (pick < 0.78) {
          // The last writes undone
          const undo = undos.pop();
          if (undo) writer.apply(undo);
        } else if (pick < 0.84) {
          // The next versions of the groups (the rows of the deltas taken into them)
          internals.flushVersions();
        } else if (pick < 0.88) {
          // A group of features put at another place of the order
          const group = groupHandleOf(random() < 0.5 ? 'ga' : 'gb');
          writer.applyGroups({
            handles: Int32Array.of(group),
            fields: new Map<TableGroupField, unknown[]>([
              ['order', [referenceKey(random() * 1e6)]],
            ]),
          });
          if (random() < 0.5) internals.flushVersions();
        } else if (pick < 0.92) {
          // A row group of new rows taken in
          const layerId = layerIds[Math.floor(random() * layerIds.length)];
          const builder = createRowBlockDataBuilder({ targetRows: 8 });
          const base = 2_000_000 + blocks * 100;
          for (let k = 0; k < 3; k++) {
            const row = randomReferenceRow(random, `blk${blocks}-${k}`, layerId);
            builder.addRow({
              id: row.id,
              type: row.type,
              geometry: row.geometry,
              order: referenceKey(base + k),
              style: row.style,
              properties: random() < 0.5 ? { callout: 1 } : {},
            });
          }
          blocks++;
          writer.addRowBlocks(layerId, builder.finish());
          internals.addQueuedRowBlocks();
        } else if (pick < 0.95) {
          // Many new rows in one write (their own row groups)
          const layerId = layerIds[Math.floor(random() * layerIds.length)];
          const n = 70;
          const ids = Array.from({ length: n }, (_, k) => `many${step}-${k}`);
          const handles = Array.from(writer.allocateHandles(utf8ColumnFromStrings(ids)));
          const base = 3_000_000 + step * 1000;
          write(
            rowPatch(handles, {
              type: handles.map(() => 'Point'),
              layerId: handles.map(() => layerId),
              geometry: handles.map((_, k) => ({ type: 'Point', coordinates: [k, k] })),
              order: handles.map((_, k) => referenceKey(base + k)),
              style: handles.map(() => ({})),
              'property:callout': handles.map((_, k) => (k % 9 === 0 ? 1 : undefined)),
            }),
          );
          if (random() < 0.5) internals.addQueuedRowBlocks();
        } else {
          // Another provider comes or goes
          if (second) {
            second();
            second = null;
          } else second = registerCallouts(companions, 'more').unregister;
        }
        // Several writes between two hits now and then
        if (random() < 0.7) check(step);
      }
      check(160);
    }
  });

  it('keeps the rows with companions of each layer of a row moved between layers', () => {
    const { internals, tables, writer } = tablesOfFeatures(
      'a',
      [
        feature('x', 'Point', [0, 0], { properties: { callout: 1 } }),
        feature('y', 'Point', [1, 0]),
      ],
      8,
    );
    const builder = createRowBlockDataBuilder({ targetRows: 8 });
    builder.addRow(rowOfFeature(feature('z', 'Point', [2, 0]), orderKey(5)));
    writer.addRowBlocks('b', builder.finish());
    internals.addQueuedRowBlocks();
    const companions = createFeatureCompanionRegistry();
    registerCallouts(companions);
    const a = internals.layerTable('a') as LayerTable;
    const b = internals.layerTable('b') as LayerTable;
    const ids = (table: LayerTable) => kept(internals, table, companions);
    expect(ids(a)).toEqual(['x']);
    expect(ids(b)).toEqual([]);
    const x = tables.findRow('x') as number;
    const moves: RowValues[] = [];
    const move = (patch: RowValues): void => {
      moves.push(internals.readValues(patch));
      writer.apply(patch);
    };
    move(
      rowPatch([x], {
        layerId: ['b'],
        order: [orderKey(9)],
        groupId: [undefined],
        member: [undefined],
      }),
    );
    expect(ids(a)).toEqual([]);
    expect(ids(b)).toEqual(['x']);
    move(rowPatch([x], { 'property:callout': [undefined] }));
    expect(ids(b)).toEqual([]);
    // Back to its layer, and its callout again
    writer.apply(moves.pop() as RowValues);
    writer.apply(moves.pop() as RowValues);
    for (const table of [a, b]) expect(ids(table)).toEqual(walked(internals, table));
    expect(ids(a)).toEqual(['x']);
    internals.flushVersions();
    for (const table of [a, b]) expect(ids(table)).toEqual(walked(internals, table));
    const fields = new Map<RowField, unknown[]>([['property:callout', [1]]]);
    writer.apply({ handles: Int32Array.of(tables.findRow('z') as number), fields });
    expect(ids(b)).toEqual(['z']);
  });
});
