// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The rows held as features (`hold`, `getOpenedFeature`, `writer.applyOpened`)
 *
 * - A row held is a feature given as it is until it changes; it stays a row of the table. The
 *   rows held change are notified as `held`, the rows an owner no longer names and no other owner
 *   names are no longer held
 * - A write of the feature of a row held writes the row, and is notified as an update of the
 *   feature; a write of the row (`apply`) of a row held is notified as an update of its feature,
 *   not of the row, and a row held deleted is a feature deleted (not in `held`)
 * - The values an edit writes in its middle are shown; the values others write meanwhile into
 *   the fields the edit writes go to the values the edit ends with: the row shows them when the
 *   edit is undone (the values before it written back) or the row is no longer held
 * - The copy of a row held in the delta is not taken by a next version until it is no longer held
 */

import { describe, expect, it } from 'vitest';
import type { RowField, RowValues } from '../api/tables.js';
import type { Feature, StoreChange } from '../shared/types/model.js';
import { feature, tablesOfFeatures } from '../test-utils.js';

/** Points in a row, `count` of them */
function points(count: number): Feature[] {
  return Array.from({ length: count }, (_, i) =>
    feature(`p${i}`, 'Point', [i, 0], { properties: { n: i } }),
  );
}

/** Tables of points with their notifications gathered */
function setup(count = 20) {
  const emitted: StoreChange[] = [];
  const tables = tablesOfFeatures('layer', points(count), 8, {
    onChange: (change) => emitted.push(change),
  });
  // What the rows added told is not gathered
  emitted.length = 0;
  const at = (id: string) => tables.internals.ids.handleOf(id);
  const row = (id: string) => tables.tables.get('layer')?.getRow(at(id));
  return { ...tables, emitted, at, row };
}

/** A patch of fields of one row */
function patchOf(handle: number, fields: Record<string, unknown>, deleted = false): RowValues {
  return {
    handles: Int32Array.of(handle),
    fields: new Map(Object.entries(fields).map(([field, value]) => [field as RowField, [value]])),
    deleted: deleted ? Uint8Array.of(1) : undefined,
  };
}

describe('the rows held as features', () => {
  it('are features given as they are until they change, and notified as held', () => {
    const { tables, internals, emitted } = setup();
    internals.open('core:selection', ['p1', 'p2', 'unknown']);
    expect(emitted).toHaveLength(1);
    expect(emitted[0].opened?.added.map((f) => f.id)).toEqual(['p1', 'p2']);
    expect(emitted[0].opened?.removed).toEqual([]);
    const held = internals.getOpenedFeature('p1');
    expect(held).toBe(emitted[0].opened?.added[0]);
    expect(held?.geometry).toEqual({ type: 'Point', coordinates: [1, 0] });
    expect(held?.properties).toEqual({ n: 1 });
    expect(internals.getOpenedFeature('p1')).toBe(held);
    expect(internals.getOpenedFeature('p3')).toBeUndefined();
    // Held by two owners: not given back until neither names it
    internals.open('core:pointer', ['p2']);
    internals.open('core:selection', ['p1']);
    expect(emitted).toHaveLength(1);
    internals.open('core:pointer', []);
    expect(emitted[1].opened).toEqual({ added: [], removed: ['p2'] });
    expect(internals.getOpenedFeature('p2')).toBeUndefined();
    // A row stays a row of the table while it is held
    expect(tables.scan().next()?.length).toBe(20);
  });

  it('write their rows when their features are written, notified as updates of the features', () => {
    const { internals, writer, emitted, row } = setup();
    internals.open('core:selection', ['p3']);
    const before = internals.getOpenedFeature('p3') as Feature;
    const next: Feature = {
      ...before,
      geometry: { type: 'Point', coordinates: [30, 3] },
      style: { pointColor: '#ff0000' },
      properties: { n: 33, name: 'three' },
    };
    emitted.length = 0;
    writer.applyOpened('p3', next);
    expect(internals.getOpenedFeature('p3')).toBe(next);
    expect(emitted).toEqual([
      { features: { updated: [{ id: 'p3', feature: next, previous: before }] } },
    ]);
    expect(row('p3')?.geometry).toEqual({ type: 'Point', coordinates: [30, 3] });
    expect(row('p3')?.style).toEqual({ pointColor: '#ff0000' });
    expect(row('p3')?.properties).toEqual({ n: 33, name: 'three' });
    // The layer of a row is written with its key
    expect(() => writer.applyOpened('p3', { ...next, layerId: 'other' })).toThrow();
    expect(() => writer.applyOpened('p4', next)).toThrow();
  });

  it('are written by apply as features: an update of the feature, a deletion of the feature', () => {
    const { internals, writer, emitted, at } = setup();
    internals.open('core:selection', ['p5', 'p6']);
    const p5 = internals.getOpenedFeature('p5') as Feature;
    emitted.length = 0;
    const change = writer.apply({
      handles: Int32Array.of(at('p5'), at('p7')),
      fields: new Map<RowField, unknown[]>([['property:n', [-5, -7]]]),
    });
    // The row held is not among the rows written
    expect(Array.from(change.layers.get('layer')?.updated ?? [])).toEqual([at('p7')]);
    expect(emitted.map((c) => Object.keys(c))).toEqual([['rows'], ['features']]);
    const updated = emitted[1].features?.updated?.[0];
    expect(updated?.previous).toBe(p5);
    expect(updated?.feature.properties).toEqual({ n: -5 });
    expect(internals.getOpenedFeature('p5')).toBe(updated?.feature);
    // A row held deleted: its feature is deleted, and it is not held any more (not in held)
    emitted.length = 0;
    writer.apply(patchOf(at('p6'), {}, true));
    expect(emitted).toHaveLength(1);
    expect(emitted[0].features?.deleted?.map((f) => f.id)).toEqual(['p6']);
    expect(emitted[0].rows).toBeUndefined();
    expect(internals.getOpenedFeature('p6')).toBeUndefined();
    emitted.length = 0;
    internals.open('core:selection', ['p5']);
    expect(emitted).toHaveLength(0);
  });

  it('keep their copies in the delta until they are no longer held', () => {
    const { tables, writer, internals, at } = setup(40);
    internals.open('core:selection', ['p2']);
    writer.apply(patchOf(at('p2'), { order: 'k000030m' }));
    expect(internals.placeOf(at('p2'))?.group.delta).toBe(true);
    internals.flushVersions();
    expect(internals.placeOf(at('p2'))?.group.delta).toBe(true);
    expect(internals.hasPendingWork).toBe(false);
    // Written while held: still kept
    writer.applyOpened('p2', {
      ...(internals.getOpenedFeature('p2') as Feature),
      geometry: { type: 'Point', coordinates: [2, 2] },
    });
    internals.flushVersions();
    expect(internals.placeOf(at('p2'))?.group.delta).toBe(true);
    internals.open('core:selection', []);
    expect(internals.hasPendingWork).toBe(true);
    internals.flushVersions();
    expect(internals.placeOf(at('p2'))?.group.delta).toBe(false);
    expect(tables.get('layer')?.getRow(at('p2'))?.geometry).toEqual({
      type: 'Point',
      coordinates: [2, 2],
    });
    const order = tables.get('layer')?.listRowHandles(0, 40) ?? new Int32Array(0);
    expect(Array.from(order, (h) => tables.getRowId(h)).indexOf('p2')).toBe(30);
  });

  it('follow their rows to another layer written by apply, read there', () => {
    const { tables, writer, internals, at } = setup();
    internals.open('core:selection', ['p4']);
    writer.apply(patchOf(at('p4'), { layerId: 'other', order: 'k000000' }));
    expect(internals.getOpenedFeature('p4')?.layerId).toBe('other');
    expect(internals.placeOf(at('p4'))?.layer.layerId).toBe('other');
    expect(tables.get('layer')?.listRowHandles(0, 100).includes(at('p4'))).toBe(false);
    expect(Array.from(tables.get('other')?.listRowHandles(0, 10) ?? [])).toEqual([at('p4')]);
  });
});
