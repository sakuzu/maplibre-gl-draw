// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `draw.selection.scan`: every selected feature visited in stacking order as a row, over a Store
 * of objects and over features selected in bulk in a Store of rows, and the selection grouped and
 * ungrouped from the IDs it gives
 */

import { afterEach, describe, expect, it } from 'vitest';
import { DrawStore } from '../../store/draw-store.js';
import { TableContractStore } from '../../store/table-memory.js';
import { createMapStub } from '../../test-utils.js';
import type { Draw } from '../draw.js';
import { DrawError } from '../errors.js';
import { createDraw, createDrawOnEngine } from './create-draw.js';
import { createEngine } from './engine.js';

const draws: Draw[] = [];

afterEach(() => {
  for (const draw of draws.splice(0)) draw.destroy();
});

const point = (i: number) => ({
  type: 'Feature' as const,
  id: `f${i}`,
  geometry: { type: 'Point' as const, coordinates: [i, i / 2] },
  properties: { n: i },
});

/** A draw over a Store of rows that lists at most 5 IDs of a selection */
function rowsDraw(): Draw {
  const store = new DrawStore(new TableContractStore(), { selectionIdsLimit: 5 });
  store.createLayer({
    id: 'l',
    name: 'l',
    visible: true,
    locked: false,
    opacity: 1,
    kind: 'table',
    styleRule: undefined,
    metadata: undefined,
  });
  const engine = createEngine(
    createMapStub().map,
    { store, initDefaultLayer: false },
    { deferDefaultMode: true },
  );
  const draw = createDrawOnEngine(engine, { store, initDefaultLayer: false });
  engine.enterDefaultMode();
  draws.push(draw);
  return draw;
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'done';
  } catch (error) {
    if (error instanceof DrawError) return error.code;
    throw error;
  }
}

describe('draw.selection.scan', () => {
  it('visits the selected features of a Store of objects in the order selected, as rows', async () => {
    const draw = createDraw(createMapStub().map);
    draws.push(draw);
    await draw.write(async (tx) => {
      for (let i = 0; i < 4; i++) await tx.features.create(point(i));
    });
    draw.selection.set('feature', ['f2', 'f0']);
    const rows: Array<{ id: string; type: string; n: unknown; group: string | null }> = [];
    await draw.selection.scan((row) =>
      rows.push({ id: row.id, type: row.featureType, n: row.property('n'), group: row.groupId }),
    );
    expect(rows).toEqual([
      { id: 'f2', type: 'Point', n: 2, group: null },
      { id: 'f0', type: 'Point', n: 0, group: null },
    ]);
  });

  it('visits the features selected in bulk in a Store of rows, and groups and ungroups them', async () => {
    const draw = rowsDraw();
    await draw.write(async (tx) => {
      // More members than a group of rows takes one by one
      for (let i = 0; i < 2_010; i++)
        await tx.features.create({ ...point(i), properties: { n: i } });
    });
    draw.selection.setAll();
    expect(draw.selection.value.ids).toBeNull();
    const ids: string[] = [];
    const progress: number[] = [];
    await draw.selection.scan(
      (row) => {
        ids.push(row.id);
        expect(row.layerId).toBe('l');
        expect(row.visible).toBe(true);
        expect(row.locked).toBe(false);
        expect(row.toFeature()).toEqual(draw.features.get(row.id));
      },
      { onProgress: (p) => progress.push(p.done) },
    );
    const order = draw.layers.listItems('l', { limit: 10_000 });
    expect(ids).toEqual(order);
    expect(progress[progress.length - 1]).toBe(2_010);

    // Grouped from the IDs it gave, in one commit
    const group = await draw.write((tx) => tx.groups.create({ members: ids }));
    expect(draw.groups.count()).toBe(1);
    expect(draw.layers.listItems('l', { limit: 10 })).toEqual([group.id]);
    expect(draw.groups.listMembers(group.id, { limit: 10_000 })).toEqual(order);
    // Taken back and made again as one step
    await draw.undo();
    expect(draw.layers.listItems('l', { limit: 10_000 })).toEqual(order);
    await draw.redo();
    expect(draw.groups.listMembers(group.id, { limit: 10_000 })).toEqual(order);

    // Ungrouped from the groups of the rows it gives, the features kept
    draw.selection.setAll();
    const groupIds = new Set<string>();
    await draw.selection.scan((row) => {
      if (row.groupId !== null) groupIds.add(row.groupId);
    });
    expect([...groupIds]).toEqual([group.id]);
    await draw.write((tx) => tx.groups.delete([...groupIds], { members: 'keep' }));
    expect(draw.groups.count()).toBe(0);
    expect(draw.features.count()).toBe(2_010);
    expect(draw.layers.listItems('l', { limit: 10_000 })).toEqual(order);
  });

  it('fails with aborted once its signal stops it', async () => {
    const draw = createDraw(createMapStub().map);
    draws.push(draw);
    await draw.write((tx) => tx.features.create(point(1)));
    draw.selection.setAll();
    const controller = new AbortController();
    controller.abort();
    expect(await codeOf(draw.selection.scan(() => {}, { signal: controller.signal }))).toBe(
      'aborted',
    );
  });
});
