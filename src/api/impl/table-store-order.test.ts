// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The order of the items of an instance over an in-memory Store of rows: the moves, the groups
 * made and undone, the features taken out of a group and the results of the geometry operations
 * put where their inputs were, through the public API, by the items around a place
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { featureTablesInternals } from '../../feature-table/feature-tables.js';
import type { Store } from '../../store/store.js';
import { createTableStore } from '../../store/table-memory.js';
import type { Feature } from '../../store/types.js';
import { writesOf } from '../../test-support/writes.js';
import { createMapStub } from '../../test-utils.js';
import type { Draw } from '../draw.js';
import { DrawError } from '../errors.js';
import { createDrawOnEngine } from './create-draw.js';
import type { Engine } from './engine.js';
import { createEngine } from './engine.js';

let engine: Engine;
let draw: Draw;
let store: Store;

function square(id: string, x: number, layerId = 'rows'): Feature {
  return {
    id,
    type: 'Polygon',
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [x, 0],
          [x + 1, 0],
          [x + 1, 1],
          [x, 1],
          [x, 0],
        ],
      ],
    },
    layerId,
    groupId: undefined,
    properties: {},
    style: {},
    visible: true,
    locked: false,
  };
}

/** The ids of the items of a layer, in their order (a group as its id) */
function items(layerId = 'rows'): string[] {
  const tables = store.tables;
  const view = tables?.get(layerId);
  if (!tables || !view) return [];
  const refs = view.listItems(0, view.itemCount);
  const groups = featureTablesInternals(tables)?.groups;
  return Array.from(refs.handles, (h, i) =>
    refs.kinds[i] === 0 ? (tables.getRowId(h) as string) : (groups?.idOf(h) as string),
  );
}

/** The ids of the members of a group, in their order */
function members(groupId: string): string[] {
  const tables = store.tables;
  const group = store.getGroup(groupId);
  const handle = featureTablesInternals(tables)?.groups.handleOfId(groupId) ?? -1;
  const view = group && tables?.get(group.layerId);
  if (!tables || !view || handle < 0) return [];
  return Array.from(view.listGroupMembers(handle, 0, view.countGroupMembers(handle)), (h) =>
    tables.getRowId(h),
  ) as string[];
}

beforeEach(() => {
  vi.useFakeTimers();
  store = createTableStore().store;
  for (const id of ['rows', 'other']) {
    store.createLayer({
      id,
      name: id,
      visible: true,
      locked: false,
      opacity: 1,
      kind: 'table',
      styleRule: undefined,
      metadata: undefined,
    });
  }
  for (let i = 0; i < 5; i++) store.createFeature(square(`s${i}`, i * 2));
  engine = createEngine(
    createMapStub().map,
    { store, initDefaultLayer: false },
    { deferDefaultMode: true },
  );
  draw = createDrawOnEngine(engine, { store, initDefaultLayer: false });
  engine.enterDefaultMode();
});

afterEach(() => {
  draw.destroy();
  vi.useRealTimers();
});

describe('the moves of features held as rows', () => {
  it('put features just above an item, just below one, at the front, and in another layer', () => {
    expect(writesOf(draw).features.move('s0', { layerId: 'rows', below: 's2' })).toBe(true);
    expect(items()).toEqual(['s1', 's2', 's0', 's3', 's4']);
    expect(writesOf(draw).features.moveMany(['s3', 's4'], { layerId: 'rows', above: 's1' })).toBe(
      true,
    );
    expect(items()).toEqual(['s3', 's4', 's1', 's2', 's0']);
    expect(writesOf(draw).features.move('s3', { layerId: 'rows' })).toBe(true);
    expect(items()).toEqual(['s4', 's1', 's2', 's0', 's3']);
    expect(writesOf(draw).features.move('s1', { layerId: 'other' })).toBe(true);
    expect(items('other')).toEqual(['s1']);
    expect(store.getFeature('s1')?.layerId).toBe('other');
  });

  it('refuses a position by index in a layer held as rows, as a refusal of its state', () => {
    expect(() => writesOf(draw).features.move('s0', { layerId: 'rows', index: 2 })).toThrow(
      DrawError,
    );
    expect(() => writesOf(draw).features.move('s0', { layerId: 'rows', index: 2 })).toThrow(
      expect.objectContaining({ code: 'invalidState' }),
    );
    expect(items()).toEqual(['s0', 's1', 's2', 's3', 's4']);
  });

  it('makes a group at the place of its frontmost member, and moves it with its members', () => {
    const group = writesOf(draw).groups.create({ members: ['s3', 's1'] });
    expect(items()).toEqual(['s0', 's2', group?.id, 's4']);
    expect(members(group?.id as string)).toEqual(['s1', 's3']);
    expect(writesOf(draw).groups.move(group?.id as string, { layerId: 'other' })).toBe(true);
    expect(items('other')).toEqual([group?.id]);
    expect(store.getFeature('s1')?.layerId).toBe('other');
    expect(members(group?.id as string)).toEqual(['s1', 's3']);
  });

  it('groups the selection at its frontmost feature, and ungroups it at the place of the group', () => {
    draw.selection.set('feature', ['s1', 's3']);
    const group = writesOf(draw).selection.group();
    expect(items()).toEqual(['s0', 's2', group?.id, 's4']);
    draw.selection.set('group', [group?.id as string]);
    expect(writesOf(draw).selection.ungroup()).toBe(true);
    expect(store.getGroup(group?.id as string)).toBeUndefined();
    expect(items()).toEqual(['s0', 's2', 's1', 's3', 's4']);
  });

  it('takes a member out of its group just in front of it, and deletes the group it leaves empty', () => {
    const group = writesOf(draw).groups.create({ members: ['s1', 's2'] })?.id as string;
    expect(items()).toEqual(['s0', group, 's3', 's4']);
    writesOf(draw).features.move('s1', { groupId: null });
    expect(items()).toEqual(['s0', group, 's1', 's3', 's4']);
    writesOf(draw).features.move('s2', { groupId: null });
    expect(store.getGroup(group)).toBeUndefined();
    expect(items()).toEqual(['s0', 's2', 's1', 's3', 's4']);
  });

  it('puts features into a group just above a member', () => {
    const group = writesOf(draw).groups.create({ members: ['s1', 's2'] })?.id as string;
    writesOf(draw).features.move('s4', { layerId: 'rows', groupId: group, below: 's1' });
    expect(members(group)).toEqual(['s1', 's4', 's2']);
    expect(store.getFeature('s4')?.groupId).toBe(group);
  });

  it('puts the result of a union where its frontmost input was', () => {
    const result = writesOf(draw).features.union(['s1', 's3']);
    expect(result).not.toBeNull();
    expect(items()).toEqual(['s0', 's2', result?.id, 's4']);
  });
});
