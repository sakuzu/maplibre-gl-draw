// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The footprints of the types of the plugins, read once: what they cover on the map, and how the
 * library hits, boxes, snaps to and draws them when the type leaves it to the library
 *
 * The distances are measured on the screen, in CSS pixels, through the conversion of the frame
 * drawn last, so a footprint is hit where it was drawn.
 */

import type { Position } from 'geojson';
import type { BBox } from '../../geometry/types.js';
import type { ScreenContext } from '../extension/context.js';
import type { Footprint as EngineFootprint } from '../extension/feature-type.js';
import type { RenderContext as EngineRenderContext } from '../extension/render.js';
import type { FeatureGeometry, FeatureStyleResolved } from '../model.js';
import type { GroundFootprint, ScreenPointContext, SnapCandidate } from '../plugin/types.js';

/**
 * A footprint a type gave, read: a geometry, four corners on the map, or a box on the screen,
 * with its extent on the map
 *
 * @internal
 */
export type Shape =
  | { readonly kind: 'geometry'; readonly geometry: FeatureGeometry; readonly bbox: BBox | null }
  | {
      readonly kind: 'ground';
      readonly corners: GroundFootprint['corners'];
      readonly snap: 'box' | 'center';
      readonly bbox: BBox;
    }
  | {
      readonly kind: 'screen';
      readonly position: Position;
      readonly halfWidth: number;
      readonly halfHeight: number;
      readonly bbox: BBox;
    };

type Point = readonly [number, number];

/** Whether a value is a position with finite coordinates */
function isPosition(value: unknown): value is Position {
  return (
    Array.isArray(value) &&
    value.length >= 2 &&
    Number.isFinite(value[0]) &&
    Number.isFinite(value[1])
  );
}

/** Whether a value is a size in pixels: a finite number of 0 or more */
function isSize(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/** How deep the positions of each kind of geometry are nested */
const DEPTHS: Readonly<Record<string, number>> = {
  Point: 0,
  MultiPoint: 1,
  LineString: 1,
  MultiLineString: 2,
  Polygon: 2,
  MultiPolygon: 3,
};

/** Whether coordinates are positions nested `depth` arrays deep, adding them to `extent` */
function readPositions(value: unknown, depth: number, extent: number[]): boolean {
  if (depth === 0) {
    if (!isPosition(value)) return false;
    extent[0] = Math.min(extent[0] as number, value[0] as number);
    extent[1] = Math.min(extent[1] as number, value[1] as number);
    extent[2] = Math.max(extent[2] as number, value[0] as number);
    extent[3] = Math.max(extent[3] as number, value[1] as number);
    return true;
  }
  return Array.isArray(value) && value.every((part) => readPositions(part, depth - 1, extent));
}

/** The extent of positions, `null` for none */
function extentOfPositions(positions: readonly Position[]): BBox {
  const xs = positions.map((p) => p[0] as number);
  const ys = positions.map((p) => p[1] as number);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

/**
 * A footprint read, `null` for a footprint of nothing to draw, `undefined` for what is not a
 * footprint
 *
 * @internal
 */
export function readShape(value: unknown): Shape | null | undefined {
  if (value === null) return null;
  if (typeof value !== 'object' || value === undefined) return undefined;
  const given = value as {
    kind?: unknown;
    type?: unknown;
    corners?: Partial<GroundFootprint['corners']>;
    snap?: unknown;
    position?: unknown;
    halfWidthPixels?: unknown;
    halfHeightPixels?: unknown;
    coordinates?: unknown;
  };
  if (given.kind === 'ground') {
    const corners = given.corners;
    if (!corners) return undefined;
    const four = [corners.topLeft, corners.topRight, corners.bottomRight, corners.bottomLeft];
    if (!four.every(isPosition)) return undefined;
    if (given.snap !== undefined && given.snap !== 'box' && given.snap !== 'center') {
      return undefined;
    }
    return {
      kind: 'ground',
      corners: corners as GroundFootprint['corners'],
      snap: given.snap ?? 'box',
      bbox: extentOfPositions(four as Position[]),
    };
  }
  if (given.kind === 'screen') {
    const { position, halfWidthPixels, halfHeightPixels } = given;
    if (!isPosition(position) || !isSize(halfWidthPixels) || !isSize(halfHeightPixels)) {
      return undefined;
    }
    const [x, y] = position as [number, number];
    return {
      kind: 'screen',
      position,
      halfWidth: halfWidthPixels,
      halfHeight: halfHeightPixels,
      bbox: [x, y, x, y],
    };
  }
  const depth = typeof given.type === 'string' ? DEPTHS[given.type] : undefined;
  if (depth === undefined) return undefined;
  const extent = [
    Number.POSITIVE_INFINITY,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  ];
  if (!readPositions(given.coordinates, depth, extent)) return undefined;
  const empty = !Number.isFinite(extent[0]);
  return {
    kind: 'geometry',
    geometry: value as FeatureGeometry,
    bbox: empty ? null : (extent as unknown as BBox),
  };
}

/**
 * A footprint as the engine takes it for the selection box: a box on the screen, or corners on
 * the map (the extent of a geometry)
 *
 * @internal
 */
export function engineFootprintOf(shape: Shape): EngineFootprint | null {
  if (shape.kind === 'screen') {
    return {
      kind: 'screen',
      position: shape.position,
      halfWidthPx: shape.halfWidth,
      halfHeightPx: shape.halfHeight,
    };
  }
  if (shape.kind === 'ground') return { kind: 'ground', corners: shape.corners };
  if (!shape.bbox) return null;
  const [w, s, e, n] = shape.bbox;
  return {
    kind: 'ground',
    corners: { topLeft: [w, n], topRight: [e, n], bottomRight: [e, s], bottomLeft: [w, s] },
  };
}

/** The parts of a shape on the map: marks, lines and areas */
type Part =
  | { readonly kind: 'point'; readonly at: Position }
  | { readonly kind: 'line'; readonly positions: readonly Position[] }
  | { readonly kind: 'area'; readonly rings: readonly (readonly Position[])[] };

/** The parts of a shape of the map (a box of the screen has none) */
function partsOf(shape: Shape): Part[] {
  if (shape.kind === 'screen') return [];
  if (shape.kind === 'ground') {
    const { topLeft, topRight, bottomRight, bottomLeft } = shape.corners;
    return [{ kind: 'area', rings: [[topLeft, topRight, bottomRight, bottomLeft, topLeft]] }];
  }
  const { geometry } = shape;
  switch (geometry.type) {
    case 'Point':
      return [{ kind: 'point', at: geometry.coordinates }];
    case 'MultiPoint':
      return geometry.coordinates.map((at) => ({ kind: 'point', at }));
    case 'LineString':
      return [{ kind: 'line', positions: geometry.coordinates }];
    case 'MultiLineString':
      return geometry.coordinates.map((positions) => ({ kind: 'line', positions }));
    case 'Polygon':
      return [{ kind: 'area', rings: geometry.coordinates }];
    case 'MultiPolygon':
      return geometry.coordinates.map((rings) => ({ kind: 'area', rings }));
  }
}

/** The corners of a box of the screen, on the map, clockwise from the top left */
function screenCorners(shape: Extract<Shape, { kind: 'screen' }>, screen: ScreenContext) {
  const [x, y] = screen.project(shape.position);
  const w = shape.halfWidth;
  const h = shape.halfHeight;
  return [
    screen.unproject([x - w, y - h]),
    screen.unproject([x + w, y - h]),
    screen.unproject([x + w, y + h]),
    screen.unproject([x - w, y + h]),
  ];
}

/** The distance from a point to a segment, on the screen */
function segmentDistance(p: Point, a: Point, b: Point): { distance: number; t: number } {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const length = dx * dx + dy * dy;
  const t =
    length === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length));
  return { distance: Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy)), t };
}

/** Whether a point is inside rings on the screen (the even-odd rule: holes are out) */
function insideRings(p: Point, rings: readonly (readonly Point[])[]): boolean {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i] as Point;
      const b = ring[j] as Point;
      if (
        a[1] > p[1] !== b[1] > p[1] &&
        p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]
      ) {
        inside = !inside;
      }
    }
  }
  return inside;
}

/** The smallest distance from a point to the edges of a path on the screen */
function pathDistance(p: Point, path: readonly Point[]): number {
  if (path.length === 1)
    return Math.hypot(p[0] - (path[0] as Point)[0], p[1] - (path[0] as Point)[1]);
  let best = Number.POSITIVE_INFINITY;
  for (let i = 1; i < path.length; i++) {
    best = Math.min(best, segmentDistance(p, path[i - 1] as Point, path[i] as Point).distance);
  }
  return best;
}

/**
 * The distance in pixels from a point of the screen to a shape, `null` past the tolerance: 0
 * inside an area or a box
 *
 * @internal
 */
export function hitShape(
  shape: Shape,
  pointer: ScreenPointContext,
  screen: ScreenContext,
): number | null {
  const p = pointer.screenPoint;
  let distance: number;
  if (shape.kind === 'screen') {
    const [x, y] = screen.project(shape.position);
    distance = Math.max(
      0,
      Math.abs(p[0] - x) - shape.halfWidth,
      Math.abs(p[1] - y) - shape.halfHeight,
    );
  } else {
    distance = Number.POSITIVE_INFINITY;
    const project = (at: Position): Point => screen.project(at);
    for (const part of partsOf(shape)) {
      if (part.kind === 'point') {
        const [x, y] = project(part.at);
        distance = Math.min(distance, Math.hypot(p[0] - x, p[1] - y));
      } else if (part.kind === 'line') {
        distance = Math.min(distance, pathDistance(p, part.positions.map(project)));
      } else {
        const rings = part.rings.map((ring) => ring.map(project));
        if (insideRings(p, rings)) return 0;
        for (const ring of rings) distance = Math.min(distance, pathDistance(p, ring));
      }
    }
  }
  return distance <= pointer.tolerancePixels ? distance : null;
}

/** Whether two segments of the screen cross */
function segmentsCross(a: Point, b: Point, c: Point, d: Point): boolean {
  const side = (p: Point, q: Point, r: Point) =>
    Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
  return side(a, b, c) * side(a, b, d) <= 0 && side(c, d, a) * side(c, d, b) <= 0;
}

/**
 * Whether a box of the screen takes a shape: a part of it is in the box, or the box is in an area
 * of it
 *
 * @internal
 */
export function boxShape(
  shape: Shape,
  box: { readonly min: Point; readonly max: Point },
  screen: ScreenContext,
): boolean {
  const { min, max } = box;
  if (shape.kind === 'screen') {
    const [x, y] = screen.project(shape.position);
    return (
      x + shape.halfWidth >= min[0] &&
      x - shape.halfWidth <= max[0] &&
      y + shape.halfHeight >= min[1] &&
      y - shape.halfHeight <= max[1]
    );
  }
  const inBox = (p: Point) => p[0] >= min[0] && p[0] <= max[0] && p[1] >= min[1] && p[1] <= max[1];
  const edges: [Point, Point][] = [
    [min, [max[0], min[1]]],
    [[max[0], min[1]], max],
    [max, [min[0], max[1]]],
    [[min[0], max[1]], min],
  ];
  const crosses = (path: readonly Point[]) =>
    path.some(inBox) ||
    path.some(
      (p, i) => i > 0 && edges.some(([c, d]) => segmentsCross(path[i - 1] as Point, p, c, d)),
    );
  const project = (at: Position): Point => screen.project(at);
  for (const part of partsOf(shape)) {
    if (part.kind === 'point') {
      if (inBox(project(part.at))) return true;
    } else if (part.kind === 'line') {
      if (crosses(part.positions.map(project))) return true;
    } else {
      const rings = part.rings.map((ring) => ring.map(project));
      if (rings.some(crosses)) return true;
      if (insideRings([(min[0] + max[0]) / 2, (min[1] + max[1]) / 2], rings)) return true;
    }
  }
  return false;
}

/**
 * The candidates to snap to of a shape: the vertices and the nearest points of the edges of a
 * geometry; the center, the corners and the edges of corners on the map (the center alone for
 * `snap: 'center'`); the position of a box of the screen
 *
 * @internal
 */
export function snapShape(
  shape: Shape,
  pointer: ScreenPointContext,
  screen: ScreenContext,
): SnapCandidate[] {
  if (shape.kind === 'screen') return [{ position: shape.position, kind: 'vertex' }];
  const out: SnapCandidate[] = [];
  const p = pointer.screenPoint;
  const edgesOf = (path: readonly Position[]) => {
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1] as Position;
      const b = path[i] as Position;
      const { t } = segmentDistance(p, screen.project(a), screen.project(b));
      const position: Position = [
        (a[0] as number) + t * ((b[0] as number) - (a[0] as number)),
        (a[1] as number) + t * ((b[1] as number) - (a[1] as number)),
      ];
      out.push({ position, kind: 'edge' });
    }
  };
  if (shape.kind === 'ground') {
    const { topLeft, topRight, bottomRight, bottomLeft } = shape.corners;
    const corners = [topLeft, topRight, bottomRight, bottomLeft];
    out.push({
      position: [
        corners.reduce((sum, c) => sum + (c[0] as number), 0) / 4,
        corners.reduce((sum, c) => sum + (c[1] as number), 0) / 4,
      ],
      kind: 'vertex',
    });
    if (shape.snap === 'center') return out;
    for (const corner of corners) out.push({ position: corner, kind: 'vertex' });
    edgesOf([...corners, topLeft]);
    return out;
  }
  for (const part of partsOf(shape)) {
    if (part.kind === 'point') {
      out.push({ position: part.at, kind: 'vertex' });
      continue;
    }
    const paths = part.kind === 'line' ? [part.positions] : part.rings;
    for (const path of paths) {
      // The last position of a ring is its first one
      const closed = part.kind === 'area' && path.length > 1;
      const vertices = closed ? path.slice(0, -1) : path;
      for (const position of vertices) out.push({ position, kind: 'vertex' });
      edgesOf(path);
    }
  }
  return out;
}

/**
 * Draws a shape with the look of its feature (or of an overlay) through the shared renderers:
 * areas filled and outlined, lines, and point marks
 *
 * @internal
 */
export function drawShape(
  shape: Shape,
  look: FeatureStyleResolved,
  context: EngineRenderContext,
): void {
  const opacity = context.opacity;
  const stroke = {
    width: look.strokeWidth,
    color: look.strokeColor,
    opacity: look.strokeOpacity * opacity,
    lineStyle: look.lineStyle,
  };
  const area = (rings: readonly (readonly Position[])[]) => {
    context.fill.draw(rings, { color: look.fillColor, opacity: look.fillOpacity * opacity });
    for (const ring of rings) context.line.draw(ring, stroke, { closed: true });
  };
  if (shape.kind === 'screen') {
    area([screenCorners(shape, context.screen)]);
    return;
  }
  for (const part of partsOf(shape)) {
    if (part.kind === 'area') area(part.rings);
    else if (part.kind === 'line') context.line.draw(part.positions, stroke);
    else {
      context.point.draw(part.at, {
        shape: look.pointShape,
        size: look.pointRadius * 2,
        fillColor: look.pointColor,
        fillOpacity: look.pointOpacity * opacity,
        strokeColor: look.pointStrokeColor,
        strokeWidth: look.pointStrokeWidth,
        strokeOpacity: look.pointOpacity * opacity,
      });
    }
  }
}

/**
 * The number of positions of a geometry
 *
 * @internal
 */
export function positionCount(geometry: FeatureGeometry): number {
  const count = (value: unknown, depth: number): number =>
    depth === 0
      ? 1
      : (value as unknown[]).reduce<number>((sum, part) => sum + count(part, depth - 1), 0);
  return count(geometry.coordinates, DEPTHS[geometry.type] as number);
}
