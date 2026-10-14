// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `draw.tables.applyRows`: the writes of rows of this client through the gate of the instance,
 * with the values before, which written back put the rows back (11.7 and 13.5 of the design); and
 * the writes of `draw.features` of rows that are not selected, notified with the values before,
 * undone by writing them back.
 */

import { afterEach, describe, expect, it } from 'vitest';
import type { Store } from '../../store/store.js';
import { createTableMemoryStore } from '../../store/table-memory.js';
import type { Feature, RowValuesSnapshot, StoreChange } from '../../store/types.js';
import { createMapStub } from '../../test-utils.js';
import type { Draw } from '../draw.js';
import type { FeatureTables, RowField } from '../tables.js';
import { createDrawOnEngine } from './create-draw.js';
import { createEngine } from './engine.js';

let draw: Draw | undefined;

afterEach(() => {
  draw?.destroy();
  draw = undefined;
});

function point(id: string, x: number): Feature {
  return {
    id,
    type: 'Point',
    geometry: { type: 'Point', coordinates: [x, 0] },
    layerId: 'rows',
    groupId: undefined,
    properties: { n: x },
    style: {},
    visible: true,
    locked: false,
  };
}

function drawOn(store: Store): Draw {
  const engine = createEngine(
    createMapStub().map,
    { store, initDefaultLayer: false },
    { deferDefaultMode: true },
  );
  draw = createDrawOnEngine(engine, { store, initDefaultLayer: false });
  engine.enterDefaultMode();
  return draw;
}

function setup() {
  const { store } = createTableMemoryStore();
  store.createLayer({
    id: 'rows',
    name: 'rows',
    visible: true,
    locked: false,
    opacity: 1,
    kind: 'table',
    styleRule: undefined,
    metadata: undefined,
  });
  for (let i = 0; i < 4; i++) store.createFeature(point(`p${i}`, i));
  const tables = store.tables as FeatureTables;
  const instance = drawOn(store);
  const notified: StoreChange[] = [];
  instance.getStore().subscribe((change) => notified.push(change));
  return { draw: instance, tables, notified };
}

/** The rows as features, in their order */
function rowsOf(instance: Draw, tables: FeatureTables): Feature[] {
  const view = tables.layer('rows');
  return Array.from(view?.rowsInOrder(0, 100) ?? [], (handle) => tables.idOf(handle) as string)
    .filter((id) => tables.handleOf(id) !== undefined)
    .map((id) => instance.getStore().getFeature(id) as Feature);
}

describe('draw.tables.applyRows', () => {
  it('writes the rows, notifies the values before and returns them', () => {
    const { draw, tables, notified } = setup();
    const start = rowsOf(draw, tables);
    const handles = Int32Array.from(['p1', 'p2'], (id) => tables.handleOf(id) as number);
    const before = draw.tables.applyRows({
      handles,
      fields: new Map<RowField, unknown[]>([
        ['style', [{ pointColor: '#ff0000' }, { pointColor: '#00ff00' }]],
        ['property:n', [10, 20]],
      ]),
    });
    expect(before?.fields.get('property:n')).toEqual([1, 2]);
    expect(notified[notified.length - 1].rows?.before).toBe(before);
    expect(draw.getStore().getFeature('p2')?.properties).toEqual({ n: 20 });
    // Written back
    draw.tables.applyRows(before as RowValuesSnapshot);
    expect(rowsOf(draw, tables)).toEqual(start);
  });

  it('brings back a row deleted where it was', () => {
    const { draw, tables, notified } = setup();
    const start = rowsOf(draw, tables);
    expect(draw.features.delete('p1')).toBe(true);
    const before = notified[notified.length - 1].rows?.before as RowValuesSnapshot;
    expect(Array.from(before.deleted ?? [])).toEqual([0]);
    draw.tables.applyRows(before);
    expect(rowsOf(draw, tables)).toEqual(start);
  });

  it('is refused while read-only', () => {
    const { draw, tables } = setup();
    draw.setReadOnly(true);
    const handle = tables.handleOf('p1') as number;
    expect(
      draw.tables.applyRows({
        handles: Int32Array.of(handle),
        fields: new Map([['visible', [false]]]),
      }),
    ).toBeNull();
    expect(draw.getStore().getFeature('p1')?.visible).toBe(true);
  });

  it('throws on a patch of the wrong shape or a handle of no row, writing nothing', () => {
    const { draw, tables, notified } = setup();
    const handle = tables.handleOf('p1') as number;
    const count = notified.length;
    const call = (patch: unknown) => () =>
      draw.tables.applyRows(patch as Parameters<Draw['tables']['applyRows']>[0]);
    expect(call(null)).toThrow(expect.objectContaining({ code: 'invalid-input' }));
    expect(call({ handles: [handle], fields: new Map() })).toThrow(
      expect.objectContaining({ code: 'invalid-input' }),
    );
    expect(call({ handles: Int32Array.of(handle), fields: new Map([['visible', []]]) })).toThrow(
      expect.objectContaining({ code: 'invalid-input' }),
    );
    expect(call({ handles: Int32Array.of(handle), fields: new Map([['size', [1]]]) })).toThrow(
      expect.objectContaining({ code: 'invalid-input' }),
    );
    expect(
      call({ handles: Int32Array.of(handle), fields: new Map(), deleted: Uint8Array.of(1, 1) }),
    ).toThrow(expect.objectContaining({ code: 'invalid-input' }));
    expect(call({ handles: Int32Array.of(9999), fields: new Map() })).toThrow(
      expect.objectContaining({ code: 'not-found' }),
    );
    expect(notified).toHaveLength(count);
  });

  it('throws invalid-state on a Store of objects, and after destroy', () => {
    const instance = drawOn(createTableMemoryStore().store);
    instance.destroy();
    expect(() =>
      instance.tables.applyRows({ handles: new Int32Array(0), fields: new Map() }),
    ).toThrow(expect.objectContaining({ code: 'invalid-state' }));
    draw = undefined;
    const objects = drawOn(undefined as unknown as Store);
    expect(() =>
      objects.tables.applyRows({ handles: new Int32Array(0), fields: new Map() }),
    ).toThrow(expect.objectContaining({ code: 'invalid-state' }));
  });
});

describe('the writes of draw.features of rows that are not selected', () => {
  it('are notified with the values before, and undone by writing them back', () => {
    const { draw, tables, notified } = setup();
    // A history of the writes of this client
    const steps: RowValuesSnapshot[] = [];
    draw.getStore().subscribe((change) => {
      if (change.source === 'local' && change.rows?.before) steps.push(change.rows.before);
    });
    const start = rowsOf(draw, tables);
    expect(draw.selection.get().ids).toEqual([]);
    draw.features.update('p2', {
      geometry: { type: 'Point', coordinates: [7, 7] },
      properties: { n: 70 },
      style: { pointColor: '#123456' },
    });
    const change = notified[notified.length - 1];
    expect(change.features?.updated ?? []).toEqual([]);
    expect(Array.from(change.rows?.layers.get('rows')?.updated ?? [])).toEqual([
      tables.handleOf('p2'),
    ]);
    draw.features.update('p3', { visible: false });
    expect(steps).toHaveLength(2);
    // Undone, the last first
    for (const step of [...steps].reverse()) {
      draw.transact(() => draw.tables.applyRows(step), { source: 'history' });
    }
    expect(rowsOf(draw, tables)).toEqual(start);
  });
});
