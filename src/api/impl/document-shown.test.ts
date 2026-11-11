// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `draw.document.setShown`: another document held as rows shown in place of the document on the
 * same map: the instance is read-only
 * while it is, the input goes to the map only, the changes from elsewhere are still taken, and
 * its memory counts in `draw.memory`. What is drawn is checked by the end-to-end test.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { MemoryStore } from '../../store/memory.js';
import type { Store } from '../../store/store.js';
import { createTableStore } from '../../store/table-memory.js';
import type { Feature, Layer } from '../../store/types.js';
import { writesOf } from '../../test-support/writes.js';
import { createMapStub, createSyntheticInput } from '../../test-utils.js';
import type { Draw } from '../draw.js';
import { DrawError } from '../errors.js';
import { createDrawOnEngine } from './create-draw.js';
import { createEngine, type Engine } from './engine.js';

const draws: Draw[] = [];

afterEach(() => {
  for (const draw of draws.splice(0)) draw.destroy();
});

function drawOn(store: Store): { draw: Draw; engine: Engine } {
  const engine = createEngine(
    createMapStub().map,
    { store, initDefaultLayer: false },
    { deferDefaultMode: true },
  );
  const draw = createDrawOnEngine(engine, { store, initDefaultLayer: false });
  engine.enterDefaultMode();
  draws.push(draw);
  return { draw, engine };
}

const layer = (id: string, table: boolean): Layer =>
  ({
    id,
    name: id,
    visible: true,
    locked: false,
    opacity: 1,
    styleRule: undefined,
    metadata: undefined,
    ...(table ? { kind: 'table' } : { items: [] }),
  }) as Layer;

const point = (id: string, layerId: string, x = 0): Feature => ({
  id,
  type: 'Point',
  geometry: { type: 'Point', coordinates: [x, 0] },
  layerId,
  groupId: undefined,
  properties: {},
  style: {},
  visible: true,
  locked: false,
});

/** A version of a document: a Store of rows of the same layer */
function version() {
  const { store, writer } = createTableStore();
  store.createLayer(layer('rows', true));
  store.transact(() => {
    for (let i = 0; i < 5; i++) store.createFeature(point(`v${i}`, 'rows', i));
  });
  return { store, writer };
}

function live() {
  const { store, writer } = createTableStore();
  store.createLayer(layer('rows', true));
  store.transact(() => {
    for (let i = 0; i < 3; i++) store.createFeature(point(`p${i}`, 'rows', i));
  });
  return { store, writer, ...drawOn(store) };
}

describe('another document shown in place of the document', () => {
  it('is a Store of rows other than the one of the instance', () => {
    const { draw, store } = live();
    expect(draw.document.getShown()).toBeNull();
    expect(() => draw.document.setShown(new MemoryStore())).toThrow(DrawError);
    expect(() => draw.document.setShown(store)).toThrow(DrawError);
    expect(() => draw.document.setShown({} as never)).toThrow(DrawError);
    const other = version().store;
    draw.document.setShown(other);
    expect(draw.document.getShown()).toBe(other);
    draw.document.setShown(null);
    expect(draw.document.getShown()).toBeNull();
  });

  it('makes the instance read-only while it is shown, and tells it', () => {
    const { draw } = live();
    const told: boolean[] = [];
    draw.on('readOnly.changed', ({ readOnly }) => told.push(readOnly));
    draw.document.setShown(version().store);
    expect(draw.isReadOnly()).toBe(true);
    expect(
      writesOf(draw).features.create({
        type: 'Point',
        geometry: { type: 'Point', coordinates: [9, 9] },
      }),
    ).toBeNull();
    expect(writesOf(draw).features.update('p1', { properties: { n: 1 } })).toBeNull();
    expect(draw.features.has('p1')).toBe(true);
    draw.document.setShown(null);
    expect(draw.isReadOnly()).toBe(false);
    expect(told).toEqual([true, false]);
    expect(
      writesOf(draw).features.create({
        type: 'Point',
        geometry: { type: 'Point', coordinates: [9, 9] },
      }),
    ).not.toBeNull();
  });

  it('keeps read-only on when it was on before', () => {
    const { draw } = live();
    draw.setReadOnly(true);
    draw.document.setShown(version().store);
    draw.document.setShown(null);
    expect(draw.isReadOnly()).toBe(true);
  });

  it('refuses a load of a document while it is shown', async () => {
    const { draw } = live();
    draw.document.setShown(version().store);
    const result = await writesOf(draw).document.load({
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [1, 1] } },
      ],
    });
    expect(result).toBeNull();
  });

  it('still takes the changes from elsewhere', () => {
    const { draw, store, writer } = live();
    draw.document.setShown(version().store);
    // A layer and a row written by a transaction from elsewhere
    store.transact(() => {
      store.createLayer(layer('more', true));
      writer.writeRows({
        handles: Int32Array.of(store.tables?.getRowRef('p1') ?? -1),
        fields: new Map([['properties:n', [7]]]),
      });
    }, 'remote');
    expect(draw.layers.has('more')).toBe(true);
    expect(writesOf(draw).features.get('p1')?.properties).toEqual({ n: 7 });
  });

  it('leaves a drawing mode for the select mode and gives the input to the map only', () => {
    const { draw, engine } = live();
    const input = createSyntheticInput(engine);
    // A click on a feature selects it while the document is shown
    input.click([1, 0]);
    expect(draw.selection.value.ids).toEqual(['p1']);
    draw.selection.clear();
    draw.setMode('draw_point');
    draw.document.setShown(version().store);
    expect(draw.getMode()).toBe('select');
    // A click is not taken: the map pans and zooms as it does
    input.click([1, 0]);
    expect(draw.selection.value.ids).toEqual([]);
    draw.document.setShown(null);
    input.click([1, 0]);
    expect(draw.selection.value.ids).toEqual(['p1']);
  });

  it('counts the memory of the document shown', () => {
    const { draw } = live();
    const before = draw.memory.get().jsBytes;
    const other = version().store;
    draw.document.setShown(other);
    const shown = draw.memory.get().jsBytes;
    expect(shown - before).toBe(draw.memory.estimate({ features: 5, positions: 5 }).jsBytes);
    draw.document.setShown(null);
    expect(draw.memory.get().jsBytes).toBe(before);
  });
});
