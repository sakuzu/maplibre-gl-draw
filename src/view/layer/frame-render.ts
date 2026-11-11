// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The drawing stages of a frame
 *
 * Every slot draws its segment (`renderSegment`: the analytic drape of the segment, then the
 * per-layer rendering once per copy of the world), and the last slot draws the foreground pass
 * (`renderForeground`: the selection UI, the tentative geometry being drawn and the overlays).
 * The state of the frame is built beforehand by frame-state.ts, and the GL state of the slot is
 * set and restored through gl-state.ts.
 */

import type { Map as MapLibreMap } from 'maplibre-gl';
import type { FeatureTypeHandler } from '../../extension/index.js';
import {
  type FeatureTablesInternals,
  featureTablesInternals,
} from '../../feature-table/feature-tables.js';
import { rowType } from '../../feature-table/row-read.js';
import { isLayerDrawnFromRows } from '../../feature-table/rows-drawn.js';
import { bulkRowMotionOf } from '../../sketches/rendered-shapes.js';
import { isInteractionBlocked } from '../../store/lock.js';
import type { Store } from '../../store/store.js';
import type { Feature } from '../../store/types.js';
import { STYLE_COLUMN } from '../../table/feature-row-columns.js';
import type { RowBlockDictionary } from '../../table/row-group-types.js';
import type { FeatureCompanionRegistry } from '../feature-companion.js';
import type { TerrainContext } from '../terrain/context.js';
import {
  setDrapePaintedDatasets,
  setQuadDrapeFrame,
  setTerrainRenderState,
  setTerrainShadeLight,
  setTerrainSurfacesFlattened,
} from '../terrain/state.js';
import type { PointFrameExtent } from '../ui/bulk-frames.js';
import type { SelectionScope } from '../ui/selection-scope.js';
import {
  type BulkMovement,
  renderBulkSelectionUI,
  renderFollowedVertices,
  renderGlobalAuxiliaryHandles,
  renderSelectionUI,
} from '../ui/selection-ui-drawer.js';
import type { DrapePlanner } from './drape-planner.js';
import type { CopyPass, FrameState } from './frame-state.js';
import {
  applyDrapeGlState,
  applySegmentDepthState,
  applySegmentGlState,
  enterSymbolGlState,
  restoreSegmentGlState,
  resumeDrapeGlState,
} from './gl-state.js';
import { ABOVE_STORE_ENTRY, renderLayers } from './render.js';
import type { Renderers } from './renderers.js';
import type { DrawnShapes } from './shown-store.js';
import type { StoreRetainedCache } from './store-retained.js';
import type { TableLayerRenderer } from './table-retained.js';

/**
 * The datasets as the per-layer rendering takes them (the type is owned by
 * render.ts, so this file does not read a type from dataset/)
 */
type RenderedDatasets = Parameters<typeof renderLayers>[10];

/** What the drawing of a frame reads (the engine of the layer, while its GPU side exists) */
export interface FrameRenderDeps {
  gl: WebGL2RenderingContext;
  renderers: Renderers;
  map: MapLibreMap;
  store: Store;
  /** The shapes the drawing reads */
  shapes: DrawnShapes;
  terrainContext: TerrainContext;
  drape: DrapePlanner;
  customRenderers: Map<string, FeatureTypeHandler['renderer']>;
  featureCompanions: FeatureCompanionRegistry;
  datasets?: RenderedDatasets;
  storeRetainedCache: StoreRetainedCache | null;
  /** The drawing of the layers held as rows of columns */
  tableRetained: TableLayerRenderer | null;
  selectionScope: SelectionScope;
}

/** Makes the renderers draw on one copy of the world */
function applyCopy(deps: FrameRenderDeps, copy: CopyPass): void {
  const r = deps.renderers;
  r.shaderInitializer.setProjectionData(copy.projectionData);
  r.shaderInitializer.applyOffsetUniforms(copy.offsetUniforms);
  if (deps.terrainContext.renderState !== copy.terrainState) {
    setTerrainRenderState(deps.terrainContext, copy.terrainState);
  }
}

/**
 * The range [from, to) of the drape elements that corresponds to the segment of a slot
 *
 * The index of the pack being drawn (entryStarts) refers to the stacking order at the moment it
 * was collected. Right after the order changes, the old pack keeps being drawn until the index
 * of the new pack is built, so an entry of the current order may be missing from the index. In
 * that case null is returned and the first slot draws every element (for a few frames they all
 * come out below the external layers).
 */
export function drapeRangeOf(
  f: Pick<
    FrameState,
    'segments' | 'layerOrder' | 'drapeEntryStarts' | 'drapeAboveStoreStart' | 'drapeElementsTotal'
  >,
  index: number,
): { from: number; to: number } | null {
  const segment = f.segments[index];
  const first = index === 0;
  const last = index === f.segments.length - 1;
  const order = f.layerOrder;
  const startOf = (position: number): number | undefined =>
    position < order.length ? f.drapeEntryStarts.get(order[position]) : f.drapeAboveStoreStart;
  let from = first ? 0 : startOf(segment.from);
  let to = last ? f.drapeElementsTotal : startOf(segment.to);
  if (from === undefined || to === undefined) return null;
  if (segment.from >= segment.to) {
    // An empty segment (an order with nothing drawn by us). If it is both first and last, every
    // element is drawn
    from = first ? 0 : from;
    to = last ? f.drapeElementsTotal : from;
  }
  return { from, to: Math.max(from, to) };
}

/** Paints the drape of a slot in parts (`beginDrapeSegment`) */
interface DrapeSegmentPainter {
  /** Paints the elements up to `at` (exclusive), with the images placed up to it */
  paintTo(at: number): void;
  /** Paints the rest of the slot, and on the last slot the selection highlight */
  finish(): void;
}

/**
 * Sectioned drawing of the analytic drape (the element range of this slot, and the images
 * interleaved into that range), in parts: up to a place in the range, and the rest. A slot
 * draws it whole before its layers; where the layers held as rows are draped, it is painted up
 * to each entry of the order before the entry is drawn (`renderSegment`)
 *
 * @returns null when the drape is not drawn in this frame
 */
function beginDrapeSegment(
  deps: FrameRenderDeps,
  f: FrameState,
  index: number,
): DrapeSegmentPainter | null {
  const { gl, renderers: r, store, drape } = deps;
  const drapeRenderer = drape.renderer;
  if (!drapeRenderer || !f.drapeUsable) return null;
  const first = index === 0;
  const last = index === f.segments.length - 1;

  if (!f.drapeReady) {
    // The images that were to be interleaved between the sections are drawn here (the first
    // slot only)
    if (first) {
      f.restoreBlendState();
      for (const quadFeature of f.drapeFallbackQuads) {
        r.featureDrawer.drawFeature(
          quadFeature,
          f.defaultProjectionData,
          f.zoom,
          store.getLayer(quadFeature.layerId) ?? undefined,
        );
      }
    }
    return null;
  }

  let range = drapeRangeOf(f, index);
  if (range === null) {
    // A transient state where the index does not fit the current order. The first slot draws
    // every element
    if (!first) return null;
    range = { from: 0, to: f.drapeElementsTotal };
  }
  const { from, to } = range;

  const drawSegment = (paintFrom: number, paintTo: number, emitSelection: boolean): void => {
    for (const tileDraw of f.drapeTileDraws) {
      drapeRenderer.drawTile(
        tileDraw.draw,
        tileDraw.projection,
        f.drapeLight,
        f.zoom,
        drape.sourceFactors,
        f.dpr,
        1,
        { paintFrom, paintTo, emitSelection },
      );
    }
  };

  // Pick only the images that fall into the range of this slot (an image whose position equals
  // the start of the range belongs to this slot; one that equals the end is picked only by the
  // last slot)
  const quads = f.pendingQuads.filter(
    (pendingQuad) => pendingQuad.at >= from && (last ? pendingQuad.at <= to : pendingQuad.at < to),
  );
  let paintCursor = from;
  let nextQuad = 0;

  /** Paints up to `at`, with the images placed at or before it (the last one: every image) */
  const paint = (at: number, final: boolean): void => {
    applyDrapeGlState(gl);
    while (nextQuad < quads.length) {
      const pendingQuad = quads[nextQuad] as (typeof quads)[number];
      if (!final && pendingQuad.at > at) break;
      nextQuad++;
      if (pendingQuad.at > paintCursor) {
        drawSegment(paintCursor, pendingQuad.at, false);
        paintCursor = pendingQuad.at;
      }
      // Interleave the image. The quad drape draws with normal compositing (not premultiplied),
      // so the blending is restored, and the depth test is left raised for the next section
      // (keepDepthTest is true until the foreground). Afterwards the assumptions of the drape are
      // established again.
      f.restoreBlendState();
      r.featureDrawer.drawFeature(
        pendingQuad.feature,
        f.defaultProjectionData,
        f.zoom,
        store.getLayer(pendingQuad.feature.layerId) ?? undefined,
      );
      resumeDrapeGlState(gl);
    }
    if (final) {
      // The final section. The remaining elements, and on the last slot the selection highlight
      // of every element, are drawn on top (the coverage of the selection accumulates regardless
      // of the range, so raising it once is enough). Nothing is drawn when no element is left
      // and there is no selection either (this skips a pointless evaluation of every pixel)
      const hasDrapeSelection = last && drape.hasSelection;
      if (to > paintCursor || hasDrapeSelection) drawSegment(paintCursor, to, last);
      paintCursor = to;
    } else if (at > paintCursor) {
      drawSegment(paintCursor, at, false);
      paintCursor = at;
    }

    f.restoreBlendState();

    // Back to the depth state of the layer rendering. What the drape could not paint (the
    // geometry being drawn, the features of extensions) is drawn next, by the vertex
    // displacement path, and the terrain must hide it as it does in a frame without the drape.
    // Symbols switch the depth test off themselves.
    applySegmentDepthState(gl, deps.terrainContext, f);
  };

  let finished = false;
  return {
    paintTo: (at) => {
      if (finished) return;
      paint(Math.min(Math.max(at, from), to), false);
    },
    finish: () => {
      if (finished) return;
      finished = true;
      paint(to, true);
    },
  };
}

/**
 * Where the drape of the other elements is painted to before an entry of the order is drawn,
 * while the layers held as rows are draped: up to the start of a layer held as rows, and to the
 * end of any other entry (its elements are under what it draws itself, as in a slot that paints
 * its drape whole)
 */
function drapeStopOf(
  f: FrameState,
  position: Map<string, number>,
  layerId: string,
  rows: boolean,
): number | undefined {
  if (rows) return f.drapeEntryStarts.get(layerId);
  const at = position.get(layerId);
  if (at === undefined) return undefined;
  const next = f.layerOrder[at + 1];
  return next === undefined ? f.drapeAboveStoreStart : f.drapeEntryStarts.get(next);
}

/** One slot (the drape of its segment and the layer rendering) */
export function renderSegment(deps: FrameRenderDeps, f: FrameState, index: number): void {
  const { gl, renderers: r, store } = deps;
  const segment = f.segments[index];
  const first = index === 0;
  const last = index === f.segments.length - 1;

  applySegmentGlState(gl, deps.terrainContext, f);
  applyCopy(deps, f.baseCopy);

  // The drape of the elements of the other entries: painted whole before the layers, or, where
  // the layers held as rows are draped too, up to each entry before it is drawn
  const drapeSegment = beginDrapeSegment(deps, f, index);
  let beforeEntry: ((layerId: string) => void) | undefined;
  if (drapeSegment && f.tableDrape) {
    const position = new Map<string, number>();
    f.layerOrder.forEach((id, i) => {
      position.set(id, i);
    });
    const tables = featureTablesInternals(store.tables);
    // The datasets below the order are drawn over their part of the drape
    const firstEntry = f.layerOrder[segment.from];
    drapeSegment.paintTo(
      index === 0 && firstEntry !== undefined ? (f.drapeEntryStarts.get(firstEntry) ?? 0) : 0,
    );
    beforeEntry = (layerId) => {
      if (layerId === ABOVE_STORE_ENTRY) {
        drapeSegment.finish();
        return;
      }
      const layer = store.getLayer(layerId);
      const rows = layer !== undefined && isLayerDrawnFromRows(store.tables, layer);
      const stop = drapeStopOf(f, position, layerId, rows && tables !== undefined);
      if (stop !== undefined) drapeSegment.paintTo(stop);
    };
  } else {
    drapeSegment?.finish();
  }

  // Per-layer rendering (only the segment of this slot), once per copy of the world in view
  for (const copy of f.copies) {
    applyCopy(deps, copy);
    renderLayers(
      r,
      store,
      copy.features,
      f.selectedIdSet,
      copy.projectionData,
      f.zoom,
      deps.customRenderers,
      copy.customRendererContext,
      deps.featureCompanions,
      f.layerAwareRenderers,
      deps.datasets,
      f.useRetained ? (deps.storeRetainedCache ?? undefined) : undefined,
      f.restoreBlendState,
      { from: segment.from, to: segment.to, first, last },
      copy.view,
      deps.tableRetained ?? undefined,
      beforeEntry,
      deps.shapes.drawings(),
    );
    // The rest of the drape of the slot, once (the copies after the first draw over it)
    if (beforeEntry) {
      drapeSegment?.finish();
      beforeEntry = undefined;
    }
  }
  applyCopy(deps, f.baseCopy);

  if (!last) restoreSegmentGlState(gl, f);
}

/** The foreground pass (drawn by the last slot) */
export function renderForeground(deps: FrameRenderDeps, f: FrameState): void {
  const { gl, renderers: r, store, map, terrainContext } = deps;

  // From the selection UI onwards it is always drawn without depth (the symbols and the UI are
  // not buried in the terrain)
  enterSymbolGlState(gl);
  // The depth is not restored even if a quad is drawn from here on
  if (f.quadDrapeFrame) f.quadDrapeFrame.keepDepthTest = false;

  // Selection UI
  // When the editing interaction is blocked for the whole selection (every feature locked, an
  // interaction lock or read-only), only the selection box is drawn and no handles appear (the
  // same look as locked); a selection some of which can be edited has its handles, over the
  // extent of it all. The box is shown even in read-only or under an interaction lock (so that a
  // viewer also gets the on-map feedback of "what is selected", in the same grammar as the
  // read-only mode of someone with edit permission).
  const selectionLocked = f.selectedFeatures.every((feature) =>
    isInteractionBlocked(feature, store),
  );
  // Features selected in bulk (and the rows a box marks past the limit): their frames are drawn
  // on the GPU, and the frame of all of them with its handles as for several features
  const bulk = store.getSelection().bulk;
  const tables = featureTablesInternals(store.tables);
  const bulkFramesShown =
    tables !== undefined &&
    deps.tableRetained !== null &&
    (bulk !== undefined ||
      (store.getBoxSelection() !== null &&
        tables.states.bulkHandles().size > store.selectionIdsLimit));
  const bulkLocked =
    bulk !== undefined &&
    (store.isReadOnly() ||
      store.isInteractionLocked() ||
      store.getUnlockedSelectedRows()?.count === 0);
  const bulkMovement: BulkMovement | null = tables ? bulkRowMotionOf(tables) : null;
  const pointExtent = tables ? pointFrameExtentOf(deps, tables) : null;
  const selectionUIDeps = {
    selectionUIRenderer: r.selectionUIRenderer,
    selectionHandlesRenderer: r.selectionHandlesRenderer,
    pointInstanceRenderer: r.pointInstanceRenderer,
    map,
    scope: deps.selectionScope,
  };
  const drawings = deps.shapes.drawings();
  const boxSelection = store.getBoxSelection();
  const globalHandlesShown =
    store.getMode() === 'select' && !store.isReadOnly() && !store.isInteractionLocked();

  // Once per copy of the world in view (the selection UI of a feature on the other side of the
  // antimeridian is drawn on the copy the feature is drawn on)
  for (const copy of f.copies) {
    applyCopy(deps, copy);
    // The extensions draw their own handles with the values of the frame of this copy
    const copyUIDeps = {
      ...selectionUIDeps,
      frame: copy.customRendererContext,
      restoreBlendState: f.restoreBlendState,
    };
    renderSelectionUI(
      copy.selectedFeatures,
      f.zoom,
      copy.projectionData,
      copyUIDeps,
      store.getDragState(),
      store.getVertexSelection(),
      selectionLocked,
    );
    if (bulkFramesShown && tables && pointExtent) {
      r.bulkFramesRenderer.setRotating(store.getDragState()?.operation === 'rotate');
      r.bulkFramesRenderer.setScreenScale(f.screenScale);
      deps.tableRetained?.drawBulkFrames(
        r.bulkFramesRenderer,
        copy.projectionData,
        r.selectionUIRenderer.config,
        tables.revision,
        pointExtent,
      );
      f.restoreBlendState();
    }
    if (bulk) {
      renderBulkSelectionUI(
        bulk,
        f.zoom,
        copy.projectionData,
        selectionUIDeps,
        store.getDragState(),
        bulkLocked,
        bulkMovement,
      );
    }
    // The handles of the extensions that belong to no feature, while they can be grabbed
    if (globalHandlesShown) {
      renderGlobalAuxiliaryHandles(f.zoom, copy.projectionData, copyUIDeps, store.getDragState());
    }

    // The vertices that follow along when a shared vertex is moved (raised only during a
    // drag). The features that follow are not selected, so they are drawn separately from the
    // selection UI.
    renderFollowedVertices(
      store.getFollowedVertices?.() ?? null,
      deps.shapes,
      copy.projectionData,
      selectionUIDeps,
    );

    // Draw the vertices of the shapes being drawn in the foreground
    for (const drawing of drawings) r.tentativeRenderer.drawVertices(drawing);

    // Draw the vertices of the layer-aware renderers in the foreground
    for (const renderer of f.layerAwareRenderers) {
      if (renderer.drawVertices) {
        renderer.drawVertices(copy.projectionData, f.zoom, copy.customRendererContext);
        f.restoreBlendState();
      }
    }

    // Box selection UI (on the stored copy: its corners come from unproject around the
    // camera)
    //
    // This is a rubber band on the screen, so pinning it to the ground would stop it from
    // being a rectangle. Its renderers are built without the terrain (box-selection.ts), so it
    // is drawn flat.
    if (boxSelection && copy.lngShift === 0) {
      r.boxSelectionRenderer.draw(boxSelection, f.defaultProjectionData, f.zoom);
    }

    // Drawing of the overlays that are not layer-aware
    for (const renderer of f.otherRenderers) {
      if (renderer.order === 'overlay' || renderer.order === 'foreground') {
        renderer.draw(copy.projectionData, f.zoom, copy.customRendererContext);
        f.restoreBlendState();
      }
    }
  }
  applyCopy(deps, f.baseCopy);

  restoreSegmentGlState(gl, f);

  // The report of the datasets being painted also lasts only for this frame
  setDrapePaintedDatasets(terrainContext, null);

  // The contract to draw flat lasts only for this frame (it is always restored so that it is
  // not read from outside the rendering)
  setTerrainSurfacesFlattened(terrainContext, false);

  // The light lasts only for this frame as well
  setTerrainShadeLight(terrainContext, null);

  // The entry point of the quads lasts only for this frame (it is always removed so that it is
  // not read from outside the rendering)
  if (f.quadDrapeFrame) setQuadDrapeFrame(terrainContext, null);
}

/**
 * The extent of the marker of a row of one position, for its frame: what the selection UI reads
 * for a point of its type and style (read once per type and style)
 */
function pointFrameExtentOf(
  deps: FrameRenderDeps,
  tables: FeatureTablesInternals,
): PointFrameExtent {
  const known = new Map<string, readonly [number, number] | null>();
  return (group, row) => {
    const data = group.data;
    const type = rowType(data, row);
    const styleNumber = (data.wholes[STYLE_COLUMN] as RowBlockDictionary).indexes[row];
    const key = `${type}\u0000${styleNumber}`;
    let extent = known.get(key);
    if (extent === undefined) {
      const feature = {
        id: '',
        type,
        geometry: { type: 'Point', coordinates: [0, 0] },
        layerId: '',
        groupId: undefined,
        properties: {},
        style: tables.styles.get(styleNumber),
        visible: true,
        locked: false,
      } as Feature;
      const corners = deps.selectionScope.extensions.resolvePointFrameCorners(
        feature,
        { x: 0, y: 0 },
        0,
      );
      extent =
        corners.length > 0
          ? [
              Math.max(...corners.map((corner) => Math.abs(corner.x))),
              Math.max(...corners.map((corner) => Math.abs(corner.y))),
            ]
          : null;
      known.set(key, extent);
    }
    return extent;
  };
}
