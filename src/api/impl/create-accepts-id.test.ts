// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Creating in a Store that takes ids of its own form only (`Store.acceptsId`)
 *
 * - A feature, a group or a layer created with an id the Store does not take is refused with
 *   `invalidInput` before anything is written: `create` and `createMany` of the features, the
 *   groups and the layers, a sketch that creates a feature, and the new layer and group of a load
 * - In `createMany`, one such id refuses every input, and nothing is written
 * - An id the Store takes, and an id left out (made by `generateId`), are created as before
 * - A group a Store of rows brings back (`groups.restore`) keeps its id without asking the Store
 *   (covered by the tests of the restore: it is not a new id)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryContractStore } from '../../store/memory.js';
import { writesOf } from '../../test-support/writes.js';
import { createMapStub } from '../../test-utils.js';
import type { Draw } from '../draw.js';
import { createDraw } from '../draw.js';
import { DrawError } from '../errors.js';
import type { StoredFeatureInput as FeatureInput } from '../model.js';

let store: MemoryContractStore;
let draw: Draw;

/** The ids the Store takes start with `w-`, the form of the ids its generator makes */
const takes = (id: string): boolean => id.startsWith('w-');

beforeEach(() => {
  store = new MemoryContractStore();
  Object.assign(store, { acceptsId: takes });
  store.createLayer({
    id: 'w-layer',
    name: 'l1',
    visible: true,
    locked: false,
    opacity: 1,
    items: [],
    styleRule: undefined,
    metadata: undefined,
  });
  let n = 0;
  draw = createDraw(createMapStub().map, {
    store,
    initDefaultLayer: false,
    generateId: () => `w-${++n}`,
  });
});

afterEach(() => draw.destroy());

const point = (id?: string): FeatureInput => ({
  type: 'Point',
  geometry: { type: 'Point', coordinates: [1, 1] },
  ...(id !== undefined && { id }),
});

/** The error the call throws */
function errorOf(call: () => unknown): DrawError {
  try {
    call();
  } catch (error) {
    expect(error).toBeInstanceOf(DrawError);
    return error as DrawError;
  }
  throw new Error('nothing was thrown');
}

describe('creating with an id the Store does not take', () => {
  it('refuses a feature with invalidInput, and writes nothing', () => {
    const write = vi.spyOn(store, 'createFeature');
    const error = errorOf(() => writesOf(draw).features.create(point('road-1')));
    expect(error.code).toBe('invalidInput');
    expect(error.ids).toEqual(['road-1']);
    expect(write).not.toHaveBeenCalled();
    expect(writesOf(draw).features.list()).toEqual([]);
  });

  it('refuses every feature of createMany for one of them', () => {
    const error = errorOf(() =>
      writesOf(draw).features.createMany([point('w-a'), point('road-1')]),
    );
    expect(error.code).toBe('invalidInput');
    expect(writesOf(draw).features.list()).toEqual([]);
  });

  it('refuses a group and a layer with invalidInput, and writes nothing', () => {
    const feature = writesOf(draw).features.create(point());
    const group = errorOf(() =>
      writesOf(draw).groups.create({ id: 'group-1', members: [feature?.id as string] }),
    );
    expect(group.code).toBe('invalidInput');
    const groups = errorOf(() =>
      writesOf(draw).groups.createMany([{ id: 'group-1', members: [feature?.id as string] }]),
    );
    expect(groups.code).toBe('invalidInput');
    expect(draw.groups.list()).toEqual([]);

    const layer = errorOf(() => writesOf(draw).layers.create({ id: 'layer-2' }));
    expect(layer.code).toBe('invalidInput');
    const layers = errorOf(() =>
      writesOf(draw).layers.createMany([{ id: 'w-l' }, { id: 'layer-2' }]),
    );
    expect(layers.code).toBe('invalidInput');
    expect(draw.layers.list().map((each) => each.id)).toEqual(['w-layer']);
  });

  it('refuses a sketch that creates a feature with such an id when it is added', () => {
    const error = errorOf(() =>
      draw.sketches.add({
        edits: [{ kind: 'create', feature: point('road-1'), placedVertexCount: 1, below: null }],
      }),
    );
    expect(error.code).toBe('invalidInput');
    expect(draw.sketches.list()).toEqual([]);
  });

  it('refuses the new layer and group of a load, and writes nothing', async () => {
    const geojson = {
      type: 'FeatureCollection' as const,
      features: [
        {
          type: 'Feature' as const,
          geometry: { type: 'Point' as const, coordinates: [1, 1] },
          properties: {},
        },
      ],
    };
    await expect(
      writesOf(draw).document.load(geojson, { layer: { id: 'layer-2' } }),
    ).rejects.toMatchObject({
      code: 'invalidInput',
    });
    await expect(
      writesOf(draw).document.load(geojson, { group: { id: 'group-1' } }),
    ).rejects.toMatchObject({
      code: 'invalidInput',
    });
    expect(writesOf(draw).features.list()).toEqual([]);
    expect(draw.layers.list().map((each) => each.id)).toEqual(['w-layer']);
  });
});

describe('creating with an id the Store takes, or with none', () => {
  it('creates them as before', () => {
    const own = writesOf(draw).features.create(point('w-own'));
    const made = writesOf(draw).features.create(point());
    expect(own?.id).toBe('w-own');
    expect(made?.id.startsWith('w-')).toBe(true);
    const group = writesOf(draw).groups.create({ members: [own?.id as string] });
    expect(group?.id.startsWith('w-')).toBe(true);
    expect(writesOf(draw).layers.create({ id: 'w-second' })?.id).toBe('w-second');
  });

  it('takes an id that is taken as taken, before it asks the Store', () => {
    writesOf(draw).features.create(point('w-own'));
    expect(errorOf(() => writesOf(draw).features.create(point('w-own'))).code).toBe(
      'alreadyExists',
    );
  });
});
