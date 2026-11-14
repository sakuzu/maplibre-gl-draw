// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * An instance with no storage reads none of its commits as operations on values, and cuts none
 * into batches: the reader and the cutter are made only for a storage
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryStore } from '../../store/memory.js';
import { createTableStore } from '../../store/table-memory.js';
import { createMapStub } from '../../test-utils.js';
import { createDraw, type Draw } from '../draw.js';
import type { FeatureInput } from '../model.js';

const made = vi.hoisted(() => ({ readers: 0, reads: 0, cuts: 0 }));

vi.mock('./commit-values.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./commit-values.js')>();
  class CommitValues extends original.CommitValues {
    constructor(...args: ConstructorParameters<typeof original.CommitValues>) {
      super(...args);
      made.readers++;
    }
    override changeOperations(
      ...args: Parameters<InstanceType<typeof original.CommitValues>['changeOperations']>
    ) {
      made.reads++;
      return super.changeOperations(...args);
    }
  }
  return { ...original, CommitValues };
});

vi.mock('./parts.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./parts.js')>();
  return {
    ...original,
    batchesOf: (...args: Parameters<typeof original.batchesOf>) => {
      made.cuts++;
      return original.batchesOf(...args);
    },
  };
});

let draw: Draw | undefined;

afterEach(() => {
  draw?.destroy();
  draw = undefined;
});

describe('an instance with no storage', () => {
  for (const [kind, makeStore] of [
    ['objects', () => new MemoryStore()],
    ['rows', () => createTableStore().store],
  ] as const) {
    it(`reads none of its commits as operations on values (${kind})`, async () => {
      draw = createDraw(createMapStub().map, { store: makeStore(), initDefaultLayer: false });
      await draw.write((tx) => tx.layers.create({ id: 'a', name: 'A' }));
      const features: FeatureInput[] = Array.from({ length: 20 }, (_, i) => ({
        type: 'Feature',
        id: `f${i}`,
        geometry: { type: 'Point', coordinates: [i, 0] },
        properties: { n: i },
      }));
      await draw.write((tx) => tx.features.create(features));
      await draw.write((tx) => tx.features.update('f1', { properties: { n: 100 } }));
      await draw.write((tx) => tx.features.place(['f2', 'f3'], { above: 'f9' }));
      await draw.write((tx) => tx.groups.create({ id: 'g', name: 'G', members: ['f4', 'f5'] }));
      await draw.write((tx) => tx.features.delete(['f6']));
      await draw.undo();
      await draw.redo();
      expect(draw.features.count()).toBe(19);
      expect(made).toEqual({ readers: 0, reads: 0, cuts: 0 });
    });
  }
});
