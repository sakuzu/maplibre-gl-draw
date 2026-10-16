// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Many features deleted over an in-memory Store of rows, one write after the other: the walk of
 * the order that finds the item just below and above each one passes the rows deleted before it
 * together (`RowSkips`), so it reads a few rows per feature, not every row deleted before it; and
 * the items it finds are the ones next to the feature among the rows not deleted, in a group of
 * the order and in the delta of the layer, after a deletion is undone too
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { LayerTable } from '../../feature-table/layer-table.js';
import { RowSkips } from '../../feature-table/row-skips.js';
import { createTableStore } from '../../store/table-memory.js';
import type { ItemMove } from '../../store/types.js';
import { createMapStub } from '../../test-utils.js';
import type { Draw } from '../draw.js';
import type { DocumentChange } from '../events.js';
import type { FeatureValues } from '../model.js';
import { createDrawOnEngine } from './create-draw.js';
import { createEngine } from './engine.js';

const instances: Draw[] = [];

/** An instance over a new Store of rows with a layer of `n` points */
function instance(n: number): { draw: Draw; ids: string[] } {
  const { store } = createTableStore();
  const engine = createEngine(
    createMapStub().map,
    { store, initDefaultLayer: false },
    { deferDefaultMode: true },
  );
  const draw = createDrawOnEngine(engine, { store, initDefaultLayer: false });
  instances.push(draw);
  draw.layers.create({ id: 'a', name: 'a' });
  const ids = Array.from({ length: n }, (_, i) => `f${i}`);
  draw.features.createMany(
    ids.map((id, i) => ({
      id,
      type: 'Point',
      layerId: 'a',
      geometry: { type: 'Point', coordinates: [i * 0.0001, 0] },
    })),
  );
  return { draw, ids };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const draw of instances.splice(0)) draw.destroy();
});

/** Deletes features one write at a time, and the items just below and above each one then */
function deleteEach(draw: Draw, ids: readonly string[]): Array<[string | null, string | null]> {
  const around: Array<[string | null, string | null]> = [];
  const off = draw.on('document.changed', (change: DocumentChange) => {
    for (const move of change.order ?? []) {
      if (move.kind === 'item' && move.to === null && move.from) {
        around.push([move.from.below, move.from.above]);
      }
    }
  });
  for (const id of ids) draw.features.delete(id);
  off();
  return around;
}

describe('features deleted over a Store of rows', () => {
  it('reads a few rows of the order per feature deleted, not the rows deleted before it', () => {
    for (const reversed of [false, true]) {
      const n = 2000;
      const { draw, ids } = instance(n);
      const previous = vi.spyOn(LayerTable.prototype, 'previousRow');
      const next = vi.spyOn(LayerTable.prototype, 'nextRow');
      const down = vi.spyOn(RowSkips.prototype, 'lastAtOrBefore');
      const up = vi.spyOn(RowSkips.prototype, 'firstAtOrAfter');
      expect(draw.features.deleteMany(reversed ? [...ids].reverse() : ids)).toBe(true);
      expect(draw.features.count({ layerId: 'a' })).toBe(0);
      // Each deleted row passed one at a time would be about n * n / 2 rows
      expect(previous.mock.calls.length + next.mock.calls.length).toBeLessThanOrEqual(4 * n);
      const skips = new Set([...down.mock.contexts, ...up.mock.contexts] as RowSkips[]);
      const steps = [...skips].reduce((sum, skip) => sum + skip.steps, 0);
      expect(steps).toBeLessThanOrEqual(4 * n);
      vi.restoreAllMocks();
    }
  });

  it('finds the items next to each feature deleted among the rows not deleted', () => {
    // 200 rows are built into a group of the order, 20 stay in the delta of the layer
    for (const n of [200, 20]) {
      const { draw, ids } = instance(n);
      // Every other one, from the front, then the rest from the back
      const first = ids.filter((_, i) => i % 2 === 1).reverse();
      const around = deleteEach(draw, first);
      first.forEach((id, k) => {
        const i = Number(id.slice(1));
        expect(around[k]).toEqual([`f${i - 1}`, i + 1 < n ? `f${i + 1}` : null]);
      });
      const rest = ids.filter((_, i) => i % 2 === 0);
      const last = deleteEach(draw, rest);
      rest.forEach((_, k) => {
        expect(last[k]).toEqual([null, rest[k + 1] ?? null]);
      });
    }
  });

  it('reads again the rows of a deletion undone', () => {
    for (const n of [200, 20]) {
      const { draw, ids } = instance(n);
      const steps: FeatureValues[] = [];
      const off = draw.on('document.changed', (change: DocumentChange) => {
        if (change.previousValues) steps.push(change.previousValues as FeatureValues);
      });
      // One at a time, so that the walks pass the rows deleted before; then undone, the last first
      deleteEach(draw, ids.slice(1, n - 1));
      off();
      while (steps.length > 0) {
        draw.transact(() => draw.features.restore(steps.pop() as FeatureValues), {
          ignoreLocks: true,
        });
      }
      expect(draw.features.count({ layerId: 'a' })).toBe(n);
      // The rows back are read: the one deleted next stands between the ones next to it
      const around = deleteEach(draw, [`f${n >> 1}`]);
      expect(around).toEqual([[`f${(n >> 1) - 1}`, `f${(n >> 1) + 1}`]]);
      const moves: ItemMove[] = [];
      draw.on('document.changed', (change: DocumentChange) => {
        for (const move of change.order ?? []) if (move.kind === 'item') moves.push(move);
      });
      draw.features.delete(`f${(n >> 1) + 1}`);
      expect(moves[0]?.from).toMatchObject({
        below: `f${(n >> 1) - 1}`,
        above: `f${(n >> 1) + 2}`,
      });
    }
  });
});
