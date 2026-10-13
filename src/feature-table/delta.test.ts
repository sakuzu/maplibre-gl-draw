// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The rows of a layer changed since their row groups were built (the delta)
 *
 * - A row placed elsewhere in the order (its key, its group of features, its type) goes to the
 *   delta of its layer, and is read there at its new place; its copy in its group is hidden and
 *   not read
 * - A row moved to another layer goes to the delta of that layer
 * - A new row (a handle without a row, with its type, layer, geometry and key) goes to the delta
 * - A row of the delta written again is written in place there, with the number of the change
 * - What the drawing could not write into its place goes to the delta as it is
 * - The change written is returned by layer
 * - Writes of every kind at random, applied to the tables and to a reference sorted by the keys:
 *   every read of the tables gives the reference (14.2 of the design, the delta)
 */

import type { Geometry } from 'geojson';
import { describe, expect, it } from 'vitest';
import type { RowField, RowPatch } from '../api/tables.js';
import { createRowGroupBuilder } from '../table/row-group-builder.js';
import { utf8ColumnFromStrings } from '../table/utf8-column.js';
import {
  expectTablesMatch,
  type ReferenceRow,
  ReferenceRows,
  seededRandom,
} from '../test-utils.js';
import { createFeatureTablesStore, featureTablesInternals } from './feature-tables.js';
import { STATE_HIDDEN_DELTA } from './row-state.js';

/** A patch of rows */
function patchOf(
  handles: number[],
  fields: Record<string, unknown[]>,
  deleted?: number[],
): RowPatch {
  return {
    handles: Int32Array.from(handles),
    fields: new Map(Object.entries(fields) as Array<[RowField, unknown[]]>),
    deleted: deleted ? Uint8Array.from(deleted) : undefined,
  };
}

/** The key of the order of a number (they sort as the numbers do) */
const key = (n: number): string => `k${String(Math.floor(n)).padStart(7, '0')}`;

/** Tables of the rows of a reference, in row groups of `targetRows` */
function tablesOf(reference: ReferenceRows, layerIds: readonly string[], targetRows = 8) {
  const { tables, writer } = createFeatureTablesStore();
  const internals = featureTablesInternals(tables);
  if (!internals) throw new Error('no internals');
  const groupHandles = new Map<string, number>();
  for (const [id, group] of reference.groups) {
    const handle = groupHandles.size + 100;
    groupHandles.set(id, handle);
    internals.groups.set(handle, {
      id,
      order: group.order,
      layerId: group.layerId,
      visible: true,
      locked: false,
    });
  }
  const groupKeys = [...reference.groups].map(([id, group]) => ({
    handle: groupHandles.get(id) as number,
    id,
    order: group.order,
  }));
  for (const layerId of layerIds) {
    const builder = createRowGroupBuilder({ groups: groupKeys, targetRows });
    for (const row of reference.rows.values()) {
      if (row.layerId !== layerId) continue;
      builder.addRow({
        id: row.id,
        type: row.type,
        geometry: row.geometry,
        order: row.order,
        member: row.groupId !== undefined ? row.member : undefined,
        group: row.groupId !== undefined ? groupHandles.get(row.groupId) : undefined,
        style: row.style,
        properties: row.properties,
        visible: row.visible,
        locked: row.locked,
        deleted: row.deleted,
      });
    }
    if (builder.length > 0) writer.adopt(layerId, builder.finish());
  }
  internals.flushAdoption();
  const groupHandleOf = (id: string): number => groupHandles.get(id) as number;
  return { tables, writer, internals, groupHandleOf };
}

/** A geometry at random */
function geometryAt(random: () => number, type: string): Geometry {
  const x = random() * 10;
  const y = random() * 10;
  if (type === 'Point') return { type: 'Point', coordinates: [x, y] };
  if (type === 'LineString') {
    const n = 2 + Math.floor(random() * 4);
    return {
      type: 'LineString',
      coordinates: Array.from({ length: n }, (_, k) => [x + k * 0.1, y + random() * 0.1]),
    };
  }
  const n = 3 + Math.floor(random() * 4);
  const ring = Array.from({ length: n }, (_, k) => {
    const a = (k / n) * Math.PI * 2;
    return [x + Math.cos(a), y + Math.sin(a)];
  });
  ring.push(ring[0]);
  return { type: 'Polygon', coordinates: [ring] };
}

const TYPES = ['Point', 'LineString', 'Polygon'];

/** A row of the reference at random */
function randomRow(random: () => number, id: string, layerId: string): ReferenceRow {
  const type = TYPES[Math.floor(random() * TYPES.length)];
  return {
    id,
    layerId,
    type,
    geometry: geometryAt(random, type),
    order: key(random() * 1e6),
    groupId: undefined,
    member: '',
    style: { strokeColor: '#ff0000' },
    properties: { n: Math.floor(random() * 100) },
    visible: true,
    locked: false,
    deleted: false,
  };
}

/** A reference of `count` rows over layers, with two groups of features */
function referenceOf(random: () => number, count: number, layerIds: readonly string[]) {
  const reference = new ReferenceRows();
  reference.groups.set('ga', { order: key(250_000), layerId: layerIds[0], visible: true });
  reference.groups.set('gb', { order: key(750_000), layerId: layerIds[0], visible: true });
  for (let i = 0; i < count; i++) {
    const row = randomRow(random, `r${i}`, layerIds[i % layerIds.length]);
    if (row.layerId === layerIds[0] && i % 7 === 0) {
      row.groupId = i % 2 === 0 ? 'ga' : 'gb';
      row.member = key(random() * 1e6);
    }
    reference.rows.set(row.id, row);
  }
  return reference;
}

describe('the delta of a layer', () => {
  it('reads a row placed elsewhere in the order at its new place, and hides its copy', () => {
    const random = seededRandom(1);
    const reference = referenceOf(random, 60, ['a']);
    const { tables, writer, internals, groupHandleOf } = tablesOf(reference, ['a']);
    const row = reference.rows.get('r10') as ReferenceRow;
    const handle = tables.handleOf('r10') as number;
    const before = internals.placeOf(handle);
    writer.apply(patchOf([handle], { order: [key(999_999)] }));
    row.order = key(999_999);
    expectTablesMatch(tables, reference, ['a'], groupHandleOf);
    expect(internals.deltaRowCount()).toBe(1);
    expect(internals.placeOf(handle)?.group.delta).toBe(true);
    // The copy in its group is hidden from the drawing and the readers
    expect(before && (before.group.state[before.row] & STATE_HIDDEN_DELTA) !== 0).toBe(true);
    expect(tables.layer('a')?.listDrawnRows([-100, -100, 100, 100]).includes(handle)).toBe(true);
    const drawn = Array.from(tables.layer('a')?.listDrawnRows([-100, -100, 100, 100]) ?? []);
    expect(drawn.filter((h) => h === handle)).toHaveLength(1);
  });

  it('reads a row moved to another layer there, and a new row at its place', () => {
    const random = seededRandom(2);
    const reference = referenceOf(random, 40, ['a', 'b']);
    const { tables, writer, internals, groupHandleOf } = tablesOf(reference, ['a', 'b']);
    const moved = tables.handleOf('r3') as number;
    writer.apply(patchOf([moved], { layerId: ['b'], order: [key(10)] }));
    Object.assign(reference.rows.get('r3') as ReferenceRow, { layerId: 'b', order: key(10) });
    const [fresh] = writer.allocateHandles(utf8ColumnFromStrings(['new']));
    const geometry: Geometry = { type: 'Point', coordinates: [1, 2] };
    const change = writer.apply(
      patchOf([fresh], {
        type: ['Point'],
        layerId: ['a'],
        geometry: [geometry],
        order: [key(500_000)],
      }),
    );
    reference.rows.set('new', {
      ...randomRow(random, 'new', 'a'),
      type: 'Point',
      geometry,
      order: key(500_000),
      style: {},
      properties: {},
    });
    expectTablesMatch(tables, reference, ['a', 'b'], groupHandleOf);
    expect(Array.from(change.layers.get('a')?.created ?? [])).toEqual([fresh]);
    expect(internals.deltaRowCount()).toBe(2);
  });

  it('writes a row of the delta in place there, with the number of the change', () => {
    const random = seededRandom(3);
    const reference = referenceOf(random, 30, ['a']);
    const { tables, writer, internals } = tablesOf(reference, ['a']);
    const handle = tables.handleOf('r5') as number;
    writer.apply(patchOf([handle], { order: [key(1)] }));
    const delta = internals.layerTable('a')?.delta;
    const slot = internals.ids.deltaSlot(handle);
    const first = delta?.writtenOf(slot) ?? -1;
    const group = delta?.group;
    const revision = delta?.revision;
    const writes: unknown[] = [];
    internals.onRowsWritten((_layer, list) => writes.push(...list));
    writer.apply(
      patchOf([handle], { 'property:name': ['written'], style: [{ pointColor: '#00ff00' }] }),
    );
    // In place: the rows of the delta are not made again
    expect(delta?.group).toBe(group);
    expect(delta?.revision).toBe(revision);
    expect(delta?.writtenOf(slot)).toBeGreaterThan(first);
    expect(tables.layer('a')?.valueAt(handle, 'name')).toBe('written');
    expect(writes).toHaveLength(1);
    expect((writes[0] as { group: number }).group).toBe(delta?.handle);
  });

  it('puts rows the drawing could not write into their places into the delta as they are', () => {
    const random = seededRandom(4);
    const reference = referenceOf(random, 30, ['a']);
    const { tables, internals, groupHandleOf } = tablesOf(reference, ['a']);
    const handles = ['r1', 'r2', 'r20'].map((id) => tables.handleOf(id) as number);
    internals.toDelta(handles);
    expect(internals.deltaRowCount()).toBe(3);
    expectTablesMatch(tables, reference, ['a'], groupHandleOf);
  });

  it('returns what it wrote by layer: the rows, the fields and the keys of the styles', () => {
    const random = seededRandom(5);
    const reference = referenceOf(random, 20, ['a', 'b']);
    const { tables, writer } = tablesOf(reference, ['a', 'b']);
    const a = tables.handleOf('r0') as number;
    const b = tables.handleOf('r1') as number;
    const change = writer.apply(
      patchOf(
        [a, b],
        { style: [{ strokeColor: '#00ff00' }, { strokeColor: '#ff0000', fillColor: '#000000' }] },
        [0, 1],
      ),
    );
    expect(Array.from(change.layers.get('a')?.updated ?? [])).toEqual([a]);
    expect(Array.from(change.layers.get('b')?.deleted ?? [])).toEqual([b]);
    expect([...(change.layers.get('a')?.styleKeys ?? [])]).toEqual(['strokeColor']);
    expect([...(change.layers.get('b')?.styleKeys ?? [])]).toEqual(['fillColor']);
    expect([...(change.layers.get('a')?.fields ?? [])]).toEqual(['style']);
  });

  it('reads every row as the reference after writes of every kind at random', () => {
    for (const seed of [11, 12, 13, 14]) {
      const random = seededRandom(seed);
      const layerIds = ['a', 'b'];
      const reference = referenceOf(random, 80, layerIds);
      const { tables, writer, internals, groupHandleOf } = tablesOf(reference, layerIds);
      let created = 0;
      for (let step = 0; step < 150; step++) {
        const ids = [...reference.rows.values()].filter((row) => !row.deleted).map((row) => row.id);
        const id = ids[Math.floor(random() * ids.length)];
        const row = reference.rows.get(id) as ReferenceRow;
        const handle = tables.handleOf(id) as number;
        const pick = random();
        if (pick < 0.15) {
          const geometry = geometryAt(random, row.type);
          writer.apply(patchOf([handle], { geometry: [geometry] }));
          row.geometry = geometry;
        } else if (pick < 0.25) {
          const style = {
            strokeColor: `#${Math.floor(random() * 0xffffff)
              .toString(16)
              .padStart(6, '0')}`,
          };
          writer.apply(patchOf([handle], { style: [style] }));
          row.style = style;
        } else if (pick < 0.35) {
          const value = random() < 0.3 ? undefined : `v${step}`;
          writer.apply(patchOf([handle], { 'property:name': [value] }));
          if (value === undefined) delete row.properties.name;
          else row.properties = { ...row.properties, name: value };
        } else if (pick < 0.5) {
          const order = key(random() * 1e6);
          writer.apply(patchOf([handle], { order: [order] }));
          row.order = order;
        } else if (pick < 0.6) {
          const layerId = layerIds[Math.floor(random() * layerIds.length)];
          const order = key(random() * 1e6);
          writer.apply(
            patchOf([handle], {
              layerId: [layerId],
              order: [order],
              groupId: [undefined],
              member: [undefined],
            }),
          );
          Object.assign(row, { layerId, order, groupId: undefined, member: '' });
        } else if (pick < 0.68 && row.layerId === 'a') {
          const groupId = random() < 0.5 ? 'ga' : 'gb';
          const member = key(random() * 1e6);
          writer.apply(patchOf([handle], { groupId: [groupId], member: [member] }));
          Object.assign(row, { groupId, member });
        } else if (pick < 0.78) {
          const id2 = `n${created++}`;
          const [fresh] = writer.allocateHandles(utf8ColumnFromStrings([id2]));
          const next = randomRow(random, id2, layerIds[Math.floor(random() * layerIds.length)]);
          writer.apply(
            patchOf([fresh], {
              type: [next.type],
              layerId: [next.layerId],
              geometry: [next.geometry],
              order: [next.order],
              style: [next.style],
              'property:n': [next.properties.n],
            }),
          );
          reference.rows.set(id2, next);
        } else if (pick < 0.85) {
          writer.apply(patchOf([handle], {}, [1]));
          row.deleted = true;
        } else if (pick < 0.92) {
          internals.toDelta([handle]);
        } else {
          writer.apply(patchOf([handle], { visible: [!row.visible] }));
          row.visible = !row.visible;
        }
        if (step % 10 === 9) expectTablesMatch(tables, reference, layerIds, groupHandleOf);
      }
      expectTablesMatch(tables, reference, layerIds, groupHandleOf);
      expect(internals.deltaRowCount()).toBeGreaterThan(20);
    }
  });
});
