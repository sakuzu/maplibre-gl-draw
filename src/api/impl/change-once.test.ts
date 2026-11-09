// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * One commit is one `change`, whatever its size: every row of a layer of 57,144 rows moved or
 * colored in bulk, and one feature edited, are each told once, with the IDs of what they changed
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { transformBulkSelection } from '../../operations/bulk-transform.js';
import type { Store } from '../../store/store.js';
import { createTableStore } from '../../store/table-memory.js';
import { createMapStub } from '../../test-utils.js';
import type { Draw } from '../draw.js';
import type { Change } from '../events.js';
import type { FeatureInput } from '../model.js';
import { createDrawOnEngine } from './create-draw.js';
import { createEngine } from './engine.js';

/** The number of points of the map the product is measured on */
const COUNT = 57_144;

let store: Store;
let draw: Draw;
const changes: Change[] = [];

beforeAll(() => {
  store = createTableStore().store;
  store.createLayer({
    id: 'rows',
    name: 'rows',
    visible: true,
    locked: false,
    opacity: 1,
    kind: 'table',
    styleRule: undefined,
    metadata: undefined,
  });
  const engine = createEngine(
    createMapStub().map,
    { store, initDefaultLayer: false },
    { deferDefaultMode: true },
  );
  draw = createDrawOnEngine(engine, { store, initDefaultLayer: false });
  engine.enterDefaultMode();
  const inputs: FeatureInput[] = [];
  for (let i = 0; i < COUNT; i++) {
    inputs.push({
      id: `f${i}`,
      type: 'Point',
      geometry: {
        type: 'Point',
        coordinates: [139 + (i % 300) * 0.001, 35 + Math.floor(i / 300) * 0.001],
      },
      layerId: 'rows',
      properties: { n: i },
    });
  }
  draw.features.createMany(inputs);
  draw.on('change', (change) => changes.push(change));
});

afterAll(() => draw.destroy());

/** The changes told while a function runs */
function told(run: () => void): Change[] {
  changes.length = 0;
  run();
  return [...changes];
}

describe('one change per commit, over a layer of 57,144 rows', () => {
  it('tells every row moved in bulk in one change', () => {
    draw.selection.setAll();
    expect(draw.selection.value.count).toBe(COUNT);
    const moved = told(() =>
      transformBulkSelection(store, { kind: 'translate', from: [139, 35], to: [139.001, 35] }),
    );
    expect(moved).toHaveLength(1);
    expect(moved[0].features.updated).toHaveLength(COUNT);
    expect(moved[0].features.created).toEqual([]);
    expect(moved[0].rows?.layers.get('rows')?.updated).toHaveLength(COUNT);
  });

  it('tells every row colored in bulk in one change', () => {
    draw.selection.setAll();
    const colored = told(() => draw.selection.update({ style: { pointColor: '#ff0000' } }));
    expect(colored).toHaveLength(1);
    expect(colored[0].features.updated).toHaveLength(COUNT);
  });

  it('tells one feature edited in one change, with the feature before it', () => {
    draw.selection.clear();
    const before = draw.features.get('f1');
    const previous: unknown[] = [];
    const stop = draw.on('change', (change) => previous.push(change.previous('f1')));
    const edited = told(() => draw.features.update('f1', { properties: { n: -1 } }));
    stop();
    expect(edited).toHaveLength(1);
    expect(edited[0].features).toEqual({ created: [], updated: ['f1'], deleted: [], placed: [] });
    expect(previous).toEqual([before]);
  });
});
