// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `draw.memory`: what the documents of the page take against the limit of the device: the limit
 * by the device and the one set, the estimate of a
 * document held as rows and as features, and the sum over the instances of the page.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { MemoryStore } from '../../store/memory.js';
import type { Store } from '../../store/store.js';
import { createTableStore } from '../../store/table-memory.js';
import type { Feature } from '../../store/types.js';
import { createMapStub } from '../../test-utils.js';
import type { Draw } from '../draw.js';
import { DrawError } from '../errors.js';
import { createDrawOnEngine } from './create-draw.js';
import { createEngine } from './engine.js';
import {
  DEFAULT_MEMORY_LIMIT_BYTES,
  deviceMemoryLimitBytes,
  MEMORY_FACTORS,
  PHONE_MEMORY_LIMIT_BYTES,
  TABLET_MEMORY_LIMIT_BYTES,
} from './memory.js';

const draws: Draw[] = [];

afterEach(() => {
  for (const draw of draws.splice(0)) draw.destroy();
});

function drawOn(store: Store): Draw {
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

function square(id: string, x: number, layerId: string): Feature {
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

const layer = (id: string, table: boolean) =>
  ({
    id,
    name: id,
    visible: true,
    locked: false,
    opacity: 1,
    styleRule: undefined,
    metadata: undefined,
    ...(table ? { kind: 'table' } : { items: [] }),
  }) as never;

describe('the limit of the device', () => {
  it('is 400 MiB on an iPhone, 500 MiB on an iPad, 1 GiB elsewhere', () => {
    expect(
      deviceMemoryLimitBytes({
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)',
      }),
    ).toBe(PHONE_MEMORY_LIMIT_BYTES);
    expect(
      deviceMemoryLimitBytes({ userAgent: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)' }),
    ).toBe(TABLET_MEMORY_LIMIT_BYTES);
    // An iPad that asks for the pages of a desktop
    expect(
      deviceMemoryLimitBytes({
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
        maxTouchPoints: 5,
      }),
    ).toBe(TABLET_MEMORY_LIMIT_BYTES);
    expect(
      deviceMemoryLimitBytes({
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
        maxTouchPoints: 0,
      }),
    ).toBe(DEFAULT_MEMORY_LIMIT_BYTES);
    expect(deviceMemoryLimitBytes({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' })).toBe(
      DEFAULT_MEMORY_LIMIT_BYTES,
    );
    expect(deviceMemoryLimitBytes(undefined)).toBe(DEFAULT_MEMORY_LIMIT_BYTES);
    expect(DEFAULT_MEMORY_LIMIT_BYTES).toBe(1024 * 1024 * 1024);
  });

  it('is the one set, and the one of the device again with null', () => {
    const draw = drawOn(new MemoryStore());
    draw.memory.setLimit(300 * 1024 * 1024);
    expect(draw.memory.get().limitBytes).toBe(300 * 1024 * 1024);
    draw.memory.setLimit(200 * 1024 * 1024);
    expect(draw.memory.get().limitBytes).toBe(200 * 1024 * 1024);
    expect(() => draw.memory.setLimit(0)).toThrow(DrawError);
    expect(() => draw.memory.setLimit(Number.NaN)).toThrow(DrawError);
    draw.memory.setLimit(null);
    expect(draw.memory.get().limitBytes).toBe(deviceMemoryLimitBytes());
  });

  it('is the one of the device until it is set', () => {
    const draw = drawOn(new MemoryStore());
    expect(draw.memory.get().limitBytes).toBe(deviceMemoryLimitBytes());
  });
});

describe('the estimate of a document', () => {
  it('takes the factors of rows in an instance whose Store holds its features as rows', () => {
    const draw = drawOn(createTableStore().store);
    const f = MEMORY_FACTORS.rows;
    const estimate = draw.memory.estimate({ features: 1000, positions: 5000 });
    expect(estimate.jsBytes).toBe(1000 * f.jsPerFeature + 5000 * f.jsPerPosition);
    expect(estimate.gpuBytes).toBe(1000 * f.gpuPerFeature + 5000 * f.gpuPerPosition);
    expect(estimate.bytes).toBe(estimate.jsBytes + estimate.gpuBytes);
  });

  it('takes the factors of features in an instance whose Store holds objects', () => {
    const draw = drawOn(new MemoryStore());
    const f = MEMORY_FACTORS.features;
    const estimate = draw.memory.estimate({ features: 10, positions: 50 });
    expect(estimate.jsBytes).toBe(10 * f.jsPerFeature + 50 * f.jsPerPosition);
    // A feature held as an object takes more than one held as a row
    const rows = drawOn(createTableStore().store).memory.estimate({ features: 10, positions: 50 });
    expect(estimate.bytes).toBeGreaterThan(rows.bytes);
  });

  it('refuses a size that is not numbers of 0 or more', () => {
    const draw = drawOn(new MemoryStore());
    expect(() => draw.memory.estimate({ features: -1, positions: 0 })).toThrow(DrawError);
    expect(() => draw.memory.estimate({ features: 1, positions: Number.NaN })).toThrow(DrawError);
    expect(() => draw.memory.estimate(null as never)).toThrow(DrawError);
  });
});

describe('the memory taken', () => {
  it('grows with the rows of a document held as rows, as the estimate of their size', () => {
    const { store } = createTableStore();
    store.createLayer(layer('rows', true));
    const draw = drawOn(store);
    const before = draw.memory.get().jsBytes;
    store.transact(() => {
      for (let i = 0; i < 10; i++) store.createFeature(square(`s${i}`, i * 2, 'rows'));
    });
    const after = draw.memory.get();
    const expected = draw.memory.estimate({ features: 10, positions: 50 });
    expect(after.jsBytes - before).toBe(expected.jsBytes);
    expect(after.bytes).toBe(after.jsBytes + after.gpuBytes);
  });

  it('grows with the features of a document of objects', () => {
    const store = new MemoryStore();
    store.createLayer(layer('objects', false));
    const draw = drawOn(store);
    const before = draw.memory.get().jsBytes;
    store.createFeature(square('a', 0, 'objects'));
    expect(draw.memory.get().jsBytes - before).toBe(
      draw.memory.estimate({ features: 1, positions: 5 }).jsBytes,
    );
  });

  it('is the sum of every instance of the page, until one is destroyed', () => {
    const first = new MemoryStore();
    first.createLayer(layer('objects', false));
    first.createFeature(square('a', 0, 'objects'));
    const one = drawOn(first);
    const alone = one.memory.get().jsBytes;
    const second = new MemoryStore();
    second.createLayer(layer('objects', false));
    second.createFeature(square('b', 0, 'objects'));
    const two = drawOn(second);
    // Both instances tell the memory of the page
    expect(one.memory.get().jsBytes).toBe(two.memory.get().jsBytes);
    expect(one.memory.get().jsBytes).toBeGreaterThan(alone);
    two.destroy();
    expect(one.memory.get().jsBytes).toBe(alone);
  });
});
