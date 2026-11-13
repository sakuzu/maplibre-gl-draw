// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for createDraw: the members of the draw instance that belong to no resource, the
 * transactions and the parts that later steps provide
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryStore } from '../../store/memory.js';
import { writesOf } from '../../test-support/writes.js';
import { createMapStub } from '../../test-utils.js';
import type { Draw } from '../draw.js';
import { createDraw } from '../draw.js';
import { DrawError } from '../errors.js';
import type { Change, DocumentChange } from '../events.js';

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
      defaultMode: 'drawPoint',
    });
    expect(other.getStore()).toBe(store);
    expect(other.layers.count()).toBe(0);
    other.destroy();
  });

  it('throws invalidInput for an unknown option or a value of the wrong type', () => {
    const map = createMapStub().map;
    for (const options of [{ unknown: 1 }, { snapping: { enabled: 'yes' } }, { style: 'red' }]) {
      try {
        createDraw(map, options as never);
        expect.unreachable();
      } catch (error) {
        expect((error as DrawError).code).toBe('invalidInput');
      }
    }
  });
});

describe('the mode', () => {
  it('changes the mode and throws notFound for a mode that does not exist', () => {
    expect(draw.getMode()).toBe('select');
    expect(draw.setMode('drawLine')).toBe(true);
    expect(draw.getMode()).toBe('drawLine');
    expect(() => draw.setMode('nothing')).toThrow(DrawError);
    try {
      draw.setMode('nothing');
    } catch (error) {
      expect((error as DrawError).code).toBe('notFound');
    }
    expect(draw.getMode()).toBe('drawLine');
  });

  it('returns false for a drawing mode under the interaction lock', () => {
    draw.setInteractionLocked(true);
    expect(draw.setMode('drawPoint')).toBe(false);
    expect(draw.getMode()).toBe('select');
  });
});

describe('read-only and the interaction lock', () => {
  it('turns read-only on and off, and the writes are refused while it is on', () => {
    draw.setReadOnly(true);
    expect(draw.isReadOnly()).toBe(true);
    expect(
      writesOf(draw).features.create({
        type: 'Point',
        geometry: { type: 'Point', coordinates: [0, 0] },
      }),
    ).toBeNull();
    draw.setReadOnly(false);
    expect(draw.isReadOnly()).toBe(false);
  });

  it('turns the lock on and back to select, and off again', () => {
    draw.setMode('drawPolygon');
    draw.setInteractionLocked(true);
    expect(draw.isInteractionLocked()).toBe(true);
    expect(draw.getMode()).toBe('select');
    draw.setInteractionLocked(false);
    expect(draw.isInteractionLocked()).toBe(false);
  });
});

describe('a transaction of the Store, as the internal writes make it', () => {
  it('delivers one Store notification for nested writes, with the outer source', () => {
    const notifications: DocumentChange[] = [];
    draw.getStore().subscribe((changes) => notifications.push(changes));
    const result = writesOf(draw).transact(
      () => {
        writesOf(draw).features.create({
          type: 'Point',
          geometry: { type: 'Point', coordinates: [0, 0] },
        });
        writesOf(draw).transact(
          () => {
            writesOf(draw).layers.create({ name: 'Second' });
            writesOf(draw).metadata.update({ title: 'Map' });
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
    const other = writesOf(draw).layers.create({ name: 'Other' });
    const point = (x: number) => ({
      type: 'Point' as const,
      geometry: { type: 'Point' as const, coordinates: [x, 0] },
    });
    const locked = writesOf(draw).features.create({ ...point(0), locked: true });
    const inGroup = writesOf(draw).features.create(point(1));
    const inLayer = writesOf(draw).features.create(point(2));
    const gone = writesOf(draw).features.create({ ...point(3), locked: true });
    if (!locked || !inGroup || !inLayer || !gone || !other) throw new Error('not created');
    const group = writesOf(draw).groups.create({ members: [inGroup.id], locked: true });
    if (!group) throw new Error('not created');
    writesOf(draw).layers.update(other.id, { locked: true });
    writesOf(draw).features.move(inLayer.id, { layerId: other.id });

    // Without the option the locks refuse the writes
    expect(writesOf(draw).features.update(locked.id, { properties: { a: 1 } })).toBeNull();
    expect(writesOf(draw).transact(() => writesOf(draw).features.delete(gone.id))).toBe(false);

    const notifications: DocumentChange[] = [];
    draw.getStore().subscribe((changes) => notifications.push(changes));
    writesOf(draw).transact(
      () => {
        expect(writesOf(draw).features.update(locked.id, { properties: { a: 1 } })).not.toBeNull();
        expect(writesOf(draw).groups.update(group.id, { name: 'Renamed' })).not.toBeNull();
        expect(writesOf(draw).features.update(inGroup.id, { properties: { b: 2 } })).not.toBeNull();
        expect(writesOf(draw).layers.update(other.id, { name: 'Renamed' })).not.toBeNull();
        expect(writesOf(draw).features.update(inLayer.id, { properties: { c: 3 } })).not.toBeNull();
        expect(writesOf(draw).features.delete(gone.id)).toBe(true);
        // A nested call keeps ignoring them
        writesOf(draw).transact(() => {
          expect(writesOf(draw).features.move(locked.id, { layerId: other.id })).toBe(true);
        });
        // Reads still tell the lock
        expect(draw.features.isEditable(locked.id)).toBe(false);
      },
      { source: 'history', ignoreLocks: true },
    );
    expect(notifications).toHaveLength(1);
    expect(notifications[0].source).toBe('history');
    expect(writesOf(draw).features.get(locked.id)?.layerId).toBe(other.id);
    expect(writesOf(draw).features.get(locked.id)?.locked).toBe(true);

    // After the call the locks refuse the writes again
    expect(writesOf(draw).features.update(locked.id, { properties: { a: 2 } })).toBeNull();
    expect(writesOf(draw).layers.delete(other.id)).toBe(false);
    expect(
      writesOf(draw).transact(() => writesOf(draw).layers.delete(other.id), { ignoreLocks: true }),
    ).toBe(true);
    expect(draw.layers.get(layer.id)).toBeDefined();
  });

  it('keeps refusing the writes under read-only with ignoreLocks', () => {
    const feature = writesOf(draw).features.create({
      type: 'Point',
      geometry: { type: 'Point', coordinates: [0, 0] },
      locked: true,
    });
    if (!feature) throw new Error('not created');
    draw.setReadOnly(true);
    writesOf(draw).transact(
      () => {
        expect(writesOf(draw).features.update(feature.id, { properties: { a: 1 } })).toBeNull();
        expect(writesOf(draw).features.delete(feature.id)).toBe(false);
      },
      { ignoreLocks: true },
    );
    expect(writesOf(draw).features.get(feature.id)).toBeDefined();
  });

  it('ends ignoring the locks when fn throws', () => {
    const feature = writesOf(draw).features.create({
      type: 'Point',
      geometry: { type: 'Point', coordinates: [0, 0] },
      locked: true,
    });
    if (!feature) throw new Error('not created');
    expect(() =>
      writesOf(draw).transact(
        () => {
          throw new Error('stop');
        },
        { ignoreLocks: true },
      ),
    ).toThrow('stop');
    expect(writesOf(draw).features.delete(feature.id)).toBe(false);
  });
});

describe('draw.write', () => {
  it('fails with invalidInput for options that are not an object, and runs nothing', async () => {
    const fn = vi.fn(() => 1);
    const run = async () => draw.write(fn, 'remote' as never);
    await expect(run()).rejects.toMatchObject({ name: 'DrawError', code: 'invalidInput' });
    expect(fn).not.toHaveBeenCalled();
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

describe('document.loadMany', () => {
  it('arrives as one change with the source local', async () => {
    const saved = draw.document.toJSON();
    const changes: Change[] = [];
    draw.on('change', (change) => changes.push(change));
    const point = (coordinates: number[]) => ({
      type: 'Feature' as const,
      properties: {},
      geometry: { type: 'Point' as const, coordinates },
    });
    await writesOf(draw).document.loadMany([
      { source: saved },
      { source: point([1, 2]) },
      { source: JSON.stringify(point([3, 4])) },
    ]);
    expect(changes).toHaveLength(1);
    // A load is a write of this client
    expect(changes[0].source).toBe('local');
    expect(draw.features.count()).toBe(2);
  });
});
