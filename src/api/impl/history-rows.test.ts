// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The local undo over a Store of rows: a move of features selected in bulk to another layer, and
 * a layer of rows deleted with its groups, are taken back and made again as they were
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createTableStore } from '../../store/table-memory.js';
import { writesOf } from '../../test-support/writes.js';
import { createMapStub } from '../../test-utils.js';
import type { Draw } from '../draw.js';
import { createDraw } from './create-draw.js';

/** More features than are opened at once for the selection */
const COUNT = 2_010;

const draws: Draw[] = [];

afterEach(() => {
  for (const draw of draws.splice(0)) draw.destroy();
});

function open(count = COUNT): Draw {
  const { store } = createTableStore();
  const draw = createDraw(createMapStub().map, { store, initDefaultLayer: false });
  draws.push(draw);
  writesOf(draw).layers.create({ id: 'l', name: 'l' });
  writesOf(draw).layers.create({ id: 'm', name: 'm' });
  writesOf(draw).features.createMany(
    Array.from({ length: count }, (_, i) => ({
      id: `f${i}`,
      type: 'Point',
      geometry: { type: 'Point', coordinates: [i % 90, 1] },
      layerId: 'l',
      properties: { n: i },
    })),
  );
  return draw;
}

const itemsOf = (draw: Draw, layerId: string) =>
  draw.layers.has(layerId) ? draw.layers.listItems(layerId, { limit: 100_000 }) : [];

describe('the local undo over a Store of rows', () => {
  it('takes back and makes again a move of features selected in bulk to another layer', async () => {
    const draw = open();
    const order = itemsOf(draw, 'l');
    draw.selection.setAll();
    await draw.write((tx) => tx.features.place(draw.selection.target, { layerId: 'm' }));
    expect(itemsOf(draw, 'l')).toEqual([]);
    expect(itemsOf(draw, 'm')).toEqual(order);
    await draw.undo();
    expect(itemsOf(draw, 'l')).toEqual(order);
    await draw.redo();
    expect(itemsOf(draw, 'm')).toEqual(order);
  });

  it('brings a layer deleted back with its rows and groups where they were', async () => {
    const draw = open(12);
    writesOf(draw).groups.create({ id: 'g1', name: 'g1', members: ['f2', 'f3'] });
    writesOf(draw).groups.create({ id: 'g2', name: 'g2', members: ['f7', 'f8'] });
    const order = itemsOf(draw, 'l');
    await draw.write((tx) => tx.layers.delete('l'));
    expect(draw.layers.has('l')).toBe(false);
    await draw.undo();
    expect(itemsOf(draw, 'l')).toEqual(order);
    await draw.redo();
    expect(draw.layers.has('l')).toBe(false);
  });
});
