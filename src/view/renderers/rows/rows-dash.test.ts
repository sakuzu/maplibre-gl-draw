// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The dashes cut in the fragments of the drawing in one draw are cut where the lines dashed on
 * the CPU are cut
 *
 * The lines dashed on the CPU (`splitIntoDashes`, each dash drawn as a line of its own) are the
 * reference. The rows are packed as the drawing in one draw packs them (`collectRow`), and the
 * dashed branch of its program (`rows-shader.ts`) is followed here: the vertex stage puts the
 * four corners of the strip of a segment (miters, bevels and round ends as it does) and hands
 * each corner its position on the line, and the fragments read the position interpolated over
 * the two triangles of the strip, a fragment being in a dash where the position modulo the
 * period is within the dash.
 *
 * At every cut of the CPU, on the center line and across the width of the line, the position
 * the fragments get is the position of the cut, whatever the latitude, the zoom, the pixel
 * ratio, the number of segments, the parts of the row and the rings of a polygon. The only
 * difference left is that the CPU interpolates a cut in degrees, where the segment is straight
 * on the Mercator plane: the cut is off by at most `tan(lat) * dLat * length / 8` (radians and
 * pixels), a hundredth of a pixel and less for the segments of these maps.
 *
 * The position along the strip (the end of the segment at both corners of a miter, the position
 * a cap is cut by) shears the dashes of a whole segment by up to the length of the miter: the
 * tests also check that it misses the cuts the projection hits.
 */

import { describe, expect, it } from 'vitest';
import { drawPropertyKey } from '../../../shared/properties.js';
import type { Coordinate, Feature } from '../../../shared/types/model.js';
import { ValueStringCache } from '../../../table/value-column.js';
import { createTestDrawer, feature, tablesOfFeatures } from '../../../test-utils.js';
import {
  collectRow,
  RowStyleSlots,
  RowsDraft,
  type RowsPackContext,
  RowsStyles,
} from '../../layer/table-collect.js';
import { TerrainContext } from '../../terrain/context.js';
import {
  DASH_COEFFICIENTS,
  dashSegmentLength,
  getStrokeDashPattern,
  splitIntoDashes,
} from '../line/dash.js';
import {
  ROWS_DASH,
  ROWS_KIND,
  ROWS_STYLE_FLOATS,
  type RowsChunkData,
  RowsPalette,
  readRowsInstance,
} from './rows-format.js';
import { ROWS_MITER_LIMIT } from './rows-shader.js';

type Point = [number, number];

/** A camera on a flat map, north up and not pitched */
interface Camera {
  readonly center: Point;
  readonly zoom: number;
  /** Device pixels per CSS px */
  readonly ratio: number;
}

const RADIANS = Math.PI / 180;

/** A position on the screen, in device pixels from the center of the screen (y up, as GL) */
function project(camera: Camera, lng: number, lat: number): Point {
  const world = 512 * 2 ** camera.zoom * camera.ratio;
  const mercatorY = (value: number) => Math.log(Math.tan(Math.PI / 4 + (value * RADIANS) / 2));
  return [
    ((lng - camera.center[0]) / 360) * world,
    ((mercatorY(lat) - mercatorY(camera.center[1])) / (2 * Math.PI)) * world,
  ];
}

const sub = (a: Point, b: Point): Point => [a[0] - b[0], a[1] - b[1]];
const dot = (a: Point, b: Point) => a[0] * b[0] + a[1] * b[1];
const unit = (a: Point): Point => {
  const length = Math.hypot(a[0], a[1]);
  return [a[0] / length, a[1] / length];
};

/** A dashed row of a scene: its feature and its width */
interface DashedRow {
  readonly feature: Feature;
  /** The created zoom (the width follows the zoom from it), or undefined for a fixed width */
  readonly createdZoom?: number;
}

/** The rows packed as the drawing in one draw packs them, in one chunk around an origin */
function packRows(
  rows: readonly DashedRow[],
  ratio: number,
  origin: [number, number],
): RowsChunkData {
  const { internals, table } = tablesOfFeatures(
    'layer',
    rows.map((row) => row.feature),
  );
  const group = table.groupAt(0);
  const slots = new RowStyleSlots(createTestDrawer(), internals.styles, undefined);
  const palette = new RowsPalette();
  const context: RowsPackContext = {
    slots,
    strings: new ValueStringCache(),
    pixelRatio: ratio,
    terrain: new TerrainContext(),
    rowsStyles: new RowsStyles(slots, palette, ratio),
    spriteSourceOf: () => undefined,
  };
  const draft = new RowsDraft(group.data.length, 0);
  for (let row = 0; row < group.data.length; row++) {
    collectRow(group, row, row, draft, origin, context);
  }
  return draft.finish(origin, palette, null);
}

/** One segment of the strip of a dashed row, as the vertex stage puts it */
interface Strip {
  readonly row: number;
  /** The corners 0 to 3 (start left, start right, end left, end right) */
  readonly corners: readonly Point[];
  /** The position on the line each corner hands the fragments (CSS px) */
  readonly positions: readonly number[];
  /** The same from the position along the strip (the miter not counted) */
  readonly stripPositions: readonly number[];
  readonly start: Point;
  readonly end: Point;
  readonly cssPerPx: number;
  /** Half the width of the line (device px) */
  readonly halfWidth: number;
  /** The position along the strip each corner hands the fragments (device px, `v_geom.y`) */
  readonly linePositions: readonly number[];
  /** The length of the segment on the screen (device px) */
  readonly length: number;
  /** The direction of the segment on the screen */
  readonly dir: Point;
  /** The position of the start of the segment and of its end on the line (CSS px) */
  readonly startCss: number;
  readonly endCss: number;
  /** The dash and the period (CSS px) */
  readonly dash: number;
  readonly period: number;
  /** The segments before and after it on the line, on the screen (null at an end of the line) */
  readonly prev: Neighbor | null;
  readonly next: Neighbor | null;
}

/** A segment next to a segment of a dashed line, as the vertex stage reads it */
interface Neighbor {
  /** Its direction on the screen (from the start of the line to its end) */
  readonly dir: Point;
  /** Its length in CSS px and on the screen (device px) */
  readonly lengthCss: number;
  readonly length: number;
}

/**
 * The strips of the dashed segments of a chunk, as the dashed branch of the vertex stage of the
 * program puts them (`drawSegment` of `rows-shader.ts`)
 */
function stripsOf(data: RowsChunkData, camera: Camera): Strip[] {
  const coord = (index: number): Point => {
    const x = data.coords[index * 2];
    const y = data.coords[index * 2 + 1];
    return [data.origin[0] + x, data.origin[1] + y];
  };
  const screen = (index: number): Point => {
    const [lng, lat] = coord(index);
    return project(camera, lng, lat);
  };
  const strips: Strip[] = [];
  for (let i = 0; i < data.instanceCount; i++) {
    const instance = readRowsInstance(data.instances, i);
    if (instance.kind !== ROWS_KIND.segment && instance.kind !== ROWS_KIND.dashedOutline) continue;
    const row = instance.row;
    const styleNumber = data.rowStyles[row * 4];
    const createdZoom = data.rowStyles[row * 4 + 1];
    const hasCreatedZoom = data.rowStyles[row * 4 + 2] > 0.5;
    const texel = instance.kind === ROWS_KIND.dashedOutline ? 2 : 1;
    const at = styleNumber * ROWS_STYLE_FLOATS + texel * 4;
    const widths = Array.from(data.palette.values.subarray(at, at + 4));
    if (widths[3] === ROWS_DASH.solid) continue;

    const [prevIdx, startIdx, endIdx, nextIdx] = instance.indices;
    const start = screen(startIdx);
    const end = screen(endIdx);
    const length = Math.hypot(end[0] - start[0], end[1] - start[1]);
    const dir = unit(sub(end, start));
    const normal: Point = [-dir[1], dir[0]];

    const strokeWidth = hasCreatedZoom ? widths[0] : widths[1];
    let lineWidth =
      strokeWidth > 0 ? strokeWidth * 2 ** (camera.zoom - createdZoom) : Math.max(-strokeWidth, 0);
    lineWidth = Math.max(lineWidth, 1);
    const expanded = lineWidth / 2 + 1;

    const lengthCss = dashSegmentLength(...coord(startIdx), ...coord(endIdx), 0) * 2 ** camera.zoom;
    const startCss = instance.extra * 2 ** camera.zoom;
    const cssPerPx = lengthCss / length;

    const corners: Point[] = [];
    const positions: number[] = [];
    const stripPositions: number[] = [];
    const linePositions: number[] = [];
    for (let corner = 0; corner < 4; corner++) {
      const atStart = corner < 2;
      const side = (corner & 1) === 0 ? 1 : -1;
      const otherIdx = atStart ? prevIdx : nextIdx;
      let miterNormal = normal;
      let miterScale = 1;
      if (otherIdx >= 0) {
        const other = screen(otherIdx);
        const otherDir = atStart ? unit(sub(start, other)) : unit(sub(other, end));
        const sum: Point = [normal[0] - otherDir[1], normal[1] + otherDir[0]];
        const sumLength = Math.hypot(sum[0], sum[1]);
        if (sumLength > 0.001) {
          miterNormal = [sum[0] / sumLength, sum[1] / sumLength];
          const cosHalf = dot(miterNormal, normal);
          if (cosHalf > 0.001) {
            miterScale = 1 / cosHalf;
            if (miterScale > ROWS_MITER_LIMIT) {
              miterScale = 1;
              miterNormal = normal;
            }
          }
        }
      }
      const offset: Point = [
        miterNormal[0] * side * expanded * miterScale,
        miterNormal[1] * side * expanded * miterScale,
      ];
      let linePos = atStart ? 0 : length;
      if (otherIdx < 0) {
        const cap = atStart ? -expanded : expanded;
        offset[0] += dir[0] * cap;
        offset[1] += dir[1] * cap;
        linePos = atStart ? -expanded : length + expanded;
      }
      const base = atStart ? start : end;
      corners.push([base[0] + offset[0], base[1] + offset[1]]);
      const along = (atStart ? 0 : length) + dot(offset, dir);
      positions.push(startCss + along * cssPerPx);
      stripPositions.push(startCss + linePos * cssPerPx);
      linePositions.push(linePos);
    }
    const cssWidth = widths[2] * (hasCreatedZoom ? 2 ** (camera.zoom - createdZoom) : 1);
    const k = widths[3] === ROWS_DASH.dashed ? DASH_COEFFICIENTS.dashed : DASH_COEFFICIENTS.dotted;
    const dash = Math.max(k.a, k.b * cssWidth);
    const gap = Math.max(cssWidth + 1, k.c * cssWidth);
    const neighbor = (from: number, to: number): Neighbor => {
      const a = screen(from);
      const b = screen(to);
      return {
        dir: unit(sub(b, a)),
        length: Math.hypot(b[0] - a[0], b[1] - a[1]),
        lengthCss: dashSegmentLength(...coord(from), ...coord(to), 0) * 2 ** camera.zoom,
      };
    };
    strips.push({
      row,
      corners,
      positions,
      stripPositions,
      start,
      end,
      cssPerPx,
      halfWidth: lineWidth / 2,
      linePositions,
      length,
      dir,
      startCss,
      endCss: startCss + lengthCss,
      dash,
      period: dash + gap,
      prev: prevIdx >= 0 ? neighbor(prevIdx, startIdx) : null,
      next: nextIdx >= 0 ? neighbor(endIdx, nextIdx) : null,
    });
  }
  return strips;
}

/**
 * The position a fragment at a point gets from a strip, interpolated over the triangle of the
 * strip it is in (null outside the strip)
 */
function positionAt(strip: Strip, point: Point, values: readonly number[]): number | null {
  for (const [a, b, c] of [
    [0, 1, 2],
    [2, 1, 3],
  ]) {
    const pa = strip.corners[a];
    const pb = strip.corners[b];
    const pc = strip.corners[c];
    const area = (pb[0] - pa[0]) * (pc[1] - pa[1]) - (pb[1] - pa[1]) * (pc[0] - pa[0]);
    const wa =
      ((pb[0] - point[0]) * (pc[1] - point[1]) - (pb[1] - point[1]) * (pc[0] - point[0])) / area;
    const wb =
      ((pc[0] - point[0]) * (pa[1] - point[1]) - (pc[1] - point[1]) * (pa[0] - point[0])) / area;
    const wc = 1 - wa - wb;
    const eps = -1e-9;
    if (wa >= eps && wb >= eps && wc >= eps)
      return wa * values[a] + wb * values[b] + wc * values[c];
  }
  return null;
}

/** A cut of a dashed line on the CPU: where a dash starts or ends */
interface Cut {
  readonly row: number;
  /** Its position on the line (CSS px) */
  readonly position: number;
  /** Where it is, in degrees */
  readonly at: Coordinate;
  /** The direction of the dash at it, in degrees */
  readonly from: Coordinate;
  /** The bound of the difference of interpolating it in degrees (device px) */
  readonly bound: number;
}

/**
 * The cuts of the lines dashed on the CPU, as the drawing at once cuts the lines and the
 * outlines of the polygons (the dashes of each part and of each ring from its first position)
 */
function cpuCuts(rows: readonly DashedRow[], camera: Camera): Cut[] {
  const cuts: Cut[] = [];
  rows.forEach((row, index) => {
    const geometry = row.feature.geometry;
    const style = row.feature.style ?? {};
    const lineStyle = style.lineStyle as 'dashed' | 'dotted';
    const width = (style.strokeWidth as number | undefined) ?? 2;
    const paths: Coordinate[][] =
      geometry.type === 'LineString'
        ? [geometry.coordinates as Coordinate[]]
        : geometry.type === 'MultiLineString' || geometry.type === 'Polygon'
          ? (geometry.coordinates as Coordinate[][])
          : [];
    const effective =
      row.createdZoom === undefined ? width : width * 2 ** (camera.zoom - row.createdZoom);
    const pattern = getStrokeDashPattern(lineStyle, effective);
    if (!pattern) return;
    const period = pattern[0] + pattern[1];
    for (const path of paths) {
      const dashes = splitIntoDashes(path, pattern[0], pattern[1], camera.zoom);
      const total = path
        .slice(1)
        .reduce(
          (sum, b, k) => sum + dashSegmentLength(path[k][0], path[k][1], b[0], b[1], camera.zoom),
          0,
        );
      // The bound of the difference of interpolating in degrees, per segment
      const bounds = path.slice(1).map((b, k) => {
        const a = path[k];
        const tan = Math.max(
          Math.abs(Math.tan(a[1] * RADIANS)),
          Math.abs(Math.tan(b[1] * RADIANS)),
        );
        const length = Math.hypot(...sub(project(camera, ...b), project(camera, ...a)));
        return (tan * Math.abs(b[1] - a[1]) * RADIANS * length) / 8;
      });
      const segmentOf = (point: Coordinate) => {
        let best = 0;
        let distance = Infinity;
        for (let k = 0; k < path.length - 1; k++) {
          const a = project(camera, ...path[k]);
          const b = project(camera, ...path[k + 1]);
          const p = project(camera, point[0], point[1]);
          const ab = sub(b, a);
          const t = Math.min(Math.max(dot(sub(p, a), ab) / dot(ab, ab), 0), 1);
          const d = Math.hypot(p[0] - a[0] - t * ab[0], p[1] - a[1] - t * ab[1]);
          if (d < distance) {
            distance = d;
            best = k;
          }
        }
        return best;
      };
      dashes.forEach((dash, j) => {
        // A dash cut at a vertex repeats it
        const coords = dash.coords.filter(
          (c, k) => k === 0 || c[0] !== dash.coords[k - 1][0] || c[1] !== dash.coords[k - 1][1],
        );
        if (coords.length < 2) return;
        const first = coords[0];
        const last = coords[coords.length - 1];
        const startPosition = j * period;
        const endPosition = j * period + pattern[0];
        // The start of the path and its end are not cuts
        if (j > 0) {
          cuts.push({
            row: index,
            position: startPosition,
            at: first,
            from: coords[1],
            bound: bounds[segmentOf(first)],
          });
        }
        if (endPosition < total - 1e-6) {
          cuts.push({
            row: index,
            position: endPosition,
            at: last,
            from: coords[coords.length - 2],
            bound: bounds[segmentOf(last)],
          });
        }
      });
    }
  });
  return cuts;
}

/** The pixels a dash of a row is cut off from where the CPU cuts it, at its cuts */
function misses(
  rows: readonly DashedRow[],
  camera: Camera,
  values: 'positions' | 'stripPositions',
): { checked: number; worst: number } {
  const origin: [number, number] = [Math.fround(camera.center[0]), Math.fround(camera.center[1])];
  const data = packRows(rows, camera.ratio, origin);
  const strips = stripsOf(data, camera);
  const cuts = cpuCuts(rows, camera);
  let checked = 0;
  let worst = 0;
  for (const cut of cuts) {
    const at = project(camera, cut.at[0], cut.at[1]);
    const from = project(camera, cut.from[0], cut.from[1]);
    const dir = unit(sub(at, from));
    const normal: Point = [-dir[1], dir[0]];
    // The strip of the segment the cut is on
    const strip = strips
      .filter((s) => s.row === cut.row)
      .map((s) => {
        const ab = sub(s.end, s.start);
        const t = dot(sub(at, s.start), ab) / dot(ab, ab);
        const off = Math.abs(dot(sub(at, s.start), [-ab[1], ab[0]])) / Math.hypot(...ab);
        // A cut at a vertex is on both segments: it is the one of the dash it cuts
        const along = Math.abs(dot(unit(ab), dir));
        return { s, inside: t >= -1e-4 && t <= 1 + 1e-4 && along > 0.999, off };
      })
      .filter((c) => c.inside)
      .sort((a, b) => a.off - b.off)[0]?.s;
    expect(strip).toBeDefined();
    if (!strip) continue;
    // On the center line, and across the width of the line (the cut of the CPU is square to it)
    const half = strip.halfWidth;
    for (const across of [0, -0.9, 0.9]) {
      const point: Point = [at[0] + normal[0] * half * across, at[1] + normal[1] * half * across];
      const position = positionAt(strip, point, strip[values]);
      // A point past the miter line is in the strip of the next segment
      if (position === null) continue;
      const miss = Math.abs(position - cut.position) / strip.cssPerPx;
      checked++;
      worst = Math.max(worst, miss - cut.bound);
    }
  }
  return { checked, worst };
}

const CREATED = (zoom: number) => ({ [drawPropertyKey('createdZoom')]: zoom });

/** A dashed line, a dotted one of two parts and a polygon with a hole and a dashed outline */
function scene(center: Point, zoom: number, createdZoom: number): DashedRow[] {
  // About 150 CSS px a step on the screen, whatever the latitude and the zoom
  const step = (150 / (512 * 2 ** zoom)) * 360;
  const stepY = step * Math.cos(center[1] * RADIANS);
  const at = (x: number, y: number): Coordinate => [center[0] + x * step, center[1] + y * stepY];
  const square = (x: number, y: number, side: number): Coordinate[] => [
    at(x - side / 2, y - side / 2),
    at(x + side / 2, y - side / 2),
    at(x + side / 2, y + side / 2),
    at(x - side / 2, y + side / 2),
    at(x - side / 2, y - side / 2),
  ];
  return [
    {
      feature: feature(
        'dashed',
        'LineString',
        [at(-2, 1), at(-0.6, 0.4), at(0.3, 1.3), at(1.9, 0.2), at(2.2, 1.5)],
        { style: { lineStyle: 'dashed', strokeWidth: 4 } },
      ),
    },
    {
      feature: feature(
        'dotted',
        'MultiLineString',
        [
          [at(-2, -0.2), at(1.8, -0.4)],
          [at(-2, -0.8), at(-0.5, -0.7), at(0.6, -1.2)],
        ],
        { style: { lineStyle: 'dotted', strokeWidth: 3 }, properties: CREATED(createdZoom) },
      ),
      createdZoom,
    },
    {
      feature: feature(
        'outline',
        'Polygon',
        [square(0, -2.2, 1.6), square(0, -2.2, 0.6).reverse()],
        {
          style: { lineStyle: 'dashed', strokeWidth: 8, fillOpacity: 0.3 },
        },
      ),
    },
  ];
}

describe('the dashes cut in the fragments of the drawing in one draw', () => {
  const latitudes = [0, 35.68, 60, 75];
  const zooms = [10, 14, 18];
  const ratios = [1, 1.5, 2];

  for (const latitude of latitudes) {
    for (const zoom of zooms) {
      it(`are cut where the CPU cuts them at latitude ${latitude}, zoom ${zoom}`, () => {
        for (const ratio of ratios) {
          const center: Point = [139.7, latitude];
          const camera: Camera = { center, zoom, ratio };
          const rows = scene(center, zoom, zoom - 1.5);
          const { checked, worst } = misses(rows, camera, 'positions');
          expect(checked).toBeGreaterThan(100);
          expect(worst).toBeLessThan(0.01);
        }
      });
    }
  }

  it('would be sheared by the miters with the position along the strip', () => {
    const center: Point = [139.7, 35.68];
    const camera: Camera = { center, zoom: 14, ratio: 1 };
    const rows = scene(center, 14, 13);
    expect(misses(rows, camera, 'positions').worst).toBeLessThan(0.01);
    // Pixels off the cuts of the CPU, as the drawing in one draw first cut the dashes
    expect(misses(rows, camera, 'stripPositions').worst).toBeGreaterThan(1);
  });

  it('use the pattern of the CPU, from the width drawn in CSS px', () => {
    // The coefficients the program is built with are the ones the CPU pattern is computed from
    for (const [lineStyle, k] of Object.entries(DASH_COEFFICIENTS)) {
      for (const width of [0.5, 2, 4, 9]) {
        expect(getStrokeDashPattern(lineStyle as 'dashed' | 'dotted', width)).toEqual([
          Math.max(k.a, k.b * width),
          Math.max(width + 1, k.c * width),
        ]);
      }
    }
  });
});

// === The coverage at the corners ===
//
// The CPU draws every dash as a line of its own: a dash that goes on over a corner has the miter
// of the corner, and one cut near a corner has a round end that reaches over it, into the strip
// of the other segment. The coverage of the drawing in one draw is compared with the one of the
// dashes cut on the CPU, blended as they are drawn, at points all around lines that turn with
// their corners at every phase of the pattern (a cut in the strip of the miter, a dash going on
// over the corner, a dash ending just before it or starting just after it). The position along a
// segment of the CPU is the projection of the point on it; the SDF lines interpolate it over the
// two triangles of a quad, which shears a round end when the other end of its quad is a miter.

/** The coverage of a line across it, `d` device px from its center line (HHAA) */
function boxCoverage(d: number, w: number): number {
  const left = Math.min(Math.max(d - w + 0.5, 0), 1);
  const right = Math.min(Math.max(d + w + 0.5, 0), 1);
  return right - left;
}

/** The coverage of a round end, `along` device px beyond it */
function capCoverage(d: number, along: number, w: number): number {
  return 1 - Math.min(Math.max(Math.hypot(d, along) - w + 0.5, 0), 1);
}

/** The alpha of the color the coverages are blended with (a draw over another adds less) */
const ALPHA = 0.6;

/** Two coverages of one color drawn over each other, as one coverage */
const over = (a: number, b: number) => a + b - ALPHA * a * b;

/**
 * The coverage of the fragment of a dashed segment at a position on the line and a distance
 * from its center line, as the dashed branch of the fragment stage computes it before the
 * corners were cut as the CPU cuts them
 */
function formerCoverage(strip: Strip, pos: number, d: number, linePos: number): number {
  const w = strip.halfWidth;
  const startDist = -linePos;
  const endDist = linePos - strip.length;
  const end = strip.next === null ? strip.endCss : -1;
  const { dash, period, cssPerPx } = strip;
  if (startDist > 0) return capCoverage(d, startDist, w);
  if (endDist > 0) {
    const atEnd = end - Math.floor(end / period) * period;
    const back = atEnd <= dash ? 0 : (atEnd - dash) / cssPerPx;
    return capCoverage(d, endDist + back, w);
  }
  const m = pos - Math.floor(pos / period) * period;
  if (m <= dash) return boxCoverage(d, w);
  let along = m - dash;
  const toNext = period - m;
  if (end < 0 || pos + toNext < end) along = Math.min(along, toNext);
  return capCoverage(d, along / cssPerPx, w);
}

/** A distance no fragment is near (device px), as the program has it */
const FAR = 1e6;

/** The dash of a segment next to a dashed one, as `v_dash_prev` and `v_dash_next` hold it */
type NeighborDash = readonly [number, number, number, number];

/** The modulo of GLSL (`mod`) */
const mod = (x: number, y: number) => x - y * Math.floor(x / y);

/**
 * The dash of a segment next to a dashed segment whose round end reaches over the corner they
 * share, as the vertex stage computes it (`dashNeighbor` of `rows-shader.ts`)
 */
function neighborDash(strip: Strip, before: boolean): NeighborDash {
  const neighbor = before ? strip.prev : strip.next;
  const none: NeighborDash = before ? [1, 0, -2 * FAR, -FAR] : [1, 0, FAR, 2 * FAR];
  if (!neighbor || neighbor.length <= 0) return none;
  const corner = before ? strip.startCss : strip.endCss;
  const perPx = neighbor.lengthCss / neighbor.length;
  const { dash, period } = strip;
  const gap = period - dash;
  const m = mod(corner, period);
  if (m > 0 && m < dash) return none;
  const c = dot(strip.dir, neighbor.dir);
  const s = dot(strip.dir, [-neighbor.dir[1], neighbor.dir[0]]);
  if (before) {
    const end = m >= dash ? corner - m + dash : corner - gap;
    const first = corner - neighbor.lengthCss;
    if (end <= first) return none;
    return [c, s, (Math.max(end - dash, first) - corner) / perPx, (end - corner) / perPx];
  }
  const start = m > 0 ? corner - m + period : corner;
  const last = corner + neighbor.lengthCss;
  if (start >= last) return none;
  return [c, s, (start - corner) / perPx, (Math.min(start + dash, last) - corner) / perPx];
}

/** The coverage of a dash drawn as a line of its own from `a` to `b` along its segment */
function dashCoverage(d: number, u: number, a: number, b: number, w: number): number {
  if (u < a) return capCoverage(d, a - u, w);
  if (u > b) return capCoverage(d, u - b, w);
  return boxCoverage(d, w);
}

/** The coverage of the dash of a segment next to this one, `u` along this one from the corner */
function neighborCoverage(dash: NeighborDash, u: number, d: number, w: number): number {
  return dashCoverage(u * dash[1] + d * dash[0], u * dash[0] - d * dash[1], dash[2], dash[3], w);
}

/**
 * The coverage of the fragment of a dashed segment at a position on the line and a distance from
 * its center line, as the dashed branch of the fragment stage computes it (`dashedCoverage` of
 * `rows-shader.ts`)
 */
function dashedCoverage(strip: Strip, pos: number, d: number): number {
  const w = strip.halfWidth;
  const { dash, period, cssPerPx: perPx } = strip;
  const first = strip.startCss;
  const last = strip.endCss;
  const lineEnd = strip.next === null;
  const at = Math.min(Math.max(pos, first), last);
  const m = mod(at, period);
  let coverage = 0;
  if (m < dash) {
    const start = at - m;
    const end = start + dash;
    const a = start >= first ? (start - pos) / perPx : -FAR;
    const b = end <= last || lineEnd ? (Math.min(end, last) - pos) / perPx : FAR;
    coverage = dashCoverage(d, 0, a, b, w);
  } else {
    const end = at - m + dash;
    if (end > first) {
      const start = end - dash;
      const a = start >= first ? (start - pos) / perPx : -FAR;
      coverage = dashCoverage(d, 0, a, (end - pos) / perPx, w);
    }
    const next = at - m + period;
    if (next < last) {
      const nextEnd = next + dash;
      const b = nextEnd <= last || lineEnd ? (Math.min(nextEnd, last) - pos) / perPx : FAR;
      coverage = over(coverage, dashCoverage(d, 0, (next - pos) / perPx, b, w));
    }
  }
  const fromStart = (pos - first) / perPx;
  coverage = over(coverage, neighborCoverage(neighborDash(strip, true), fromStart, d, w));
  const fromEnd = (pos - last) / perPx;
  coverage = over(coverage, neighborCoverage(neighborDash(strip, false), fromEnd, d, w));
  return coverage;
}

/** The coverage of the fragments of a dashed segment at a point on the screen (null outside) */
type FragmentCoverage = (strip: Strip, pos: number, d: number, linePos: number) => number;

/** The coverage the strips of the drawing in one draw give a point, blended */
function rowsCoverage(strips: readonly Strip[], point: Point, fragment: FragmentCoverage): number {
  let coverage = 0;
  for (const strip of strips) {
    const pos = positionAt(strip, point, strip.positions);
    if (pos === null) continue;
    const eh = strip.halfWidth + 1;
    const d = positionAt(strip, point, [eh, -eh, eh, -eh]) as number;
    const linePos = positionAt(strip, point, strip.linePositions) as number;
    coverage = over(coverage, fragment(strip, pos, d, linePos));
  }
  return coverage;
}

/** A segment of a dash cut on the CPU, drawn as a line of its own (`SDFLineRenderer`) */
interface CpuSegment {
  readonly start: Point;
  readonly end: Point;
  /** The quad it is drawn in (start left, start right, end left, end right) */
  readonly corners: readonly Point[];
  /** Whether its start and its end are round ends (the ends of the dash) */
  readonly capStart: boolean;
  readonly capEnd: boolean;
  readonly halfWidth: number;
}

/** The quad of a segment of a line, as the vertex stage of the SDF lines puts it */
function lineQuad(
  start: Point,
  end: Point,
  prev: Point | null,
  next: Point | null,
  expanded: number,
): Point[] {
  const dir = unit(sub(end, start));
  const normal: Point = [-dir[1], dir[0]];
  const corners: Point[] = [];
  for (let corner = 0; corner < 4; corner++) {
    const atStart = corner < 2;
    const side = (corner & 1) === 0 ? 1 : -1;
    const other = atStart ? prev : next;
    let miterNormal = normal;
    let miterScale = 1;
    if (other) {
      const otherDir = atStart ? unit(sub(start, other)) : unit(sub(other, end));
      const sum: Point = [normal[0] - otherDir[1], normal[1] + otherDir[0]];
      const sumLength = Math.hypot(sum[0], sum[1]);
      if (sumLength > 0.001) {
        miterNormal = [sum[0] / sumLength, sum[1] / sumLength];
        const cosHalf = dot(miterNormal, normal);
        if (cosHalf > 0.001) {
          miterScale = 1 / cosHalf;
          if (miterScale > ROWS_MITER_LIMIT) {
            miterScale = 1;
            miterNormal = normal;
          }
        }
      }
    }
    const offset: Point = [
      miterNormal[0] * side * expanded * miterScale,
      miterNormal[1] * side * expanded * miterScale,
    ];
    if (!other) {
      const cap = atStart ? -expanded : expanded;
      offset[0] += dir[0] * cap;
      offset[1] += dir[1] * cap;
    }
    const base = atStart ? start : end;
    corners.push([base[0] + offset[0], base[1] + offset[1]]);
  }
  return corners;
}

/** Whether a point is in a quad (its two triangles, as a strip of 4 vertices draws them) */
function inQuad(corners: readonly Point[], point: Point): boolean {
  const zero = [0, 0, 0, 0];
  return positionAt({ corners } as Strip, point, zero) !== null;
}

/**
 * The segments of the dashes the CPU cuts a dashed row into (`splitIntoDashes`, as the drawing at
 * once cuts the lines and the rings of the polygons), on the screen
 */
function cpuSegments(row: DashedRow, camera: Camera): CpuSegment[] {
  const geometry = row.feature.geometry;
  const style = row.feature.style ?? {};
  const lineStyle = style.lineStyle as 'dashed' | 'dotted';
  const width = (style.strokeWidth as number | undefined) ?? 2;
  const scale = row.createdZoom === undefined ? 1 : 2 ** (camera.zoom - row.createdZoom);
  const pattern = getStrokeDashPattern(lineStyle, width * scale);
  if (!pattern) return [];
  const halfWidth = Math.max(width * scale * camera.ratio, 1) / 2;
  // The rings of the polygons of these tests are closed, as the CPU closes them
  const paths: Coordinate[][] =
    geometry.type === 'LineString'
      ? [geometry.coordinates as Coordinate[]]
      : geometry.type === 'MultiLineString' || geometry.type === 'Polygon'
        ? (geometry.coordinates as Coordinate[][])
        : [];
  const segments: CpuSegment[] = [];
  for (const path of paths) {
    for (const piece of splitIntoDashes(path, pattern[0], pattern[1], camera.zoom)) {
      const points = piece.coords.map((c) => project(camera, c[0], c[1]));
      for (let k = 0; k < points.length - 1; k++) {
        const prev = k > 0 ? points[k - 1] : null;
        const next = k + 2 < points.length ? points[k + 2] : null;
        segments.push({
          start: points[k],
          end: points[k + 1],
          corners: lineQuad(points[k], points[k + 1], prev, next, halfWidth + 1),
          capStart: k === 0,
          capEnd: k === points.length - 2,
          halfWidth,
        });
      }
    }
  }
  return segments;
}

/**
 * The coverage the dashes cut on the CPU give a point, blended (the position along a segment
 * being the projection of the point on it)
 */
function cpuCoverage(segments: readonly CpuSegment[], point: Point): number {
  let coverage = 0;
  for (const segment of segments) {
    if (!inQuad(segment.corners, point)) continue;
    const dir = unit(sub(segment.end, segment.start));
    const length = Math.hypot(...sub(segment.end, segment.start));
    const rel = sub(point, segment.start);
    const along = dot(rel, dir);
    const d = dot(rel, [-dir[1], dir[0]]);
    const w = segment.halfWidth;
    let value: number;
    if (segment.capStart && along < 0) value = capCoverage(d, -along, w);
    else if (segment.capEnd && along > length) value = capCoverage(d, along - length, w);
    else value = boxCoverage(d, w);
    coverage = over(coverage, value);
  }
  return coverage;
}

/**
 * The largest difference of the coverage of the drawing in one draw from the one of the dashes
 * cut on the CPU, over the points around a row (a grid that does not line up with the pixels)
 */
function worstCoverage(
  row: DashedRow,
  camera: Camera,
  fragment: FragmentCoverage,
): { checked: number; worst: number } {
  const origin: [number, number] = [Math.fround(camera.center[0]), Math.fround(camera.center[1])];
  const strips = stripsOf(packRows([row], camera.ratio, origin), camera);
  const segments = cpuSegments(row, camera);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const strip of strips) {
    for (const [x, y] of strip.corners) {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  const step = 0.43;
  let checked = 0;
  let worst = 0;
  for (let y = minY - 1; y <= maxY + 1; y += step) {
    for (let x = minX - 1; x <= maxX + 1; x += step) {
      const point: Point = [x, y];
      // Only the points near the line (the rest is drawn by neither)
      const near = strips.some((strip) => {
        const ab = sub(strip.end, strip.start);
        const t = Math.min(Math.max(dot(sub(point, strip.start), ab) / dot(ab, ab), 0), 1);
        const foot: Point = [strip.start[0] + ab[0] * t, strip.start[1] + ab[1] * t];
        return Math.hypot(...sub(point, foot)) < strip.halfWidth + 2;
      });
      if (!near) continue;
      checked++;
      const difference = Math.abs(
        rowsCoverage(strips, point, fragment) - cpuCoverage(segments, point),
      );
      worst = Math.max(worst, difference);
    }
  }
  return { checked, worst };
}

/** A position `x`, `y` CSS px from the center of the camera, in degrees */
function offsetBy(camera: Camera, x: number, y: number): Coordinate {
  const perDegree = (512 * 2 ** camera.zoom) / 360;
  return [
    camera.center[0] + x / perDegree,
    camera.center[1] + (y * Math.cos(camera.center[1] * RADIANS)) / perDegree,
  ];
}

/**
 * A dashed row of two segments that turn by `turn` degrees, its corner `phase` of a period into
 * the pattern
 */
function cornerRow(
  camera: Camera,
  lineStyle: 'dashed' | 'dotted',
  turn: number,
  phase: number,
): DashedRow {
  const createdZoom = lineStyle === 'dotted' ? camera.zoom - 1 : undefined;
  const width = lineStyle === 'dotted' ? 3 : 4;
  const effective = width * (createdZoom === undefined ? 1 : 2 ** (camera.zoom - createdZoom));
  const [dash, gap] = getStrokeDashPattern(lineStyle, effective) as [number, number];
  const period = dash + gap;
  const first = 2 * period + phase * period;
  const heading = 10 * RADIANS;
  const turned = heading + turn * RADIANS;
  const corner: Point = [Math.cos(heading) * first, Math.sin(heading) * first];
  const second = 2.3 * period;
  const end: Point = [corner[0] + Math.cos(turned) * second, corner[1] + Math.sin(turned) * second];
  return {
    feature: feature(
      'corner',
      'LineString',
      [offsetBy(camera, 0, 0), offsetBy(camera, ...corner), offsetBy(camera, ...end)],
      {
        style: { lineStyle, strokeWidth: width },
        ...(createdZoom === undefined ? {} : { properties: CREATED(createdZoom) }),
      },
    ),
    createdZoom,
  };
}

/** A square with a dashed outline, its corners at the phases its side gives */
function squareRow(camera: Camera, side: number): DashedRow {
  const ring = [
    offsetBy(camera, 0, 0),
    offsetBy(camera, side, 0),
    offsetBy(camera, side, side),
    offsetBy(camera, 0, side),
    offsetBy(camera, 0, 0),
  ];
  return {
    feature: feature('square', 'Polygon', [ring], {
      style: { lineStyle: 'dashed', strokeWidth: 3, fillOpacity: 0.2 },
    }),
  };
}

/** The phases of a corner in the pattern the tests go through (they miss every round number) */
const PHASES = Array.from({ length: 24 }, (_, i) => (i + 0.37) / 24);

describe('the corners of the dashes drawn in one draw', () => {
  const camera: Camera = { center: [139.7, 35.68], zoom: 14, ratio: 1 };

  for (const lineStyle of ['dashed', 'dotted'] as const) {
    for (const turn of [90, -90, 51, -51]) {
      it(`are drawn as the CPU draws them, ${lineStyle}, turning by ${turn} degrees`, () => {
        for (const phase of PHASES) {
          const { checked, worst } = worstCoverage(
            cornerRow(camera, lineStyle, turn, phase),
            camera,
            dashedCoverage,
          );
          expect(checked).toBeGreaterThan(500);
          expect(worst, `phase ${phase}`).toBeLessThan(0.005);
        }
      });
    }
  }

  it('of the dashed outlines of polygons are drawn as the CPU draws them', () => {
    // A dashed outline 3 px wide: dashes of 12 and gaps of 6
    for (const phase of PHASES) {
      const { checked, worst } = worstCoverage(
        squareRow(camera, 3 * 18 + phase * 18),
        camera,
        dashedCoverage,
      );
      expect(checked).toBeGreaterThan(500);
      expect(worst, `phase ${phase}`).toBeLessThan(0.005);
    }
  });

  it('would be drawn with round ends past the corners and sheared ends without them', () => {
    // As the fragments first drew the dashes: the dashes of a segment cut along its line past
    // its corners, and the round ends of the line at the position along the strip
    let worst = 0;
    for (const phase of PHASES) {
      for (const turn of [90, 51]) {
        const row = cornerRow(camera, 'dashed', turn, phase);
        worst = Math.max(worst, worstCoverage(row, camera, formerCoverage).worst);
      }
    }
    expect(worst).toBeGreaterThan(0.5);
  });
});
