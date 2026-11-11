// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A write from elsewhere applied while writes of this client are queued (a commit of
 * `draw.write`, the rest of a write over several tasks): the writes of this client are not made
 * inside it, and each is told with its own source, after it
 */

import { afterEach, describe, expect, it } from 'vitest';
import type { Draw } from '../api/draw.js';
import { createDraw } from '../api/draw.js';
import { TableSelection } from '../feature-table/selection.js';
import { writeKindsInSlices } from '../operations/bulk-sliced.js';
import { writesOf } from '../test-support/writes.js';
import { createMapStub } from '../test-utils.js';
import { createTableStore } from './table-memory.js';

const draws: Draw[] = [];

afterEach(() => {
  for (const draw of draws.splice(0)) draw.destroy();
});

describe('a write from elsewhere while writes of this client are queued', () => {
  it('leaves a commit of draw.write queued to be told after it, as local', async () => {
    const store = createTableStore().store;
    const draw = createDraw(createMapStub().map, { store, initDefaultLayer: false });
    draws.push(draw);
    writesOf(draw).layers.create({ id: 'l', name: 'l' });
    const told: Array<{ source: string | undefined; layers: number; rows: boolean }> = [];
    store.subscribe((change) =>
      told.push({
        source: change.source,
        layers: change.layers?.created?.length ?? 0,
        rows: change.rows !== undefined,
      }),
    );
    const write = draw.write((tx) =>
      tx.features.create({
        type: 'Feature',
        id: 'p',
        geometry: { type: 'Point', coordinates: [1, 0] },
        properties: {},
      }),
    );
    for (let i = 0; i < 20 && !store.slicedWritePending; i++) await Promise.resolve();
    expect(store.slicedWritePending).toBe(true);
    // A Store applying what it received: a write of the Store inside a transaction from elsewhere
    store.transact(() => store.createLayer({ id: 'r', name: 'r' } as never), 'remote');
    await write;
    expect(told).toEqual([
      { source: 'remote', layers: 1, rows: false },
      { source: 'local', layers: 0, rows: true },
    ]);
    // The commit of this client is still a step of its undo
    await draw.undo();
    expect(draw.features.has('p')).toBe(false);
    expect(draw.layers.has('r')).toBe(true);
  });

  it('leaves the rest of a write over several tasks to its next steps, as local', () => {
    const store = createTableStore().store;
    store.createLayer({ id: 'l', name: 'l', kind: 'table' } as never);
    const features = Array.from({ length: 2_000 }, (_, i) => ({
      id: `p${i}`,
      type: 'Point',
      layerId: 'l',
      properties: {},
      geometry: { type: 'Point', coordinates: [i * 0.001, 0] },
    }));
    store.createFeatures(features as never);
    const handles = features.map((f) => store.tables?.getRowRef(f.id) as number);
    const told: Array<{ source: string | undefined; layers: number }> = [];
    store.subscribe((change) =>
      told.push({ source: change.source, layers: change.layers?.created?.length ?? 0 }),
    );
    let next: (() => void) | null = null;
    let t = 0;
    writeKindsInSlices(
      store as never,
      TableSelection.of(handles),
      [{ rows: handles, op: { kind: 'delete' } as never }],
      {
        onDone: () => {},
        budgetMs: 1,
        schedule: (step) => {
          next = step;
        },
        now: () => (t += 1),
      },
    );
    expect(store.slicedWritePending).toBe(true);
    store.transact(
      () => store.createLayer({ id: 'r', name: 'r', kind: 'table' } as never),
      'remote',
    );
    // Told: the first step (local), then the write from elsewhere alone
    expect(told.map((entry) => entry.source)).toEqual(['local', 'remote']);
    expect(told[1]?.layers).toBe(1);
    // The rest is written by its next steps, as local
    while (next) {
      const step: () => void = next;
      next = null;
      step();
    }
    expect(told.slice(2).every((entry) => entry.source === 'local')).toBe(true);
    expect(features.filter((f) => store.getFeature(f.id)).length).toBe(0);
  });
});
