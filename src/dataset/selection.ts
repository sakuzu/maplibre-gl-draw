// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Selection highlight and hit testing of a dataset
 *
 * The highlight overdraws the selected features on the immediate-mode path, so switching the
 * selection never rebuilds a GPU resource. The hit test narrows the candidates with the spatial
 * index and tests them precisely from the front of the draw order. Both are pure functions over
 * what the dataset hands them; the dataset keeps the state (the selected features, the
 * index, the thinning).
 */

import type { ProjectionData } from 'maplibre-gl';
import {
  SELECTION_HIGHLIGHT_COLOR,
  SELECTION_HIGHLIGHT_FILL_OPACITY,
  SELECTION_HIGHLIGHT_RING_EXTRA,
  SELECTION_HIGHLIGHT_STROKE_EXTRA,
} from '../shared/config/selection-highlight.js';
import type { BoundingBox, Coordinate, Feature } from '../shared/types/model.js';
import { getBoundingBox } from '../shared/utils/feature-bbox.js';
import type { RetainedDrawFactors } from '../view/renderers/draw-factors.js';
import type { PointStyle } from '../view/renderers/point/point-shape.js';
import type { RetainedStyleResolver } from '../view/renderers/retained.js';
import { getStyleRuleChannel } from '../view/style-rule.js';
import type { TerrainContext } from '../view/terrain/context.js';
import { isDrapePaintedDataset } from '../view/terrain/state.js';
import { boundsIntersect } from './chunk.js';
import { pointMarkerRadiusPx, worldUnitsPerPixel } from './thinning.js';
import type { DatasetBaseStyle, DisplayBatchTarget, DisplayHitTestFn } from './types.js';

/** Default line width (the same as lineString.stroke.width of feature-style) */
const DEFAULT_STROKE_WIDTH = 2;

/** Default radius of a point (half of point.point.size 12 of feature-style) */
const DEFAULT_POINT_RADIUS = 6;

/**
 * What the selection highlight of one frame is drawn from
 *
 * @internal
 */
export interface SelectionHighlightInput {
  target: DisplayBatchTarget;
  projectionData: ProjectionData;
  zoom: number;
  /**
   * The draw factors of the frame (those of `zoomScale`; the highlight and the feature redrawn
   * over it take the same factors as the rest of the dataset). No factors when omitted
   */
  factors?: RetainedDrawFactors;
  bounds: BoundingBox;
  /** The selected features (in draw order) */
  selected: readonly Feature[];
  /** The style resolver of the retained renderers (undefined in immediate mode) */
  styles: RetainedStyleResolver | undefined;
  /** The terrain of the draw target */
  terrain: TerrainContext;
  /** The id of the dataset (to ask whether the drape is painting it) */
  datasetId: string;
  /** Whether the polygons and lines are handed to the analytic drape */
  drapedFills: boolean;
  /** Returns the feature carrying the rule color and the base style */
  prepare(feature: Feature): Feature;
  /** Whether it is a point drawn by an external renderer (core does not draw it) */
  isExternalPoint(feature: Feature): boolean;
}

/**
 * Overpaints the selected features with the highlight
 *
 * Neither the retained batches nor the reused features are touched. It only overdraws on the
 * same immediate-mode path as fallback, so switching the selection never rebuilds a GPU
 * resource.
 *
 * A point is drawn as "a point of the key color slightly larger than the original → the
 * original point", so that the difference shows as a ring. Lines and polygons are painted over
 * in the key color.
 *
 * While the polygons and lines are handed to the analytic drape, however, their highlight is
 * not drawn here (the drape draws it as ground pixels; `isHandedToDrape`). The immediate-mode
 * path only subdivides along the terrain inside the region of the subdivision (the DEM atlas ∩
 * the view), so drawing a surface the size of a prefecture here would leave everything outside
 * that region as flat triangles and turn into "a red vertical wall" and "a wrong fan-shaped
 * coverage". The test for the hand-over is paired with the drape side (collectDataset in
 * `drape/pass.ts`), so in the band where the feature itself appears the highlight always
 * appears too.
 *
 * @internal
 */
export function drawSelectionHighlight(input: SelectionHighlightInput): void {
  const { target, projectionData, zoom, bounds, styles } = input;
  if (input.selected.length === 0) return;

  const visible = input.selected.filter(
    (feature) => feature.visible && boundsIntersect(getBoundingBox(feature), bounds),
  );
  if (visible.length === 0) return;

  target.beginFrame(projectionData, zoom, undefined, input.factors);
  for (const feature of visible) {
    const prepared = input.prepare(feature);
    // The hand-over decision (drapedFills) switches a few frames late, so looking only at it
    // would let the immediate path draw the highlight while the drape is already painting. The
    // immediate path does not subdivide outside the region of the subdivision, so a surface as
    // large as a prefecture or a city becomes a flat plate there, floats off the terrain and
    // raises a vertical wall. Whether it is actually painting is looked at as well
    const draped = input.drapedFills || isDrapePaintedDataset(input.terrain, input.datasetId);
    if (draped && styles && isHandedToDrape(prepared, styles)) {
      continue;
    }
    target.processFeature(highlightFeature(prepared), false);
    // To make a point look like a ring, the original point is drawn again over the highlight.
    // For a point drawn by an external renderer the overpaint is skipped and only the halo
    // underneath is left (the picture of the external renderer is drawn above core, so the
    // result is a selection halo behind that picture)
    if (getStyleRuleChannel(prepared.type) === 'point' && !input.isExternalPoint(prepared)) {
      target.processFeature(prepared, false);
    }
  }
  target.endFrame();
}

/**
 * What the hit test of one dataset looks at
 *
 * @internal
 */
export interface DisplayHitTestInput {
  coordinate: Coordinate;
  toleranceLngLat: number;
  test: DisplayHitTestFn;
  /** The current zoom (the hit radius of a point is the size drawn at it) */
  zoom: number;
  /** The zoom-dependent size factor at that zoom */
  scale: number;
  baseStyle: DatasetBaseStyle | undefined;
  /** Default style of a point */
  pointDefaults: PointStyle;
  /** The largest point radius given by an individual style (px; 0 when none is given) */
  maxStylePointRadius: number;
  /** The candidate rows in a range, in draw order (the spatial index) */
  search(bounds: BoundingBox): number[];
  /** The feature of a row (without the rule colors) */
  featureAt(row: number): Feature;
  /** Whether a row survived the thinning */
  isDrawn(row: number): boolean;
}

/**
 * A hit of a dataset: the feature and its row
 *
 * @internal
 */
export interface DisplayRowHit {
  feature: Feature;
  row: number;
}

/**
 * Returns the frontmost hit (the feature as stored, without the styles applied, and its row)
 *
 * The candidates are narrowed with the spatial index and tested precisely from the back of the
 * draw order (the front).
 *
 * A point is "grabbable anywhere inside the marker that is drawn". A marker is drawn at the
 * size of the radius + the white outline multiplied by the zoom-dependent factor, and depending
 * on what the host specifies and on the factor it gets far larger than the click tolerance.
 * Deciding by the tolerance alone would miss even a click inside a clearly visible circle (the
 * tolerance passed in is kept as a lower bound).
 *
 * @internal
 */
export function hitTestDisplayFeatures(input: DisplayHitTestInput): DisplayRowHit | null {
  const { coordinate, toleranceLngLat, baseStyle, pointDefaults: defaults, scale } = input;
  const degreesPerPixel = worldUnitsPerPixel(input.zoom) * 360;
  // The narrowing of the index is widened to the range the largest marker reaches
  const maxPointRadius = Math.max(
    pointMarkerRadiusPx(undefined, baseStyle, defaults, scale),
    input.maxStylePointRadius > 0
      ? pointMarkerRadiusPx(input.maxStylePointRadius, baseStyle, defaults, scale)
      : 0,
  );
  const reach = Math.max(toleranceLngLat, maxPointRadius * degreesPerPixel);

  const bounds: BoundingBox = {
    minX: coordinate[0] - reach,
    minY: coordinate[1] - reach,
    maxX: coordinate[0] + reach,
    maxY: coordinate[1] + reach,
  };

  const candidates = input.search(bounds);
  for (let i = candidates.length - 1; i >= 0; i--) {
    const row = candidates[i];
    // What has been thinned away and is not visible cannot be grabbed
    if (!input.isDrawn(row)) continue;
    const feature = input.featureAt(row);
    if (!feature.visible) continue;
    const tolerance =
      getStyleRuleChannel(feature.type) === 'point'
        ? Math.max(
            toleranceLngLat,
            pointMarkerRadiusPx(feature.style?.pointRadius, baseStyle, defaults, scale) *
              degreesPerPixel,
          )
        : toleranceLngLat;
    if (input.test(feature, coordinate, tolerance)) return { feature, row };
  }
  return null;
}

/**
 * Measures the largest point radius given by an individual style (0 when none is given)
 *
 * It is used to decide the range that narrows the hit test candidates. Only the points are
 * walked.
 *
 * @internal
 */
export function maxStylePointRadiusOf(features: Feature[]): number {
  let max = 0;
  for (const feature of features) {
    if (getStyleRuleChannel(feature.type) !== 'point') continue;
    const radius = feature.style?.pointRadius;
    if (radius !== undefined && radius > max) max = radius;
  }
  return max;
}

/**
 * Checks whether two feature lists have the same set of ids
 *
 * It is used for the diff test of the selection. The order is determined by the draw order, so
 * if the sets are the same the order is the same too.
 *
 * @internal
 */
export function sameFeatureIds(a: readonly Feature[], b: readonly Feature[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].id !== b[i].id) return false;
  }
  return true;
}

/**
 * Whether the analytic drape draws the polygons and lines of this feature
 *
 * It is paired with `collectDataset` in `view/terrain/drape/pass.ts`. Changing only one of
 * them would show the selection highlight twice or in neither of them.
 *
 * Dashed lines and dashed outlines go onto the drape like solid ones (the drape lays the pattern
 * out along the path). For what does not go onto it, the immediate-mode path draws the highlight
 * as before.
 */
export function isHandedToDrape(feature: Feature, styles: RetainedStyleResolver): boolean {
  if (feature.type === 'Polygon' || feature.type === 'MultiPolygon') {
    const { fillColor, strokeStyle } = styles.getPolygonStyles(feature);
    const hasStroke = strokeStyle.opacity > 0 && strokeStyle.width > 0;
    return hasStroke || fillColor[3] > 0;
  }

  if (
    feature.type === 'LineString' ||
    feature.type === 'MultiLineString' ||
    feature.type === 'Freehand'
  ) {
    const strokeStyle = styles.getLineStringStrokeStyle(feature);
    return strokeStyle.opacity > 0 && strokeStyle.width > 0;
  }

  return false;
}

/**
 * Returns a feature whose style is overwritten for the selection highlight
 *
 * Neither the original feature nor the cache is rewritten; a copy with only the style replaced is
 * made. The painting is split by the channel of the geometry type (the same vocabulary as the
 * rule colors).
 *
 * - Point: a point of the key color with the original radius + 3px (the original point is drawn
 *   on top of it to make a ring)
 * - Line: a line of the key color with the original width + 2px
 * - Polygon: a translucent fill of the key color and a frame of the key color with the original
 *   width + 2px
 *
 * @internal
 */
export function highlightFeature(feature: Feature): Feature {
  const style = feature.style;
  const channel = getStyleRuleChannel(feature.type);

  if (channel === 'point') {
    return {
      ...feature,
      style: {
        ...style,
        pointColor: SELECTION_HIGHLIGHT_COLOR,
        pointRadius: (style?.pointRadius ?? DEFAULT_POINT_RADIUS) + SELECTION_HIGHLIGHT_RING_EXTRA,
      },
    };
  }

  const strokeWidth =
    (style?.strokeWidth ?? DEFAULT_STROKE_WIDTH) + SELECTION_HIGHLIGHT_STROKE_EXTRA;

  if (channel === 'stroke') {
    return {
      ...feature,
      style: {
        ...style,
        strokeColor: SELECTION_HIGHLIGHT_COLOR,
        strokeOpacity: 1,
        strokeWidth,
      },
    };
  }

  return {
    ...feature,
    style: {
      ...style,
      fillColor: SELECTION_HIGHLIGHT_COLOR,
      fillOpacity: SELECTION_HIGHLIGHT_FILL_OPACITY,
      strokeColor: SELECTION_HIGHLIGHT_COLOR,
      strokeOpacity: 1,
      strokeWidth,
    },
  };
}
