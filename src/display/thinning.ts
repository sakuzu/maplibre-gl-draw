// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Collision thinning of a dataset
 *
 * It is the selection "do not draw the point markers of a dataset when they
 * overlap on screen". The test uses "the size actually drawn" (the radius of the style
 * + the white outline + the margin), so if the host makes the markers bigger the thinning gets
 * coarser too.
 *
 * The skeleton of the decision:
 *
 * - For each integer zoom band `b = floor(zoom)`, the set of winners is decided from all of the
 *   features of the dataset. It is not narrowed by the view, so panning does not swap the
 *   winners (it is deterministic). When there is a pitch, the band is taken from "the shallowest
 *   effective zoom on screen" (`effectiveZoomForCamera`)
 * - The footprint radius of each point is computed in the screen pixels of band b, converted
 *   into mercator world coordinates (the 0..1 square), and the distances are compared. At the
 *   same zoom, screen pixels and world coordinates are proportional regardless of the latitude,
 *   so a single factor is enough for the conversion
 * - They are taken greedily in the reverse of the draw order (from the frontmost), and one is
 *   taken when it satisfies `dist < r_i + r_j` with none of the winners already taken. The
 *   neighbour search uses a spatial hash grid (the cell side = the largest footprint of that
 *   band), but the decision is never made by the occupancy of the grid: a winner in a
 *   neighbouring cell can be right next to it, so the real distance is always used
 * - Anything but a point (Point) is not thinned. A MultiPoint is not thinned either (one feature
 *   has several footprints far apart, so a single footprint cannot decide it)
 *
 * This function is a pure function that depends only on the feature list, the band and the
 * footprint radii, and it always returns the same set of winners for the same input (so a path
 * that draws once at a given zoom, such as a snapshot of the view, gets the same picture as the
 * screen).
 */

import type { Coordinate, Feature } from '../shared/types/model.js';
import type { PointStyle } from '../view/renderers/point/point-shape.js';
import type { DatasetBaseStyle } from './types.js';

/**
 * The zoom at which the thinning stops (default). At or above it every feature is drawn
 *
 * @internal
 */
export const DEFAULT_FULL_DISPLAY_ZOOM = 17;

/**
 * Margin added to a footprint (px, default)
 *
 * @internal
 */
export const DEFAULT_THINNING_MARGIN_PX = 2;

/**
 * How many bands of winners a dataset keeps (one byte per row each). A zoom gesture crosses a few
 * bands; going back and forth over them costs no selection
 */
const MAX_CACHED_BANDS = 6;

/** Upper limit of the zoom bands (22 steps, the same as the tile coordinates) */
const MAX_ZOOM_BAND = 22;

/** Screen pixels of one tile of the mercator world coordinates (512px tiles) */
const TILE_SIZE_PX = 512;

/** Upper limit of the latitude that Web Mercator can express */
const MAX_MERCATOR_LAT = 85.0511287798066;

/**
 * The collision thinning of the point markers of a dataset, as the host
 * passes it.
 *
 * Everything can be omitted, and an omitted item takes its default value. While it is
 * enabled, `Point` markers that overlap on screen are not drawn and cannot be hit; lines,
 * polygons and MultiPoint are always drawn. The overlap is tested with the size actually drawn
 * (the radius + the outline + `marginPx`), and the winners are picked greedily from the front
 * of the draw order for each integer zoom band, so panning does not swap them.
 *
 * @example
 * ```ts
 * const places = draw.addDataset({
 *   id: 'places',
 *   features,
 *   collisionThinning: { enabled: true, fullDisplayZoom: 17, marginPx: 2 },
 * });
 * const { total, visible } = places.getThinningStats(); // "showing 1,200 of 50,000"
 * ```
 */
export interface DatasetCollisionThinning {
  /** Whether the thinning is enabled (false by default = everything is drawn as before) */
  enabled?: boolean;
  /**
   * The zoom at which the thinning stops (17 by default)
   *
   * At or above this zoom the set of winners becomes every feature. It is an escape hatch that
   * avoids "something in the source data can never be seen no matter what", and it can be
   * changed at runtime because it is decided by looking at the real thing.
   */
  fullDisplayZoom?: number;
  /**
   * Margin added around each marker's footprint, in screen px (2 by default; NaN or a negative
   * value gives 2)
   */
  marginPx?: number;
}

/**
 * The collision thinning in effect, with every default filled in, as
 * {@link Dataset.getCollisionThinning} returns it.
 */
export interface ResolvedCollisionThinning {
  /** Whether the thinning is enabled */
  enabled: boolean;
  /** The zoom at or above which every feature is drawn */
  fullDisplayZoom: number;
  /** The margin added around each marker's footprint, in screen px */
  marginPx: number;
}

/**
 * The current result of the collision thinning, as {@link Dataset.getThinningStats}
 * returns it; for a message such as "showing n of N".
 */
export interface DatasetThinningStats {
  /** Whether it is enabled as a setting */
  enabled: boolean;
  /** Whether it is actually thinning (the band is below fullDisplayZoom and winners exist) */
  active: boolean;
  /** The number of all the features held */
  total: number;
  /** The number of features drawn (the same as total when nothing is thinned) */
  visible: number;
  /** The zoom band the winners were picked for (null when not computed or disabled) */
  band: number | null;
}

/**
 * Resolves the settings (an unspecified item takes its default)
 *
 * fullDisplayZoom and marginPx fall back to their defaults for an invalid value (NaN, negative).
 *
 * @internal
 */
export function resolveCollisionThinning(
  input: DatasetCollisionThinning | null | undefined,
): ResolvedCollisionThinning {
  return {
    enabled: input?.enabled ?? false,
    fullDisplayZoom:
      input?.fullDisplayZoom !== undefined && Number.isFinite(input.fullDisplayZoom)
        ? input.fullDisplayZoom
        : DEFAULT_FULL_DISPLAY_ZOOM,
    marginPx:
      input?.marginPx !== undefined && Number.isFinite(input.marginPx) && input.marginPx >= 0
        ? input.marginPx
        : DEFAULT_THINNING_MARGIN_PX,
  };
}

/**
 * Whether two settings are the same
 *
 * @internal
 */
export function sameCollisionThinning(
  a: ResolvedCollisionThinning | null,
  b: ResolvedCollisionThinning | null,
): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.enabled === b.enabled && a.fullDisplayZoom === b.fullDisplayZoom && a.marginPx === b.marginPx
  );
}

/**
 * Computes the integer band from a zoom (clamped into 0..22)
 *
 * @internal
 */
export function zoomBandFor(zoom: number): number {
  if (!Number.isFinite(zoom)) return 0;
  return Math.min(MAX_ZOOM_BAND, Math.max(0, Math.floor(zoom)));
}

/**
 * The length in mercator world coordinates that corresponds to one screen pixel in band b
 *
 * The whole world is `512 * 2^b` px on a side, so it is the reciprocal of that. It works not
 * only for an integer band but also for a fractional zoom such as an effective zoom.
 *
 * @internal
 */
export function worldUnitsPerPixel(band: number): number {
  return 1 / (TILE_SIZE_PX * 2 ** band);
}

/**
 * Upper limit of the drop of the effective zoom allowed by the pitch correction
 *
 * When the pitch is large and the horizon enters the screen, the top edge goes to infinity and
 * the ratio diverges. The cap keeps the band from falling to 0 and tipping into "almost nothing
 * is drawn". At the default maximum pitch of 60 degrees the drop is about 3.2, so it normally
 * has no effect.
 *
 * @internal
 */
export const MAX_PITCH_ZOOM_DROP = 8;

/**
 * The camera used to measure the effective zoom (read only)
 *
 * It is the minimal shape that the Map of MapLibre satisfies structurally. It is the entry point
 * for measuring how things look including the pitch, while keeping everything under display
 * independent of the map implementation.
 *
 * @internal
 */
export interface ThinningCamera {
  getZoom(): number;
  getPitch(): number;
  /** Converts a screen coordinate (CSS pixels) back into a map coordinate */
  unproject(point: [number, number]): { lng: number; lat: number };
  /** Size of the screen in CSS pixels */
  getCanvas(): { clientWidth: number; clientHeight: number };
}

/**
 * Computes the shallowest effective zoom on screen (a pure function)
 *
 * With a pitch, the higher part of the screen is farther away and only there the effective scale
 * gets shallower. Deciding the band with the zoom of the camera would let everything flow into
 * the distance and get squashed. So the ratio "how many pixels the distance from the center of
 * the screen to the top center would correspond to on a plane (pitch 0)" is measured, and the
 * zoom is lowered by that much.
 *
 * - On a plane, the distance in mercator world coordinates from the center to the top edge
 *   matches `pixelDistance / (512 * 2^zoom)` exactly (ratio = 1), so at pitch 0 the result is
 *   exactly the zoom
 * - The same camera state always returns the same value (it is deterministic)
 * - The drop is capped by `MAX_PITCH_ZOOM_DROP`
 *
 * @param zoom The zoom of the camera
 * @param center The map coordinate of the center of the screen
 * @param topCenter The map coordinate of the top center of the screen
 * @param pixelDistance The screen pixels from the center to the top edge (half the height)
 *
 * @internal
 */
export function effectiveZoomForPitch(input: {
  zoom: number;
  center: Coordinate;
  topCenter: Coordinate;
  pixelDistance: number;
}): number {
  const { zoom, center, topCenter, pixelDistance } = input;
  if (!Number.isFinite(zoom)) return zoom;
  if (!Number.isFinite(pixelDistance) || pixelDistance <= 0) return zoom;

  const dx = lngToWorldX(topCenter[0]) - lngToWorldX(center[0]);
  const dy = latToWorldY(topCenter[1]) - latToWorldY(center[1]);
  const measured = Math.sqrt(dx * dx + dy * dy);
  const flat = pixelDistance * worldUnitsPerPixel(zoom);
  if (!Number.isFinite(measured) || measured <= 0 || flat <= 0) return zoom;

  const ratio = measured / flat;
  // When the ratio is at most 1 (pitch 0, rounding error) the zoom of the camera is used as before
  if (!Number.isFinite(ratio) || ratio <= 1) return zoom;

  return Math.max(zoom - MAX_PITCH_ZOOM_DROP, zoom - Math.log2(ratio));
}

/**
 * Computes the effective zoom from the camera
 *
 * When the pitch is 0 it returns the zoom of the camera without measuring anything (so even with
 * a projection that cannot be measured on a plane, such as globe, the result is exactly the same
 * as before as long as there is no pitch).
 *
 * @internal
 */
export function effectiveZoomForCamera(camera: ThinningCamera): number {
  const zoom = camera.getZoom();
  const pitch = camera.getPitch();
  if (!Number.isFinite(pitch) || pitch <= 0) return zoom;

  const canvas = camera.getCanvas();
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (!(width > 0) || !(height > 0)) return zoom;

  const centerX = width / 2;
  const centerY = height / 2;
  const center = camera.unproject([centerX, centerY]);
  const topCenter = camera.unproject([centerX, 0]);

  return effectiveZoomForPitch({
    zoom,
    center: [center.lng, center.lat],
    topCenter: [topCenter.lng, topCenter.lat],
    pixelDistance: centerY,
  });
}

/**
 * Longitude into the mercator world coordinate X (0..1)
 *
 * @internal
 */
export function lngToWorldX(lng: number): number {
  return (Math.min(180, Math.max(-180, lng)) + 180) / 360;
}

/**
 * Latitude into the mercator world coordinate Y (0..1)
 *
 * @internal
 */
export function latToWorldY(lat: number): number {
  const clamped = Math.min(MAX_MERCATOR_LAT, Math.max(-MAX_MERCATOR_LAT, lat));
  const rad = (clamped * Math.PI) / 180;
  return (1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2;
}

/**
 * Computes the radius (px) at which a point marker is drawn
 *
 * It is "the size that appears on screen": the radius of the fill plus the width of the white
 * outline, multiplied by the zoom-dependent factor. The radius is resolved in the same order as
 * on the rendering side (FeatureDrawer.getPointStyle): "the individual style > the base style >
 * the core default". The outline width of a point cannot be changed by an individual style, so
 * the default value is used as it is.
 *
 * Both the footprint of the thinning (with the margin added) and the hit radius of the hit
 * testing (grabbable exactly as it looks) go through this single place.
 *
 * @param styleRadius The radius of the individual style (undefined when there is none)
 * @param baseStyle The base style of the dataset
 * @param defaults The default point style of core
 * @param scale The zoom-dependent size factor (the scale of zoomScale)
 *
 * @internal
 */
export function pointMarkerRadiusPx(
  styleRadius: number | undefined,
  baseStyle: DatasetBaseStyle | undefined,
  defaults: PointStyle,
  scale: number,
): number {
  const radius = styleRadius ?? baseStyle?.point?.pointRadius ?? defaults.size / 2;
  const stroke = defaults.strokeOpacity > 0 ? defaults.strokeWidth : 0;
  return Math.max(0, (radius + stroke) * scale);
}

/**
 * Computes the footprint radius (px) of a point
 *
 * The decision uses the size actually drawn, so the margin is added to the radius that is drawn
 * (`pointMarkerRadiusPx`).
 *
 * @param feature The target (a Point)
 * @param baseStyle The base style of the dataset
 * @param defaults The default point style of core
 * @param scale The zoom-dependent size factor (the scale of zoomScale)
 * @param marginPx The margin (px)
 *
 * @internal
 */
export function pointFootprintPx(
  feature: Feature,
  baseStyle: DatasetBaseStyle | undefined,
  defaults: PointStyle,
  scale: number,
  marginPx: number,
): number {
  return pointMarkerRadiusPx(feature.style?.pointRadius, baseStyle, defaults, scale) + marginPx;
}

/**
 * What a row is to the collision thinning
 *
 * - skip: it is not drawn (hidden, or without a geometry): neither a winner nor an obstacle
 * - winner: it is not thinned (a line, a polygon, a MultiPoint, a point without valid
 *   coordinates) and is always drawn
 * - point: a point that takes part in the thinning
 *
 * @internal
 */
export type ThinningRole = 'skip' | 'winner' | 'point';

/**
 * The rows the collision thinning reads (a `DisplaySource` satisfies it)
 *
 * @internal
 */
export interface ThinningRows {
  /** The number of rows, in draw order (the later, the more in front) */
  readonly length: number;
  /** What the row is to the thinning */
  thinningRole(row: number): ThinningRole;
  /** The `[lng, lat]` of a row whose role is `point` */
  pointOf(row: number): readonly [number, number];
  /** The point radius of the individual style of a row (undefined for none) */
  styleRadiusOf(row: number): number | undefined;
  /** The id of a row */
  idOf(row: number): string;
}

/**
 * Picks the winners among the rows
 *
 * The result also marks what is out of scope for the thinning (anything but a Point, and so on).
 * A row that is not drawn (`skip`) becomes neither a winner nor an obstacle.
 *
 * @param radiusPx The footprint radius of a row (px, including the outline and the margin)
 * @returns 1 for each row that may be drawn, 0 otherwise
 *
 * @internal
 */
export function selectCollisionWinnerRows(
  rows: ThinningRows,
  band: number,
  radiusPx: (row: number) => number,
): Uint8Array {
  const count = rows.length;
  const winners = new Uint8Array(count);

  // Build arrays that hold only the points (the decision is made in world coordinates)
  const xs = new Float64Array(count);
  const ys = new Float64Array(count);
  const rs = new Float64Array(count);
  const pointRows = new Int32Array(count);
  const perPixel = worldUnitsPerPixel(band);
  let pointCount = 0;
  let maxRadius = 0;

  for (let row = 0; row < count; row++) {
    const role = rows.thinningRole(row);
    if (role === 'skip') continue;
    if (role === 'winner') {
      // A line, a polygon, a MultiPoint and so on are not thinned (they win unconditionally)
      winners[row] = 1;
      continue;
    }

    const coord = rows.pointOf(row);
    const radius = radiusPx(row) * perPixel;
    xs[pointCount] = lngToWorldX(coord[0]);
    ys[pointCount] = latToWorldY(coord[1]);
    rs[pointCount] = radius;
    pointRows[pointCount] = row;
    if (radius > maxRadius) maxRadius = radius;
    pointCount++;
  }

  if (pointCount === 0) return winners;

  // With no footprint (radius 0) nobody collides
  if (maxRadius <= 0) {
    for (let k = 0; k < pointCount; k++) winners[pointRows[k]] = 1;
    return winners;
  }

  const grid = createHashGrid(xs, ys, pointCount, maxRadius);
  const { cell, minX, minY, stride, buckets, keyDeltas } = grid;

  // Take them greedily in the reverse of the draw order (from the frontmost)
  for (let k = pointCount - 1; k >= 0; k--) {
    const x = xs[k];
    const y = ys[k];
    const r = rs[k];
    const key = (Math.floor((y - minY) / cell) + 1) * stride + (Math.floor((x - minX) / cell) + 1);

    let blocked = false;
    // From its own cell outwards, decided by the real distance to the winners (not by occupancy)
    for (let d = 0; d < keyDeltas.length; d++) {
      const bucket = buckets.get(key + keyDeltas[d]);
      if (bucket === undefined) continue;
      for (let i = 0; i < bucket.length; i++) {
        const j = bucket[i];
        const ddx = xs[j] - x;
        const ddy = ys[j] - y;
        const sum = rs[j] + r;
        if (ddx * ddx + ddy * ddy < sum * sum) {
          blocked = true;
          break;
        }
      }
      if (blocked) break;
    }
    if (blocked) continue;

    const bucket = buckets.get(key);
    if (bucket) bucket.push(k);
    else buckets.set(key, [k]);
    winners[pointRows[k]] = 1;
  }

  return winners;
}

/**
 * Input of the collision thinning of an array of features
 *
 * @internal
 */
export interface CollisionThinningInput {
  /** The features in draw order (the later, the more in front) */
  features: readonly Feature[];
  /** The zoom band to decide for */
  band: number;
  /** The footprint radius of a feature (px, including the outline and the margin) */
  radiusPx(feature: Feature): number;
}

/**
 * Picks the set of winners among features (`selectCollisionWinnerRows` over an array)
 *
 * @returns The set of ids of the features that may be drawn
 *
 * @internal
 */
export function selectCollisionWinners(input: CollisionThinningInput): Set<string> {
  const { features, band, radiusPx } = input;
  const rows: ThinningRows = {
    length: features.length,
    thinningRole: (row) => featureThinningRole(features[row]),
    pointOf: (row) => features[row].coordinates as [number, number],
    styleRadiusOf: (row) => features[row].style?.pointRadius,
    idOf: (row) => features[row].id,
  };
  const mask = selectCollisionWinnerRows(rows, band, (row) => radiusPx(features[row]));
  const winners = new Set<string>();
  for (let row = 0; row < mask.length; row++) {
    if (mask[row] === 1) winners.add(features[row].id);
  }
  return winners;
}

/**
 * What a feature is to the collision thinning
 *
 * @internal
 */
export function featureThinningRole(feature: Feature): ThinningRole {
  if (!feature.visible) return 'skip';
  if (feature.type !== 'Point') return 'winner';
  const coord = feature.coordinates as unknown;
  if (!Array.isArray(coord) || typeof coord[0] !== 'number' || typeof coord[1] !== 'number') {
    return 'winner';
  }
  return 'point';
}

/**
 * Spatial hash grid (only the winners go in)
 *
 * The key is a single integer, `row * stride + column`. The columns keep a margin of one cell on
 * each side, so the key of a neighbouring cell (±1, ±stride) never wraps into another row.
 */
interface HashGrid {
  /** The cell side (in world coordinates) */
  cell: number;
  /** The origin of the grid (in world coordinates) */
  minX: number;
  minY: number;
  /** The step of the key per row */
  stride: number;
  /** key → the indices of the winners */
  buckets: Map<number, number[]>;
  /** The key deltas of its own cell and the 8 cells around it (its own cell comes first) */
  keyDeltas: readonly number[];
}

/**
 * Prepares the grid
 *
 * The cell side is "the diameter of the largest footprint of that band". Two colliding points
 * always fall within a displacement of one cell, so looking only at its own cell and the 8 cells
 * around it misses nothing.
 *
 * The key is an integer built from the row and the column, but when the range is so wide that it
 * would leave the safe integers, the cells are made coarser (this only adds candidates; the
 * decision uses the real distance, so the result does not change).
 */
function createHashGrid(
  xs: Float64Array,
  ys: Float64Array,
  count: number,
  maxRadius: number,
): HashGrid {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < count; i++) {
    if (xs[i] < minX) minX = xs[i];
    if (xs[i] > maxX) maxX = xs[i];
    if (ys[i] < minY) minY = ys[i];
    if (ys[i] > maxY) maxY = ys[i];
  }

  let cell = maxRadius * 2;
  let cols = Math.floor((maxX - minX) / cell) + 1;
  let rows = Math.floor((maxY - minY) / cell) + 1;
  // Make them coarser until they fit in the safe integers even with the room to subtract one
  // surrounding cell (+2)
  while ((cols + 2) * (rows + 2) > Number.MAX_SAFE_INTEGER) {
    cell *= 2;
    cols = Math.floor((maxX - minX) / cell) + 1;
    rows = Math.floor((maxY - minY) / cell) + 1;
  }

  const stride = cols + 2;

  return {
    cell,
    minX,
    minY,
    stride,
    buckets: new Map<number, number[]>(),
    // Its own cell is looked at first, so that the denser it is, the sooner it is rejected
    keyDeltas: [0, -1, 1, -stride, stride, -stride - 1, -stride + 1, stride - 1, stride + 1],
  };
}

/**
 * What the thinning state of a dataset reads from its dataset
 *
 * @internal
 */
export interface CollisionThinningHost {
  /** The rows in draw order */
  rows(): ThinningRows;
  /** Generation of the set of rows (advances when the contents are replaced) */
  featuresGeneration(): number;
  /** Revision number of the style (advances when the rule, the base style or the factors change) */
  styleRevision(): number;
  /**
   * The footprint radius of a point in band `band` (px, including the outline and `marginPx`),
   * from the point radius of its individual style (undefined for none)
   *
   * The zoom-dependent factor is applied with the value of the band.
   */
  footprintPx(band: number, marginPx: number): (styleRadius: number | undefined) => number;
  /** The current zoom and "the shallowest effective zoom on screen" (with the pitch correction) */
  viewport(): { zoom: number; effectiveZoom?: number };
}

/**
 * The collision thinning state of one dataset
 *
 * It holds the settings and the rows that are drawn (the winners; cached by the feature
 * generation, the style revision and the zoom band). The methods that change what is drawn
 * return whether it actually changed; the dataset then discards its retained batches and
 * tells its listeners.
 *
 * @internal
 */
export class CollisionThinningState {
  /** Settings of the collision thinning (null = not set = disabled) */
  private settings: ResolvedCollisionThinning | null;
  /**
   * The cache key of the winners (the feature generation, the style revision and the zoom band)
   */
  private state: { generation: number; revision: number; band: number } | null = null;
  /** 1 for each row that is drawn (the winners). null means every row */
  private drawnRows: Uint8Array | null = null;
  /** The number of rows that are drawn */
  private drawnCount = 0;
  /** The ids of the drawn rows, built on the first request */
  private drawnIds: Set<string> | null = null;
  /**
   * The winners already picked for each band, for the feature generation and the style revision
   * in `cacheKey` (null = every row). Going back to a band seen before costs nothing
   */
  private readonly bandCache = new Map<number, Uint8Array | null>();
  /** The feature generation and the style revision the bands in `bandCache` were picked for */
  private cacheKey: { generation: number; revision: number } | null = null;

  constructor(
    private readonly host: CollisionThinningHost,
    options?: DatasetCollisionThinning,
  ) {
    this.settings = options ? resolveCollisionThinning(options) : null;
  }

  /** The settings (null when not set) */
  get options(): ResolvedCollisionThinning | null {
    return this.settings;
  }

  /** Whether the thinning is enabled */
  get enabled(): boolean {
    return this.settings?.enabled ?? false;
  }

  /** Whether some rows are thinned away (false: every row is drawn) */
  get active(): boolean {
    return this.drawnRows !== null;
  }

  /** The ids of the rows that are drawn (null = every row) */
  get drawable(): ReadonlySet<string> | null {
    const mask = this.drawnRows;
    if (!mask) return null;
    if (!this.drawnIds) {
      const rows = this.host.rows();
      const ids = new Set<string>();
      for (let row = 0; row < mask.length; row++) {
        if (mask[row] === 1) ids.add(rows.idOf(row));
      }
      this.drawnIds = ids;
    }
    return this.drawnIds;
  }

  /**
   * Replaces the settings
   *
   * @returns null when the settings are the same; otherwise whether what is drawn changed
   */
  setOptions(options: DatasetCollisionThinning | null): { drawnChanged: boolean } | null {
    const next = options ? resolveCollisionThinning(options) : null;
    if (sameCollisionThinning(this.settings, next)) return null;

    const wasThinning = this.drawnRows !== null;
    this.settings = next;
    this.state = null;
    this.setDrawn(null);
    this.forgetBands();

    if (next?.enabled) {
      this.recompute(zoomBandFor(this.zoomFor()));
    }
    return { drawnChanged: wasThinning || this.drawnRows !== null };
  }

  /** Whether a row is drawn (it survived the thinning, or nothing is thinned) */
  isDrawnRow(row: number): boolean {
    return this.drawnRows === null || this.drawnRows[row] === 1;
  }

  /** The statistics of the thinning for `total` features */
  stats(total: number): DatasetThinningStats {
    const thinning = this.drawnRows !== null;
    return {
      enabled: this.enabled,
      active: thinning,
      total,
      visible: thinning ? this.drawnCount : total,
      band: thinning ? (this.state?.band ?? null) : null,
    };
  }

  /**
   * Follows the band of the displayed zoom (the path of moveend)
   *
   * @returns Whether what is drawn changed
   */
  refresh(zoom?: number): boolean {
    const band = zoomBandFor(this.zoomFor(zoom));
    if (this.isFresh() && this.state?.band === band) return false;
    return this.recompute(band);
  }

  /**
   * Prepares the winners right before drawing
   *
   * The winners are rebuilt when there are none yet, or when they went stale because the
   * features or the style changed.
   *
   * @returns Whether what is drawn changed
   */
  ensure(zoom: number): boolean {
    if (!this.enabled) {
      if (this.drawnRows === null) return false;
      this.state = null;
      this.setDrawn(null);
      return true;
    }
    if (this.isFresh()) return false;
    return this.recompute(zoomBandFor(this.zoomFor(zoom)));
  }

  /**
   * Follows the band of the current zoom of the map, in the middle of a zoom or pitch gesture as
   * well (called right before drawing)
   *
   * Keeping the winners of the band the gesture started in would draw them at another scale:
   * after a large zoom out they pile up into a solid patch until the gesture ends. The winners
   * of each band are kept for the current features and style, so the selection runs at most once
   * per band crossed, not once per frame.
   *
   * @returns Whether what is drawn changed
   */
  follow(): boolean {
    if (!this.enabled || !this.isFresh()) return false;
    const band = zoomBandFor(this.zoomFor());
    if (this.state?.band === band) return false;
    return this.recompute(band);
  }

  /**
   * Picks the winners again after the style changed (in the band already decided)
   *
   * @returns Whether what is drawn changed
   */
  onStyleChanged(): boolean {
    if (!this.enabled) return false;
    return this.recompute(this.state?.band ?? zoomBandFor(this.zoomFor()));
  }

  /**
   * Picks the winners of one band near the current one ahead of time (`missingNeighbors`)
   *
   * Called while the page is idle, so that crossing into that band during a gesture costs no
   * selection in the middle of a frame.
   *
   * @returns Whether a band near the current one is still missing
   */
  prefetchNeighbor(): boolean {
    const settings = this.settings;
    const state = this.state;
    if (!settings?.enabled || !state || !this.isFresh()) return false;

    const missing = this.missingNeighbors(state.band);
    if (missing.length === 0) return false;
    this.keepBand(missing[0], this.pickWinners(missing[0], settings));
    return missing.length > 1;
  }

  /**
   * The bands near `band` (two on each side) whose winners are not kept yet, the nearest and the
   * lower first. A fast zoom gesture crosses two bands before the page is idle again
   */
  private missingNeighbors(band: number): number[] {
    const missing: number[] = [];
    for (const next of [band - 1, band + 1, band - 2, band + 2]) {
      if (next < 0 || next > MAX_ZOOM_BAND) continue;
      const kept = this.bandCache.get(next);
      // A band still kept is marked as used, so that picking the missing ones does not drop it
      if (kept === undefined) missing.push(next);
      else this.keepBand(next, kept);
    }
    return missing;
  }

  /** Picks the winners again after the contents were replaced */
  onFeaturesReplaced(): void {
    if (this.enabled) this.recompute(zoomBandFor(this.zoomFor()));
  }

  /** Forgets the winners (the settings are kept) */
  clear(): void {
    this.state = null;
    this.setDrawn(null);
    this.forgetBands();
  }

  /**
   * The zoom that decides the band of the thinning (with the pitch correction)
   *
   * With a pitch, the higher part of the screen is farther away and only there the effective
   * scale gets shallower. Deciding the band with the zoom of the camera would let everything flow
   * into the distance and get squashed, so the difference from "the shallowest effective zoom on
   * screen" (the drop) is subtracted. At pitch 0 the drop is 0 and the band is exactly the same
   * as before.
   *
   * @param zoom The zoom to base it on (the current zoom of the map when omitted)
   */
  zoomFor(zoom?: number): number {
    const view = this.host.viewport();
    const base = zoom ?? view.zoom;
    const effective = view.effectiveZoom;
    if (effective === undefined || !Number.isFinite(effective)) return base;
    const drop = view.zoom - effective;
    return drop > 0 ? base - drop : base;
  }

  /** Whether the winners are those of the current feature generation and style revision */
  private isFresh(): boolean {
    const state = this.state;
    return (
      state !== null &&
      state.generation === this.host.featuresGeneration() &&
      state.revision === this.host.styleRevision()
    );
  }

  /** Discards the winners kept per band */
  private forgetBands(): void {
    this.bandCache.clear();
    this.cacheKey = null;
  }

  /** Replaces the drawn rows (null = every row) */
  private setDrawn(mask: Uint8Array | null): void {
    this.drawnRows = mask;
    this.drawnIds = null;
    let count = 0;
    if (mask) for (let row = 0; row < mask.length; row++) count += mask[row];
    this.drawnCount = count;
  }

  /**
   * Picks the winners again for the band `band`
   *
   * The footprint is "the resolved radius + the outline + the margin" seen as a size in the
   * screen pixels of the band. At a band at or above `fullDisplayZoom` nothing is thinned (every
   * row is drawn).
   *
   * @returns Whether what is drawn actually changed
   */
  private recompute(band: number): boolean {
    const settings = this.settings;
    if (!settings?.enabled) return false;

    const before = this.drawnRows;
    const generation = this.host.featuresGeneration();
    const revision = this.host.styleRevision();
    this.state = { generation, revision, band };

    const key = this.cacheKey;
    if (!key || key.generation !== generation || key.revision !== revision) {
      this.bandCache.clear();
      this.cacheKey = { generation, revision };
    }

    let mask = this.bandCache.get(band);
    if (mask === undefined) mask = this.pickWinners(band, settings);
    this.keepBand(band, mask);
    if (mask === before) return false;

    const changed = !sameMask(before, mask);
    this.setDrawn(mask);
    return changed;
  }

  /**
   * Keeps the winners of a band as the most recently used one (the least recently used band is
   * dropped first; a Map keeps the order of insertion)
   */
  private keepBand(band: number, mask: Uint8Array | null): void {
    this.bandCache.delete(band);
    if (this.bandCache.size >= MAX_CACHED_BANDS) {
      const oldest = this.bandCache.keys().next().value;
      if (oldest !== undefined) this.bandCache.delete(oldest);
    }
    this.bandCache.set(band, mask);
  }

  /** The winners of the band `band` (null = every row) */
  private pickWinners(band: number, settings: ResolvedCollisionThinning): Uint8Array | null {
    if (band >= settings.fullDisplayZoom) return null;
    const rows = this.host.rows();
    const footprint = this.host.footprintPx(band, settings.marginPx);
    return selectCollisionWinnerRows(rows, band, (row) => footprint(rows.styleRadiusOf(row)));
  }
}

/** Whether two masks of drawn rows are the same (null = every row) */
function sameMask(a: Uint8Array | null, b: Uint8Array | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
