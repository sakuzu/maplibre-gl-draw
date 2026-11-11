// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What the local undo lets go of: the rows a step deleted are kept by the Store until the step
 * is dropped, and a restore of them after that is not checked against what is kept (the restore
 * of the Store goes with the Store, in the change of the storage)
 */

import { afterEach, expect, it } from 'vitest';
import { createTableStore } from '../../store/table-memory.js';
import type { StoreChange } from '../../store/types.js';
import { writesOf } from '../../test-support/writes.js';
import { createMapStub } from '../../test-utils.js';
import type { Draw } from '../draw.js';
import { createDraw } from '../draw.js';
import type { FeatureValues } from '../model.js';

let draw: Draw | undefined;

afterEach(() => {
  draw?.destroy();
});

const point = (x: number) => ({
  type: 'Feature' as const,
  geometry: { type: 'Point' as const, coordinates: [x, 0] },
  properties: {},
});

it.fails('refuses to write back rows a dropped step let go of', async () => {
  const { store } = createTableStore();
  draw = createDraw(createMapStub().map, { store, history: { maxSteps: 1 } });
  const ids = await draw.write((tx) => tx.features.create([point(1), point(2), point(3)]));
  let before: FeatureValues | undefined;
  const stop = store.subscribe((change: StoreChange) => {
    before ??= change.previousValues as FeatureValues | undefined;
  });
  await draw.write((tx) => tx.features.delete(ids));
  stop();
  // The step of the deletion is dropped, and what kept its rows is let go of
  await draw.write((tx) => tx.features.create(point(4)));
  let refused = false;
  try {
    writesOf(draw).features.restore(before as FeatureValues);
  } catch {
    refused = true;
  }
  // Written back, the rows are counted but cannot be read
  expect(refused || ids.every((id) => draw?.features.has(id) === true)).toBe(true);
});
