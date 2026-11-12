// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * No local undo (`history.maxSteps` 0): no step is kept, and the rows a deletion deleted stay
 * with the Store for what takes the deletion back elsewhere
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createTableStore } from '../../store/table-memory.js';
import type { StoreChange } from '../../store/types.js';
import { writesOf } from '../../test-support/writes.js';
import { createMapStub } from '../../test-utils.js';
import type { Draw } from '../draw.js';
import { createDraw } from '../draw.js';
import { DrawError } from '../errors.js';
import type { FeatureValues } from '../model.js';

let draw: Draw | undefined;

afterEach(() => {
  draw?.destroy();
  draw = undefined;
});

const point = (x: number) => ({
  type: 'Feature' as const,
  geometry: { type: 'Point' as const, coordinates: [x, 0] },
  properties: { n: x },
});

describe('no local undo', () => {
  it('keeps no step of the commits', async () => {
    const { store } = createTableStore();
    draw = createDraw(createMapStub().map, { store, history: { maxSteps: 0 } });
    const [id] = await draw.write((tx) => tx.features.create([point(1)]));
    await draw.write((tx) => tx.features.update(id as string, { properties: { n: 2 } }));
    const undo = draw.undo();
    await expect(undo).rejects.toBeInstanceOf(DrawError);
    await expect(undo).rejects.toMatchObject({ code: 'invalid-state' });
    await expect(draw.redo()).rejects.toMatchObject({ code: 'invalid-state' });
    expect(draw.features.get(id as string)?.properties).toMatchObject({ n: 2 });
  });

  it('leaves the rows a deletion deleted with the Store, however many commits come after', async () => {
    const { store } = createTableStore();
    draw = createDraw(createMapStub().map, { store, history: { maxSteps: 0 } });
    const ids = await draw.write((tx) => tx.features.create([point(1), point(2), point(3)]));
    let before: FeatureValues | undefined;
    let token: unknown;
    const stop = store.subscribe((change: StoreChange) => {
      before ??= change.previousValues as FeatureValues | undefined;
      token ??= change.restoreToken;
    });
    await draw.write((tx) => tx.features.delete(ids));
    stop();
    expect(token).toBeDefined();
    for (let i = 0; i < 5; i++) await draw.write((tx) => tx.features.create(point(10 + i)));
    // Written back, the rows come back as they were: nothing let them go
    writesOf(draw).features.restore(before as FeatureValues);
    expect(ids.map((id) => draw?.features.get(id)?.geometry)).toEqual([
      { type: 'Point', coordinates: [1, 0] },
      { type: 'Point', coordinates: [2, 0] },
      { type: 'Point', coordinates: [3, 0] },
    ]);
  });
});
