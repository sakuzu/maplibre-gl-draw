// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `features.pick`: the features at a point of the screen, from the top, as the frame drawn last
 * shows them
 *
 * - The features under the point come in the stacking order, the one on top first, each once; a
 *   hidden one is not there
 * - A feature a sketch edits is where the sketch draws it, not where it is written
 * - Rows moved as a whole by their state (a drag of many) are where they are drawn
 * - The tolerance is the click tolerance unless one is given; a wrong point is refused
 * - A transaction picks as the instance does
 * - On the terrain a point is where its anchor is drawn, as a click hits it, a sketch and a drag
 *   of many applied
 */

import { afterEach, describe, expect, it } from 'vitest';
import { BULK_MOVE_SET } from '../../feature-table/feature-row-states.js';
import { setAnchorProjector } from '../../shared/math/index.js';
import { MemoryStore } from '../../store/memory.js';
import type { Store } from '../../store/store.js';
import { createTableStore } from '../../store/table-memory.js';
import { writesOf } from '../../test-support/writes.js';
import { createMapStub, internalsOf } from '../../test-utils.js';
import type { Draw } from '../draw.js';
import { DrawError } from '../errors.js';
import type { FeatureGeometry } from '../model.js';
import type { FeatureTables } from '../tables.js';
import { createDrawOnEngine } from './create-draw.js';
import { createEngine, type Engine } from './engine.js';

const opened: Draw[] = [];
afterEach(() => {
  for (const draw of opened.splice(0)) draw.destroy();
});

/** An instance with a layer `l`, the map laying 100 px on a degree around [0, 0] */
function open(rows = false): { draw: Draw; engine: Engine; store: Store } {
  const store = rows ? createTableStore().store : new MemoryStore();
  store.createLayer({
    id: 'l',
    name: 'l',
    visible: true,
    locked: false,
    opacity: 1,
    ...(store.tables ? { kind: 'table' } : { items: [] }),
    styleRule: undefined,
    metadata: undefined,
  } as never);
  const engine = createEngine(
    createMapStub().map,
    { store, initDefaultLayer: false },
    { deferDefaultMode: true },
  );
  const draw = createDrawOnEngine(engine, { store, initDefaultLayer: false });
  engine.enterDefaultMode();
  opened.push(draw);
  return { draw, engine, store };
}

function create(draw: Draw, id: string, geometry: FeatureGeometry): void {
  writesOf(draw).features.create({ id, type: geometry.type, geometry, layerId: 'l' });
}

const square = (x: number, y: number, half: number): FeatureGeometry => ({
  type: 'Polygon',
  coordinates: [
    [
      [x - half, y - half],
      [x + half, y - half],
      [x + half, y + half],
      [x - half, y + half],
      [x - half, y - half],
    ],
  ],
});

/** The IDs picked at a position */
function pickedAt(draw: Draw, engine: Engine, at: [number, number]): string[] {
  const { x, y } = engine.map.project(at);
  return draw.features.pick([x, y]).map((hit) => hit.feature.id);
}

describe('features.pick', () => {
  for (const rows of [false, true]) {
    const store = rows ? 'a Store of rows' : 'a Store of objects';

    it(`gives the features under the point from the top, a hidden one left out (${store})`, () => {
      const { draw, engine } = open(rows);
      create(draw, 'below', square(0, 0, 1));
      create(draw, 'middle', square(0, 0, 0.5));
      create(draw, 'top', { type: 'Point', coordinates: [0, 0] });
      create(draw, 'away', { type: 'Point', coordinates: [3, 3] });
      expect(pickedAt(draw, engine, [0, 0])).toEqual(['top', 'middle', 'below']);
      expect(pickedAt(draw, engine, [0.8, 0])).toEqual(['below']);
      writesOf(draw).features.update('middle', { visible: false });
      expect(pickedAt(draw, engine, [0, 0])).toEqual(['top', 'below']);
      draw.hidden.add('top');
      expect(pickedAt(draw, engine, [0, 0])).toEqual(['below']);
    });

    it(`gives a feature a sketch edits where the sketch draws it (${store})`, () => {
      const { draw, engine } = open(rows);
      create(draw, 'area', square(0, 0, 1));
      create(draw, 'moved', { type: 'Point', coordinates: [0, 0] });
      draw.sketches.add({
        edits: [{ kind: 'translate', target: { featureIds: ['moved'] }, from: [0, 0], to: [3, 0] }],
      });
      // Where it is written, only what is under it
      expect(pickedAt(draw, engine, [0, 0])).toEqual(['area']);
      // Where it is drawn, as it is drawn
      const { x, y } = engine.map.project([3, 0]);
      const hits = draw.features.pick([x, y]);
      expect(hits.map((hit) => hit.feature.id)).toEqual(['moved']);
      expect(hits[0]?.feature.geometry).toEqual({
        type: 'Point',
        coordinates: [expect.closeTo(3, 9), expect.closeTo(0, 9)],
      });
      // In its place in the order: above the area once it is drawn over it again
      draw.sketches.update(draw.sketches.list()[0]?.id as string, {
        edits: [
          { kind: 'translate', target: { featureIds: ['moved'] }, from: [0, 0], to: [0.5, 0] },
        ],
      });
      expect(pickedAt(draw, engine, [0.5, 0])).toEqual(['moved', 'area']);
    });
  }

  it('gives the rows moved as a whole by their state where they are drawn', () => {
    const { draw, engine, store } = open(true);
    create(draw, 'area', square(0, 0, 1));
    create(draw, 'p0', { type: 'Point', coordinates: [0, 0] });
    create(draw, 'p1', { type: 'Point', coordinates: [0.5, 0.5] });
    const tables = store.tables as FeatureTables;
    const states = internalsOf(tables).states;
    states.setMoving(
      Int32Array.of(tables.getRowRef('p0') as number, tables.getRowRef('p1') as number),
      BULK_MOVE_SET,
    );
    states.setTranslation(BULK_MOVE_SET, 3, 0);
    expect(pickedAt(draw, engine, [0, 0])).toEqual(['area']);
    expect(pickedAt(draw, engine, [3, 0])).toEqual(['p0']);
    const { x, y } = engine.map.project([3.5, 0.5]);
    const [hit] = draw.features.pick([x, y]);
    expect(hit?.feature.id).toBe('p1');
    expect(hit?.feature.geometry).toEqual({
      type: 'Point',
      coordinates: [expect.closeTo(3.5, 9), expect.closeTo(0.5, 9)],
    });
  });

  it('hits as far as the tolerance given', () => {
    const { draw, engine } = open();
    create(draw, 'p', { type: 'Point', coordinates: [0, 0] });
    const { x, y } = engine.map.project([0, 0]);
    // 30 px off: farther than the click tolerance and the marker
    expect(draw.features.pick([x + 30, y]).map((hit) => hit.feature.id)).toEqual([]);
    expect(
      draw.features.pick({ x: x + 30, y }, { tolerancePixels: 40 }).map((hit) => hit.feature.id),
    ).toEqual(['p']);
    // The tolerance of the instance is the same after
    expect(draw.features.pick([x + 30, y])).toEqual([]);
  });

  it('refuses a point or a tolerance of the wrong shape', () => {
    const { draw } = open();
    for (const point of [null, [1], [Number.NaN, 0], { x: 1 }]) {
      expect(() => draw.features.pick(point as never)).toThrow(DrawError);
    }
    expect(() => draw.features.pick([0, 0], { tolerancePixels: -1 })).toThrow(DrawError);
    expect(() => draw.features.pick([0, 0], { tolerance: 1 } as never)).toThrow(DrawError);
  });

  it('picks the same in a transaction', async () => {
    const { draw, engine } = open();
    create(draw, 'p', { type: 'Point', coordinates: [0, 0] });
    const { x, y } = engine.map.project([0, 0]);
    const ids = await draw.write((tx) => tx.features.pick([x, y]).map((hit) => hit.feature.id));
    expect(ids).toEqual(['p']);
  });
});

describe('features.pick on the terrain', () => {
  /**
   * The anchors drawn 2 degrees west of where they stand on the screen (as the ground lifts them),
   * the projection the click hits the points with
   */
  function lift(engine: Engine): void {
    const map = engine.map;
    setAnchorProjector(map, {
      project: (lng, lat) => map.project([lng - 2, lat]),
      searchBoxes: (x, y, reachPx) => {
        const { lng, lat } = map.unproject([x, y]);
        const by = reachPx / 100 + 0.01;
        return [lng + 2 - by, lat - by, lng + 2 + by, lat + by];
      },
    });
  }

  for (const rows of [false, true]) {
    const store = rows ? 'a Store of rows' : 'a Store of objects';

    it(`gives a point where its anchor is drawn, a sketch applied (${store})`, () => {
      const { draw, engine } = open(rows);
      create(draw, 'drawn', { type: 'Point', coordinates: [2, 0] });
      create(draw, 'standing', { type: 'Point', coordinates: [0, 0] });
      lift(engine);
      // Not the point standing at the coordinate of the click, drawn elsewhere
      expect(pickedAt(draw, engine, [0, 0])).toEqual(['drawn']);
      draw.sketches.add({
        edits: [{ kind: 'translate', target: { featureIds: ['drawn'] }, from: [2, 0], to: [3, 0] }],
      });
      expect(pickedAt(draw, engine, [0, 0])).toEqual([]);
      expect(pickedAt(draw, engine, [1, 0])).toEqual(['drawn']);
    });
  }

  it('gives the points of rows moved as a whole where their anchors are drawn', () => {
    const { draw, engine, store } = open(true);
    create(draw, 'drawn', { type: 'Point', coordinates: [2, 0] });
    create(draw, 'standing', { type: 'Point', coordinates: [0, 0] });
    lift(engine);
    const tables = store.tables as FeatureTables;
    const states = internalsOf(tables).states;
    states.setMoving(Int32Array.of(tables.getRowRef('drawn') as number), BULK_MOVE_SET);
    states.setTranslation(BULK_MOVE_SET, 1, 0);
    expect(pickedAt(draw, engine, [0, 0])).toEqual([]);
    expect(pickedAt(draw, engine, [1, 0])).toEqual(['drawn']);
  });
});
