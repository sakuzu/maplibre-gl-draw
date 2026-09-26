// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The public API interface of MapLibreGLDraw and the createDrawAPI orchestrator
 *
 * The interface definitions are gathered in this file, while the implementation of each
 * method is spread across the sub-api files per functional domain (feature-api / layer-api /
 * group-api / selection-api / event-api / extension-api / instance-api). createDrawAPI is a
 * thin orchestrator that composes them by spreading.
 */

import type {
  CustomLayerInterface as MapLibreCustomLayerInterface,
  Map as MapLibreMap,
} from 'maplibre-gl';
import type { InputRouter } from '../dispatcher/input-router.js';
import type { InputNormalizer } from '../dispatcher/normalizer.js';
import type { MapClickEventPayload } from '../dispatcher/types.js';
import type { DatasetManager } from '../display/manager.js';
import type {
  Dataset,
  DatasetClickEventPayload,
  DatasetOptions,
  DatasetPlacement,
} from '../display/types.js';
import type { CustomFeatureHandler, CustomOverlayRenderer } from '../extension/index.js';
import type { ModeHandler } from '../modes/handler.js';
import type { ModeManager } from '../modes/manager.js';
import { subscribeMutationHooks } from '../plugins/mutation-hooks.js';
import type { Plugin } from '../plugins/plugin.js';
import type { PluginManager } from '../plugins/plugin-manager.js';
import type {
  FeaturesChangePayload,
  GeometryAppliedPayload,
  LoadErrorPayload,
} from '../shared/utils/event-emitter.js';
import type { SnapResult } from '../snapping/types.js';
import type { EventBridge } from '../store/event-bridge.js';
import type { StoreSpatialIndex } from '../store/spatial/store-spatial-index.js';
import type { StoreView } from '../store/store.js';
import type {
  ExportFormat,
  ExportOptions,
  ExportResult,
  Feature,
  FeatureInput,
  Group,
  Layer,
  LoadOptions,
  LoadResult,
  Metadata,
  Mode,
  Selection,
  SelectionType,
  VertexRef,
  VertexSelection,
} from '../store/types.js';
import type { RenderCoordinator } from '../view/coordinator.js';
import type {
  FeatureCompanionProvider,
  FeatureCompanionRegistry,
} from '../view/feature-companion.js';
import type { CustomLayerInterface } from '../view/layer/index.js';
import type { RenderSlot } from '../view/layer/slots.js';
import type { TerrainDrapeDebug } from '../view/terrain/state.js';
import type { AuxiliaryHandleProvider } from '../view/ui/auxiliary-handles.js';
import type { Context } from './context.js';
import { createDisplayApi } from './display-api.js';
import { createEventApi } from './event-api.js';
import { createExtensionApi } from './extension-api.js';
import { createFeatureApi } from './feature-api.js';
import type { GeometryOperations } from './geometry-operations.js';
import { createGeometryApi } from './geometry-operations.js';
import { createGroupApi } from './group-api.js';
import type { ImportExportAPI } from './import-export/index.js';
import type { InputOperations } from './input-api.js';
import { createInputApi } from './input-api.js';
import { createInstanceApi } from './instance-api.js';
import { createLayerApi } from './layer-api.js';
import { createSelectionApi } from './selection-api.js';
import type { SnappingOperations } from './snapping-api.js';
import { createSnappingApi } from './snapping-api.js';
import type { TopologyOperations } from './topology-api.js';
import { createTopologyApi } from './topology-api.js';
import type { TracingOperations } from './tracing-api.js';
import { createTracingApi } from './tracing-api.js';

/**
 * The events of a draw instance and the payload each one carries.
 *
 * Subscribe with {@link MapLibreGLDraw.on}; the key is the event name. The methods of the
 * instance work synchronously, and the events are how the host learns the result of a change,
 * whatever made it (a method call, a user operation, a change applied from outside).
 *
 * The per-item events (`draw.feature.*`, `draw.layer.*`, `draw.group.*`) are emitted once for
 * every change, so a bulk load of 1000 features emits `draw.feature.create` 1000 times.
 * A subscriber that only rebuilds a view on any change subscribes to `draw.features.change`
 * instead, which is emitted once per flush. A listener that throws is reported with
 * `console.error` and does not stop the other listeners.
 *
 * @example
 * ```typescript
 * draw.on('draw.feature.create', ({ feature }) => {
 *   console.log('Created', feature.id, feature.type);
 * });
 * draw.on('draw.selection.change', ({ ids }) => {
 *   updatePropertyPanel(ids);
 * });
 * ```
 */
export interface EventPayloads {
  /** A feature was created. Emitted once per feature, whatever created it */
  'draw.feature.create': {
    /** The feature as it was created */
    feature: Feature;
  };
  /** A feature was updated. Emitted once per feature and per change */
  'draw.feature.update': {
    /** The feature after the update */
    feature: Feature;
    /** The feature before the update */
    previous: Feature;
  };
  /** A feature was deleted. Emitted once per feature */
  'draw.feature.delete': {
    /** The feature as it was when it was deleted */
    feature: Feature;
  };
  /**
   * The feature changes of one flush, emitted after the per-feature events of that flush.
   *
   * A flush is one transaction (a load, an import, a drag commit, an undo and so on) or one
   * write made outside a transaction. Subscribe to this instead of the per-feature events to
   * rebuild a view once per change rather than once per feature.
   */
  'draw.features.change': FeaturesChangePayload;
  /** A layer was created */
  'draw.layer.create': {
    /** The layer as it was created */
    layer: Layer;
  };
  /** A layer was updated (its name, visibility, lock, order of items, style rule and so on) */
  'draw.layer.update': {
    /** The layer after the update */
    layer: Layer;
    /** The layer before the update */
    previous: Layer;
  };
  /** A layer was deleted */
  'draw.layer.delete': {
    /** The layer as it was when it was deleted */
    layer: Layer;
  };
  /** The stacking order of the layers changed (see {@link MapLibreGLDraw.setLayerOrder}) */
  'draw.layer.reorder': {
    /** The new order; the last entry is the frontmost */
    order: string[];
    /** The order before the change */
    previous: string[];
  };
  /** A group was created */
  'draw.group.create': {
    /** The group as it was created */
    group: Group;
  };
  /** A group was updated (its members, name, visibility, lock and so on) */
  'draw.group.update': {
    /** The group after the update */
    group: Group;
    /** The group before the update */
    previous: Group;
  };
  /**
   * A group was deleted, explicitly or because its last member left it (an empty group is not
   * kept)
   */
  'draw.group.delete': {
    /** The group as it was when it was deleted */
    group: Group;
  };
  /** The selection changed, by a method call or by a user operation */
  'draw.selection.change': {
    /** What is selected now; null when nothing is selected */
    type: SelectionType | null;
    /** The IDs of the selected items */
    ids: string[];
    /** What was selected before */
    previousType: SelectionType | null;
    /** The IDs that were selected before */
    previousIds: string[];
  };
  /** The mode changed. Not emitted when a request is refused or asks for the current mode */
  'draw.mode.change': {
    /** The mode now */
    mode: Mode;
    /** The mode before the change */
    previousMode: Mode;
  };
  /** The metadata (the title, the description and so on) changed */
  'draw.metadata.change': {
    /** The metadata after the change */
    metadata: Metadata;
    /** The metadata before the change */
    previous: Metadata;
  };
  /**
   * The image drawing mode asks the host for an image file.
   *
   * Entering `draw_image` emits it and returns to select mode. The host lets the user choose a
   * file and passes it to {@link MapLibreGLDraw.load} with the carried coordinate, zoom and
   * layer as its {@link LoadOptions}.
   */
  'draw.image.request': {
    /** The center of the map when the mode was entered, `[lng, lat]` */
    coordinate: [number, number];
    /** The zoom of the map when the mode was entered */
    zoom: number;
    /** The writable layer the image should go into */
    layerId: string;
  };
  /**
   * An operation of {@link MapLibreGLDraw.geometry} finished.
   *
   * `status: 'applied'` means result features were created; `'empty'` means the operation ran
   * but its result had no area, and nothing changed. Nothing is emitted when the operation did
   * not run (too few targets, read-only).
   */
  'draw.geometry.applied': GeometryAppliedPayload;
  /**
   * The snapping result changed: the target changed, or it was lost (then a result with no
   * target is emitted once)
   */
  'draw.snap.change': SnapResult;
  /**
   * A click in select mode was resolved against the datasets.
   *
   * `datasetId` and `feature` are set when an interactive dataset took the click, and
   * both are null when it hit none (a click on empty space). Not emitted for a click that hit
   * a feature of the Store, nor in any mode other than select.
   */
  'draw.dataset.click': DatasetClickEventPayload;
  /**
   * A dataset was added.
   *
   * Emitted by {@link MapLibreGLDraw.addDataset} once the dataset is listed, so
   * {@link MapLibreGLDraw.getDataset} returns it inside the handler. The datasets
   * that existed before the subscription are not announced; read them with
   * {@link MapLibreGLDraw.getDatasets}.
   */
  'draw.dataset.add': {
    /** The id of the dataset that was added */
    datasetId: string;
  };
  /**
   * A dataset was removed, by {@link MapLibreGLDraw.removeDataset}
   * or by {@link Dataset.remove}.
   *
   * Emitted once the dataset is no longer listed. Not emitted when the draw instance is
   * destroyed. A dataset added again under the same id is a new object, announced by a new
   * `draw.dataset.add`.
   */
  'draw.dataset.remove': {
    /** The id of the dataset that was removed */
    datasetId: string;
  };
  /**
   * The order of the datasets changed: {@link MapLibreGLDraw.moveDataset}
   * moved a dataset within its side or to another side.
   *
   * Not emitted for a move that leaves everything where it was. Adding or removing a
   * dataset emits `draw.dataset.add` or `draw.dataset.remove` instead.
   */
  'draw.dataset.reorder': {
    /**
     * The ids of the datasets in display order, from the back to the front (the same as
     * {@link MapLibreGLDraw.getDatasets})
     */
    order: string[];
  };
  /**
   * A click on the map in select mode, whether or not it hit anything.
   *
   * The coordinates are the raw ones, before snapping. It is a read-only notification that
   * does not affect the selection, for a host that needs any click on the map (placing a pin,
   * for example). Not emitted in any mode other than select.
   */
  'draw.map.click': MapClickEventPayload;
  /**
   * Frames were added or removed, or the interval of a frame changed.
   *
   * The payload is the same as {@link MapLibreGLDraw.getRenderSlots}. On receiving it, the
   * host places its native layers between the frames again (see
   * {@link Options.isExternalEntry}).
   */
  'draw.renderslots.change': {
    /** Every frame, from the backmost */
    slots: RenderSlot[];
  };
  /**
   * An asynchronous load that no call returns failed.
   *
   * With `source: 'image'`, the image of an Image feature could not be decoded (`featureId`);
   * it is emitted once per image, the image is not retried, and the feature is drawn without
   * it.
   */
  'draw.load.error': LoadErrorPayload;
}

/**
 * A draw instance: the drawing and editing tools attached to one MapLibre map.
 *
 * Create one with {@link createMapLibreGLDraw}. Every method works synchronously on the
 * document held by the Store (only {@link MapLibreGLDraw.load} returns a Promise), and the
 * result of a change reaches the host through the events (see {@link EventPayloads}).
 *
 * The methods report a problem in one of three ways, by its cause:
 *
 * - An argument that cannot apply throws an `Error` and changes nothing: an ID that does not
 *   exist, a `layerId` or `groupId` that names nothing, an ID that is already taken.
 * - A write refused because of the state does not throw. While read-only is on, every write
 *   to the document is refused, and so is a write that would change a locked feature, group
 *   or layer beyond `locked` and `visible`. The methods that return a boolean return false,
 *   and nothing changes. Read-only is checked first, so a write while read-only returns false
 *   even for an ID that does not exist.
 * - Data that a load cannot use is left out and listed in `LoadResult.skipped`.
 *
 * @example
 * ```typescript
 * const draw = createMapLibreGLDraw(map);
 * draw.on('draw.feature.create', ({ feature }) => console.log(feature.id));
 * draw.setMode('draw_polygon');
 * ```
 */
export interface MapLibreGLDraw {
  // Map / Store API
  /**
   * Gets the MapLibre map the instance was created with.
   *
   * A plugin that needs the map itself (to place a DOM overlay, for example) reaches it with
   * `ctx.draw.getMap()`.
   */
  getMap(): MapLibreMap;
  /**
   * Gets a read-only view of the Store: the reads, `subscribe` for the changes, and
   * `transact` to group writes into one notification.
   *
   * It has no write methods: the host writes through the methods of this instance, and a
   * plugin through its {@link PluginContext} (`ctx.getStore()` when it needs the Store
   * itself). The objects it returns are read-only; the in-memory store freezes them.
   *
   * @example
   * ```typescript
   * // One transaction: one notification (one step for a subscriber that records changes) for several
   * // writes, labeled with the source 'batch'
   * draw.getStore().transact(() => {
   *   const layerId = draw.addLayer('Imported');
   *   if (layerId === null) return; // read-only
   *   draw.setActiveLayer(layerId);
   *   draw.addFeature({ type: 'Point', coordinates: [139.767, 35.681] });
   * }, 'batch');
   * ```
   */
  getStore(): StoreView;

  // Mode API
  /**
   * Gets the current mode.
   *
   * Read it after {@link MapLibreGLDraw.setMode} to tell whether a request was refused.
   */
  getMode(): Mode;
  /**
   * Changes the mode.
   *
   * The built-in modes are `select`, `draw_point`, `draw_line`, `draw_polygon`, `draw_image`,
   * `draw_circle` and `draw_freehand`; others are added with
   * {@link MapLibreGLDraw.registerMode}. A drawing mode writes new features into the active
   * layer when it can be written (it exists, is not locked, is visible and is not locally
   * hidden), otherwise into the first writable layer.
   *
   * A request is refused, with nothing changed and no event, for a name with no registered
   * mode (with a console warning), for any mode other than select while the interaction lock
   * is on, and for a mode that writes features while no layer can be written (for example with
   * `initDefaultLayer: false` before the host creates a layer). Asking for the current mode
   * does nothing and does not restart it. Emits `draw.mode.change` when the mode changed.
   *
   * @param mode the mode to enter
   * @returns whether the mode is `mode` after the call; false when the request was refused
   *
   * @example
   * ```typescript
   * if (!draw.setMode('draw_line')) {
   *   console.warn('Cannot draw now; the mode stays', draw.getMode());
   * }
   * ```
   */
  setMode(mode: Mode): boolean;

  // ReadOnly API (read-only; while it is on, writes to the shared data are stopped)
  /** Whether read-only is on (see {@link MapLibreGLDraw.setReadOnly}) */
  isReadOnly(): boolean;
  /**
   * Turns read-only on or off.
   *
   * While it is on, every local write to the document (features, layers, groups, metadata) is
   * refused: the methods that return a boolean return false and nothing changes. Local state
   * still changes: the selection, the mode and local hiding. Read-only is local to this client
   * is not part of the document; changes applied to the document store below it keep
   * arriving.
   *
   * @param value true to stop the writes, false to allow them again
   */
  setReadOnly(value: boolean): void;

  // InteractionLock API (the interaction lock; it is orthogonal to readOnly, does not stop
  // writes to the Store, and only suppresses the start of editing interactions from user
  // input: for a screen where the drawing is looked at and selected but not edited)
  /** Whether the interaction lock is on (see {@link MapLibreGLDraw.setInteractionLock}) */
  isInteractionLocked(): boolean;
  /**
   * Turns the interaction lock on or off.
   *
   * While it is on, the user can still select features, select vertices and toggle local
   * hiding, but no editing interaction starts from user input: no drag, resize, rotation or
   * vertex edit, no delete or group shortcut and no drawing mode. It does not
   * stop writes made through the methods or by plugins; that is read-only's job, and the two
   * are independent. Turning it on while drawing discards the drawing and returns to select.
   *
   * @param value true to lock the interactions, false to release them
   */
  setInteractionLock(value: boolean): void;

  // RenderSlot API (the separators and the frames of the stacking order)
  /**
   * Gets the frames that draw the stacking order, from the backmost.
   *
   * Each frame covers an interval `[from, to)` of the layer order and is drawn by one
   * MapLibre custom layer, whose id it carries. The entries for which
   * {@link Options.isExternalEntry} returns true are separators between the frames: the host
   * places the native layer of a separator just before the frame directly above it
   * (`map.moveLayer(id, slot.layerId)`), or in the foreground when no frame is above it.
   * Without separators there is a single frame, `maplibre-gl-draw-layer`. The event
   * `draw.renderslots.change` announces every change of this list.
   *
   * @returns the frames, from the backmost
   */
  getRenderSlots(): RenderSlot[];

  // RenderScale API (the render scale; it enlarges or shrinks, all at once, the dimensions
  // that are fixed in screen pixels)
  /**
   * Gets the current coefficient of the render scale (default 1).
   */
  getRenderScale(): number;
  /**
   * Sets the coefficient of the render scale (default 1).
   *
   * The dimensions fixed in screen pixels, such as line widths, point sizes, outlines and
   * glyphs, are drawn as CSS pixels times the render scale, and this coefficient multiplies
   * it: 0.5 halves only this library's own screen-pixel dimensions. The positions of the
   * features and the dimensions given in meters do not change, and neither does the width of
   * a line that scales with the zoom (a feature with a created zoom).
   *
   * Use it when the map is shown enlarged or reduced, for example with a CSS transform: a map
   * shown at 1/k, such as a page preview, calls `setRenderScale(1 / k)` so that this library's
   * lines and points shrink with the basemap. A change triggers a repaint, and the baked
   * batches are rebuilt on the next frame.
   *
   * @param scale the coefficient; anything other than a finite positive number is ignored
   *
   * @example
   * ```typescript
   * draw.setRenderScale(0.5); // while the map is shown at half size
   * draw.setRenderScale(1); // back to normal
   * ```
   */
  setRenderScale(scale: number): void;
  /**
   * Gets the resolved render scale: {@link Options.pixelRatio}, or else the map's
   * `getPixelRatio()`, times the coefficient of {@link MapLibreGLDraw.setRenderScale}.
   *
   * An extension that draws with a renderer of its own (text, for example) passes it on so
   * that its drawing matches, typically as a function: `pixelRatio: () => draw.getPixelRatio()`.
   */
  getPixelRatio(): number;

  // Diagnostics API
  /**
   * Gets the terrain diagnostics of this instance, as of the last frame drawn.
   *
   * For debugging and measurement tools only. The value is a layer 2 type: its fields follow
   * the rendering and can change in a minor release. `render` holds the numbers of the terrain
   * state the frame drew with (whether the terrain was active, where the DEM atlas lies, the
   * subdivision step and its generation), and `drape` reports whether the analytic drape was
   * used and why not. Both are snapshots of plain values: a later frame does not change them.
   * A map without terrain reports `render.active === false`.
   *
   * @example
   * ```typescript
   * const { render, drape } = draw.getTerrainDiagnostics();
   * console.log(render.active, render.stepMeters, drape.used, drape.reason);
   * ```
   */
  getTerrainDiagnostics(): TerrainDiagnostics;

  // Pending work API
  /**
   * Whether the renderer still has work that later frames finish on their own and that will
   * change the picture.
   *
   * It is true while the most recent frame left chunks of a dataset unbuilt or the tile index
   * of the terrain drape incomplete, while a huge polygon is being triangulated, while a
   * provider call waits for its debounce or its response, and while an overlay renderer reports
   * work of its own (`CustomOverlayRenderer.hasPendingWork`). The renderer requests the repaints
   * that finish this work itself.
   *
   * A host that reads the picture back (a print, a thumbnail) waits for the map's `idle`, which
   * covers the tiles and the DEM of the map, and then for this to return false after a frame:
   * maplibre fires `idle` even when this library asked for another frame during the last one,
   * so `idle` alone does not mean the picture is complete. With `timeSlicing: false` in the
   * rendering settings, the frames themselves are complete, and this usually turns false right
   * after the first frame. A change made after the last frame is drawn by the next one; ask
   * after that frame.
   *
   * @example
   * ```typescript
   * // Resolves once the picture on the canvas is complete
   * async function whenPictureComplete(map: maplibregl.Map, draw: MapLibreGLDraw): Promise<void> {
   *   map.triggerRepaint();
   *   await map.once('idle');
   *   while (draw.hasPendingWork()) await map.once('render');
   * }
   * ```
   */
  hasPendingWork(): boolean;

  // LocallyHidden API (hiding for this client only; it does not change the shared visible)
  /**
   * Whether a feature, group or layer is hidden for this client only (it does not look at
   * the shared `visible`)
   *
   * @param id the ID of a feature, a group or a layer
   */
  isLocallyHidden(id: string): boolean;
  /** Gets the IDs that are hidden for this client only */
  getLocallyHidden(): ReadonlySet<string>;
  /**
   * Hides or shows a feature, group or layer for this client only.
   *
   * It does not change `visible`, which is part of the document. What is hidden
   * is not drawn, hit or box selected, hiding a group or a layer hides everything in it, and
   * hidden items leave the selection. It works while read-only is on.
   *
   * @param id the ID of a feature, a group or a layer
   * @param hidden true to hide, false to show again
   */
  setLocallyHidden(id: string, hidden: boolean): void;

  // Feature API
  /**
   * Adds a feature.
   *
   * Only `type` and `coordinates` are required. The rest take defaults: a generated `id`, the
   * active layer, empty `properties`, `locked: false` and `visible: true`. The feature is
   * placed at the front of its layer, and `draw.feature.create` is emitted.
   *
   * @param feature the feature to add
   * @returns the ID of the feature; null when the write was refused because the Store is
   *   read-only (nothing is added)
   * @throws Error when the ID is already taken, or when `layerId` (or the active layer, when
   *   it is omitted) names no layer; nothing is added
   *
   * @example
   * ```typescript
   * const id = draw.addFeature({
   *   type: 'Point',
   *   coordinates: [139.767, 35.681],
   *   properties: { name: 'Tokyo Station' },
   * });
   * if (id !== null) draw.select(id);
   * ```
   */
  addFeature(feature: FeatureInput): string | null;
  /**
   * Gets a feature by ID.
   *
   * @returns the feature, or undefined when no feature has the ID
   */
  getFeature(id: string): Feature | undefined;
  /** Gets every feature, in display order (from the back), hidden ones included */
  getAllFeatures(): Feature[];
  /**
   * Gets the features the shared visible flag shows (the feature, its group and its layer are
   * all visible), in display order (from the back). Local hiding is not applied.
   */
  getVisibleFeatures(): Feature[];
  /**
   * Updates a feature.
   *
   * Any field can be updated partially. Changing `layerId` or `groupId` moves the feature to
   * its new container, at the front; to choose the position use
   * {@link MapLibreGLDraw.moveToLayer}, {@link MapLibreGLDraw.addFeatureToGroup} or
   * {@link MapLibreGLDraw.removeFeatureFromGroup}. Emits `draw.feature.update`.
   *
   * @param id the ID of the feature
   * @param updates the fields to change
   * @returns true when applied; false when refused because the Store is read-only, or
   *   because the feature, its group or its layer is locked and the update changes more
   *   than `locked` / `visible`
   * @throws Error when no feature has the ID, or when `layerId` names no layer
   *
   * @example
   * ```typescript
   * draw.updateFeature(id, {
   *   properties: { name: 'Updated name' },
   *   style: { strokeColor: '#e11d48' },
   * });
   * ```
   */
  updateFeature(id: string, updates: Partial<Feature>): boolean;
  /**
   * Deletes a feature. A group that the deletion leaves empty is deleted with it.
   *
   * @param id the ID of the feature
   * @returns true when deleted; false when refused because the Store is read-only
   * @throws Error when no feature has the ID
   */
  deleteFeature(id: string): boolean;
  /**
   * Deletes every feature (hidden ones included) in one notification.
   *
   * @returns true when deleted; false when refused because the Store is read-only
   */
  deleteAllFeatures(): boolean;

  // Layer API
  /** Gets every layer */
  getAllLayers(): Layer[];
  /**
   * Gets a layer by ID.
   *
   * @returns the layer, or undefined when no layer has the ID
   */
  getLayer(id: string): Layer | undefined;
  /**
   * Adds an empty layer at the front of the stacking order.
   *
   * The new layer does not become the active layer; call {@link MapLibreGLDraw.setActiveLayer}
   * to draw into it. Emits `draw.layer.create`.
   *
   * @param name the name; when omitted, a name from the automatic naming
   *   ({@link Options.autoName}), or the word of Layer alone when it is off
   * @returns the ID of the layer; null when the write was refused because the Store is
   *   read-only (nothing is added)
   */
  addLayer(name?: string): string | null;
  /**
   * Updates a layer.
   *
   * Any field can be updated partially, the style rule (`styleRule`) included. Emits
   * `draw.layer.update`.
   *
   * @param id the ID of the layer
   * @param updates the fields to change
   * @returns true when applied; false when refused because the Store is read-only, or
   *   because the layer is locked and the update changes more than `locked` / `visible`
   * @throws Error when no layer has the ID
   *
   * @example
   * ```typescript
   * draw.updateLayer(layerId, { name: 'Parcels', locked: true });
   * ```
   */
  updateLayer(id: string, updates: Partial<Layer>): boolean;
  /**
   * Deletes a layer with every feature and group in it, and removes its ID from the stacking
   * order. Emits `draw.layer.delete`.
   *
   * @param id the ID of the layer
   * @returns true when deleted; false when refused because the Store is read-only
   * @throws Error when no layer has the ID
   */
  deleteLayer(id: string): boolean;
  /**
   * Gets the stacking order: the IDs of the layers (and of any other entries set with
   * {@link MapLibreGLDraw.setLayerOrder}), where the last one is the frontmost.
   */
  getLayerOrder(): readonly string[];
  /**
   * Sets the stacking order. The last entry is the frontmost.
   *
   * The order is part of the document: the native format saves it and a replaced store
   * holds it. Its entries are not only layer IDs: a dataset with
   * `order: 'layer-order'` takes part in the same order, and a separator for a native layer
   * of the host (see {@link Options.isExternalEntry}) too. What such an entry means is the
   * application's; the library keeps it at its position and never removes it (deleting a
   * layer removes only that layer's ID), and one that names nothing is skipped when drawing
   * and hit testing. Removing it is the caller's job. Empty strings are dropped and a
   * repeated entry is kept at its first position. Emits `draw.layer.reorder`.
   *
   * @param order the new order, from the back
   * @returns true when applied; false when refused because the Store is read-only
   *
   * @example
   * ```typescript
   * // Put a dataset between two layers
   * draw.addDataset({ id: 'parcels', features, order: 'layer-order' });
   * draw.setLayerOrder([baseLayerId, 'parcels', notesLayerId]);
   * ```
   */
  setLayerOrder(order: string[]): boolean;
  /**
   * Moves a feature or a group to another position inside its layer.
   *
   * @param itemId the ID of a feature or a group directly in the layer
   * @param layerId the ID of the layer
   * @param newIndex the new position in the order of the layer; 0 is the backmost
   * @returns true when applied; false when refused because the Store is read-only
   * @throws Error when no layer has the ID, or when the item is not in that layer
   */
  reorderInLayer(itemId: string, layerId: string, newIndex: number): boolean;
  /**
   * Moves a feature or a group to the front of another layer.
   *
   * A feature that was in a group leaves the group. Nothing happens when the item or the
   * layer does not exist, or when the item is already directly in that layer.
   *
   * @param itemId the ID of a feature or a group
   * @param targetLayerId the ID of the destination layer
   */
  moveToLayer(itemId: string, targetLayerId: string): void;
  /**
   * Gets the ID of the active layer, the layer new features go into by default.
   *
   * When the active layer has been deleted, the first layer becomes active.
   */
  getActiveLayer(): string;
  /**
   * Sets the active layer, the layer new features go into by default.
   *
   * @param layerId the ID of the layer; an ID that names no layer is ignored
   */
  setActiveLayer(layerId: string): void;

  // Group API
  /** Gets every group */
  getAllGroups(): Group[];
  /**
   * Gets a group by ID.
   *
   * @returns the group, or undefined when no group has the ID
   */
  getGroup(id: string): Group | undefined;
  /**
   * Groups features.
   *
   * The features leave the order of the layer, and the group takes their place at the front
   * of the layer. Emits `draw.group.create`.
   *
   * @param featureIds the IDs of the features to group, from the back
   * @param layerId the ID of the layer the features are in
   * @param name the name; when omitted, a name from the automatic naming
   *   ({@link Options.autoName}), or the word of Group alone when it is off
   * @returns the ID of the group; null when the write was refused because the Store is
   *   read-only (nothing changes)
   *
   * @example
   * ```typescript
   * const groupId = draw.addGroup([idA, idB], draw.getActiveLayer(), 'Station area');
   * ```
   */
  addGroup(featureIds: string[], layerId: string, name?: string): string | null;
  /**
   * Updates a group. Emits `draw.group.update`.
   *
   * @param id the ID of the group
   * @param updates the fields to change
   * @returns true when applied; false when refused because the Store is read-only, or
   *   because the group or its layer is locked and the update changes more than `locked` /
   *   `visible`
   * @throws Error when no group has the ID
   */
  updateGroup(id: string, updates: Partial<Group>): boolean;
  /**
   * Deletes a group; its features stay, in the group's place in the order of its layer.
   *
   * @param id the ID of the group
   * @returns true when deleted; false when refused because the Store is read-only
   * @throws Error when no group has the ID
   */
  deleteGroup(id: string): boolean;
  /**
   * Moves a feature to another position inside its group.
   *
   * @param featureId the ID of a member of the group
   * @param groupId the ID of the group
   * @param newIndex the new position among the members; 0 is the backmost
   * @returns true when applied; false when refused because the Store is read-only
   * @throws Error when no group has the ID, or when the feature is not a member of it
   */
  reorderInGroup(featureId: string, groupId: string, newIndex: number): boolean;
  /**
   * Adds a feature to a group.
   *
   * A feature in another group leaves that group first. Nothing happens when the feature or
   * the group does not exist, or when the feature is already a member.
   *
   * @param featureId the ID of the feature
   * @param groupId the ID of the group
   * @param index the position among the members; when omitted, the front
   */
  addFeatureToGroup(featureId: string, groupId: string, index?: number): void;
  /**
   * Takes a feature out of its group and places it just in front of the group in the layer.
   *
   * A group that the removal leaves empty is deleted. Nothing happens for a feature in no
   * group.
   *
   * @param featureId the ID of the feature
   */
  removeFeatureFromGroup(featureId: string): void;
  /**
   * Groups the selected features, the same as Cmd/Ctrl+G in select mode.
   *
   * It groups when two or more features are selected, all in the same layer, and none of
   * them in a group that exists.
   *
   * @returns the ID of the new group, or null when the selection cannot be grouped
   */
  groupSelection(): string | null;
  /**
   * Takes the selection out of the group structure, the same as Shift+Cmd/Ctrl+G in select
   * mode.
   *
   * A selected group is dissolved: its members take its place and the group is deleted. A
   * selected member leaves its group and is placed just in front of it; a group left empty is
   * deleted. Anything else does nothing. It is one transaction, one notification.
   */
  ungroupSelection(): void;
  /**
   * Dissolves a group whatever is selected: its members take its place in the layer and the
   * group is deleted, in one transaction.
   *
   * @param groupId the ID of the group
   */
  ungroupGroup(groupId: string): void;

  // Selection API
  /**
   * Gets the selection: its type (`feature`, `group` or `layer`, or null) and the selected
   * IDs.
   *
   * @example
   * ```typescript
   * const selection = draw.getSelection();
   * if (selection.type === 'feature') {
   *   console.log('Selected features:', selection.ids);
   * }
   * ```
   */
  getSelection(): Selection;
  /**
   * Selects items, replacing the current selection.
   *
   * Locked items can be selected. Emits `draw.selection.change` when the selection changed.
   *
   * @param ids the IDs of the items to select (a single one or a list)
   * @param type the selection type (when omitted, it is 'feature')
   *
   * @example
   * ```typescript
   * draw.select(featureId);
   * draw.select([idA, idB]);
   * draw.select(layerId, 'layer');
   * ```
   */
  select(ids: string | string[], type?: SelectionType): void;
  /** Clears the selection. Emits `draw.selection.change` when something was selected */
  deselect(): void;
  /** Gets the selected features; an empty array unless the selection type is 'feature' */
  getSelectedFeatures(): Feature[];
  /** Gets the IDs of the selected items, whatever their type */
  getSelectedIds(): string[];
  /**
   * Deletes what is selected as one change, the same as the Delete key of the select mode:
   * the selected vertices when there are any, otherwise the selected features, the contents of
   * the selected groups, or the selected layers (at least one layer is kept). Locked items are
   * kept: a group loses only its unlocked members, and a layer holding a locked feature or
   * group is not deleted.
   *
   * @returns true when something was deleted; false while read-only or the interaction lock
   *   is on, when nothing is selected, or when everything selected is locked
   *
   * @example
   * ```typescript
   * deleteButton.onclick = () => draw.deleteSelection();
   * ```
   */
  deleteSelection(): boolean;

  // Vertex API
  /**
   * Selects vertices of a feature, replacing the vertex selection.
   *
   * @param featureId the ID of the feature
   * @param vertices an array of vertex references (part number + ring number + vertex index).
   *   For a Polygon, ring 0 is the exterior ring and 1 onwards are the interior rings (holes).
   *   For LineString / Point it is ring 0. part is the part number of the Multi geometries,
   *   and when omitted it is 0 (for a single geometry it is always 0)
   *
   * @example
   * ```typescript
   * draw.selectVertices(polygonId, [{ ring: 0, index: 0 }, { ring: 0, index: 2 }]);
   * // A vertex of a hole of the second polygon of a MultiPolygon
   * draw.selectVertices(multiPolygonId, [{ part: 1, ring: 1, index: 2 }]);
   * ```
   */
  selectVertices(featureId: string, vertices: VertexRef[]): void;
  /** Clears the vertex selection */
  deselectVertices(): void;
  /**
   * Gets the selected vertices: the feature and the references of its vertices.
   *
   * @returns the vertex selection, or null when no vertex is selected
   */
  getSelectedVertices(): VertexSelection | null;
  /**
   * Deletes vertices of a feature in one change, and clears the vertex selection of that
   * feature.
   *
   * A vertex whose deletion would leave its ring or part below the minimum (2 for a line,
   * 3 for a polygon ring) is kept; the test is made per ring and per part, so the others are
   * still deleted. Deleting a vertex of a MultiPoint removes that part, and the last part is
   * kept.
   *
   * @param featureId the ID of the feature
   * @param vertices the references of the vertices to delete
   * @returns the number of vertices deleted; 0 when the feature does not exist
   *
   * @example
   * ```typescript
   * const selection = draw.getSelectedVertices();
   * if (selection) {
   *   draw.deleteVertices(selection.featureId, selection.vertexIndices);
   * }
   * ```
   */
  deleteVertices(featureId: string, vertices: VertexRef[]): number;

  // Geometry API (the namespace of the geometry operations; the boolean editing operations
  // and the buffer)
  /**
   * The geometry operations on features: union, subtract, intersect, buffer and split.
   *
   * When the arguments are omitted, the current selection is the target. The computation is
   * done by the pure functions of `@sakuzu/maplibre-gl-draw/geometry`, and this namespace
   * adds the selection, the transaction (one notification) and the `draw.geometry.applied`
   * event.
   */
  geometry: GeometryOperations;

  // Snapping API (the namespace of snapping; enabling and disabling it, and registering
  // providers)
  /**
   * Snapping: switching it at runtime and adding candidates.
   *
   * The coordinates of clicks, moves and drags are snapped before any mode sees them, so
   * snapping works the same way in every mode and for vertex dragging. By default the
   * candidates are the vertices and edges of the Store; more come from providers added with
   * `draw.snapping.register()`. The initial settings are {@link Options.snap}.
   */
  snapping: SnappingOperations;

  // Tracing API (the namespace of edge tracing; enabling and disabling it)
  /**
   * Edge tracing: switching it at runtime.
   *
   * In draw_line / draw_polygon, when the previous click and this click both snapped to the
   * boundary (a vertex or an edge) of the same feature, the boundary vertices between them
   * are inserted automatically. It is enabled by default ({@link Options.trace}).
   */
  tracing: TracingOperations;

  // Topology API (the namespace of topology; switching the simultaneous movement of shared
  // vertices)
  /**
   * Topology: switching at runtime the settings that keep editing from breaking boundaries
   * shared by adjacent features.
   *
   * The initial settings are {@link Options.topology}. A switch takes effect from the next
   * drag start.
   */
  topology: TopologyOperations;

  // Input API (synthetic input; it gives points to the drawing modes from numeric input,
  // from tests or from automation)
  /**
   * Synthetic input: clicks, moves and keys given to the modes from code.
   *
   * The events take the same path as real input, so snapping and the plugins see them in the
   * same way. Use it for numeric input (a distance and a bearing, absolute coordinates), for
   * tests and for automation. The input fields of a numeric input UI are not part of the
   * library.
   */
  input: InputOperations;

  // Display API (read-only bulk display; it does not enter the Store)
  /**
   * Adds a dataset: many features that are shown, with an attribute-driven
   * style, but never edited.
   *
   * It is a path independent of the Store, meant for overlaying external data of tens of
   * thousands of features. The features are not editable, not selectable with the selection
   * UI, not on the undo history, not in the `draw.feature.*` events and not in
   * {@link MapLibreGLDraw.export}. To edit one, copy it into the Store with
   * {@link MapLibreGLDraw.addFeature}. Give either `features` or `provider`, not both.
   * Emits `draw.dataset.add`.
   *
   * @param options the ID, the features or the provider, the style and the placement
   * @returns the dataset, which is also how it is updated and removed
   * @throws Error when the ID is already taken, when both `features` and `provider` are
   *   given, or when the instance has been destroyed
   *
   * @example
   * ```typescript
   * const dataset = draw.addDataset({
   *   id: 'districts',
   *   features: districtFeatures,
   *   styleRule: {
   *     kind: 'graduated',
   *     property: 'population',
   *     breaks: [1000, 5000, 10000],
   *     colors: ['#eff3ff', '#bdd7e7', '#6baed6', '#2171b5'],
   *     other: '#cccccc',
   *   },
   *   interactive: true,
   * });
   * dataset.on('click', ({ feature }) => console.log(feature.properties));
   * ```
   */
  addDataset(options: DatasetOptions): Dataset;
  /**
   * Gets a dataset by ID.
   *
   * @returns the dataset, or undefined when no dataset has the ID
   */
  getDataset(id: string): Dataset | undefined;
  /**
   * Gets the datasets in display order (from the back to the front).
   *
   * It starts at the backmost of below-store and ends at the frontmost of above-store. The
   * array is a copy; reorder with {@link MapLibreGLDraw.moveDataset}.
   */
  getDatasets(): Dataset[];
  /**
   * Reorders a dataset.
   *
   * `order` changes the side (in front of or behind the Store) and `index` changes the
   * position within that side (0 is the backmost; out-of-range values are clamped). When
   * `index` is omitted, a dataset that changes side goes to the front of it, and one that
   * stays keeps its position. The visibility, the features and the GPU resources are not
   * affected, and hit testing follows the same order as the drawing. Emits
   * `draw.dataset.reorder` when the order or the side changed.
   *
   * @param id the ID of the dataset
   * @param placement the side and the position
   * @returns true if it was moved (false for an ID that does not exist)
   *
   * @example
   * ```typescript
   * draw.moveDataset('parcels', { order: 'above-store' });
   * draw.moveDataset('parcels', { index: 0 }); // to the back of its side
   * ```
   */
  moveDataset(id: string, placement: DatasetPlacement): boolean;
  /**
   * Removes a dataset and releases its GPU resources.
   *
   * Its ID is not removed from the stacking order; that is the caller's job when it was added
   * with `order: 'layer-order'`. Emits `draw.dataset.remove` when it was removed.
   *
   * @param id the ID of the dataset
   * @returns true if it was removed (false if it does not exist)
   */
  removeDataset(id: string): boolean;

  // Event API
  /**
   * Subscribes to an event.
   *
   * See {@link EventPayloads} for the events and their payloads.
   *
   * @param event the event name
   * @param handler the function called with the payload of each event
   * @returns the function that unsubscribes the handler (the same as calling `off`)
   *
   * @example
   * ```typescript
   * const unsubscribe = draw.on('draw.features.change', ({ created, updated, deleted }) => {
   *   rebuildList();
   * });
   * // Later
   * unsubscribe();
   * ```
   */
  on<K extends keyof EventPayloads>(
    event: K,
    handler: (data: EventPayloads[K]) => void,
  ): () => void;
  /**
   * Unsubscribes a handler given to {@link MapLibreGLDraw.on}.
   *
   * @param event the event name
   * @param handler the same function that was subscribed
   */
  off<K extends keyof EventPayloads>(event: K, handler: (data: EventPayloads[K]) => void): void;

  // Import/Export API
  /**
   * Loads data or a file.
   *
   * The kind of the source is detected: a `File` (a `.json` or `.geojson` file, or an image),
   * or an object in the native format or a GeoJSON FeatureCollection. The native format
   * replaces the existing data; GeoJSON and an image are added to it. The data is validated
   * before the Store changes, so a rejected load leaves the existing data as it was. A GeoJSON
   * feature whose geometry cannot be used is left out and listed in `skipped`, and one whose
   * ID is taken gets a new ID. The whole load is one transaction: a GeoJSON or image load is
   * one change, and a native load is notified with the source 'silent'.
   *
   * @param source a `File`, or a parsed native or GeoJSON object
   * @param options the placement of an image (required for an image file) and the handling
   *   of Multi geometries
   * @returns the format that was detected, the IDs of the added features and what was
   *   skipped
   * @throws Error (the Promise rejects) for an unsupported file or data format, a JSON file
   *   that does not parse, native data that is malformed or of another major version, an
   *   embedded image that is not accepted, or an image file without a coordinate
   *
   * @example
   * ```typescript
   * const result = await draw.load(file);
   * console.log(result.format, result.featureIds.length, result.skipped);
   *
   * // An image needs a coordinate
   * await draw.load(imageFile, {
   *   coordinate: [139.767, 35.681],
   *   zoom: map.getZoom(),
   *   layerId: draw.getActiveLayer(),
   * });
   * ```
   */
  load(source: File | unknown, options?: LoadOptions): Promise<LoadResult>;
  /**
   * Exports the data as a string in the given format.
   *
   * `native` holds everything (layers, groups, features, files and metadata) and loads back
   * as it was. `geojson` is a FeatureCollection that follows RFC 7946: rings follow the
   * right-hand rule, positions are rounded to 7 decimal places, and the FeatureCollection carries a
   * `bbox`.
   *
   * @param format `native` or `geojson`
   * @param options the features to include and the file name
   * @returns the data, its MIME type and a file name
   * @throws Error for an unsupported format
   *
   * @example
   * ```typescript
   * const { data, mimeType, fileName } = draw.export('geojson');
   * const url = URL.createObjectURL(new Blob([data], { type: mimeType }));
   * // Offer url for download as fileName
   *
   * // Only some features
   * draw.export('geojson', { featureIds: [idA, idB] });
   * ```
   */
  export(format: ExportFormat, options?: ExportOptions): ExportResult;
  /**
   * Gets a file name for a native export: the metadata title (or `drawing`) with the date and
   * the time, such as `My map_2026-09-24_153000.maplibre-gl-draw.json`.
   */
  getSuggestedFileName(): string;

  // Metadata API
  /** Gets the metadata of the document (the title, the description and so on) */
  getMetadata(): Metadata;
  /**
   * Updates the metadata; the fields left out keep their values. Emits
   * `draw.metadata.change`.
   *
   * @param metadata the fields to change
   * @returns true when applied; false when refused because the Store is read-only
   *
   * @example
   * ```typescript
   * draw.setMetadata({ title: 'Survey 2026', description: 'Field notes' });
   * ```
   */
  setMetadata(metadata: Partial<Metadata>): boolean;

  // Lifecycle
  /**
   * Destroys the instance: removes its layers and listeners from the map and unregisters
   * every plugin (each one's `onUninstall` runs).
   *
   * The registrations of the extension points (feature handlers, auxiliary handles, snapping
   * candidates and so on) belong to this instance and are cleared; another instance on the
   * page is not touched. What the instance changed on the map is given back as it was found
   * (box zoom, the `tabIndex` of the canvas). A second call does nothing.
   *
   * The calls made afterwards do not throw and reach neither the map nor a timer: a
   * registration is ignored and returns a cancel function that does nothing, and
   * {@link MapLibreGLDraw.addDataset} throws. The other calls work on the Store the
   * destroyed instance keeps in memory.
   *
   * @example
   * ```typescript
   * // In the teardown of a component
   * draw.destroy();
   * map.remove();
   * ```
   */
  destroy(): void;

  // Extension API (plugins / custom extensions)
  /**
   * Adds a custom overlay renderer after initialization.
   *
   * An extension uses it to draw with WebGL behind the features (`background`), in front of
   * them (`foreground`) or in front of the selection UI (`overlay`). The renderer receives
   * `onAdd(gl, map)` when the rendering engine is built and `onRemove()` when it is torn down,
   * which can happen several times (after `setStyle`, after a lost WebGL context): create the
   * GL objects in `onAdd` and release them in `onRemove`.
   *
   * @param renderer the renderer to add
   * @returns a function that removes the renderer (it gets its onRemove when the rendering
   *   is on the map)
   */
  addOverlayRenderer(renderer: CustomOverlayRenderer): () => void;
  /**
   * Registers a plugin.
   *
   * The plugin's `onInstall` receives a {@link PluginContext}, its modes are registered and
   * its hooks are called from then on. The registration belongs to this instance.
   *
   * @param plugin the plugin to register
   * @returns a function that unregisters the plugin (its modes are removed and its
   *   onUninstall runs); a plugin whose name is already registered is skipped, and the
   *   function returned then does nothing
   *
   * @example
   * ```typescript
   * const unregister = draw.addPlugin({
   *   name: 'logger',
   *   onInstall(ctx) {
   *     ctx.on('feature.create', ({ feature }) => console.log('created', feature.id));
   *   },
   * });
   * ```
   */
  addPlugin(plugin: Plugin): () => void;
  /**
   * Gets the API a plugin publishes (the `api` of the {@link Plugin}).
   *
   * @param name the name of the plugin
   * @returns the API, or undefined when no plugin of that name is registered or it publishes
   *   none
   */
  getPluginApi<T>(name: string): T | undefined;
  /**
   * Registers a custom mode, entered with {@link MapLibreGLDraw.setMode}.
   *
   * A mode that creates features declares `writesFeatures` on its handler: it is then entered
   * only while a layer can be written, and it reads `ModeContext.getCurrentLayerId()` again
   * when it commits (an empty string means no layer can be written: discard the drawing and
   * return to select). A mode consumes a double click or a key by calling
   * `event.originalEvent.preventDefault()`, so the map does not also zoom or pan.
   *
   * @param mode the name of the mode
   * @param factory creates the handler each time the mode is entered
   * @returns a function that removes the mode (select is entered first when it is the
   *   current mode); it does nothing once the name has been registered again
   *
   * @example
   * ```typescript
   * const unregister = draw.registerMode('measure', () => new MeasureMode());
   * draw.setMode('measure');
   * ```
   */
  registerMode(mode: Mode, factory: () => ModeHandler): () => void;
  /**
   * Registers a custom feature type: how it is drawn, hit, box selected, measured, resized
   * and snapped to.
   *
   * `type`, `renderer` and `hitTest` are required; the other parts fall back to the built-in
   * behavior. Registering re-measures the features of the type already in the Store. A part
   * registered for a built-in type replaces the built-in one until it is cancelled.
   *
   * @param handler the parts of the feature type
   * @returns a function that cancels every registration the handler made (renderer, hit
   *   test, box selection, extents, resize, snapping); a part that another handler has
   *   registered again for the type since is left in place
   *
   * @example
   * ```typescript
   * const unregister = draw.registerFeatureHandler({
   *   type: 'Star',
   *   renderer: new StarRenderer(),
   *   hitTest: new StarHitTest(),
   *   getBoundingBox: (feature) => starBounds(feature),
   * });
   * draw.addFeature({ type: 'Star', coordinates: [139.767, 35.681] });
   * ```
   */
  registerFeatureHandler(handler: CustomFeatureHandler): () => void;
  /**
   * Registers a provider of auxiliary handles.
   *
   * It is the extension point for showing, on the selected feature, handles of your own that
   * are neither vertices nor resize handles, and for grabbing them. The rendering is the
   * responsibility of the registering side; the library only performs the hit testing and
   * the delegation of the drag.
   *
   * @param provider the provider to register
   * @returns a function that cancels the registration
   */
  registerAuxiliaryHandleProvider(provider: AuxiliaryHandleProvider): () => void;
  /**
   * Registers a provider of companion rendering and companion hits.
   *
   * It is the extension point for drawing something just behind a feature (one step below it
   * in the stacking order) and for making it grabbable at the same position in the order of
   * a click. The library does not know the meaning of the companion, the rendering is the
   * responsibility of the registering side, and a click that hits is simply handed back to
   * the provider.
   *
   * @param provider the provider to register
   * @returns a function that cancels the registration
   */
  registerFeatureCompanionProvider(provider: FeatureCompanionProvider): () => void;
}

/**
 * The input-related components
 *
 * @internal
 */
export interface InputComponents {
  inputNormalizer: InputNormalizer;
  inputRouter: InputRouter;
}

/**
 * The lifecycle management components
 *
 * @internal
 */
export interface LifecycleComponents {
  modeManager: ModeManager;
  renderCoordinator: RenderCoordinator;
}

/**
 * The extension components (for dynamic registration)
 *
 * @internal
 */
export interface ExtensionComponents {
  pluginManager: PluginManager;
  /** The spatial index derived from the Store (stopped on destroy) */
  spatialIndex: StoreSpatialIndex;
  /** The manager of the datasets */
  datasets: DatasetManager;
  /** The providers of companion rendering and companion hits (those of this draw instance) */
  featureCompanions: FeatureCompanionRegistry;
}

/**
 * The terrain diagnostics of a draw instance, as of the last frame it drew (see
 * {@link MapLibreGLDraw.getTerrainDiagnostics}).
 *
 * For debugging and measurement tools only: the fields follow the rendering and can change in
 * a minor release (it is a layer 2 type). Both values are snapshots of plain values that a
 * later frame does not change.
 */
export interface TerrainDiagnostics {
  /**
   * The terrain state the last frame drew with: whether the terrain was active, where the DEM
   * atlas lies, the subdivision step and its generation
   */
  readonly render: TerrainRenderDiagnostics;
  /** Whether the last frame used the analytic drape, why not when it did not, and its counters */
  readonly drape: Readonly<TerrainDrapeDebug>;
}

/**
 * The numbers of the terrain state a frame drew with, for diagnostics (see
 * {@link TerrainDiagnostics}). It is a layer 2 type and can change in a minor release.
 */
export interface TerrainRenderDiagnostics {
  /** Whether the terrain was enabled and the DEM atlas usable */
  readonly active: boolean;
  /** The Mercator rectangle the DEM atlas covers, [x0, y0, 1/width, 1/height] */
  readonly atlasRect: readonly [number, number, number, number];
  /** The number of texels of the DEM atlas, [width, height] */
  readonly atlasSize: readonly [number, number];
  /** The conversion factor from meters to Mercator z at the latitude of the screen center */
  readonly elevationScale: number;
  /** The lift above the ground in meters, against Z-fighting */
  readonly liftMeters: number;
  /** The subdivision step in meters (0 means no subdivision) */
  readonly stepMeters: number;
  /** The grid spacing of the subdivision, in Mercator units */
  readonly stepGrid: number;
  /** The generation of the subdivision (it counts the changes of the step, per instance) */
  readonly generation: number;
}

/**
 * The orchestrator that creates the public API. It composes the sub-apis of each functional
 * domain by spreading.
 *
 * @internal
 */
export function createDrawAPI(
  context: Context,
  input: InputComponents,
  eventBridge: EventBridge,
  customLayer: MapLibreCustomLayerInterface | CustomLayerInterface,
  importExportAPI: ImportExportAPI,
  lifecycle: LifecycleComponents,
  extension: ExtensionComponents,
): MapLibreGLDraw {
  const {
    map,
    store,
    eventEmitter,
    generateFeatureId,
    autoNameGenerator,
    hitTestService,
    boxSelectionRegistry,
    getActiveLayerId,
    setActiveLayerId,
    snapService,
    topology,
    trace,
    pixelRatioSource,
  } = context;
  const { spatialIndex, pluginManager, datasets, featureCompanions } = extension;
  const { inputNormalizer, inputRouter } = input;
  const { modeManager, renderCoordinator } = lifecycle;

  // The after-mutation hooks of the plugins are fired from the Store notification, so they
  // see every write whatever made it
  const stopMutationHooks = subscribeMutationHooks(store, pluginManager);

  const instanceApi = createInstanceApi({
    map,
    store,
    modeManager,
    eventBridge,
    renderCoordinator,
    inputRouter,
    inputNormalizer,
    customLayer,
    autoNameGenerator,
    pixelRatioSource,
    pluginManager,
  });

  return {
    ...instanceApi,
    destroy(): void {
      instanceApi.destroy();
      // After the plugins are uninstalled (their onUninstall can still read the index)
      stopMutationHooks();
      spatialIndex.destroy();
    },
    ...createFeatureApi({ store, generateFeatureId, getActiveLayerId }),
    ...createLayerApi({
      store,
      generateFeatureId,
      autoNameGenerator,
      getActiveLayerId,
      setActiveLayerId,
    }),
    ...createGroupApi({ store, generateFeatureId, autoNameGenerator }),
    ...createSelectionApi({ store }),
    ...createGeometryApi({ store, eventEmitter, generateFeatureId }),
    ...createDisplayApi({ datasets }),
    ...createSnappingApi({ snapService, map }),
    ...createTracingApi({ trace }),
    ...createTopologyApi({ topology }),
    ...createInputApi({ map, inputRouter }),
    ...createEventApi({ eventEmitter }),
    ...createExtensionApi({
      pluginManager,
      modeManager,
      spatialIndex,
      hitTestService,
      boxSelectionRegistry,
      customLayer: customLayer as CustomLayerInterface,
      featureCompanions,
      selectionScope: context.selectionScope,
      snapTargets: context.snapTargets,
    }),
    // The Import/Export API spreads importExportAPI directly
    // (load / export / getSuggestedFileName)
    load: (source, options) => importExportAPI.load(source, options),
    export: (format, options) => importExportAPI.export(format, options),
    getSuggestedFileName: () => importExportAPI.getSuggestedFileName(),
  };
}
