// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * An instance with no storage reads none of its commits as operations on values, and cuts none
 * into batches: the sender, the reader and the cutter are made only for a storage (they are
 * counted too with one, to show the counting works)
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryStore } from '../../store/memory.js';
import { createTableStore } from '../../store/table-memory.js';
import { createMapStub } from '../../test-utils.js';
import { createDraw, type Draw } from '../draw.js';
import type { FeatureInput } from '../model.js';
import type { Backend } from './backend.js';

const made = vi.hoisted(() => ({ senders: 0, readers: 0, reads: 0, cuts: 0 }));

vi.mock('./sender.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./sender.js')>();
  class Sender extends original.Sender {
    constructor(...args: ConstructorParameters<typeof original.Sender>) {
      super(...args);
      made.senders++;
    }
  }
  return { ...original, Sender };
});

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
    override readChange(
      ...args: Parameters<InstanceType<typeof original.CommitValues>['readChange']>
    ) {
      made.reads++;
      return super.readChange(...args);
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
    batchesInSteps: (...args: Parameters<typeof original.batchesInSteps>) => {
      made.cuts++;
      return original.batchesInSteps(...args);
    },
  };
});

let draw: Draw | undefined;

afterEach(() => {
  draw?.destroy();
  draw = undefined;
  Object.assign(made, { senders: 0, readers: 0, reads: 0, cuts: 0 });
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
      expect(made).toEqual({ senders: 0, readers: 0, reads: 0, cuts: 0 });
    });
  }

  it('makes them with a storage', async () => {
    const backend: Backend = {
      load: async () => ({ type: 'FeatureCollection', features: [] }),
      send: async () => ({ status: 'accepted' }),
    };
    draw = createDraw(createMapStub().map, { backend, initDefaultLayer: false });
    await draw.write((tx) => tx.layers.create({ id: 'a', name: 'A' })).save();
    expect(made.senders).toBe(1);
    expect(made.readers).toBe(1);
    expect(made.reads).toBeGreaterThan(0);
    expect(made.cuts).toBe(1);
  });
});
