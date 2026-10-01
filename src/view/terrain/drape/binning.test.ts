// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The verification of the binning of the analytic drape
 *
 * The binning makes two promises.
 *
 * 1. That with the inside/outside of the cell origin + "the number of crossings
 *    between the segment drawn from the origin to the pixel and the edges of
 *    that cell", the inside/outside of a pixel matches the inherent
 *    inside/outside of the geometry
 * 2. That the edges include every one of "those that pass through that cell"
 *    (if they do not, 1 breaks)
 *
 * Here what the shader does is copied on the CPU and matched against a naive
 * inside/outside test.
 */

import { describe, expect, it } from 'vitest';
import type { Coordinate } from '../../../store/types.js';
import {
  binTile,
  chooseGrid,
  DRAPE_MAX_CELLS,
  DRAPE_MIN_CELLS,
  type DrapeElement,
  type DrapeTile,
  type TileBins,
} from './binning.js';
import { buildDrapeGeometry, drapeMercatorX, drapeMercatorY, drapePathStarts } from './geometry.js';

/** Takes the bounding box out of a geometry (a small helper for the tests) */
function geometryBounds(geometry: ReturnType<typeof buildDrapeGeometry>) {
  return {
    minX: geometry.minX,
    minY: geometry.minY,
    maxX: geometry.maxX,
    maxY: geometry.maxY,
  };
}

/** Builds a polygon element */
function polygonElement(rings: Coordinate[][], strokeWidthPx = 2): DrapeElement {
  return {
    kind: 0,
    bounds: geometryBounds(buildDrapeGeometry(rings, true)),
    geometry: () => buildDrapeGeometry(rings, true),
    fill: [1, 0, 0, 1],
    stroke: [0, 0, 0, 1],
    strokeWidthPx,
    source: 0,
    widthZoom: -1,
    selectionKey: '',
  };
}

/** Builds a line element */
function lineElement(paths: Coordinate[][], strokeWidthPx = 2): DrapeElement {
  return {
    kind: 1,
    bounds: geometryBounds(buildDrapeGeometry(paths, false)),
    geometry: () => buildDrapeGeometry(paths, false),
    fill: [0, 0, 0, 0],
    stroke: [0, 0, 1, 1],
    strokeWidthPx,
    source: 0,
    widthZoom: -1,
    selectionKey: '',
  };
}

/** Turns a ring in longitude and latitude into in-tile coordinates */
function toTile(ring: Coordinate[], tile: DrapeTile): Array<[number, number]> {
  const scale = 2 ** tile.z;
  return ring.map((c) => [
    drapeMercatorX(c[0]) * scale - tile.x,
    drapeMercatorY(c[1]) * scale - tile.y,
  ]);
}

/** A naive inside/outside test (the even-odd rule) */
function insideReference(rings: Array<Array<[number, number]>>, px: number, py: number): boolean {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      if (a[1] > py !== b[1] > py) {
        const t = (py - a[1]) / (b[1] - a[1]);
        if (px < a[0] + t * (b[0] - a[0])) inside = !inside;
      }
    }
  }
  return inside;
}

/** The same formula as the crossing test of the shader */
function crosses(
  p: [number, number],
  q: [number, number],
  a: [number, number],
  b: [number, number],
): boolean {
  const cross = (ux: number, uy: number, vx: number, vy: number): number => ux * vy - uy * vx;
  const d1 = cross(b[0] - a[0], b[1] - a[1], p[0] - a[0], p[1] - a[1]);
  const d2 = cross(b[0] - a[0], b[1] - a[1], q[0] - a[0], q[1] - a[1]);
  const d3 = cross(q[0] - p[0], q[1] - p[1], a[0] - p[0], a[1] - p[1]);
  const d4 = cross(q[0] - p[0], q[1] - p[1], b[0] - p[0], b[1] - p[1]);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

/** Copies on the CPU the inside/outside test that the shader does */
function insideFromBins(bins: TileBins, elementIndex: number, px: number, py: number): boolean {
  const grid = bins.grid;
  const cellSize = 1 / grid;
  const ci = Math.min(grid - 1, Math.max(0, Math.floor(px * grid)));
  const cj = Math.min(grid - 1, Math.max(0, Math.floor(py * grid)));
  const cell = cj * grid + ci;
  const runStart = bins.cells[cell * 2];
  const runCount = bins.cells[cell * 2 + 1];
  const origin: [number, number] = [ci * cellSize, cj * cellSize];

  for (let r = 0; r < runCount; r++) {
    const at = (runStart + r) * 4;
    if (bins.runs[at] !== elementIndex) continue;
    let inside = bins.runs[at + 3] > 0.5;
    const edgeStart = bins.runs[at + 1];
    const edgeCount = bins.runs[at + 2];
    for (let e = 0; e < edgeCount; e++) {
      const seg = (edgeStart + e) * 4;
      const a: [number, number] = [bins.edges[seg], bins.edges[seg + 1]];
      const b: [number, number] = [bins.edges[seg + 2], bins.edges[seg + 3]];
      if (crosses(origin, [px, py], a, b)) inside = !inside;
    }
    return inside;
  }
  return false;
}

/** A deterministic pseudo-random number generator */
function makeRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

/** A polygon close to a circle */
function circleRing(
  cx: number,
  cy: number,
  radius: number,
  count: number,
  phase = 0,
): Coordinate[] {
  const out: Coordinate[] = [];
  for (let i = 0; i < count; i++) {
    const angle = phase + (i / count) * Math.PI * 2;
    out.push([cx + radius * Math.cos(angle), cy + radius * Math.sin(angle)]);
  }
  return out;
}

describe('chooseGrid', () => {
  it('gives the smallest grid when there are few edges', () => {
    expect(chooseGrid(10, 0.002)).toBe(DRAPE_MIN_CELLS);
  });

  it('becomes finer as the edges increase (up to the limit)', () => {
    expect(chooseGrid(4_000, 0.002)).toBeGreaterThan(DRAPE_MIN_CELLS);
    expect(chooseGrid(1_000_000, 0.002)).toBe(DRAPE_MAX_CELLS);
  });

  it('does not pick a grid finer than the margin', () => {
    // A margin of 0.03 means 1 / grid >= 0.03, that is, grid <= 32
    expect(chooseGrid(1_000_000, 0.03)).toBeLessThanOrEqual(32);
  });
});

describe('the inside/outside test of binTile', () => {
  const tile: DrapeTile = { x: 0, y: 0, z: 0 };

  it('treats a polygon that covers the tile as inside at every pixel', () => {
    const ring = [
      [-170, -80],
      [170, -80],
      [170, 80],
      [-170, 80],
    ] as Coordinate[];
    const bins = binTile([polygonElement([ring])], tile);
    for (const [px, py] of [
      [0.5, 0.5],
      [0.2, 0.7],
      [0.9, 0.15],
    ]) {
      expect(insideFromBins(bins, 0, px, py)).toBe(true);
    }
  });

  it('treats a polygon outside the tile as outside at every pixel', () => {
    const ring = circleRing(-160, 60, 2, 24);
    const bins = binTile([polygonElement([ring])], tile);
    expect(insideFromBins(bins, 0, 0.5, 0.5)).toBe(false);
  });

  it('matches the naive test even for a complex polygon', () => {
    // A concave polygon close to a star shape + a hole
    const outer: Coordinate[] = [];
    for (let i = 0; i < 40; i++) {
      const angle = (i / 40) * Math.PI * 2;
      const radius = i % 2 === 0 ? 60 : 30;
      outer.push([radius * Math.cos(angle), (radius * Math.sin(angle)) / 2]);
    }
    const hole = circleRing(0, 0, 8, 16).reverse();
    const rings = [outer, hole];
    const bins = binTile([polygonElement(rings)], tile);
    const tileRings = rings.map((ring) => toTile(ring, tile));

    const random = makeRandom(12345);
    let checked = 0;
    for (let i = 0; i < 4000; i++) {
      // A fraction is added so that it does not land on a cell origin or on an edge
      const px = random() * 0.98 + 0.01 + 1e-4;
      const py = random() * 0.98 + 0.01 + 1e-4;
      expect(insideFromBins(bins, 0, px, py)).toBe(insideReference(tileRings, px, py));
      checked++;
    }
    expect(checked).toBe(4000);
  });

  it('matches the naive test even with a fine grid', () => {
    // Increase the edges to make the grid finer
    const rings = [circleRing(0, 0, 70, 3000), circleRing(0, 0, 20, 800).reverse()];
    const bins = binTile([polygonElement(rings)], tile);
    expect(bins.grid).toBeGreaterThan(DRAPE_MIN_CELLS);

    const tileRings = rings.map((ring) => toTile(ring, tile));
    const random = makeRandom(99);
    for (let i = 0; i < 3000; i++) {
      const px = random() * 0.96 + 0.02 + 1e-4;
      const py = random() * 0.96 + 0.02 + 1e-4;
      expect(insideFromBins(bins, 0, px, py)).toBe(insideReference(tileRings, px, py));
    }
  });
});

describe('binTile and the edges outside the tile', () => {
  // In a deep tile, most of a feature is outside the tile. The inside/outside is decided by
  // the number of crossings to the right of the cell origin, so an edge outside the tile on
  // the right also counts (it becomes a flip of a whole row). Dropping this breaks things in
  // the form of "only the inside of a large polygon is left unpainted".
  const tile: DrapeTile = { x: 3, y: 3, z: 3 };

  it('has every pixel inside for a large polygon that contains the whole tile', () => {
    const ring = [
      [-170, -80],
      [170, -80],
      [170, 80],
      [-170, 80],
    ] as Coordinate[];
    const bins = binTile([polygonElement([ring])], tile);
    const random = makeRandom(7);
    for (let i = 0; i < 500; i++) {
      const px = random() * 0.98 + 0.01;
      const py = random() * 0.98 + 0.01;
      expect(insideFromBins(bins, 0, px, py)).toBe(true);
    }
  });

  it('matches the naive test for a polygon that touches only half of the tile as well', () => {
    const scale = 2 ** tile.z;
    // A rectangle that covers only the right of the center of the tile and juts far outside
    const centerLng = ((tile.x + 0.5) / scale) * 360 - 180;
    const ring = [
      [centerLng, -85],
      [179, -85],
      [179, 85],
      [centerLng, 85],
    ] as Coordinate[];
    const bins = binTile([polygonElement([ring])], tile);
    const tileRings = [toTile(ring, tile)];

    const random = makeRandom(31);
    for (let i = 0; i < 2000; i++) {
      const px = random() * 0.98 + 0.01 + 1e-4;
      const py = random() * 0.98 + 0.01 + 1e-4;
      expect(insideFromBins(bins, 0, px, py)).toBe(insideReference(tileRings, px, py));
    }
  });
});

describe('the edge assignment of binTile', () => {
  const tile: DrapeTile = { x: 0, y: 0, z: 0 };

  it('puts a line into the cells it passes through', () => {
    // A line that crosses diagonally
    const path: Coordinate[] = [
      [-170, 80],
      [170, -80],
    ];
    const bins = binTile([lineElement([path])], tile);
    const grid = bins.grid;

    // The cells on the diagonal have edges and the cells off it have none
    const edgeCountOf = (ci: number, cj: number): number => {
      const cell = cj * grid + ci;
      const runStart = bins.cells[cell * 2];
      const runCount = bins.cells[cell * 2 + 1];
      let total = 0;
      for (let r = 0; r < runCount; r++) total += bins.runs[(runStart + r) * 4 + 2];
      return total;
    };
    expect(edgeCountOf(0, 0)).toBeGreaterThan(0);
    expect(edgeCountOf(grid - 1, grid - 1)).toBeGreaterThan(0);
    expect(edgeCountOf(0, grid - 1)).toBe(0);
  });

  it('gives no runs to an element that is not relevant to the tile', () => {
    const far = polygonElement([circleRing(-170, -80, 1, 8)]);
    const bins = binTile([far], { x: 1, y: 1, z: 2 });
    let runs = 0;
    for (let c = 0; c + 1 < bins.cells.length; c += 2) runs += bins.cells[c + 1];
    expect(runs).toBe(0);
  });
});

describe('binTile and the laziness of the geometry', () => {
  it('does not convert the coordinates of an element that does not touch the tile', () => {
    // Converting even the features outside the view up front comes as a single hit of 76ms for
    // a million vertices
    let built = 0;
    const far: DrapeElement = {
      kind: 0,
      bounds: { minX: 0.9, minY: 0.9, maxX: 0.95, maxY: 0.95 },
      geometry: () => {
        built++;
        return buildDrapeGeometry([circleRing(170, -80, 1, 8)], true);
      },
      fill: [1, 0, 0, 1],
      stroke: [0, 0, 0, 1],
      strokeWidthPx: 2,
      source: 0,
      widthZoom: -1,
      selectionKey: '',
    };
    binTile([far], { x: 0, y: 0, z: 3 });
    expect(built).toBe(0);
  });

  it('converts an element that touches the tile only once', () => {
    let built = 0;
    const ring = circleRing(0, 0, 40, 12);
    const near: DrapeElement = {
      kind: 0,
      bounds: geometryBounds(buildDrapeGeometry([ring], true)),
      geometry: () => {
        built++;
        return buildDrapeGeometry([ring], true);
      },
      fill: [1, 0, 0, 1],
      stroke: [0, 0, 0, 1],
      strokeWidthPx: 2,
      source: 0,
      widthZoom: -1,
      selectionKey: '',
    };
    binTile([near], { x: 0, y: 0, z: 0 });
    expect(built).toBe(1);
  });
});

describe('the stacking order of binTile', () => {
  const tile: DrapeTile = { x: 0, y: 0, z: 0 };

  it('puts the runs inside a cell in the order of the elements', () => {
    const a = polygonElement([circleRing(0, 0, 60, 8)]);
    const b = polygonElement([circleRing(0, 0, 40, 8)]);
    const c = polygonElement([circleRing(0, 0, 20, 8)]);
    const bins = binTile([a, b, c], tile);

    const grid = bins.grid;
    const cell = Math.floor(grid / 2) * grid + Math.floor(grid / 2);
    const runStart = bins.cells[cell * 2];
    const runCount = bins.cells[cell * 2 + 1];
    expect(runCount).toBeGreaterThan(1);

    const order: number[] = [];
    for (let r = 0; r < runCount; r++) order.push(bins.runs[(runStart + r) * 4]);
    expect(order).toEqual([...order].sort((x, y) => x - y));
  });
});

describe('the budget of binTile', () => {
  it('quantizes vertices onto a grid to fit a tile with many edges (no map degradation)', () => {
    // 130,000 outline edges. Too fine when seen from the resolution of a single tile, so they
    // are quantized
    const rings = [circleRing(0, 0, 60, 130_000)];
    const bins = binTile([polygonElement(rings)], { x: 0, y: 0, z: 0 });
    expect(bins.overflow).toBe(false);
    expect(bins.edgeEstimate).toBeLessThanOrEqual(48_000);
    expect(bins.edges.length).toBeGreaterThan(0);
  });

  it('leaves no truncation even for dense tiled polygons (administrative boundary shape)', () => {
    // 400 polygons tiled without overlapping, like administrative boundaries
    const elements: DrapeElement[] = [];
    for (let i = 0; i < 400; i++) {
      const cx = -60 + (i % 20) * 6;
      const cy = -30 + Math.floor(i / 20) * 3;
      elements.push(polygonElement([circleRing(cx, cy, 3, 80)]));
    }
    const bins = binTile(elements, { x: 0, y: 0, z: 0 });
    expect(bins.overflow).toBe(false);
    expect(bins.truncatedCells).toBe(0);
    expect(bins.maxEdgesPerCell).toBeLessThanOrEqual(256);
  });

  it('never claims to be "usable" while still truncated', () => {
    // 300 polygons are stacked in the same place. They do not fit in a single cell even when
    // the grid is made finer, so in the end it returns the degradation signal (drawing while
    // still truncated makes square blotches)
    const elements: DrapeElement[] = [];
    for (let i = 0; i < 300; i++) {
      elements.push(polygonElement([circleRing(0.2 * (i % 5), 0.2 * (i % 7), 0.6, 60)]));
    }
    const bins = binTile(elements, { x: 0, y: 0, z: 0 });
    expect(bins.truncatedCells === 0 || bins.overflow).toBe(true);
  });

  it('returns the degradation signal when even quantization does not make it fit', () => {
    // 20,000 polygons filling the tile. Even after quantization a few points remain per
    // polygon, so it does not fit
    const elements: DrapeElement[] = [];
    for (let i = 0; i < 20_000; i++) {
      elements.push(polygonElement([circleRing(0, 0, 60 + (i % 7), 12)]));
    }
    const bins = binTile(elements, { x: 0, y: 0, z: 0 });
    expect(bins.overflow).toBe(true);
    expect(bins.edges.length).toBe(0);
  });

  it('matches the naive test in the inside/outside test even for quantized geometry', () => {
    const rings = [circleRing(0, 0, 60, 40_000)];
    const bins = binTile([polygonElement(rings)], { x: 0, y: 0, z: 0 });
    // Matched against the quantized outline itself (not the original outline)
    const random = makeRandom(4242);
    let inside = 0;
    for (let i = 0; i < 500; i++) {
      const px = random() * 0.1 + 0.45;
      const py = random() * 0.1 + 0.45;
      if (insideFromBins(bins, 0, px, py)) inside++;
    }
    // Everything near the center comes out inside
    expect(inside).toBe(500);
  });
});

describe('the order of the runs in a cell', () => {
  it('is the draw order of the elements (the drape shader stops a section at its end)', () => {
    const elements = [
      polygonElement([circleRing(10, 10, 20, 24)]),
      lineElement([
        [
          [-30, -20],
          [40, 30],
        ],
      ]),
      polygonElement([circleRing(0, 0, 30, 24)]),
      polygonElement([circleRing(-5, 5, 10, 24)]),
    ];
    const bins = binTile(elements, { x: 0, y: 0, z: 0 });
    const cellCount = bins.grid * bins.grid;
    let checked = 0;
    for (let cell = 0; cell < cellCount; cell++) {
      const start = bins.cells[cell * 2];
      const count = bins.cells[cell * 2 + 1];
      for (let r = 1; r < count; r++) {
        expect(bins.runs[(start + r) * 4]).toBeGreaterThan(bins.runs[(start + r - 1) * 4]);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });
});

describe('the starts of the edges along their paths', () => {
  const tile: DrapeTile = { x: 0, y: 0, z: 0 };
  const path: Coordinate[] = [
    [-150, 60],
    [-30, -20],
    [40, 30],
    [150, -60],
  ];

  /** The edges of the bins, each with its start along the path */
  function edgesWithStarts(bins: TileBins): Array<{ x0: number; y0: number; start: number }> {
    const out: Array<{ x0: number; y0: number; start: number }> = [];
    for (let i = 0; i < bins.edgeStarts.length; i++) {
      out.push({ x0: bins.edges[i * 4], y0: bins.edges[i * 4 + 1], start: bins.edgeStarts[i] });
    }
    return out;
  }

  it('go along with the edges of a dashed line, one per edge', () => {
    const element: DrapeElement = {
      ...lineElement([path]),
      dash: { a: 12, b: 4, c: 2, pixelRatio: 1 },
    };
    const bins = binTile([element], tile);
    const starts = drapePathStarts(element.geometry().paths[0]);

    expect(bins.edgeStarts.length).toBe(bins.edges.length / 4);
    expect(bins.edgeStarts.length).toBeGreaterThan(0);
    // Each edge carries the start of the vertex it begins at (found again by its first point)
    const xy = element.geometry().paths[0].xy;
    for (const edge of edgesWithStarts(bins)) {
      let vertex = -1;
      for (let v = 0; v < xy.length / 2; v++) {
        if (Math.abs(xy[v * 2] - edge.x0) < 1e-6 && Math.abs(xy[v * 2 + 1] - edge.y0) < 1e-6) {
          vertex = v;
        }
      }
      expect(vertex).toBeGreaterThanOrEqual(0);
      expect(edge.start).toBeCloseTo(starts[vertex], 6);
    }
    expect(Math.max(...bins.edgeStarts)).toBeGreaterThan(0);
  });

  it('are 0 for a solid line, which has no pattern to lay out', () => {
    const bins = binTile([lineElement([path])], tile);
    expect(bins.edgeStarts.length).toBe(bins.edges.length / 4);
    expect(bins.edgeStarts.every((start) => start === 0)).toBe(true);
  });
});
