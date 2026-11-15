// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The limit of the bytes of the local undo (`history.maxBytes`): past it, the oldest steps are
 * let go of first, the last one kept; without it, the steps are kept up to `maxSteps`
 */

import { afterEach, describe, expect, it } from 'vitest';
import { MemoryStore } from '../../store/memory.js';
import { createTableStore } from '../../store/table-memory.js';
import { createMapStub } from '../../test-utils.js';
import type { Draw } from '../draw.js';
import { createDraw } from '../draw.js';
import type { FeatureInput } from '../model.js';

let draw: Draw | undefined;

afterEach(() => {
  draw?.destroy();
  draw = undefined;
});

/** A line of many positions, so that a step that keeps it keeps many bytes */
const line = (positions: number): FeatureInput => ({
  type: 'Feature',
  geometry: {
    type: 'LineString',
    coordinates: Array.from({ length: positions }, (_, i) => [i * 0.001, 0]),
  },
  properties: {},
});

/** Points in a row */
const points = (count: number, y: number): FeatureInput[] =>
  Array.from({ length: count }, (_, i) => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [i * 0.001, y] },
    properties: {},
  }));

/** How many steps can be taken back */
async function undos(draw: Draw): Promise<number> {
  let n = 0;
  while (draw.status.value.history.canUndo) {
    await draw.undo();
    n++;
  }
  return n;
}

describe('history.maxBytes', () => {
  for (const rows of [false, true]) {
    const kind = rows ? 'a Store of rows' : 'a Store of objects';

    it(`lets go of the oldest steps past the budget, the last one kept (${kind})`, async () => {
      const store = rows ? createTableStore().store : new MemoryStore();
      draw = createDraw(createMapStub().map, { store, history: { maxBytes: 50_000 } });
      const batches: (readonly string[])[] = [];
      for (let i = 0; i < 4; i++) {
        batches.push(await draw.write((tx) => tx.features.create(points(100, i))));
      }
      // Each deletion keeps 100 features to take it back: one of them fits in the budget
      for (const ids of batches) await draw.write((tx) => tx.features.delete(ids));
      expect(await undos(draw)).toBe(1);
      // The newest step is the one kept: the last deletion is taken back
      expect(draw.features.count()).toBe(100);
      expect(draw.features.has(batches[3]?.[0] as string)).toBe(true);
    });
  }

  it('keeps the last step however many bytes it keeps', async () => {
    draw = createDraw(createMapStub().map, { history: { maxBytes: 0 } });
    const a = await draw.write((tx) => tx.features.create(line(10)));
    await draw.write((tx) => tx.features.update(a.id, { properties: { n: 1 } }));
    expect(await undos(draw)).toBe(1);
    expect(draw.features.get(a.id)?.properties).not.toHaveProperty('n');
    // The step made again is the last one too
    expect(draw.status.value.history.canRedo).toBe(true);
    await draw.redo();
    expect(draw.features.get(a.id)?.properties).toMatchObject({ n: 1 });
  });

  it('keeps every step up to maxSteps without it', async () => {
    draw = createDraw(createMapStub().map);
    for (let i = 0; i < 6; i++) await draw.write((tx) => tx.features.create(line(1000)));
    expect(await undos(draw)).toBe(6);
  });

  it('refuses a budget that is not a number from 0', () => {
    for (const maxBytes of [-1, Number.NaN, '1']) {
      expect(() =>
        createDraw(createMapStub().map, { history: { maxBytes: maxBytes as number } }),
      ).toThrow(expect.objectContaining({ code: 'invalidInput' }));
    }
  });
});
