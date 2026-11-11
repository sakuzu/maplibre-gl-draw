// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A group of features hidden on this client (`draw.hidden`) in a layer held as rows: its rows are
 * not drawn and not hit, as the features of a group hidden are in a layer of objects, whatever
 * joins or leaves the group while it is hidden, until it is shown again
 */

import { afterEach, describe, expect, it } from 'vitest';
import { STATE_HIDDEN_MASK } from '../../feature-table/feature-row-states.js';
import { featureTablesInternals } from '../../feature-table/feature-tables.js';
import { createTableStore } from '../../store/table-memory.js';
import { writesOf } from '../../test-support/writes.js';
import { createMapStub } from '../../test-utils.js';
import type { Draw } from '../draw.js';
import type { FeatureTables } from '../tables.js';
import { createDrawOnEngine } from './create-draw.js';
import { createEngine } from './engine.js';

let draw: Draw | undefined;

afterEach(() => {
  draw?.destroy();
  draw = undefined;
});

function open(): { draw: Draw; tables: FeatureTables } {
  const { store } = createTableStore();
  const engine = createEngine(
    createMapStub().map,
    { store, initDefaultLayer: false },
    { deferDefaultMode: true },
  );
  draw = createDrawOnEngine(engine, { store, initDefaultLayer: false });
  engine.enterDefaultMode();
  writesOf(draw).layers.create({ id: 'l', name: 'l' });
  for (const [i, id] of ['a', 'b', 'c', 'd'].entries()) {
    writesOf(draw).features.create({
      id,
      type: 'Point',
      geometry: { type: 'Point', coordinates: [i, 0] },
      layerId: 'l',
    });
  }
  writesOf(draw).groups.create({ id: 'g', name: 'g', featureIds: ['b', 'c'] });
  return { draw, tables: draw.getStore().tables as FeatureTables };
}

/** The ids of the rows the layer draws */
function drawn(tables: FeatureTables): string[] {
  return Array.from(tables.get('l')?.listDrawnRows([-10, -10, 10, 10]) ?? []).map(
    (handle) => tables.getRowId(handle) as string,
  );
}

/** Whether the copy of the state of the row of an id is hidden (as the drawing reads it) */
function hiddenInState(tables: FeatureTables, id: string): boolean {
  const internals = featureTablesInternals(tables);
  const place = internals?.placeOf(tables.getRowRef(id) as number);
  if (!place) throw new Error(`no row ${id}`);
  return (place.group.state[place.row] & STATE_HIDDEN_MASK) !== 0;
}

describe('a group hidden on this client in a layer held as rows', () => {
  it('hides its rows from the drawing and the reads of the rows drawn, until it is shown again', () => {
    const { draw, tables } = open();
    expect(drawn(tables)).toEqual(['a', 'b', 'c', 'd']);
    draw.hidden.add('g');
    expect(drawn(tables)).toEqual(['a', 'd']);
    expect(hiddenInState(tables, 'b')).toBe(true);
    expect(hiddenInState(tables, 'a')).toBe(false);
    draw.hidden.remove('g');
    expect(drawn(tables)).toEqual(['a', 'b', 'c', 'd']);
    expect(hiddenInState(tables, 'b')).toBe(false);
  });

  it('hides a row that joins it while it is hidden, and shows a row that leaves it', () => {
    const { draw, tables } = open();
    draw.hidden.add('g');
    expect(writesOf(draw).features.move('d', { layerId: 'l', groupId: 'g', above: null })).toBe(
      true,
    );
    expect(writesOf(draw).features.move('c', { layerId: 'l', above: null })).toBe(true);
    expect(writesOf(draw).features.get('d')?.groupId).toBe('g');
    expect(writesOf(draw).features.get('c')?.groupId).toBeUndefined();
    expect(drawn(tables).sort()).toEqual(['a', 'c']);
    draw.hidden.remove('g');
    expect(drawn(tables).sort()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('leaves the hidden ids with the group deleted: restored or created again, it is shown', () => {
    const { draw, tables } = open();
    draw.hidden.add('g');
    writesOf(draw).groups.delete('g');
    expect(draw.hidden.has('g')).toBe(false);
    expect(drawn(tables)).toEqual(['a', 'b', 'c', 'd']);
    writesOf(draw).groups.restore('g');
    expect(draw.groups.has('g')).toBe(true);
    expect(draw.hidden.has('g')).toBe(false);
    expect(drawn(tables)).toEqual(['a', 'b', 'c', 'd']);
    writesOf(draw).groups.delete('g');
    writesOf(draw).groups.create({ id: 'g', name: 'g', featureIds: ['a', 'd'] });
    expect(hiddenInState(tables, 'a')).toBe(false);
    draw.hidden.add('g');
    expect(drawn(tables).sort()).toEqual(['b', 'c']);
  });
});
