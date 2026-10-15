// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The features drawn over rows for this client (`FeatureTables.showInPlace`, 9.7 of the design)
 *
 * - A feature is drawn in the place of the row of its id (a row of the delta drawn and not read),
 *   and the row is not drawn while it is; a feature of no row is drawn at the end of its layer
 * - Nothing is read differently: the order, the values, the scan, the rows hit (the row drawn
 *   over is hit where it is)
 * - The features of an owner are replaced by the next call; none takes them all away
 * - No next version takes a feature drawn over a row
 */

import { describe, expect, it } from 'vitest';
import type { StoreChange } from '../shared/types/model.js';
import { feature, internalsOf, tablesOfFeatures } from '../test-utils.js';
import { hitTestLayerTable } from './hit-test.js';
import { STATE_HIDDEN_OVERLAY } from './row-state.js';

const square = (x: number) => [
  [
    [x, 0],
    [x + 1, 0],
    [x + 1, 1],
    [x, 1],
    [x, 0],
  ],
];

function setup() {
  const emitted: StoreChange[] = [];
  const list = Array.from({ length: 12 }, (_, i) => feature(`p${i}`, 'Polygon', square(i * 2)));
  const tables = tablesOfFeatures('layer', list, 4, {
    onChange: (change) => emitted.push(change),
  });
  const ids = () =>
    Array.from(tables.tables.get('layer')?.listRowHandles(0, 100) ?? [], (h) =>
      tables.tables.getRowId(h),
    );
  return { ...tables, emitted, ids };
}

/** The ids of the rows of the delta of the layer, in their order, with their places */
function deltaIds(table: ReturnType<typeof setup>['table']): string[] {
  const delta = table.delta.group;
  if (!delta) return [];
  return Array.from({ length: delta.data.length }, (_, k) => {
    const bytes = delta.data.ids.bytes.subarray(
      delta.data.ids.offsets[k],
      delta.data.ids.offsets[k + 1],
    );
    return new TextDecoder().decode(bytes);
  });
}

describe('the features drawn over rows for this client', () => {
  it('are drawn in the places of the rows, which are not drawn, and read as before', () => {
    const { tables, internals, table, emitted, ids } = setup();
    const before = ids();
    const p3 = tables.get('layer')?.getRow(tables.findRow('p3') ?? -1);
    tables.showInPlace('peer', [{ ...feature('p3', 'Polygon', square(30)), layerId: 'layer' }]);
    // Drawn as a row of the delta, at the place of p3
    expect(deltaIds(table)).toEqual(['\u0000overlay\u0000peer\u0000p3']);
    const place = table.deltaPlaces();
    const p3Place = internals.placeOf(tables.findRow('p3') ?? -1);
    expect(place.groups[0]).toBe(table.orderOf(p3Place?.group.handle ?? -1));
    expect(place.cuts[0]).toBe(p3Place?.row);
    // The row drawn over is not drawn
    expect((p3Place?.group.state[p3Place.row] ?? 0) & STATE_HIDDEN_OVERLAY).not.toBe(0);
    // Read as before
    expect(ids()).toEqual(before);
    expect(tables.get('layer')?.getRow(tables.findRow('p3') ?? -1)).toEqual(p3);
    const scanned: number[] = [];
    const cursor = tables.scan({ layerIds: ['layer'] });
    for (let batch = cursor.next(); batch; batch = cursor.next()) scanned.push(...batch);
    expect(scanned.map((h) => tables.getRowId(h))).toEqual(before);
    expect(emitted).toEqual([]);
    // Hit where it is, not where it is drawn
    const hit = (x: number) =>
      hitTestLayerTable(internals, table, {
        coordinate: [x, 0.5],
        reach: 0.1,
        toleranceOf: () => 0.01,
        testShape: () => null,
        test: (f, [cx, cy]) => {
          const ring = (f.geometry as { coordinates: number[][][] }).coordinates[0];
          return cx >= ring[0][0] && cx <= ring[1][0] && cy >= 0 && cy <= 1;
        },
      });
    const at = hit(6.5);
    expect(at && tables.getRowId(at.group.data.handles[at.row])).toBe('p3');
    expect(hit(30.5)).toBeNull();
  });

  it('are replaced by the next call of their owner, and taken away by none', () => {
    const { tables, internals, table } = setup();
    internalsOf(tables).showInPlace('peer', [
      { ...feature('p3', 'Polygon', square(30)), layerId: 'layer' },
      { ...feature('new', 'Polygon', square(40)), layerId: 'layer' },
    ]);
    // A feature of no row at the end of the layer
    const places = table.deltaPlaces();
    const newAt = deltaIds(table).indexOf('\u0000overlay\u0000peer\u0000new');
    expect(newAt).toBeGreaterThanOrEqual(0);
    expect(places.groups[newAt]).toBe(table.groupCount - 1);
    expect(places.cuts[newAt]).toBe(table.groupAt(table.groupCount - 1).data.length);
    internalsOf(tables).showInPlace('peer', [
      { ...feature('p5', 'Polygon', square(50)), layerId: 'layer' },
    ]);
    expect(deltaIds(table)).toEqual(['\u0000overlay\u0000peer\u0000p5']);
    const p3 = internals.placeOf(tables.findRow('p3') ?? -1);
    expect((p3?.group.state[p3.row] ?? 0) & STATE_HIDDEN_OVERLAY).toBe(0);
    internalsOf(tables).showInPlace('peer', []);
    expect(table.delta.group).toBeNull();
    const p5 = internals.placeOf(tables.findRow('p5') ?? -1);
    expect((p5?.group.state[p5.row] ?? 0) & STATE_HIDDEN_OVERLAY).toBe(0);
  });

  it('are kept per owner: an owner replaces only its own', () => {
    const { tables, internals, table } = setup();
    tables.showInPlace('a', [{ ...feature('p3', 'Polygon', square(30)), layerId: 'layer' }]);
    tables.showInPlace('b', [{ ...feature('p5', 'Polygon', square(50)), layerId: 'layer' }]);
    expect(deltaIds(table).sort()).toEqual([
      '\u0000overlay\u0000a\u0000p3',
      '\u0000overlay\u0000b\u0000p5',
    ]);
    tables.showInPlace('a', []);
    expect(deltaIds(table)).toEqual(['\u0000overlay\u0000b\u0000p5']);
    const p3 = internals.placeOf(tables.findRow('p3') ?? -1);
    const p5 = internals.placeOf(tables.findRow('p5') ?? -1);
    expect((p3?.group.state[p3.row] ?? 0) & STATE_HIDDEN_OVERLAY).toBe(0);
    expect((p5?.group.state[p5.row] ?? 0) & STATE_HIDDEN_OVERLAY).not.toBe(0);
  });

  it('are not taken by the next versions', () => {
    const { tables, internals, table, writer, ids } = setup();
    internalsOf(tables).showInPlace('peer', [
      { ...feature('p3', 'Polygon', square(30)), layerId: 'layer' },
    ]);
    // A row moved in the same layer goes to the delta and to the next version
    writer.apply({
      handles: Int32Array.of(tables.findRow('p1') ?? -1),
      fields: new Map([['order', ['k000009m']]]),
    });
    internals.flushVersions();
    expect(deltaIds(table)).toEqual(['\u0000overlay\u0000peer\u0000p3']);
    expect(ids()).toEqual([
      'p0',
      'p2',
      'p3',
      'p4',
      'p5',
      'p6',
      'p7',
      'p8',
      'p9',
      'p1',
      'p10',
      'p11',
    ]);
    expect(internals.hasPendingWork).toBe(false);
  });
});
