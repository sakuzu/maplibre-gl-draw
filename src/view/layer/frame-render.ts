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
import type { DrawnRows } from '../../store/built-in/drawn-rows.js';
import type { DocumentAccess } from '../../store/document-access.js';
import { isInteractionBlocked } from '../../store/lock.js';
import type { Feature } from '../../store/types.js';
import type { FeatureCompanionRegistry } from '../feature-companion.js';
import type { TerrainContext } from '../terrain/context.js';
import {
  setDrapePaintedDatasets,
  setQuadDrapeFrame,
  setTerrainRenderState,
  setTerrainShadeLight,
  setTerrainSurfacesFlattened,
} from '../terrain/state.js';
import { type BulkFrameRows, boxedByFeature } from '../ui/bulk-frames.js';
import type { ManySelection } from '../ui/bulk-selection.js';
import type { SelectionScope } from '../ui/selection-scope.js';
import {
  renderFollowedVertices,
  renderGlobalAuxiliaryHandles,
  renderManySelectionUI,
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
import { renderLayers } from './render.js';
import type { Renderers } from './renderers.js';
import type { DrawnRowGroup, TableLayerRenderer } from './table-retained.js';

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
  store: DocumentAccess;
  terrainContext: TerrainContext;
  drape: DrapePlanner;
  customRenderers: Map<string, FeatureTypeHandler['renderer']>;
  featureCompanions: FeatureCompanionRegistry;
  datasets?: RenderedDatasets;
  /** The drawing of the layers from their rows (null when the Store does not hand out its rows) */
  tableRetained?: TableLayerRenderer | null;
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

/**
 * Sectioned drawing of the analytic drape (the element range of this slot, and the images
 * interleaved into that range)
 */
function drawDrapeSegment(deps: FrameRenderDeps, f: FrameState, index: number): void {
  const { gl, renderers: r, store, drape } = deps;
  const drapeRenderer = drape.renderer;
  if (!drapeRenderer || !f.drapeUsable) return;
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
    return;
  }

  let range = drapeRangeOf(f, index);
  if (range === null) {
    // A transient state where the index does not fit the current order. The first slot draws
    // every element
    if (!first) return;
    range = { from: 0, to: f.drapeElementsTotal };
  }
  const { from, to } = range;

  applyDrapeGlState(gl);

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
  let paintCursor = from;
  for (const pendingQuad of f.pendingQuads) {
    const inRange = pendingQuad.at >= from && (last ? pendingQuad.at <= to : pendingQuad.at < to);
    if (!inRange) continue;
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

  // The final section. The remaining elements, and on the last slot the selection highlight of
  // every element, are drawn on top (the coverage of the selection accumulates regardless of
  // the range, so raising it once is enough). Nothing is drawn when no element is left and
  // there is no selection either (this skips a pointless evaluation of every pixel)
  const hasDrapeSelection = last && drape.hasSelection;
  if (to > paintCursor || hasDrapeSelection) {
    drawSegment(paintCursor, to, last);
  }

  f.restoreBlendState();

  // Back to the depth state of the layer rendering. What the drape could not paint (the
  // geometry being drawn, the features of extensions) is drawn next, by the vertex displacement path, and the terrain must hide it
  // as it does in a frame without the drape. Symbols switch the depth test off themselves.
  applySegmentDepthState(gl, deps.terrainContext, f);
}

/** One slot (the drape of its segment and the layer rendering) */
export function renderSegment(deps: FrameRenderDeps, f: FrameState, index: number): void {
  const { gl, renderers: r, store } = deps;
  const segment = f.segments[index];
  const first = index === 0;
  const last = index === f.segments.length - 1;

  applySegmentGlState(gl, deps.terrainContext, f);
  applyCopy(deps, f.baseCopy);

  drawDrapeSegment(deps, f, index);

  // Per-layer rendering (only the segment of this slot), once per copy of the world in view
  if (f.useRows) deps.tableRetained?.setSurface(f.tableSurface);
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
      undefined,
      f.restoreBlendState,
      { from: segment.from, to: segment.to, first, last },
      copy.view,
      f.useRows ? (deps.tableRetained ?? undefined) : undefined,
    );
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
  // When the editing interaction is blocked (an effective lock, an interaction lock or
  // read-only), only the selection box is drawn and no handles appear (the same look as
  // locked). The box is shown even in read-only or under an interaction lock (so that a viewer
  // also gets the on-map feedback of "what is selected", in the same grammar as the read-only
  // mode of someone with edit permission).
  // A selection of many features is drawn from its rows: the frames of its rows on the GPU, and
  // the frame of all of them with its handles from what is read of the rows selected
  const many = f.manySelected ? manySelectionOf(deps, f, f.manySelected) : null;
  const selectionLocked = many
    ? many.selection.locked || store.isReadOnly() || store.isInteractionLocked()
    : f.selectedFeatures.some((feature) => isInteractionBlocked(feature, store));
  const selectionUIDeps = {
    selectionUIRenderer: r.selectionUIRenderer,
    selectionHandlesRenderer: r.selectionHandlesRenderer,
    pointInstanceRenderer: r.pointInstanceRenderer,
    map,
    scope: deps.selectionScope,
  };
  const tentative = store.getTentative();
  const boxSelection = store.getBoxSelection();
  const globalHandlesShown =
    store.getMode() === 'select' && !store.isReadOnly() && !store.isInteractionLocked();

  // Once per copy of the world in view (the selection UI of a feature on the other side of the
  // antimeridian is drawn on the copy the feature is drawn on)
  for (const copy of f.copies) {
    applyCopy(deps, copy);
    if (many) {
      r.bulkFramesRenderer.drawGroups(
        {
          shaderData: f.shaderData,
          projectionData: copy.projectionData,
          offsetUniforms: copy.offsetUniforms,
          zoom: f.zoom,
          config: r.selectionUIRenderer.config,
          terrain: terrainContext,
        },
        many.rows,
        many.groups,
        many.selection.groups,
      );
      f.restoreBlendState();
      // The features framed from their features, on the copy they are drawn on; the frame of
      // all of them on the stored copy
      const framed =
        f.copies.length === 1 || !copy.view
          ? many.framed
          : many.framed.filter((feature) => copy.view?.getVisibleIds().has(feature.id));
      renderManySelectionUI(
        framed,
        many.selection,
        f.zoom,
        copy.projectionData,
        selectionUIDeps,
        store.getDragState(),
        selectionLocked,
        copy.lngShift === 0,
      );
    } else {
      renderSelectionUI(
        copy.selectedFeatures,
        f.zoom,
        copy.projectionData,
        selectionUIDeps,
        store.getDragState(),
        store.getVertexSelection(),
        selectionLocked,
      );
    }
    // The handles of the extensions that belong to no feature, while they can be grabbed
    if (globalHandlesShown) {
      renderGlobalAuxiliaryHandles(
        f.zoom,
        copy.projectionData,
        selectionUIDeps,
        store.getDragState(),
      );
    }

    // The vertices that follow along when a shared vertex is moved (raised only during a
    // drag). The features that follow are not selected, so they are drawn separately from the
    // selection UI.
    renderFollowedVertices(
      store.getFollowedVertices?.() ?? null,
      store,
      f.zoom,
      copy.projectionData,
      selectionUIDeps,
    );

    // Draw the vertices of the tentative in the foreground
    if (tentative) {
      r.tentativeRenderer.drawVertices(tentative, f.zoom);
    }

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
  // The frames of the rows of the groups not drawn go; everything goes with no selection of many
  if (many) r.bulkFramesRenderer.endFrame();
  else r.bulkFramesRenderer.releaseAll();

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

/** What the selection UI of a selection of many features is drawn with in a frame */
interface ManySelectionFrame {
  readonly selection: ManySelection;
  /** How the frames of the rows are read */
  readonly rows: BulkFrameRows;
  /** The row groups drawn in the frame */
  readonly groups: readonly DrawnRowGroup[];
  /** The features selected framed from their features, drawn in the frame */
  readonly framed: readonly Feature[];
}

/**
 * Reads what the selection UI of a selection of many features is drawn with: the row groups
 * drawn, the rows selected (read again only when something they come from changed) and the
 * features selected drawn one at a time in the frame, which are framed from their features (null
 * without the drawing of the rows)
 */
function manySelectionOf(
  deps: FrameRenderDeps,
  f: FrameState,
  reader: DrawnRows,
): ManySelectionFrame | null {
  const table = deps.tableRetained;
  if (!table) return null;
  const { store, customRenderers, featureCompanions, selectionScope } = deps;
  const extensions = selectionScope.extensions;
  const groups: DrawnRowGroup[] = [];
  const layerOf = new Map<unknown, string>();
  const generations = new Map<string, number>();
  table.forEachDrawnGroup((entry) => {
    groups.push(entry);
    layerOf.set(entry.group, entry.layerId);
    generations.set(entry.layerId, entry.generation);
  });
  const classification = [
    ...generations.entries(),
    ['companions', featureCompanions.generation()],
    ['types', customRenderers.size],
  ].join(',');
  const rows: BulkFrameRows = {
    reader,
    revision: `${reader.revision}|${classification}`,
    framedByFeature: (type) =>
      type === 'Image' ||
      customRenderers.has(type) ||
      extensions.getBoundingBoxCalculator(type) !== undefined,
    pointExtent: (type, style, at) => {
      // The extent of the marker is read from the type and the style alone, as the frame of a
      // point reads it from its feature
      const extent = extensions.resolvePointFrameExtent({
        id: '',
        type,
        geometry: { type: 'Point', coordinates: at },
        layerId: '',
        groupId: undefined,
        properties: {},
        style: style ?? {},
        visible: true,
        locked: false,
      } as Feature);
      return [extent.halfWidth, extent.halfHeight];
    },
  };
  const selection = deps.renderers.bulkFramesRenderer.selection.read(store, {
    reader,
    boxedByFeature: (type) => boxedByFeature(rows, type),
    layerOf: (group) => layerOf.get(group),
    classification,
    extensions,
  });
  // Every row drawn one at a time in the frame is framed from its feature, as it is drawn (a point
  // the terrain fades gets its frame faded with it)
  const framed: Feature[] = [];
  table.forEachDrawnAtOnce((feature, _group, _row, selected) => {
    if (selected) framed.push(feature);
  });
  // The images the analytic drape draws are not drawn at once: their features are those of the
  // drape
  const chosen = store.getSelection();
  for (const feature of [...f.pendingQuads.map((quad) => quad.feature), ...f.drapeFallbackQuads]) {
    if (selectedIn(chosen, feature)) framed.push(feature);
  }
  return { selection, rows, groups, framed };
}

/** Whether a feature is in a selection (by its ID, its group or its layer) */
function selectedIn(selection: ReturnType<DocumentAccess['getSelection']>, feature: Feature) {
  switch (selection.type) {
    case 'feature':
      return selection.ids.has(feature.id);
    case 'group':
      return feature.groupId !== undefined && selection.ids.has(feature.groupId);
    case 'layer':
      return selection.ids.has(feature.layerId);
    default:
      return false;
  }
}
