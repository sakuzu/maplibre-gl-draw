// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests that a map takes one draw instance at a time
 *
 * A second `createDraw` on a map that has an instance throws `invalidState` and leaves the first
 * instance and the layers of the map as they were; once the first is destroyed, the map takes
 * another. Another map takes an instance whatever the first map has.
 */

import type { Map as MapLibreMap } from 'maplibre-gl';
import { afterEach, describe, expect, it } from 'vitest';
import { createMapStub } from '../../test-utils.js';
import type { Draw } from '../draw.js';
import { createDraw } from '../draw.js';
import { DrawError } from '../errors.js';

const draws: Draw[] = [];

afterEach(() => {
  for (const draw of draws.splice(0)) draw.destroy();
});

/** A draw instance on a map, destroyed after the test */
function put(map: MapLibreMap): Draw {
  const draw = createDraw(map);
  draws.push(draw);
  return draw;
}

/** The ids of the layers of a map stub, in their order */
const layerIds = (stub: ReturnType<typeof createMapStub>) => [...stub.layers.keys()];

describe('a map with a draw instance', () => {
  it('refuses a second instance with invalidState, and the first instance and the layers stay', () => {
    const stub = createMapStub();
    const map = stub.map as unknown as MapLibreMap;
    const first = put(map);
    const layer = first.layers.create({ name: 'Roads' });
    if (!layer) throw new Error('not created');
    const before = layerIds(stub);
    const beforeLayers = [...stub.layers.values()];
    expect(before.length).toBeGreaterThan(0);

    let thrown: unknown;
    try {
      put(map);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(DrawError);
    expect((thrown as DrawError).code).toBe('invalidState');

    // The same layers, the same objects, in the same order
    expect(layerIds(stub)).toEqual(before);
    [...stub.layers.values()].forEach((l, i) => {
      expect(l).toBe(beforeLayers[i]);
    });
    // The first instance still works
    expect(first.layers.get(layer.id)?.name).toBe('Roads');
    const feature = first.features.create({
      type: 'Point',
      geometry: { type: 'Point', coordinates: [1, 2] },
    });
    expect(feature).not.toBeNull();
    expect(first.features.list().map((f) => f.id)).toEqual([feature?.id]);
  });

  it('takes another instance once the first is destroyed', () => {
    const stub = createMapStub();
    const map = stub.map as unknown as MapLibreMap;
    const first = put(map);
    first.destroy();

    const second = put(map);
    expect(second.layers.list().length).toBeGreaterThan(0);
    expect(layerIds(stub).length).toBeGreaterThan(0);
  });

  it('does not keep another map from taking an instance', () => {
    const one = createMapStub();
    const other = createMapStub();
    put(one.map as unknown as MapLibreMap);

    const second = put(other.map as unknown as MapLibreMap);
    expect(second.layers.list().length).toBeGreaterThan(0);
    expect(layerIds(other).length).toBeGreaterThan(0);
  });
});
