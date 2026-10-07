// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * BatchManager
 *
 * Manages the batching of features.
 * It groups features with the same style to reduce draw calls, while preserving the draw order.
 */

import type { ProjectionData } from 'maplibre-gl';
import { generateCirclePolygon } from '../../shared/math/index.js';
import { coordinatesOf } from '../../shared/utils/coordinates.js';
import { getCircleRadius, getCreatedZoom } from '../../shared/utils/property.js';
import type { Coordinate, Feature, Layer } from '../../store/types.js';
import { densifyPathForGlobe } from '../globe-subdivision.js';
import { TerrainContext } from '../terrain/context.js';
import { anchorGhostOpacity } from '../terrain/occlusion.js';
import {
  combineDrawFactors,
  layerDrawFactors,
  NEUTRAL_DRAW_FACTORS,
  type RetainedDrawFactors,
} from './draw-factors.js';
import type { FeatureDrawer } from './drawer.js';
import { getStrokeDashPattern, splitIntoDashes } from './line/dash.js';
import type { LineBatchItem, LineBatchShape } from './line/line-types.js';
import type { SDFLineRenderer, SDFStrokeStyle } from './line/sdf-line.js';
import {
  type Color,
  type PointInstanceDataFull,
  type PointInstanceRenderer,
  type PointShape,
  toInstancedPointShape,
} from './point/point-instance.js';
import type { PointStyle } from './point/point-shape.js';
import type { PolygonBatchData, PolygonBatchRenderer } from './polygon/batch.js';
import type { SDFPolygonBatchData, SDFPolygonRenderer } from './polygon/sdf-polygon.js';
import type { RetainedRendererSet } from './retained.js';

/**
 * The Point shapes that support instancing (circle, square, triangle, star)
 */
type InstancingShape = PointShape;

/**
 * A Point batch: the data for drawing Points of the same shape together
 *
 * Color, size and stroke are held as per-instance attributes, so the only
 * condition that splits a batch is the shape.
 */
interface PointBatch {
  points: PointInstanceDataFull[];
  shape: InstancingShape;
}

/**
 * The dependencies of BatchManager
 */
export interface BatchManagerDeps {
  gl: WebGL2RenderingContext;
  featureDrawer: FeatureDrawer;
  pointInstanceRenderer: PointInstanceRenderer;
  sdfLineRenderer: SDFLineRenderer;
  polygonBatchRenderer: PolygonBatchRenderer;
  sdfPolygonRenderer: SDFPolygonRenderer;
  /** The terrain state of the draw instance (occlusion of the points; flat when omitted) */
  terrain?: TerrainContext;
}

/**
 * The current batch type
 */
type BatchType = 'point' | 'linestring' | 'polygon' | null;

/**
 * Convert a Point style into instance data
 *
 * The opacity is folded into the alpha of the color, and the stroke is disabled
 * by setting its width to 0 when its opacity is 0.
 */
export function toPointInstanceData(coord: Coordinate, style: PointStyle): PointInstanceDataFull {
  const fillColor: Color = [
    style.fillColor[0],
    style.fillColor[1],
    style.fillColor[2],
    style.fillColor[3] * style.fillOpacity,
  ];
  const strokeColor: Color = [
    style.strokeColor[0],
    style.strokeColor[1],
    style.strokeColor[2],
    style.strokeColor[3] * style.strokeOpacity,
  ];

  return {
    coord: [coord[0], coord[1]],
    fillColor,
    fillSize: style.size / 2,
    strokeColor,
    strokeWidth: style.strokeOpacity > 0 ? style.strokeWidth : 0,
  };
}

/**
 * Convert a Point style into the packed style of `PackedPointInstances`
 *
 * The same values as `toPointInstanceData` puts on a point, in the order fillColor, strokeColor,
 * fillSize, strokeWidth.
 */
export function toPackedPointStyle(style: PointStyle): Float64Array {
  const packed = toPointInstanceData([0, 0], style);
  return Float64Array.of(
    packed.fillColor[0],
    packed.fillColor[1],
    packed.fillColor[2],
    packed.fillColor[3],
    packed.strokeColor[0],
    packed.strokeColor[1],
    packed.strokeColor[2],
    packed.strokeColor[3],
    packed.fillSize,
    packed.strokeWidth,
  );
}

/**
 * Convert a stroke style into an item of a line batch
 *
 * The color and the opacity are passed to the GPU as instance attributes, so
 * they are expanded from the style down to the per-item level. The dash kind and
 * the reference zoom of the width are handled on the shape side (the batch key
 * and the instance attributes), so they are not included here.
 */
export function toLineBatchItem(
  coords: [number, number][],
  featureId: string,
  style: SDFStrokeStyle,
  createdZoom: number,
  closed = false,
): LineBatchItem {
  return {
    coords,
    featureId,
    closed,
    strokeWidth: style.width,
    createdZoom,
    color: [style.color[0], style.color[1], style.color[2], style.color[3]],
    opacity: style.opacity,
  };
}

/**
 * Turn an item that is "constant in width on the screen" into a negative fixed width
 *
 * When the line width is expressed as a negative value, the shader ignores
 * createdZoom and draws it at a fixed width. Putting features that have no
 * createdZoom (that is, those that should stay constant in width on the screen)
 * on that convention lets them declare that their dimension is "fixed in screen
 * pixels" while staying in the same batch as variable-width ones. Only once that
 * is declared does renderScale (the factor of the rendering ratio) apply (see
 * "the two ratios" in shared/utils/pixel-ratio.ts).
 */
function withFixedWidth(item: LineBatchItem, fixed: boolean): LineBatchItem {
  if (!fixed) return item;
  item.strokeWidth = -item.strokeWidth;
  return item;
}

/**
 * Obtain the shape parameters of a line batch
 *
 * The color is an instance attribute, so it is not included. For solid lines the
 * dash array is not used for rendering, so it is dropped to avoid pointless batch
 * splits.
 */
export function toLineBatchShape(style: SDFStrokeStyle): LineBatchShape {
  if (style.lineStyle === 'solid') {
    return { lineStyle: 'solid' };
  }
  return { lineStyle: style.lineStyle, dashArray: style.dashArray };
}

/**
 * Obtain the key of a line batch (shape parameters only; it does not depend on the color)
 */
export function lineBatchKey(shape: LineBatchShape): string {
  return [shape.lineStyle, (shape.dashArray ?? []).join(',')].join(':');
}

/**
 * BatchManager
 *
 * The class that manages the batching of features
 *
 * @internal
 */
export class BatchManager {
  private gl: WebGL2RenderingContext;
  private featureDrawer: FeatureDrawer;
  private pointInstanceRenderer: PointInstanceRenderer;
  private sdfLineRenderer: SDFLineRenderer;
  private polygonBatchRenderer: PolygonBatchRenderer;
  private sdfPolygonRenderer: SDFPolygonRenderer;
  /** The terrain state of the draw instance (occlusion of the points) */
  private terrain: TerrainContext;

  /**
   * The set of renderers for retained mode
   *
   * undefined = not determined yet, null = not supported (immediate mode only)
   */
  private retainedRenderers: RetainedRendererSet | null | undefined;

  // State
  private currentBatchType: BatchType = null;

  // Point batch management (the key is the shape only)
  private pointBatches: Map<InstancingShape, PointBatch> = new Map();
  private currentPointBatchKey: InstancingShape | null = null;

  // LineString batch management (the key is the shape parameters only; the color is held
  // by the item)
  private lineBatch: LineBatchItem[] = [];
  private lineBatchShapeKey = '';
  private lineBatchShape: LineBatchShape | null = null;
  private sdfLineDrawing = false;

  // Polygon batch management
  private polygonFillBatch: PolygonBatchData[] = [];
  private sdfPolygonBatch: SDFPolygonBatchData[] = [];

  // The rendering context
  private projectionData: ProjectionData | null = null;
  private zoom = 14;
  /**
   * The layer being drawn
   *
   * The rendering loop starts a frame per layer, so the layer needed to evaluate
   * the style rules can be held as the context of the frame.
   */
  private layer: Layer | undefined;
  /**
   * The draw-time factors of the frame (the opacity of the layer being drawn)
   *
   * The batches are flushed within the frame, so they are drawn with the factors of the layer
   * they were filled for. The paths without a factor uniform (the fill-only polygons, the
   * per-point shapes) multiply the opacity into their colors instead.
   */
  private factors: RetainedDrawFactors = NEUTRAL_DRAW_FACTORS;

  constructor(deps: BatchManagerDeps) {
    this.gl = deps.gl;
    this.featureDrawer = deps.featureDrawer;
    this.pointInstanceRenderer = deps.pointInstanceRenderer;
    this.sdfLineRenderer = deps.sdfLineRenderer;
    this.polygonBatchRenderer = deps.polygonBatchRenderer;
    this.sdfPolygonRenderer = deps.sdfPolygonRenderer;
    this.terrain = deps.terrain ?? new TerrainContext();
  }

  /**
   * The terrain state of the draw instance (read by the datasets drawn here)
   */
  getTerrain(): TerrainContext {
    return this.terrain;
  }

  /**
   * Return the set of renderers for retained mode
   *
   * Used for rendering that is not rebuilt every frame, such as a
   * dataset. When the renderers do not support retained mode (a test stub, for
   * example), undefined is returned and the caller falls back to the immediate-mode
   * path.
   */
  getRetainedRenderers(): RetainedRendererSet | undefined {
    if (this.retainedRenderers !== undefined) return this.retainedRenderers ?? undefined;

    const line = this.sdfLineRenderer;
    const polygon = this.sdfPolygonRenderer;
    const point = this.pointInstanceRenderer;
    const supported =
      typeof line?.buildRetainedBatch === 'function' &&
      typeof polygon?.buildRetained === 'function' &&
      typeof point?.buildRetained === 'function';

    if (!supported) {
      this.retainedRenderers = null;
      return undefined;
    }

    this.retainedRenderers = {
      line,
      polygon,
      point,
      styles: this.featureDrawer,
      viewport: (): [number, number] => [this.gl.drawingBufferWidth, this.gl.drawingBufferHeight],
    };
    return this.retainedRenderers;
  }

  /**
   * Begin a rendering frame
   *
   * @param layer The layer to draw (used to evaluate the style rules, and its opacity is
   *   multiplied into everything the frame draws; no factor when omitted)
   * @param factors The draw factors of the frame itself (a dataset passes those of its
   *   `zoomScale`). They are combined with the factors of the layer and multiplied into
   *   everything the frame draws, the same as on the retained path; no factor when omitted
   */
  beginFrame(
    projectionData: ProjectionData,
    zoom: number,
    layer?: Layer,
    factors: RetainedDrawFactors = NEUTRAL_DRAW_FACTORS,
  ): void {
    this.projectionData = projectionData;
    this.zoom = zoom;
    this.layer = layer;
    this.factors = combineDrawFactors(layerDrawFactors(layer), factors);
    this.currentBatchType = null;
  }

  /**
   * Process a feature
   *
   * @returns true when it is selected
   */
  processFeature(feature: Feature, isSelected: boolean): boolean {
    if (!feature.visible || !this.projectionData) return false;

    if (feature.type === 'Point') {
      this.processPoint(feature);
    } else if (feature.type === 'LineString') {
      this.processLineString(feature);
    } else if (feature.type === 'Polygon') {
      this.processPolygon(feature);
    } else if (feature.type === 'MultiPoint') {
      this.processMultiPoint(feature);
    } else if (feature.type === 'MultiLineString') {
      this.processMultiLineString(feature);
    } else if (feature.type === 'MultiPolygon') {
      this.processMultiPolygon(feature);
    } else if (feature.type === 'Freehand') {
      // Freehand is processed in the same way as LineString
      this.processLineString(feature);
    } else if (feature.type === 'Circle') {
      // Circle is batched in the same way as Polygon
      this.processCircle(feature);
    } else if (feature.type === 'Image') {
      // Image: always flush the batches and draw it individually
      this.flushLineBatch();
      // endSDFLineDraw is called only at the end of the frame (a performance optimization)
      this.flushAllBatches();
      this.currentBatchType = null;
      this.featureDrawer.drawFeature(feature, this.projectionData, this.zoom, this.layer);
    }

    return isSelected;
  }

  /**
   * End the rendering frame (flush the remaining batches)
   */
  endFrame(): void {
    this.flushLineBatch();
    this.endSDFLineDraw();
    this.flushAllBatches();
  }

  // === Point processing ===

  private processPoint(feature: Feature): void {
    this.processPointCoord(feature, coordinatesOf(feature) as Coordinate);
  }

  /**
   * Add a MultiPoint to the point batch, part by part
   *
   * The coordinates are `Coordinate[]` (a part = one point). The style is per
   * feature, so it is shared across all parts.
   */
  private processMultiPoint(feature: Feature): void {
    const parts = coordinatesOf(feature) as Coordinate[];
    for (const coord of parts) {
      this.processPointCoord(feature, coord);
    }
  }

  /**
   * The shared processing that adds one point to the batch (shared by Point and the parts
   * of MultiPoint)
   */
  private processPointCoord(feature: Feature, coord: Coordinate): void {
    if (this.currentBatchType !== null && this.currentBatchType !== 'point') {
      this.flushLineBatch();
      // endSDFLineDraw is called only at the end of the frame (a performance optimization)
      this.flushAllBatches();
    }
    this.currentBatchType = 'point';

    const style = this.featureDrawer.getPointStyle(feature, this.layer);

    const instancedShape = toInstancedPointShape(style.shape);
    // The look of a Point does not change when it is selected; it is shown enclosed by a
    // bounding box
    // Therefore it is drawn with instancing even when selected
    if (!instancedShape) {
      if (this.pointBatches.size > 0) {
        this.flushPointBatches();
      }
      // Shapes that do not support instancing are drawn individually, one point at a time
      // (MultiPoint comes into this function part by part, so they are drawn per point)
      this.featureDrawer.drawPointShape(coord, this.withFrameFactors(style), this.zoom, feature.id);
    } else {
      // Color, size and stroke are instance attributes, so the batch key only needs the shape
      const batchKey: InstancingShape = instancedShape;

      if (this.currentPointBatchKey !== null && this.currentPointBatchKey !== batchKey) {
        this.flushPointBatches();
      }

      let batch = this.pointBatches.get(batchKey);
      if (!batch) {
        batch = { points: [], shape: batchKey };
        this.pointBatches.set(batchKey, batch);
      }
      // Points occluded by the terrain are drawn faintly (ghost). This is the
      // immediate path, rebuilt every frame, so it follows the camera movement directly.
      batch.points.push({
        ...toPointInstanceData(coord, style),
        ghost: anchorGhostOpacity(this.terrain, coord[0], coord[1]),
      });
      this.currentPointBatchKey = batchKey;
    }
  }

  private flushPointBatches(): void {
    for (const batch of this.pointBatches.values()) {
      if (batch.points.length > 0) {
        this.pointInstanceRenderer.drawAll(batch.points, batch.shape, this.zoom, this.factors);
      }
    }
    this.pointBatches.clear();
    this.currentPointBatchKey = null;
  }

  // === LineString processing ===

  private processLineString(feature: Feature): void {
    this.processLineCoords(feature, coordinatesOf(feature) as Coordinate[]);
  }

  /**
   * Add a MultiLineString to the line batch, part by part
   *
   * The coordinates are `Coordinate[][]` (a part = one polyline).
   */
  private processMultiLineString(feature: Feature): void {
    const parts = coordinatesOf(feature) as Coordinate[][];
    for (const coords of parts) {
      if (coords.length < 2) continue;
      this.processLineCoords(feature, coords);
    }
  }

  /**
   * The shared processing that adds one polyline to the batch (shared by LineString,
   * Freehand and the parts of MultiLineString)
   */
  private processLineCoords(feature: Feature, coords: Coordinate[]): void {
    if (this.currentBatchType !== null && this.currentBatchType !== 'linestring') {
      // endSDFLineDraw is called only at the end of the frame (a performance optimization)
      this.flushLineBatch();
      this.flushAllBatches();
    }
    this.currentBatchType = 'linestring';

    const strokeStyle = this.featureDrawer.getLineStringStrokeStyle(feature, this.layer);
    // A feature that has no createdZoom is drawn "constant in width on the screen". It is
    // passed to the GPU as a negative fixed width and does not go through the shader's zoom
    // conversion (the same convention as retained mode; at scale = 1, 2^(zoom - zoom) = 1, so
    // the look does not change).
    const fixedWidth = getCreatedZoom(feature) === undefined;
    const createdZoom = getCreatedZoom(feature) ?? this.zoom;

    // Compute the effective line width at the current zoom level (with the size factor of the
    // frame, which the shader multiplies into the width, so the dashes follow the drawn width)
    const effectiveStrokeWidth =
      strokeStyle.width * 2 ** (this.zoom - createdZoom) * this.factors.scale;

    // For dashed/dotted lines the dashes are computed on the CPU side
    const dashPattern = getStrokeDashPattern(strokeStyle.lineStyle, effectiveStrokeWidth);
    if (dashPattern) {
      // They are drawn as solid lines, so the shape is treated as 'solid'
      const shape = toLineBatchShape({ ...strokeStyle, lineStyle: 'solid' });
      this.switchLineBatchShape(shape);

      // Split into dashes on the CPU side. On the globe the path is cut along the Mercator
      // plane first, so the dashes follow the path the solid line takes (globe-subdivision.ts)
      const dashSegments = splitIntoDashes(
        densifyPathForGlobe(this.terrain, coords as [number, number][]),
        dashPattern[0],
        dashPattern[1],
        this.zoom,
      );

      // Add each dash as an individual solid line
      for (const segment of dashSegments) {
        if (segment.coords.length >= 2) {
          this.lineBatch.push(
            withFixedWidth(
              toLineBatchItem(segment.coords, feature.id, strokeStyle, createdZoom),
              fixedWidth,
            ),
          );
        }
      }
    } else {
      // For a solid line, as before
      this.switchLineBatchShape(toLineBatchShape(strokeStyle));

      this.lineBatch.push(
        withFixedWidth(
          toLineBatchItem(coords as [number, number][], feature.id, strokeStyle, createdZoom),
          fixedWidth,
        ),
      );
    }
  }

  /**
   * Switch the shape of the line batch
   *
   * It is flushed only when the shape (the dash kind) changes. The color is an
   * instance attribute, so it does not split the batch.
   */
  private switchLineBatchShape(shape: LineBatchShape): void {
    const key = lineBatchKey(shape);

    if (this.lineBatchShapeKey !== '' && this.lineBatchShapeKey !== key) {
      this.flushLineBatch();
    }

    this.lineBatchShapeKey = key;
    this.lineBatchShape = shape;
  }

  private beginSDFLineDraw(): void {
    if (!this.sdfLineDrawing && this.projectionData) {
      this.sdfLineRenderer.beginDraw(this.projectionData, this.zoom);
      this.sdfLineDrawing = true;
    }
  }

  private endSDFLineDraw(): void {
    if (this.sdfLineDrawing) {
      this.sdfLineRenderer.endDraw();
      this.sdfLineDrawing = false;
    }
  }

  private flushLineBatch(): void {
    if (this.lineBatch.length > 0 && this.lineBatchShape && this.projectionData) {
      this.beginSDFLineDraw();
      this.sdfLineRenderer.drawAll(
        this.lineBatch,
        this.lineBatchShape,
        this.zoom,
        this.projectionData,
        this.factors,
      );
      this.lineBatch.length = 0;
      this.lineBatchShapeKey = '';
      this.lineBatchShape = null;
    }
  }

  // === Polygon processing ===

  private processPolygon(feature: Feature): void {
    const rings = coordinatesOf(feature) as Coordinate[][];
    const outerRing = rings[0];
    if (!outerRing || outerRing.length < 3) return;

    this.processPolygonRings(rings, feature);
  }

  /**
   * Add a MultiPolygon to the hole-aware polygon batch, part by part
   *
   * The coordinates are `Coordinate[][][]` (a part = an array of rings; rings[0] is the
   * outer ring and the rest are inner rings).
   * The key of the earcut cache includes the part index as well.
   */
  private processMultiPolygon(feature: Feature): void {
    const parts = coordinatesOf(feature) as Coordinate[][][];
    for (let partIndex = 0; partIndex < parts.length; partIndex++) {
      const rings = parts[partIndex];
      const outerRing = rings?.[0];
      if (!outerRing || outerRing.length < 3) continue;

      this.processPolygonRings(rings, feature, partIndex);
    }
  }

  // === Circle processing ===

  private processCircle(feature: Feature): void {
    const center = coordinatesOf(feature) as Coordinate;
    const radiusMeters = getCircleRadius(feature);

    if (!radiusMeters || radiusMeters <= 0) return;

    // Convert the circle into a polygon (a Circle is always a single ring)
    const circleCoords = generateCirclePolygon(center, radiusMeters);
    this.processPolygonRings([circleCoords], feature);
  }

  // === Processing shared by Polygon and Circle ===

  /**
   * The shared processing that adds an array of polygon rings to a batch
   *
   * Shared by Polygon ([0] is the outer ring, [1..] are the inner rings), Circle
   * (a polygon approximation with a single ring) and each part of a MultiPolygon.
   *
   * @param partIndex The part index of a MultiPolygon (for the key of the earcut cache)
   */
  private processPolygonRings(rings: Coordinate[][], feature: Feature, partIndex = 0): void {
    if (this.currentBatchType !== null && this.currentBatchType !== 'polygon') {
      this.flushLineBatch();
      this.flushAllBatches();
    }
    this.currentBatchType = 'polygon';

    const { fillColor, strokeStyle } = this.featureDrawer.getPolygonStyles(feature, this.layer);
    // The outline of a feature that has no createdZoom uses a negative fixed width (the same
    // convention as withFixedWidth; collectPolygons in retained mode does the same).
    const fixedWidth = getCreatedZoom(feature) === undefined;
    const createdZoom = getCreatedZoom(feature) ?? this.zoom;
    // The drawn width of the outline (with the size factor of the frame; the dashes follow it)
    const effectiveStrokeWidth =
      strokeStyle.width * 2 ** (this.zoom - createdZoom) * this.factors.scale;
    const isDashed = strokeStyle.lineStyle !== 'solid';

    if (strokeStyle.opacity > 0 && !isDashed) {
      // For a solid line: drawn all at once by SDFPolygonRenderer
      this.flushPolygonFillBatch();
      this.sdfPolygonBatch.push({
        coordinates: rings,
        style: {
          fillColor,
          fillOpacity: 1,
          strokeColor: strokeStyle.color,
          strokeWidth: fixedWidth ? -strokeStyle.width : strokeStyle.width,
          strokeOpacity: 1,
        },
        createdZoom,
        featureId: feature.id,
        partIndex,
      });
    } else if (strokeStyle.opacity > 0 && isDashed) {
      // For a dashed/dotted line: the fill goes to PolygonBatchRenderer, and the stroke
      // is split into dashes on the CPU side and drawn by SDFLineRenderer
      this.addPolygonDashedStroke(
        rings,
        feature.id,
        fillColor,
        strokeStyle,
        effectiveStrokeWidth,
        createdZoom,
        partIndex,
        fixedWidth,
      );
    } else {
      // When there is no stroke: the fill only
      this.flushSdfPolygonBatch();
      if (fillColor[3] > 0) {
        this.polygonFillBatch.push({
          coordinates: rings,
          color: this.colorWithFrameOpacity(fillColor),
          featureId: feature.id,
          partIndex,
        });
      }
    }
  }

  /**
   * Processing of the dashed/dotted stroke of a polygon
   */
  private addPolygonDashedStroke(
    rings: Coordinate[][],
    featureId: string,
    fillColor: [number, number, number, number],
    strokeStyle: ReturnType<FeatureDrawer['getLineStringStrokeStyle']>,
    effectiveStrokeWidth: number,
    createdZoom: number,
    partIndex = 0,
    fixedWidth = false,
  ): void {
    this.flushSdfPolygonBatch();

    // Draw the fill (inner rings are punched out as holes)
    if (fillColor[3] > 0) {
      this.polygonFillBatch.push({
        coordinates: rings,
        color: this.colorWithFrameOpacity(fillColor),
        featureId,
        partIndex,
      });
    }
    this.flushPolygonFillBatch();

    // They are drawn as solid lines, so the shape is treated as 'solid'
    this.switchLineBatchShape(toLineBatchShape({ ...strokeStyle, lineStyle: 'solid' }));

    // Split into dashes on the CPU side (the outer ring and each inner ring are drawn as
    // closed paths)
    const dashPattern = getStrokeDashPattern(strokeStyle.lineStyle, effectiveStrokeWidth);
    if (dashPattern) {
      for (const ring of rings) {
        if (ring.length < 3) continue;

        // To draw it as a closed path, the first point is appended at the end
        const closedCoords = [...ring] as [number, number][];
        const first = closedCoords[0];
        const last = closedCoords[closedCoords.length - 1];
        if (first[0] !== last[0] || first[1] !== last[1]) {
          closedCoords.push(first);
        }

        const dashSegments = splitIntoDashes(
          densifyPathForGlobe(this.terrain, closedCoords),
          dashPattern[0],
          dashPattern[1],
          this.zoom,
        );

        for (const segment of dashSegments) {
          if (segment.coords.length >= 2) {
            this.lineBatch.push(
              withFixedWidth(
                toLineBatchItem(segment.coords, featureId, strokeStyle, createdZoom),
                fixedWidth,
              ),
            );
          }
        }
      }
    }
  }

  private flushPolygonFillBatch(): void {
    if (this.polygonFillBatch.length > 0 && this.projectionData) {
      this.polygonBatchRenderer.drawBatch(this.polygonFillBatch, this.projectionData, this.zoom);
      this.polygonFillBatch.length = 0;
    }
  }

  private flushSdfPolygonBatch(): void {
    if (this.sdfPolygonBatch.length > 0 && this.projectionData) {
      this.sdfPolygonRenderer.drawBatch(
        this.sdfPolygonBatch,
        this.projectionData,
        this.zoom,
        [this.gl.drawingBufferWidth, this.gl.drawingBufferHeight],
        this.factors,
      );
      this.sdfPolygonBatch.length = 0;
    }
  }

  /**
   * A color with the opacity factor of the frame multiplied into its alpha (for the fill-only
   * polygon batch, whose colors are per vertex and which has no factor uniform)
   */
  private colorWithFrameOpacity(color: Color): Color {
    const opacity = this.factors.opacity;
    return opacity === 1 ? color : [color[0], color[1], color[2], color[3] * opacity];
  }

  /**
   * A point style with the factors of the frame multiplied in (for the per-point renderer, which
   * has no factor uniform): the size and the stroke width by the size factor, the opacities by
   * the opacity factor
   */
  private withFrameFactors(style: PointStyle): PointStyle {
    const { scale, opacity } = this.factors;
    if (scale === 1 && opacity === 1) return style;
    return {
      ...style,
      size: style.size * scale,
      strokeWidth: style.strokeWidth * scale,
      fillOpacity: style.fillOpacity * opacity,
      strokeOpacity: style.strokeOpacity * opacity,
    };
  }

  private flushAllBatches(): void {
    if (this.pointBatches.size > 0) {
      this.flushPointBatches();
    }
    if (this.polygonFillBatch.length > 0) {
      this.flushPolygonFillBatch();
    }
    if (this.sdfPolygonBatch.length > 0) {
      this.flushSdfPolygonBatch();
    }
  }
}

/**
 * Create a BatchManager
 */
export function createBatchManager(deps: BatchManagerDeps): BatchManager {
  return new BatchManager(deps);
}
