// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests of the references of the order the drape of the rows keeps among the points drawn
 * between its elements (`TableDrapePainter`, `each` and `each-near`), over a frame that records
 * what is drawn
 *
 * - Every run of points is a break: the drape is painted up to it, then it is drawn
 * - each paints the drape up to a break in every tile, each-near in the tiles the run meets
 * - The end of a layer paints the drape to its end in every tile
 * - A copy of the world after the first draws the runs alone (the drape is painted once)
 */

import { afterEach, describe, expect, it } from 'vitest';
import type { DrapeBounds } from '../terrain/drape/geometry.js';
import { type TableDrapeFrame, TableDrapePainter, type TableDrapeRank } from './table-drape.js';

/** What a frame was asked to draw, in order */
type Event =
  | { kind: 'tile'; tile: number; from: TableDrapeRank; to: TableDrapeRank }
  | { kind: 'enter' | 'leave' }
  | { kind: 'points'; from: number; to: number };

/** A frame of tiles of a unit side in a row along x (in Mercator units of 1 / 64), recording */
function recordingFrame(tiles: number) {
  const events: Event[] = [];
  const entries = Array.from({ length: tiles }, (_, i) => ({ draw: { i }, projection: {} }));
  const size = 1 / 64;
  const frame = {
    renderer: {
      drawRowsTile(
        draw: { i: number },
        _projection: unknown,
        _light: unknown,
        _zoom: number,
        _dpr: number,
        _opacity: number,
        ranks: { from: TableDrapeRank; to: TableDrapeRank },
      ) {
        events.push({ kind: 'tile', tile: draw.i, from: ranks.from, to: ranks.to });
      },
    },
    light: {},
    zoom: 14,
    dpr: 1,
    tiles: entries.map((entry, i) => ({
      entry,
      tile: { x: i, y: 0, z: 6 },
      box: { minX: i * size, minY: 0, maxX: (i + 1) * size, maxY: size },
      pixels: 512,
      moving: null,
      depth: 0,
    })),
    enter: () => events.push({ kind: 'enter' }),
    leave: () => events.push({ kind: 'leave' }),
    drape: {
      layerRange: () => ({ from: [4, 0, 0], to: [7, 0, 0] }),
      keyOf: (rank: TableDrapeRank) => rank[0] * 2 ** 34 + rank[1] * 1024 + rank[2],
    },
    moving: [],
    inBand: true,
  };
  return { frame: frame as unknown as TableDrapeFrame, events };
}

/** The box of a point in the tile `t` of the recording frame */
function boxIn(t: number): DrapeBounds {
  const size = 1 / 64;
  const x = (t + 0.5) * size;
  return { minX: x, minY: size / 2, maxX: x, maxY: size / 2 };
}

/** Gives a painter `runs` runs of one point each, rows `2r` in tile `tile` */
function runPoints(painter: TableDrapePainter, events: Event[], runs: number, tile = 0): void {
  const draw = (from: number, to: number): void => {
    events.push({ kind: 'points', from, to });
  };
  const owner = {};
  for (let r = 0; r < runs; r++) {
    painter.run([5, 4 * r + 1, 0], boxIn(tile), 8, owner, 2 * r, 2 * r + 1, draw);
  }
}

function tilesOf(events: Event[]): Array<Extract<Event, { kind: 'tile' }>> {
  return events.filter((e) => e.kind === 'tile') as Array<Extract<Event, { kind: 'tile' }>>;
}

afterEach(() => {
  TableDrapePainter.order = 'ground';
});

describe('the references of the order of the drape of the rows', () => {
  it('paints the drape up to every run in every tile, then draws it (each)', () => {
    TableDrapePainter.order = 'each';
    const { frame, events } = recordingFrame(3);
    const painter = new TableDrapePainter();
    expect(painter.begin(frame, 'layer', 1)).toBe(true);
    runPoints(painter, events, 2);
    painter.end();
    // Each run: the three tiles painted up to it, then its points
    const kinds = events.filter((e) => e.kind !== 'enter' && e.kind !== 'leave').map((e) => e.kind);
    expect(kinds).toEqual([
      'tile',
      'tile',
      'tile',
      'points',
      'tile',
      'tile',
      'tile',
      'points',
      'tile',
      'tile',
      'tile',
    ]);
    const tiles = tilesOf(events);
    expect(tiles[0]?.from).toEqual([4, 0, 0]);
    expect(tiles[0]?.to).toEqual([5, 1, 0]);
    expect(tiles[3]?.from).toEqual([5, 1, 0]);
    expect(tiles[3]?.to).toEqual([5, 5, 0]);
    // The end of the layer
    expect(tiles[8]?.to).toEqual([7, 0, 0]);
    expect(painter.breaks).toBe(2);
    expect(painter.draws).toBe(9);
  });

  it('paints the drape up to a run in the tiles it meets (each-near)', () => {
    TableDrapePainter.order = 'each-near';
    const { frame, events } = recordingFrame(3);
    const painter = new TableDrapePainter();
    painter.begin(frame, 'layer', 1);
    runPoints(painter, events, 1, 1);
    painter.end();
    const tiles = tilesOf(events);
    // The tile of the run, then every tile to the end of the layer
    expect(tiles[0]?.tile).toBe(1);
    expect(tiles[0]?.to).toEqual([5, 1, 0]);
    expect(tiles.slice(1).map((t) => t.tile)).toEqual([0, 1, 2]);
    expect(tiles[1]?.from).toEqual([4, 0, 0]);
    expect(tiles[2]?.from).toEqual([5, 1, 0]);
  });

  it('draws the runs alone on a copy of the world after the first', () => {
    TableDrapePainter.order = 'each';
    const { frame, events } = recordingFrame(2);
    const painter = new TableDrapePainter();
    painter.begin(frame, 'layer', 1, false);
    runPoints(painter, events, 2);
    painter.end();
    expect(tilesOf(events)).toHaveLength(0);
    expect(events.filter((e) => e.kind === 'points')).toHaveLength(2);
  });

  it('draws nothing of the drape without a frame', () => {
    const painter = new TableDrapePainter();
    expect(painter.begin(null, 'layer', 1)).toBe(false);
    expect(painter.active).toBe(false);
  });
});
