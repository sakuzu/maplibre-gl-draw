// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests of the order the drape of the rows keeps among the points drawn between its elements
 * (`TableDrapePainter`), over a frame that records what is drawn
 *
 * - Split by the keys of the points, a layer is drawn in steps, each the keys of the points, a
 *   bound of each pixel and a segment of the drape and of the points, then a last segment,
 *   however many runs of points there are and whatever covers them
 * - Step `s` reads bound `s` from channel `s % 2` and writes bound `s + 1` to the other one
 * - The steps follow the most runs a pixel of the tiles reads, up to their most
 * - Where a tile is deeper than the steps, what is past the last bound is drawn by the breaks
 *   of its deep cells, run by run
 * - The keys of a run are those of its rows in the order of the drape: the place of their
 *   partition from the first one of the layer, and their slot
 * - A run without keys, or with keys the split cannot hold, is a break: what waits is drawn with
 *   the drape up to it, then it is drawn
 * - Without the keys of the points, every run an element after it covers is a break
 */

import { afterEach, describe, expect, it } from 'vitest';
import type { RowsKey, RowsKeyFloor, RowsSegment } from '../renderers/rows/rows-renderer.js';
import type { DrapeBounds } from '../terrain/drape/geometry.js';
import { DRAPE_SPLIT_SLOTS, type DrapeSplitDraw } from '../terrain/drape/renderer.js';
import {
  type TableDrapeFrame,
  type TableDrapeKeys,
  TableDrapePainter,
  type TableDrapeRank,
} from './table-drape.js';

/** What a frame was asked to draw, in order */
type Event =
  | {
      kind: 'tile';
      tile: number;
      from: TableDrapeRank;
      to: TableDrapeRank;
      split: DrapeSplitDraw | null;
    }
  | { kind: 'low' | 'end' | 'enter' | 'leave' }
  | { kind: 'bounds'; channel: number | null }
  | {
      kind: 'keys';
      target: string;
      from: number;
      to: number;
      key: RowsKey;
      floor: RowsKeyFloor | null;
    }
  | { kind: 'segment'; target: string; from: number; to: number; segment: RowsSegment }
  | { kind: 'points'; target: string; from: number; to: number };

/**
 * A frame of tiles of a unit side in a row along x (in Mercator units of 1 / 64), recording
 *
 * @param depth The most runs a pixel of each tile reads
 * @param covers Whether an element after a run covers it in a tile, given the depth asked for
 */
function recordingFrame(
  tiles: number,
  depth: number | readonly number[] = 3,
  covers: (deeperThan: number) => boolean = () => true,
) {
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
        _moving: unknown,
        split: DrapeSplitDraw | null,
      ) {
        events.push({ kind: 'tile', tile: draw.i, from: ranks.from, to: ranks.to, split });
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
      depth: typeof depth === 'number' ? depth : (depth[i] as number),
    })),
    enter: () => events.push({ kind: 'enter' }),
    leave: () => events.push({ kind: 'leave' }),
    drape: {
      layerRange: () => ({ from: [4, 0, 0], to: [7, 0, 0] }),
      keyOf: (rank: TableDrapeRank) => rank[0] * 2 ** 34 + rank[1] * 1024 + rank[2],
      index: {
        coversBox: (
          _tile: unknown,
          _box: unknown,
          _after: number,
          _zoom: number,
          deeperThan?: number,
        ) => covers(deeperThan ?? 0),
      },
    },
    moving: [],
    split: {
      ensure: () => true,
      beginLow: () => events.push({ kind: 'low' }),
      beginBounds: (channel: number | null) => events.push({ kind: 'bounds', channel }),
      end: () => events.push({ kind: 'end' }),
      lowTexture: { low: true },
      boundsTexture: { bounds: true },
    },
  };
  return { frame: frame as unknown as TableDrapeFrame, events };
}

/** The box of a point in the tile `t` of the recording frame */
function boxIn(t: number): DrapeBounds {
  const size = 1 / 64;
  const x = (t + 0.5) * size;
  return { minX: x, minY: size / 2, maxX: x, maxY: size / 2 };
}

/**
 * The keys of the rows of a group of the partition at `place` (row `r` at slot `2r + 1`), each
 * row with a point a run of its own in tile `tile`
 */
function keysOf(
  events: Event[],
  target: string,
  place: number,
  rows: number,
  tile = 0,
): TableDrapeKeys {
  return {
    place,
    mul: 2,
    add: 1,
    lastSlot: 2 * (rows - 1) + 1,
    draw: (from, to, key, floor) => events.push({ kind: 'keys', target, from, to, key, floor }),
    drawSegment: (from, to, _key, segment) =>
      events.push({ kind: 'segment', target, from, to, segment }),
    // The rows with points are the even ones (the odd ones are drawn by the drape)
    eachRun: (from, to, each) => {
      for (let r = from + (from % 2); r < to; r += 2) {
        const rank: TableDrapeRank = [place, 2 * r + 1, 0];
        each(r, r + 1, rank, rank, boxIn(tile), 8);
      }
    },
  };
}

function drawOf(events: Event[], target: string) {
  return (from: number, to: number): void => {
    events.push({ kind: 'points', target, from, to });
  };
}

/** Gives a painter of the frame `runs` runs of one point each, rows `2r` of tile `tile` */
function runPoints(
  painter: TableDrapePainter,
  events: Event[],
  runs: number,
  tile = 0,
  target = 'a',
): void {
  const keys = keysOf(events, target, 5, runs * 2, tile);
  const draw = drawOf(events, target);
  const owner = {};
  for (let r = 0; r < runs; r++) {
    painter.run(
      [5, 4 * r + 1, 0],
      [5, 4 * r + 1, 0],
      boxIn(tile),
      8,
      owner,
      2 * r,
      2 * r + 1,
      draw,
      keys,
    );
  }
}

function tilesOf(events: Event[]): Array<Extract<Event, { kind: 'tile' }>> {
  return events.filter((e) => e.kind === 'tile') as Array<Extract<Event, { kind: 'tile' }>>;
}

afterEach(() => {
  TableDrapePainter.order = 'split';
  TableDrapePainter.steps = 0;
  TableDrapePainter.tail = 'over';
});

describe('the order of the points among the drape of the rows', () => {
  it('splits the drape at the keys of the points in as many draws for any number of runs', () => {
    const counts: number[] = [];
    for (const runs of [10, 1000]) {
      const { frame, events } = recordingFrame(8);
      const painter = new TableDrapePainter();
      expect(painter.begin(frame, 'L', 1, true, true)).toBe(true);
      expect(painter.splits).toBe(true);
      runPoints(painter, events, runs, 2);
      painter.end();
      // The keys of the rows given as the chunk gives them: one draw for its rows per step
      const keyed = events.filter((e) => e.kind === 'keys');
      expect(keyed).toHaveLength(3);
      expect(keyed[0]).toMatchObject({ from: 0, to: runs * 2 - 1 });
      // The key of row r: the place from the first one of the layer, and the slot 2r + 1
      expect((keyed[0] as { key: RowsKey }).key).toEqual({ add: DRAPE_SPLIT_SLOTS + 1, mul: 2 });
      // Three steps (the most runs a pixel reads), each a bound and a segment in every tile,
      // and the last segment
      const tiles = tilesOf(events);
      expect(tiles.filter((e) => e.split?.pass === 'bounds')).toHaveLength(3 * 8);
      expect(tiles.filter((e) => e.split?.pass === 'segment')).toHaveLength(4 * 8);
      // Every pass paints the range of the layer
      for (const e of tiles) {
        expect(e.from).toEqual([4, 0, 0]);
        expect(e.to).toEqual([7, 0, 0]);
      }
      expect(events.filter((e) => e.kind === 'segment')).toHaveLength(4);
      // The points are drawn by their segments, not as they are
      expect(events.filter((e) => e.kind === 'points')).toHaveLength(0);
      expect(painter.breaks).toBe(1);
      expect(painter.steps).toBe(3);
      counts.push(painter.draws + painter.pointDraws);
    }
    expect(counts[1]).toBe(counts[0]);
  });

  it('draws the steps in their order, each bound read from the channel the step before wrote', () => {
    const { frame, events } = recordingFrame(1);
    const painter = new TableDrapePainter();
    painter.begin(frame, 'L', 1, true, true);
    runPoints(painter, events, 1);
    painter.end();
    const order = events
      .filter((e) => ['tile', 'segment', 'keys', 'bounds'].includes(e.kind))
      .map((e) => {
        if (e.kind === 'keys') return `keys${e.floor ? e.floor.at : '-'}`;
        if (e.kind === 'bounds') return `bound${e.channel}`;
        if (e.kind === 'segment') return `points${e.segment.from},${e.segment.to}`;
        const split = (e as { split: DrapeSplitDraw }).split;
        return split.pass === 'bounds' ? 'drape' : `drape${split.from},${split.to}`;
      });
    expect(order).toEqual([
      'keys-',
      'bound1',
      'drape',
      'drape-1,1',
      'points-1,1',
      'keys1',
      'bound0',
      'drape',
      'drape1,0',
      'points1,0',
      'keys0',
      'bound1',
      'drape',
      'drape0,1',
      'points0,1',
      'drape1,-1',
      'points1,-1',
    ]);
  });

  it('takes as many steps as the runs a pixel reads, up to the most it takes', () => {
    for (const [depth, steps] of [
      [0, 1],
      [1, 1],
      [5, 5],
      [100, 8],
    ] as const) {
      const { frame, events } = recordingFrame(2, depth, () => false);
      const painter = new TableDrapePainter();
      painter.begin(frame, 'L', 1, true, true);
      runPoints(painter, events, 4);
      painter.end();
      expect(painter.steps).toBe(steps);
      expect(events.filter((e) => e.kind === 'bounds')).toHaveLength(steps);
    }
  });

  it('leaves a tile out of the steps past the runs its pixels read', () => {
    const { frame, events } = recordingFrame(3, [0, 1, 3], () => false);
    const painter = new TableDrapePainter();
    painter.begin(frame, 'L', 1, true, true);
    runPoints(painter, events, 2);
    painter.end();
    expect(painter.steps).toBe(3);
    const passes = (tile: number) =>
      tilesOf(events)
        .filter((e) => e.tile === tile)
        .map((e) => (e.split?.pass === 'bounds' ? 'b' : `s${e.split?.from},${e.split?.to}`));
    // A tile without runs: its first segment alone (its bound is cleared to none)
    expect(passes(0)).toEqual(['s-1,1']);
    // One run a pixel: a bound, its first segment and the segment past it
    expect(passes(1)).toEqual(['b', 's-1,1', 's1,0']);
    // Three: every step and the last segment
    expect(passes(2)).toEqual(['b', 's-1,1', 'b', 's1,0', 'b', 's0,1', 's1,-1']);
  });

  it('draws what is past the last bound by the breaks of the cells deeper than the steps, when asked', () => {
    TableDrapePainter.tail = 'breaks';
    const asked: number[] = [];
    const { frame, events } = recordingFrame(2, 100, (deeperThan) => {
      asked.push(deeperThan);
      return true;
    });
    const painter = new TableDrapePainter();
    painter.begin(frame, 'L', 1, true, true);
    runPoints(painter, events, 3);
    painter.end();
    // Eight steps, then the runs one by one, each a break in the cells deeper than the steps
    expect(painter.steps).toBe(8);
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.every((d) => d === 8)).toBe(true);
    const past = events.filter(
      (e) => e.kind === 'segment' && e.segment.from === 0 && e.segment.to === -1,
    );
    expect(past.map((e) => [(e as { from: number }).from, (e as { to: number }).to])).toEqual([
      [0, 1],
      [2, 3],
      [4, 5],
    ]);
    // The drape past the last bound painted up to each run in the tile it reaches, then to the
    // end of the layer in both
    const tail = tilesOf(events).filter((e) => e.split?.from === 0 && e.split.to === -1);
    expect(tail.map((e) => `${e.tile}:${e.to.join(',')}`)).toEqual([
      '0:5,1,0',
      '0:5,5,0',
      '0:5,9,0',
      '0:7,0,0',
      '1:7,0,0',
    ]);
    expect(painter.breaks).toBe(4);
  });

  it('draws what is past the last bound as one segment where no cell is deeper', () => {
    TableDrapePainter.tail = 'breaks';
    const { frame, events } = recordingFrame(2, 100, () => false);
    const painter = new TableDrapePainter();
    painter.begin(frame, 'L', 1, true, true);
    runPoints(painter, events, 3);
    painter.end();
    const past = events.filter(
      (e) => e.kind === 'segment' && e.segment.from === 0 && e.segment.to === -1,
    );
    expect(past).toHaveLength(1);
    expect(painter.breaks).toBe(1);
  });

  it('breaks the order at a run without keys, and at one the keys cannot hold', () => {
    const { frame, events } = recordingFrame(1, 1);
    const painter = new TableDrapePainter();
    painter.begin(frame, 'L', 1, true, true);
    runPoints(painter, events, 1);
    // Without keys (a picture of another renderer): what waits is split up to it, then it is
    // drawn
    painter.run([4, 5, 0], [4, 5, 0], boxIn(0), 8, {}, 2, 3, drawOf(events, 'b'), null);
    // A slot past those the keys hold
    const far = { ...keysOf(events, 'c', 4, 1), lastSlot: DRAPE_SPLIT_SLOTS };
    painter.run([4, 7, 0], [4, 7, 0], boxIn(0), 8, {}, 3, 4, drawOf(events, 'c'), far);
    painter.end();
    const drawn = events.filter((e) => e.kind === 'segment' || e.kind === 'points');
    // The two segments of the first run (one step), then the other two as they are
    expect(drawn.map((e) => `${e.kind}:${(e as { target: string }).target}`)).toEqual([
      'segment:a',
      'segment:a',
      'points:b',
      'points:c',
    ]);
    // The drape is painted up to each of them before it is drawn
    const ends = tilesOf(events).map((e) => e.to.join(','));
    expect(ends.slice(-3)).toEqual(['4,5,0', '4,7,0', '7,0,0']);
  });

  it('breaks the order at every covered run without the keys of the points', () => {
    const { frame, events } = recordingFrame(1);
    const painter = new TableDrapePainter();
    painter.begin(frame, 'L', 1, true, false);
    expect(painter.splits).toBe(false);
    for (let r = 0; r < 5; r++) {
      painter.run(
        [4, 2 * r + 1, 0],
        [4, 2 * r + 1, 0],
        boxIn(0),
        8,
        {},
        r,
        r + 1,
        drawOf(events, 'a'),
      );
    }
    painter.end();
    expect(painter.breaks).toBe(5);
    expect(events.filter((e) => e.kind === 'keys')).toHaveLength(0);
  });
});
