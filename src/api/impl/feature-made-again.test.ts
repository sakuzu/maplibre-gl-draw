// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for a feature deleted and created again with its ID in one transaction: it is told as
 * updated, once, from what it was before the transaction to what it is now, and neither as
 * created nor as deleted, whether the instance wrote it (a transaction, a load that replaces the
 * features) or it was written to the Store directly
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStore } from '../../store/built-in/create-store.js';
import type { Store } from '../../store/built-in/types.js';
import { createMapStub, rowWrites } from '../../test-utils.js';
import type { Draw } from '../draw.js';
import type { Feature } from '../model.js';
import { createDrawOnEngine } from './create-draw.js';
import { createEngine } from './engine.js';

const draws: Draw[] = [];

afterEach(() => {
  for (const draw of draws.splice(0)) draw.destroy();
  vi.useRealTimers();
});

/** An instance over a built-in Store with the point `a` (and `b`), and what it tells */
function instance() {
  vi.useFakeTimers();
  const store = createStore();
  const engine = createEngine(createMapStub().map, { store }, { deferDefaultMode: true });
  const draw = createDrawOnEngine(engine, { store });
  engine.enterDefaultMode();
  draws.push(draw);
  draw.features.create({
    id: 'a',
    type: 'Point',
    geometry: { type: 'Point', coordinates: [1, 1] },
    properties: { n: 1 },
  });
  draw.features.create({
    id: 'b',
    type: 'Point',
    geometry: { type: 'Point', coordinates: [2, 2] },
  });
  const told: Array<{ kind: string; id: string; feature?: Feature; previous?: Feature }> = [];
  draw.on('feature.created', ({ feature }) => told.push({ kind: 'created', id: feature.id }));
  draw.on('feature.deleted', ({ feature }) => told.push({ kind: 'deleted', id: feature.id }));
  draw.on('feature.updated', ({ feature, previous }) =>
    told.push({ kind: 'updated', id: feature.id, feature, previous }),
  );
  const changes: Array<{ created: string[]; updated: string[]; deleted: string[] }> = [];
  draw.on('document.changed', (change) =>
    changes.push({
      created: [...change.features.created.iterate()],
      updated: [...change.features.updated.iterate()],
      deleted: [...change.features.deleted.iterate()],
    }),
  );
  return { draw, store, told, changes, before: draw.features.get('a') as Feature };
}

/** Expects `a` told as updated once, from what it was to what it is now */
function expectUpdatedOnce(host: ReturnType<typeof instance>): void {
  const { draw, told, changes, before } = host;
  const now = draw.features.get('a') as Feature;
  expect(now).toBeDefined();
  expect(now.properties).toMatchObject({ n: 2 });
  const ofA = told.filter((entry) => entry.id === 'a');
  expect(ofA).toEqual([{ kind: 'updated', id: 'a', feature: now, previous: before }]);
  expect(changes).toHaveLength(1);
  expect(changes[0].updated).toContain('a');
  expect(changes[0].created).not.toContain('a');
  expect(changes[0].deleted).not.toContain('a');
}

describe('a feature deleted and created again with its ID in one transaction', () => {
  it('is updated once when a transaction of the instance writes it', () => {
    const host = instance();
    host.draw.transact(() => {
      host.draw.features.delete('a');
      host.draw.features.create({
        id: 'a',
        type: 'Point',
        geometry: { type: 'Point', coordinates: [3, 3] },
        properties: { n: 2 },
      });
    });
    expectUpdatedOnce(host);
  });

  it('is updated once when a load replaces the features with the same IDs', async () => {
    const host = instance();
    await host.draw.document.load(
      {
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            id: 'a',
            properties: { n: 2 },
            geometry: { type: 'Point', coordinates: [3, 3] },
          },
        ],
      },
      { mode: 'replace' },
    );
    expectUpdatedOnce(host);
    // The feature the load does not bring back is deleted
    expect(host.told.filter((entry) => entry.id === 'b').map((entry) => entry.kind)).toEqual([
      'deleted',
    ]);
  });

  it('is updated once when it is written to the Store directly', () => {
    const host = instance();
    const store: Store = host.store;
    const rows = rowWrites(store);
    store.transact(() => {
      rows.deleteFeature('a');
      rows.createFeature({
        ...host.before,
        geometry: { type: 'Point', coordinates: [3, 3] },
        properties: { n: 2 },
      });
    }, 'remote');
    expectUpdatedOnce(host);
  });
});
