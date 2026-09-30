// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for createDraw: the members of the draw instance that belong to no resource, the
 * transactions and the parts that later steps provide
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryStore } from '../../store/memory.js';
import { createMapStub } from '../../test-utils.js';
import type { Draw } from '../draw.js';
import { createDraw } from '../draw.js';
import { DrawError } from '../errors.js';
import type { DocumentChange } from '../events.js';

let stub: ReturnType<typeof createMapStub>;
let draw: Draw;

beforeEach(() => {
  vi.useFakeTimers();
  stub = createMapStub();
  draw = createDraw(stub.map);
});

afterEach(() => {
  draw.destroy();
  vi.useRealTimers();
});

describe('createDraw', () => {
  it('gives the map and the Store, which starts with one layer', () => {
    expect(draw.getMap()).toBe(stub.map);
    expect(draw.getStore().listLayers()).toHaveLength(1);
    expect(draw.layers.getActive()?.id).toBe(draw.getStore().listLayers()[0].id);
  });

  it('takes a Store of the library and the options the engine reads as they are', () => {
    const store = new MemoryStore();
    const other = createDraw(createMapStub().map, {
      store,
      initDefaultLayer: false,
      defaultMode: 'draw_point',
    });
    expect(other.getStore()).toBe(store);
    expect(other.layers.count()).toBe(0);
    other.destroy();
  });

  it('throws invalid-input for an unknown option or a value of the wrong type', () => {
    const map = createMapStub().map;
    for (const options of [{ unknown: 1 }, { snapping: { enabled: 'yes' } }, { style: 'red' }]) {
      try {
        createDraw(map, options as never);
        expect.unreachable();
      } catch (error) {
        expect((error as DrawError).code).toBe('invalid-input');
      }
    }
  });
});

describe('the mode', () => {
  it('changes the mode and throws not-found for a mode that does not exist', () => {
    expect(draw.getMode()).toBe('select');
    expect(draw.setMode('draw_line')).toBe(true);
    expect(draw.getMode()).toBe('draw_line');
    expect(() => draw.setMode('nothing')).toThrow(DrawError);
    try {
      draw.setMode('nothing');
    } catch (error) {
      expect((error as DrawError).code).toBe('not-found');
    }
    expect(draw.getMode()).toBe('draw_line');
  });

  it('returns false for a drawing mode under the interaction lock', () => {
    draw.setInteractionLocked(true);
    expect(draw.setMode('draw_point')).toBe(false);
    expect(draw.getMode()).toBe('select');
  });
});

describe('read-only and the interaction lock', () => {
  it('turns read-only on and off, and the writes are refused while it is on', () => {
    draw.setReadOnly(true);
    expect(draw.isReadOnly()).toBe(true);
    expect(
      draw.features.create({ type: 'Point', geometry: { type: 'Point', coordinates: [0, 0] } }),
    ).toBeNull();
    draw.setReadOnly(false);
    expect(draw.isReadOnly()).toBe(false);
  });

  it('turns the lock on and back to select, and off again', () => {
    draw.setMode('draw_polygon');
    draw.setInteractionLocked(true);
    expect(draw.isInteractionLocked()).toBe(true);
    expect(draw.getMode()).toBe('select');
    draw.setInteractionLocked(false);
    expect(draw.isInteractionLocked()).toBe(false);
  });
});

describe('transact', () => {
  it('delivers one Store notification for nested writes, with the outer source', () => {
    const notifications: DocumentChange[] = [];
    draw.getStore().subscribe((changes) => notifications.push(changes));
    const result = draw.transact(
      () => {
        draw.features.create({ type: 'Point', geometry: { type: 'Point', coordinates: [0, 0] } });
        draw.transact(
          () => {
            draw.layers.create({ name: 'Second' });
            draw.metadata.update({ title: 'Map' });
          },
          { source: 'inner' },
        );
        return 42;
      },
      { source: 'outer' },
    );
    expect(result).toBe(42);
    expect(notifications).toHaveLength(1);
    expect(notifications[0].source).toBe('outer');
    expect(notifications[0].features?.created).toHaveLength(1);
    expect(notifications[0].layers?.created).toHaveLength(1);
    expect(notifications[0].metadata?.metadata.title).toBe('Map');
  });

  it('lets the writes change locked features, groups and layers with ignoreLocks', () => {
    const layer = draw.layers.getActive() as NonNullable<ReturnType<typeof draw.layers.getActive>>;
    const other = draw.layers.create({ name: 'Other' });
    const point = (x: number) => ({
      type: 'Point' as const,
      geometry: { type: 'Point' as const, coordinates: [x, 0] },
    });
    const locked = draw.features.create({ ...point(0), locked: true });
    const inGroup = draw.features.create(point(1));
    const inLayer = draw.features.create(point(2));
    const gone = draw.features.create({ ...point(3), locked: true });
    if (!locked || !inGroup || !inLayer || !gone || !other) throw new Error('not created');
    const group = draw.groups.create({ featureIds: [inGroup.id], locked: true });
    if (!group) throw new Error('not created');
    draw.layers.update(other.id, { locked: true });
    draw.features.move(inLayer.id, { layerId: other.id });

    // Without the option the locks refuse the writes
    expect(draw.features.update(locked.id, { properties: { a: 1 } })).toBeNull();
    expect(draw.transact(() => draw.features.delete(gone.id))).toBe(false);

    const notifications: DocumentChange[] = [];
    draw.getStore().subscribe((changes) => notifications.push(changes));
    draw.transact(
      () => {
        expect(draw.features.update(locked.id, { properties: { a: 1 } })).not.toBeNull();
        expect(draw.groups.update(group.id, { name: 'Renamed' })).not.toBeNull();
        expect(draw.features.update(inGroup.id, { properties: { b: 2 } })).not.toBeNull();
        expect(draw.layers.update(other.id, { name: 'Renamed' })).not.toBeNull();
        expect(draw.features.update(inLayer.id, { properties: { c: 3 } })).not.toBeNull();
        expect(draw.features.delete(gone.id)).toBe(true);
        // A nested call keeps ignoring them
        draw.transact(() => {
          expect(draw.features.move(locked.id, { layerId: other.id })).toBe(true);
        });
        // Reads still tell the lock
        expect(draw.features.isEditable(locked.id)).toBe(false);
      },
      { source: 'history', ignoreLocks: true },
    );
    expect(notifications).toHaveLength(1);
    expect(notifications[0].source).toBe('history');
    expect(draw.features.get(locked.id)?.layerId).toBe(other.id);
    expect(draw.features.get(locked.id)?.locked).toBe(true);

    // After the call the locks refuse the writes again
    expect(draw.features.update(locked.id, { properties: { a: 2 } })).toBeNull();
    expect(draw.layers.delete(other.id)).toBe(false);
    expect(draw.transact(() => draw.layers.delete(other.id), { ignoreLocks: true })).toBe(true);
    expect(draw.layers.get(layer.id)).toBeDefined();
  });

  it('keeps refusing the writes under read-only with ignoreLocks', () => {
    const feature = draw.features.create({
      type: 'Point',
      geometry: { type: 'Point', coordinates: [0, 0] },
      locked: true,
    });
    if (!feature) throw new Error('not created');
    draw.setReadOnly(true);
    draw.transact(
      () => {
        expect(draw.features.update(feature.id, { properties: { a: 1 } })).toBeNull();
        expect(draw.features.delete(feature.id)).toBe(false);
      },
      { ignoreLocks: true },
    );
    expect(draw.features.get(feature.id)).toBeDefined();
  });

  it('ends ignoring the locks when fn throws', () => {
    const feature = draw.features.create({
      type: 'Point',
      geometry: { type: 'Point', coordinates: [0, 0] },
      locked: true,
    });
    if (!feature) throw new Error('not created');
    expect(() =>
      draw.transact(
        () => {
          throw new Error('stop');
        },
        { ignoreLocks: true },
      ),
    ).toThrow('stop');
    expect(draw.features.delete(feature.id)).toBe(false);
  });

  it('throws invalid-input for options that are not an object', () => {
    try {
      draw.transact(() => 1, 'remote' as never);
      expect.unreachable();
    } catch (error) {
      expect((error as DrawError).code).toBe('invalid-input');
    }
  });
});

describe('destroy', () => {
  it('removes every layer and listener it added to the map', () => {
    const other = createMapStub();
    const instance = createDraw(other.map);
    expect(other.layers.size).toBeGreaterThan(0);
    instance.destroy();
    expect(other.layers.size).toBe(0);
    expect(other.mapListenerCount()).toBe(0);
    expect(other.canvasListenerCount()).toBe(0);
    expect(() => instance.destroy()).not.toThrow();
  });
});
