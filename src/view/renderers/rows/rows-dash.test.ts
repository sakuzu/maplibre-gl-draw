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
    }
    strips.push({
      row,
      corners,
      positions,
      stripPositions,
      start,
      end,
      cssPerPx,
      halfWidth: lineWidth / 2,
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
