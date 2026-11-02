// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests of the drape index made of partitions
 *
 * - The runs of a cell are the runs of its partitions in the order of the partitions, each in the
 *   order of its elements: the order of the drape
 * - An index changed partition by partition (elements written, added, taken away, the order of
 *   the partitions changed) holds what an index built afresh from the same partitions holds
 * - A change of an element bins again its partition in the tiles its box touches, and nothing
 *   else: the work does not grow with the elements and the partitions elsewhere
 * - A change of the order of the partitions joins the tiles again without binning anything
 * - The tables of the copies keep a copy's texels when its range moves, and a copy not written is
 *   hidden
 */

import { describe, expect, it } from 'vitest';
import type { Coordinate } from '../../../store/types.js';
import {
  type DrapePartitionElement,
  type DrapeTile,
  drapeCopyRef,
  drapePosition,
} from './binning.js';
import { buildDrapeGeometry, type DrapeBounds } from './geometry.js';
import {
  DRAPE_STATE_HIDDEN,
  DrapeCopyTables,
  type DrapePartitionSource,
  PartitionedDrapeIndex,
} from './partitioned.js';

/** A square element around (x, y) in Mercator units of the world, of a half size */
function square(
  ref: number,
  slot: number,
  x: number,
  y: number,
  half: number,
): DrapePartitionElement {
  const ring: Coordinate[] = [];
  // Mercator to degrees, for the geometry built from longitudes and latitudes
  const lng = (mx: number) => mx * 360 - 180;
  const lat = (my: number) => (Math.atan(Math.sinh(Math.PI * (1 - 2 * my))) * 180) / Math.PI;
  ring.push([lng(x - half), lat(y - half)]);
  ring.push([lng(x + half), lat(y - half)]);
  ring.push([lng(x + half), lat(y + half)]);
  ring.push([lng(x - half), lat(y + half)]);
  const geometry = buildDrapeGeometry([ring], true);
  return {
    ref,
    position: drapePosition(slot),
    kind: 0,
    bounds: { minX: geometry.minX, minY: geometry.minY, maxX: geometry.maxX, maxY: geometry.maxY },
    geometry: () => geometry,
    fill: [1, 0, 0, 1],
    stroke: [0, 0, 0, 1],
    strokeWidthPx: 1,
    source: 0,
    widthZoom: -1,
    selectionKey: '',
  };
}

/** A partition of elements */
function partition(id: number, elements: DrapePartitionElement[]): DrapePartitionSource {
  let bounds: DrapeBounds | null = null;
  for (const e of elements) {
    bounds = bounds
      ? {
          minX: Math.min(bounds.minX, e.bounds.minX),
          minY: Math.min(bounds.minY, e.bounds.minY),
          maxX: Math.max(bounds.maxX, e.bounds.maxX),
          maxY: Math.max(bounds.maxY, e.bounds.maxY),
        }
      : e.bounds;
  }
  return { id, elements, bounds };
}

/** The tiles of a z of a square of the world around (0.5, 0.5) */
function tilesAround(z: number, n: number): DrapeTile[] {
  const out: DrapeTile[] = [];
  const c = 2 ** (z - 1);
  for (let x = c - n; x < c + n; x++) for (let y = c - n; y < c + n; y++) out.push({ x, y, z });
  return out;
}

/**
 * What a cell holds, read from the arrays of the index: per run, its copy, its inside flag and
 * the edges it sweeps
 */
function cellsOf(index: PartitionedDrapeIndex, tile: DrapeTile): string[] {
  const entry = index.entryOf(tile);
  if (!entry) return [];
  const { cells, runs, edges } = index.storage;
  const out: string[] = [];
  for (let c = 0; c < entry.grid * entry.grid; c++) {
    const at = (entry.cellOffset + c) * 4;
    const start = cells.data[at] as number;
    const count = cells.data[at + 1] as number;
    const list: string[] = [];
    for (let r = 0; r < count; r++) {
      const run = (start + r) * 4;
      const edgeStart = runs.data[run + 1] as number;
      const edgeCount = runs.data[run + 2] as number;
      const swept: number[] = [];
      for (let e = 0; e < edgeCount; e++) {
        for (let k = 0; k < 4; k++) swept.push(edges.data[(edgeStart + e) * 4 + k] as number);
      }
      list.push(`${runs.data[run]}:${runs.data[run + 3]}:${swept.join(',')}`);
    }
    out.push(list.join('|'));
  }
  return out;
}

/** A random generator from a seed */
function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

describe('the drape index made of partitions', () => {
  const tiles = tilesAround(10, 2);

  it('joins the runs of a cell in the order of the partitions, each in the order of its elements', () => {
    const index = new PartitionedDrapeIndex();
    // Two partitions over the same place: the second is drawn over the first
    const a = partition(0, [
      square(drapeCopyRef(0, 1), 1, 0.5, 0.5, 0.001),
      square(drapeCopyRef(0, 2), 3, 0.5, 0.5, 0.0005),
    ]);
    const b = partition(1, [square(drapeCopyRef(1, 7), 1, 0.5, 0.5, 0.0008)]);
    index.setPartition(a, null);
    index.setPartition(b, null);
    index.setOrder([1, 0]);
    index.prepare(tiles, Number.POSITIVE_INFINITY, 10);
    const orderOf = (ref: number) =>
      [drapeCopyRef(1, 7), drapeCopyRef(0, 1), drapeCopyRef(0, 2)].indexOf(ref);
    let seen = 0;
    for (const tile of tiles) {
      for (const cell of cellsOf(index, tile)) {
        if (cell === '') continue;
        const refs = cell.split('|').map((run) => Number(run.split(':')[0]));
        const places = refs.map(orderOf);
        expect(places).toEqual([...places].sort((x, y) => x - y));
        seen += refs.length;
      }
    }
    expect(seen).toBeGreaterThan(0);
  });

  it('holds what an index built afresh holds, whatever is changed partition by partition', () => {
    for (const seed of [1, 2, 3]) {
      const random = seeded(seed);
      const index = new PartitionedDrapeIndex();
      const sources = new Map<number, DrapePartitionElement[]>();
      let nextRef = 0;
      const randomElement = (slot: number): DrapePartitionElement =>
        square(
          drapeCopyRef(0, nextRef++),
          slot,
          0.5 + (random() - 0.5) * 0.006,
          0.5 + (random() - 0.5) * 0.006,
          0.00005 + random() * 0.0004,
        );
      for (let p = 0; p < 5; p++) {
        const list = Array.from({ length: 20 }, (_, i) => randomElement(2 * i + 1));
        sources.set(p, list);
        index.setPartition(partition(p, list), null);
      }
      let order = [0, 1, 2, 3, 4];
      index.setOrder(order);
      index.prepare(tiles, Number.POSITIVE_INFINITY, 10);
      for (let step = 0; step < 40; step++) {
        const pick = random();
        const p = Math.floor(random() * 5);
        const list = sources.get(p) as DrapePartitionElement[];
        if (pick < 0.5 && list.length > 0) {
          // An element written: moved and resized
          const i = Math.floor(random() * list.length);
          const old = list[i] as DrapePartitionElement;
          const moved = square(
            old.ref,
            Math.floor(old.position / 2 ** 16),
            0.5 + (random() - 0.5) * 0.006,
            0.5 + (random() - 0.5) * 0.006,
            0.0002,
          );
          const next = list.slice();
          next[i] = moved;
          sources.set(p, next);
          index.setPartition(partition(p, next), [old.bounds, moved.bounds]);
        } else if (pick < 0.7) {
          // An element added at the end
          const added = randomElement(2 * list.length + 41);
          const next = [...list, added];
          sources.set(p, next);
          index.setPartition(partition(p, next), [added.bounds]);
        } else if (pick < 0.85 && list.length > 0) {
          // An element taken away
          const i = Math.floor(random() * list.length);
          const gone = list[i] as DrapePartitionElement;
          const next = list.filter((_, k) => k !== i);
          sources.set(p, next);
          index.setPartition(partition(p, next), [gone.bounds]);
        } else {
          order = [...order].sort(() => random() - 0.5);
          index.setOrder(order);
        }
        if (random() < 0.5) index.prepare(tiles, Number.POSITIVE_INFINITY, 10);
      }
      index.prepare(tiles, Number.POSITIVE_INFINITY, 10);

      const fresh = new PartitionedDrapeIndex();
      for (const [p, list] of sources) fresh.setPartition(partition(p, list), null);
      fresh.setOrder(order);
      fresh.prepare(tiles, Number.POSITIVE_INFINITY, 10);
      const runs = tiles.flatMap((tile) => cellsOf(fresh, tile)).filter((c) => c !== '');
      expect(runs.length).toBeGreaterThan(10);
      for (const tile of tiles) {
        expect(cellsOf(index, tile), `seed ${seed}, tile ${tile.x}/${tile.y}`).toEqual(
          cellsOf(fresh, tile),
        );
      }
    }
  });

  it('bins again only the partition of an element written, in the tiles its box touches', () => {
    const work = (partitions: number): number => {
      const index = new PartitionedDrapeIndex();
      const wide = tilesAround(12, 4);
      for (let p = 0; p < partitions; p++) {
        const list: DrapePartitionElement[] = [];
        for (let i = 0; i < 40; i++) {
          list.push(
            square(
              drapeCopyRef(0, p * 40 + i),
              2 * i + 1,
              0.5 + ((i % 8) - 4) * 0.0002,
              0.5 + (Math.floor(i / 8) - 2) * 0.0002,
              0.00003,
            ),
          );
        }
        index.setPartition(partition(p, list), null);
      }
      index.setOrder(Array.from({ length: partitions }, (_, p) => p));
      index.prepare(wide, Number.POSITIVE_INFINITY, 12);
      const before = index.binCount;
      // One element of the first partition moves a little, within one tile
      const source = index.partition(0) as DrapePartitionSource;
      const old = source.elements[0] as DrapePartitionElement;
      const moved = square(old.ref, 1, 0.5 - 4 * 0.0002 + 0.00001, 0.5 - 2 * 0.0002, 0.00003);
      const next = [moved, ...source.elements.slice(1)];
      index.setPartition(partition(0, next), [old.bounds, moved.bounds]);
      index.prepare(wide, Number.POSITIVE_INFINITY, 12);
      return index.binCount - before;
    };
    const few = work(2);
    const many = work(20);
    expect(few).toBeGreaterThan(0);
    expect(few).toBeLessThanOrEqual(4);
    expect(many).toBe(few);
  });

  it('joins the tiles again for a new order of the partitions, binning nothing', () => {
    const index = new PartitionedDrapeIndex();
    index.setPartition(partition(0, [square(drapeCopyRef(0, 0), 1, 0.5, 0.5, 0.001)]), null);
    index.setPartition(partition(1, [square(drapeCopyRef(0, 1), 1, 0.5, 0.5, 0.0007)]), null);
    index.setOrder([0, 1]);
    index.prepare(tiles, Number.POSITIVE_INFINITY, 10);
    const before = index.binCount;
    const revision = index.revision;
    index.setOrder([1, 0]);
    index.prepare(tiles, Number.POSITIVE_INFINITY, 10);
    expect(index.binCount).toBe(before);
    expect(index.revision).toBeGreaterThan(revision);
    const cell = cellsOf(index, { x: 512, y: 512, z: 10 }).find((c) => c.includes('|')) as string;
    expect(cell.split('|').map((run) => Number(run.split(':')[0]))).toEqual([
      drapeCopyRef(0, 1),
      drapeCopyRef(0, 0),
    ]);
  });

  it('tells the highest key in the order of what a tile holds in a box', () => {
    const index = new PartitionedDrapeIndex();
    index.setPartition(partition(0, [square(drapeCopyRef(0, 0), 5, 0.5005, 0.5005, 0.0001)]), null);
    index.setOrder([0]);
    index.prepare(tiles, Number.POSITIVE_INFINITY, 10);
    const tile = { x: 512, y: 512, z: 10 };
    const over = { minX: 0.5004, minY: 0.5004, maxX: 0.5006, maxY: 0.5006 };
    const away = { minX: 0.5009, minY: 0.5009, maxX: 0.50095, maxY: 0.50095 };
    expect(index.maxKeyIn(tile, over)).toBe(index.rankKey(0, drapePosition(5)));
    expect(index.maxKeyIn(tile, away)).toBe(Number.NEGATIVE_INFINITY);
  });
});

describe('the tables of the copies', () => {
  it('keeps the texels of a range when it moves to grow, and hides the copies not written', () => {
    const tables = new DrapeCopyTables();
    const style = {
      fill: [0.1, 0.2, 0.3, 1] as const,
      stroke: [0, 0, 0, 1] as const,
      strokeWidthPx: 2,
      kind: 0 as const,
      source: 0,
      widthZoom: -1,
      dash: null,
    };
    tables.setStyle(1, 3, style);
    tables.setRank(1, 3, 9, drapePosition(7, 2), 0);
    const id = tables.id;
    const base = tables.rankBase[1] as number;
    // Far past the room of the range: it moves
    tables.setRank(1, 50_000, 9, drapePosition(1), 0);
    expect(tables.id).not.toBe(id);
    expect(tables.rankBase[1]).not.toBe(base);
    const at = ((tables.rankBase[1] as number) + 3) * 4;
    expect(Array.from(tables.ranks.data.subarray(at, at + 4))).toEqual([9, 7, 2, 0]);
    const styleAt = ((tables.styleBase[1] as number) + 3 * 5) * 4;
    expect(tables.styles.data[styleAt]).toBeCloseTo(0.1);
    expect(tables.stateOf(1, 4)).toBe(DRAPE_STATE_HIDDEN);
    tables.clear(1, 3);
    expect(tables.stateOf(1, 3)).toBe(DRAPE_STATE_HIDDEN);
  });
});
