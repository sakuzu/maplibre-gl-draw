// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The locks in the writes of a transaction: the features named by their IDs are written all or
 * none (a locked one fails the write with `locked`), and a filter, every feature and the
 * selection leave the locked ones out without counting them. A target of the selection names
 * the selection as it was when it was read, whatever is selected since
 */

import { afterEach, describe, expect, it } from 'vitest';
import { DrawStore } from '../store/draw-store.js';
import { TableContractStore } from '../store/table-memory.js';
import { writesOf } from '../test-support/writes.js';
import { createMapStub } from '../test-utils.js';
import type { Draw } from './draw.js';
import { createDraw } from './draw.js';
import { DrawError } from './errors.js';

const draws: Draw[] = [];

afterEach(() => {
  for (const draw of draws.splice(0)) draw.destroy();
});

const point = (i: number, properties: Record<string, unknown> = {}) => ({
  type: 'Feature' as const,
  id: `f${i}`,
  geometry: { type: 'Point' as const, coordinates: [i, 0] },
  properties,
});

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'done';
  } catch (error) {
    if (error instanceof DrawError) return error.code;
    throw error;
  }
}

/** Three features, the second locked */
async function opened(): Promise<Draw> {
  const draw = createDraw(createMapStub().map);
  draws.push(draw);
  await draw.write(async (tx) => {
    await tx.features.create(point(0, { kind: 'a' }));
    await tx.features.create(point(1, { kind: 'a', 'maplibre-gl-draw:locked': true }));
    await tx.features.create(point(2, { kind: 'a' }));
  });
  return draw;
}

describe('the locks in the writes of a transaction', () => {
  it('fail a write that names a locked feature by its ID, and write none of the others', async () => {
    const draw = await opened();
    const style = { properties: { 'maplibre-gl-draw:style': { pointColor: '#ff0000' } } };
    expect(await codeOf(draw.write((tx) => tx.features.update('f1', style)))).toBe('locked');
    expect(await codeOf(draw.write((tx) => tx.features.update(['f0', 'f1'], style)))).toBe(
      'locked',
    );
    expect(
      await codeOf(
        draw.write((tx) =>
          tx.features.update([
            { id: 'f0', patch: style },
            { id: 'f1', patch: style },
          ]),
        ),
      ),
    ).toBe('locked');
    expect(await codeOf(draw.write((tx) => tx.features.delete(['f0', 'f1'])))).toBe('locked');
    expect(await codeOf(draw.write((tx) => tx.features.place(['f0', 'f1'], { above: 'f2' })))).toBe(
      'locked',
    );
    expect(draw.features.count()).toBe(3);
    expect(draw.features.get('f0')?.properties['maplibre-gl-draw:style']).toBeUndefined();
  });

  it('leave a locked feature out of a filter, every feature and the selection, uncounted', async () => {
    const draw = await opened();
    const style = { properties: { 'maplibre-gl-draw:style': { pointColor: '#ff0000' } } };
    expect(await draw.write((tx) => tx.features.update({ properties: { kind: 'a' } }, style))).toBe(
      2,
    );
    expect(await draw.write((tx) => tx.features.update({ all: true }, style))).toBe(2);
    draw.selection.set('feature', ['f0', 'f1', 'f2']);
    expect(
      await draw.write((tx) => tx.features.place(draw.selection.target, { above: 'f0' })),
    ).toBe(2);
    expect(await draw.write((tx) => tx.features.delete({ all: true }))).toBe(2);
    expect(draw.features.list().map((feature) => feature.id)).toEqual(['f1']);
  });

  it('take a patch of the lock alone for a locked feature named by its ID', async () => {
    const draw = await opened();
    await draw.write((tx) =>
      tx.features.update('f1', { properties: { 'maplibre-gl-draw:locked': false } } as never),
    );
    expect(draw.features.get('f1')?.properties['maplibre-gl-draw:locked']).toBeUndefined();
  });
});

describe('a target of the selection', () => {
  it('names the features selected when it was read, the selection changed since', async () => {
    const draw = await opened();
    draw.selection.set('feature', ['f0', 'f2']);
    const target = draw.selection.target;
    draw.selection.set('feature', ['f1']);
    expect(await draw.write((tx) => tx.features.delete(target))).toBe(2);
    expect(draw.features.list().map((feature) => feature.id)).toEqual(['f1']);
  });

  it('names the features selected in bulk when it was read, the selection cleared since', async () => {
    const store = new DrawStore(new TableContractStore(), { selectionIdsLimit: 2 });
    store.createLayer({
      id: 'l',
      name: 'l',
      visible: true,
      locked: false,
      opacity: 1,
      kind: 'table',
      styleRule: undefined,
      metadata: undefined,
    });
    const draw = createDraw(createMapStub().map, {
      store: store as never,
      initDefaultLayer: false,
    });
    draws.push(draw);
    writesOf(draw).features.createMany(
      Array.from({ length: 6 }, (_, i) => ({
        id: `r${i}`,
        type: 'Point',
        geometry: { type: 'Point', coordinates: [i, 1] },
        layerId: 'l',
        properties: {},
        locked: i === 3,
      })) as never,
    );
    draw.selection.setAll();
    expect(draw.selection.value.ids).toBeNull();
    const target = draw.selection.target;
    draw.selection.clear();
    // The locked one is left out and not counted
    expect(await draw.write((tx) => tx.features.delete(target))).toBe(5);
    expect(draw.features.list(undefined, { limit: 10 }).map((feature) => feature.id)).toEqual([
      'r3',
    ]);
  });
});
