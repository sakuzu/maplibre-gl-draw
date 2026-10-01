// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The orchestration of the analytic drape
 *
 * It maps the features of the Store and the features of datasets into "a form
 * that can be evaluated analytically" (a list of edges + a style). The point is to put both
 * into a single list, and the stacking order is preserved by "compositing every element in
 * style order within the same surface evaluation".
 *
 * Previously the presence of even one dataset dropped everything to the vertex displacement
 * path, but that path only holds together while an exact match with maplibre's terrain mesh is
 * maintained, and it was the origin of the symptoms when the match broke down (wedges, holes,
 * streaks, seams and ribbons).
 *
 * When it does not hold, the caller drops to the previous vertex displacement path (a
 * two-stage arrangement). The condition for dropping is decided here by `canDrape`.
 */

import { coordinatesOf } from '../../../shared/utils/coordinates.js';
import { getCreatedZoom } from '../../../shared/utils/property.js';
import { getDisplayFeatures, isLocallyHidden } from '../../../store/local-visibility.js';
import type { Store } from '../../../store/store.js';
import type { Coordinate, Feature } from '../../../store/types.js';
import { layerDrawFactors } from '../../renderers/draw-factors.js';
import type { RetainedStyleResolver } from '../../renderers/retained.js';
import {
  type DrapeColor,
  type DrapeElement,
  type DrapeQuadBreak,
  drapeSelectionKey,
} from './binning.js';
import { drapeBoundsOf, drapeGeometryOf } from './geometry.js';
import { DRAPE_MAX_SOURCES } from './renderer.js';

export type { DrapeQuadBreak };

/** The feature types the drape can handle */
const DRAPEABLE_TYPES = new Set([
  'Polygon',
  'MultiPolygon',
  'LineString',
  'MultiLineString',
  // A freehand line is a polyline too. It is treated like a line and painted as ground
  // pixels
  'Freehand',
]);

/**
 * The upper bound on the number of edges one tile of the view can handle
 *
 * A tile that exceeds it is degraded without being built (building it and then throwing it
 * away would stall the frame for exactly that time). Measured on 8,172 administrative
 * boundaries, one tile at z13 to z16 has a few thousand to 20,000 edges, so there is plenty of
 * room.
 */
export const DRAPE_MAX_EDGES_PER_TILE = 120_000;

/**
 * The upper bound on the number of vertices that can be put on the drape (for the whole map)
 *
 * The cost of holding the Mercator coordinates (16 bytes per vertex) and the cost of scanning
 * the bounding boxes per tile are capped here. 8,172 administrative boundaries (about 1.1
 * million vertices) fit. A map that exceeds it is drawn with the previous vertex displacement
 * path.
 */
export const DRAPE_MAX_VERTICES = 4_000_000;

/** The collected elements, and the Store features that could not be put on the drape */
export interface DrapeCollectResult {
  /** The elements in draw order */
  readonly elements: DrapeElement[];
  /** The IDs of the Store features that cannot be put on the drape (points, images, dashed
   * lines and so on) */
  readonly excluded: Set<string>;
  /** The breaks in the stacking order (the positions of the images; dataset order =
   * ascending afterElements) */
  readonly quadBreaks: DrapeQuadBreak[];
  /**
   * The starting position of each entry of the stack (an index into the element list)
   *
   * The index that lets a frame (the CustomLayer of each interval) paint only the elements of
   * its own interval. The elements of the datasets below the stack come before the starting
   * position of the first entry, and the elements of the datasets above the stack are laid
   * out from aboveStoreStart on.
   */
  readonly entryStarts: ReadonlyMap<string, number>;
  /** The index at which the elements of the datasets above the stack begin (= the end of
   * the elements of the stack) */
  readonly aboveStoreStart: number;
  /** The total number of edges */
  readonly edgeCount: number;
  /** The total number of vertices */
  readonly vertexCount: number;
  /** The IDs of the datasets put on the drape */
  readonly drapedDatasets: Set<string>;
  /**
   * The factor source of each Store layer (layer ID → source)
   *
   * The opacity of a layer is written into its source every frame, so a change of the opacity
   * does not rebuild the index. A layer past the capacity of the sources is not listed: its
   * opacity is baked into the colors of its elements instead (see {@link drapeLayerSource}).
   */
  readonly layerSources: ReadonlyMap<string, number>;
}

/**
 * The factor source of the Store layer at `layerIndex` (among the Store layers of the stacking
 * order), or 0 when the sources are used up
 *
 * Source 0 is the neutral source (factor 1), 1 to `datasetCount` are the
 * datasets, and the Store layers follow. A layer that gets 0 has its opacity baked into the
 * colors of its elements, so the planner puts the opacity of such a layer into the key of the
 * dataset (a change of it collects again).
 */
export function drapeLayerSource(layerIndex: number, datasetCount: number): number {
  const source = datasetCount + 1 + layerIndex;
  return source < DRAPE_MAX_SOURCES ? source : 0;
}

/**
 * The view of a dataset restricted to the part the drape needs
 *
 * The implementation in `dataset/dataset.ts` satisfies this shape. To keep the type
 * dependency one-directional, only the structure is declared here.
 */
export interface DrapeDatasetSource {
  readonly id: string;
  readonly order: 'below-store' | 'layer-order' | 'above-store';
  readonly visible: boolean;
  /** The version of the contents, the style and the thinning (when it changes, the index is
   * rebuilt) */
  readonly drapeRevision: number;
  /** The features to put on the drape (with the thinning and the rule colors already
   * applied, in draw order) */
  drapeFeatures(): Feature[];
  /** The IDs of the selected features (needed so that the drape can draw the selection
   * highlight) */
  getSelectedIds(): string[];
}

/**
 * Collects the elements of the analytic drape from the Store and the datasets
 *
 * The draw order is datasets (below-store) -> the Store's stack (a mixture of
 * layers and the datasets that take part in the stack) -> datasets
 * (above-store). It is aligned with the draw order in `view/layer/render.ts`.
 *
 * It is not narrowed down by the view. Narrowing it down would change the element order every
 * time the view moves and require rebuilding the tile indices (the narrowing down within a
 * tile is done by `binTile` using the bounding boxes).
 *
 * @param pixelRatio The rendering pixel ratio, for widths fixed in screen pixels (the rendering
 *   scale included; `resolvePixelRatio`)
 * @param contentPixelRatio The rendering pixel ratio for widths that follow the zoom (the
 *   rendering scale not applied; `resolveContentPixelRatio`)
 */
export function collectDrapeElements(
  store: Store,
  styles: RetainedStyleResolver,
  pixelRatio: number,
  contentPixelRatio: number,
  datasets: readonly DrapeDatasetSource[],
): DrapeCollectResult {
  const visible = getDisplayFeatures(store);
  const byLayer = new Map<string, Feature[]>();
  for (const feature of visible) {
    if (isLocallyHidden(feature, store)) continue;
    const list = byLayer.get(feature.layerId);
    if (list) list.push(feature);
    else byLayer.set(feature.layerId, [feature]);
  }

  const context: CollectContext = {
    elements: [],
    excluded: new Set<string>(),
    quadBreaks: [],
    entryStarts: new Map<string, number>(),
    edgeCount: 0,
    vertexCount: 0,
    drapedDatasets: new Set<string>(),
    styles,
    pixelRatio,
    contentPixelRatio,
    layerSources: new Map<string, number>(),
  };

  const byId = new Map<string, DrapeDatasetSource>();
  for (const dataset of datasets) byId.set(dataset.id, dataset);

  let source = 1;
  const sourceOf = new Map<string, number>();
  for (const dataset of datasets) {
    sourceOf.set(dataset.id, source++);
  }

  for (const dataset of datasets) {
    if (dataset.order !== 'below-store') continue;
    collectDataset(context, dataset, sourceOf.get(dataset.id) ?? 0);
  }

  let layerIndex = 0;
  for (const layerId of store.getLayerOrder()) {
    context.entryStarts.set(layerId, context.elements.length);
    const layer = store.getLayer(layerId);
    if (!layer) {
      const dataset = byId.get(layerId);
      if (dataset && dataset.order === 'layer-order') {
        collectDataset(context, dataset, sourceOf.get(dataset.id) ?? 0);
      }
      continue;
    }
    const layerSource = drapeLayerSource(layerIndex++, datasets.length);
    if (layerSource > 0) context.layerSources.set(layerId, layerSource);
    // A layer without a source of its own has its opacity baked into its colors
    const bakedOpacity = layerSource > 0 ? 1 : layerDrawFactors(layer).opacity;
    for (const feature of byLayer.get(layerId) ?? []) {
      collectStoreFeature(context, feature, layer, layerSource, bakedOpacity);
    }
  }

  const aboveStoreStart = context.elements.length;
  for (const dataset of datasets) {
    if (dataset.order !== 'above-store') continue;
    collectDataset(context, dataset, sourceOf.get(dataset.id) ?? 0);
  }

  return {
    elements: context.elements,
    excluded: context.excluded,
    quadBreaks: context.quadBreaks,
    entryStarts: context.entryStarts,
    aboveStoreStart,
    edgeCount: context.edgeCount,
    vertexCount: context.vertexCount,
    drapedDatasets: context.drapedDatasets,
    layerSources: context.layerSources,
  };
}

/** The intermediate state of the dataset */
interface CollectContext {
  elements: DrapeElement[];
  excluded: Set<string>;
  quadBreaks: DrapeQuadBreak[];
  entryStarts: Map<string, number>;
  edgeCount: number;
  vertexCount: number;
  drapedDatasets: Set<string>;
  styles: RetainedStyleResolver;
  /** The rendering pixel ratio for widths fixed in screen pixels */
  pixelRatio: number;
  /** The rendering pixel ratio for widths that follow the zoom */
  contentPixelRatio: number;
  layerSources: Map<string, number>;
}

/**
 * Puts a single Store feature on (what cannot be put on goes into excluded)
 *
 * @param source The factor source of its layer (0 = none of its own)
 * @param bakedOpacity The opacity of its layer when it has no source of its own (1 otherwise)
 */
function collectStoreFeature(
  context: CollectContext,
  feature: Feature,
  layer: Parameters<RetainedStyleResolver['getPolygonStyles']>[1],
  source: number,
  bakedOpacity: number,
): void {
  if (!DRAPEABLE_TYPES.has(feature.type)) {
    context.excluded.add(feature.id);
    // An image is remembered as a break in the stacking order. It is drawn by the quad drape,
    // but "which elements it is above and which it is below" is decided at this position
    if (feature.type === 'Image') {
      context.quadBreaks.push({ featureId: feature.id, afterElements: context.elements.length });
    }
    return;
  }

  if (feature.type === 'Polygon' || feature.type === 'MultiPolygon') {
    const { fillColor, strokeStyle } = context.styles.getPolygonStyles(feature, layer);
    // Dashed lines are not put through the analytic evaluation (solving the accumulated
    // distance along the outline from the pixel is not implemented). Drawing them as solid
    // lines would change the appearance, so features with dashed lines are routed to the
    // previous vertex displacement path.
    if (strokeStyle.lineStyle !== 'solid') {
      context.excluded.add(feature.id);
      return;
    }
    const hasStroke = strokeStyle.opacity > 0 && strokeStyle.width > 0;
    const rings = polygonRings(feature);
    if (rings.length === 0) return;
    if (fillColor[3] <= 0 && !hasStroke) return;

    const polygonWidth = widthOf(feature, strokeStyle.width, context);
    pushElement(context, feature, 0, rings, {
      fill: [fillColor[0], fillColor[1], fillColor[2], fillColor[3] * bakedOpacity],
      stroke: [
        strokeStyle.color[0],
        strokeStyle.color[1],
        strokeStyle.color[2],
        strokeStyle.color[3] * (hasStroke ? strokeStyle.opacity : 0) * bakedOpacity,
      ],
      strokeWidthPx: hasStroke ? polygonWidth.px : 0,
      source,
      widthZoom: polygonWidth.zoom,
      // A Store selection is expressed by the selection UI (the box and the handles). The
      // drape does not change the color
      selectionKey: '',
    });
    return;
  }

  const strokeStyle = context.styles.getLineStringStrokeStyle(feature, layer);
  if (strokeStyle.lineStyle !== 'solid') {
    context.excluded.add(feature.id);
    return;
  }
  if (strokeStyle.opacity <= 0 || strokeStyle.width <= 0) return;
  const paths = linePaths(feature);
  if (paths.length === 0) return;

  const lineWidth = widthOf(feature, strokeStyle.width, context);
  pushElement(context, feature, 1, paths, {
    fill: [0, 0, 0, 0],
    stroke: [
      strokeStyle.color[0],
      strokeStyle.color[1],
      strokeStyle.color[2],
      strokeStyle.color[3] * strokeStyle.opacity * bakedOpacity,
    ],
    strokeWidthPx: lineWidth.px,
    source,
    widthZoom: lineWidth.zoom,
    selectionKey: '',
  });
}

/**
 * Puts a single dataset on
 *
 * So that the retained batch side does not draw the same features that were put on, the caller
 * tells the dataset "the polygons and lines are drawn by the drape"
 * (`drapedDatasets`). The test here and `collectFeature` in `dataset/retained.ts` form a
 * pair, so the condition must never be changed on only one side.
 */
function collectDataset(
  context: CollectContext,
  dataset: DrapeDatasetSource,
  source: number,
): void {
  if (!dataset.visible) return;
  context.drapedDatasets.add(dataset.id);

  for (const feature of dataset.drapeFeatures()) {
    if (!feature.visible) continue;

    if (feature.type === 'Polygon' || feature.type === 'MultiPolygon') {
      const { fillColor, strokeStyle } = context.styles.getPolygonStyles(feature);
      const hasStroke = strokeStyle.opacity > 0 && strokeStyle.width > 0;
      // A dashed outline is drawn by the immediate path on the retained batch side (the
      // paired test)
      if (hasStroke && strokeStyle.lineStyle !== 'solid') continue;
      if (!hasStroke && fillColor[3] <= 0) continue;
      const rings = polygonRings(feature);
      if (rings.length === 0) continue;

      const width = widthOf(feature, strokeStyle.width, context);
      pushElement(context, coordinatesOf(feature) as object, 0, rings, {
        fill: fillColor,
        stroke: [
          strokeStyle.color[0],
          strokeStyle.color[1],
          strokeStyle.color[2],
          hasStroke ? strokeStyle.color[3] : 0,
        ],
        strokeWidthPx: hasStroke ? width.px : 0,
        source,
        widthZoom: width.zoom,
        selectionKey: drapeSelectionKey(dataset.id, feature.id),
      });
      continue;
    }

    if (
      feature.type !== 'LineString' &&
      feature.type !== 'MultiLineString' &&
      feature.type !== 'Freehand'
    ) {
      continue;
    }

    const strokeStyle = context.styles.getLineStringStrokeStyle(feature);
    if (strokeStyle.lineStyle !== 'solid') continue;
    if (strokeStyle.opacity <= 0 || strokeStyle.width <= 0) continue;
    const paths = linePaths(feature);
    if (paths.length === 0) continue;

    const width = widthOf(feature, strokeStyle.width, context);
    pushElement(context, coordinatesOf(feature) as object, 1, paths, {
      fill: [0, 0, 0, 0],
      stroke: [
        strokeStyle.color[0],
        strokeStyle.color[1],
        strokeStyle.color[2],
        strokeStyle.color[3] * strokeStyle.opacity,
      ],
      strokeWidthPx: width.px,
      source,
      widthZoom: width.zoom,
      selectionKey: drapeSelectionKey(dataset.id, feature.id),
    });
  }
}

/**
 * Resolves the line width with the same convention as the retained batch path
 *
 * A feature without a `createdZoom` is fixed in screen pixels (the rendering scale applies),
 * and a feature with one scales by `2^(zoom - createdZoom)` (the device pixel ratio applies,
 * the rendering scale does not). So that the thickness does not change with the presence of
 * terrain, the drape follows the same convention.
 */
function widthOf(
  feature: Feature,
  width: number,
  ratios: Pick<CollectContext, 'pixelRatio' | 'contentPixelRatio'>,
): { px: number; zoom: number } {
  const createdZoom = getCreatedZoom(feature);
  if (createdZoom !== undefined && Number.isFinite(createdZoom)) {
    return { px: width * ratios.contentPixelRatio, zoom: createdZoom };
  }
  return { px: width * ratios.pixelRatio, zoom: -1 };
}

/** The rings of a polygon (with the closing point dropped) */
function polygonRings(feature: Feature): Coordinate[][] {
  return feature.type === 'Polygon'
    ? openRings(coordinatesOf(feature) as Coordinate[][])
    : (coordinatesOf(feature) as Coordinate[][][]).flatMap((part) => openRings(part));
}

/** The paths of a line */
function linePaths(feature: Feature): Coordinate[][] {
  const paths: Coordinate[][] =
    feature.type === 'LineString' || feature.type === 'Freehand'
      ? [coordinatesOf(feature) as Coordinate[]]
      : (coordinatesOf(feature) as Coordinate[][]);
  return paths.filter((path) => path.length >= 2);
}

/** Pushes an element */
function pushElement(
  context: CollectContext,
  cacheKey: object,
  kind: 0 | 1,
  paths: Coordinate[][],
  style: {
    fill: DrapeColor;
    stroke: DrapeColor;
    strokeWidthPx: number;
    source: number;
    widthZoom: number;
    selectionKey: string;
  },
): void {
  const bounds = drapeBoundsOf(cacheKey, paths);
  if (bounds.maxX < bounds.minX) return;

  let edges = 0;
  for (const path of paths) {
    context.vertexCount += path.length;
    edges += kind === 0 ? path.length : path.length - 1;
  }
  if (edges === 0) return;

  context.elements.push({
    kind,
    bounds,
    // The geometry is built only after passing the tile narrowing (what is outside the view
    // is not converted)
    geometry: () => drapeGeometryOf(cacheKey, paths, kind === 0),
    ...style,
  });
  context.edgeCount += edges;
}

/** Turns it into an array of rings with the closing point dropped */
function openRings(rings: Coordinate[][]): Coordinate[][] {
  const out: Coordinate[][] = [];
  for (const ring of rings) {
    if (ring.length < 3) continue;
    const first = ring[0];
    const last = ring[ring.length - 1];
    out.push(first[0] === last[0] && first[1] === last[1] ? ring.slice(0, -1) : ring);
  }
  return out;
}

/**
 * Whether the analytic drape may be used
 *
 * The conditions under which it cannot be used (degrade and drop to the vertex displacement
 * path):
 *
 * - The total number of vertices exceeds the budget (a size at which holding the Mercator
 *   coordinates is not realistic)
 * - The edges of a single tile exceed the budget (`binTile` returns overflow without building
 *   it)
 * - Too many cells exceeded the per-cell budget (likewise)
 *
 * The presence of datasets is not in itself a reason to degrade. Custom types
 * and overlay rendering are no obstacle either. Features that do not go on the drape are
 * routed to the previous immediate path as `excluded`, and overlays are drawn inside
 * renderLayers as before (both come after the drape).
 */
export function canDrape(options: { vertexCount: number }): boolean {
  return options.vertexCount <= DRAPE_MAX_VERTICES;
}
