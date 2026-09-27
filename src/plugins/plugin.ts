// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Plugin Types
 *
 * Type definitions for the plugin system.
 * core provides only simple types, and is extensible so that extension
 * implementations can use their own source values.
 */

import type { Feature as GeoJSONFeature } from 'geojson';
import type { MapLibreGLDraw } from '../api/api.js';
import type {
  DragNormalizedEvent,
  KeyNormalizedEvent,
  MouseNormalizedEvent,
} from '../dispatcher/types.js';
import type { ModeFactory } from '../modes/handler.js';
import type { ScreenPoint } from '../shared/math/index.js';
import type { EventEmitter, EventMap } from '../shared/utils/event-emitter.js';
import type { AutoNameGenerator } from '../shared/utils/name-generator.js';
import type { Store } from '../store/store.js';
import type {
  Feature,
  Group,
  Layer,
  Mode,
  Selection,
  SelectionType,
  UpdateSource,
} from '../store/types.js';
import type { BoundingBoxCoords } from '../view/ui/selection-ui/index.js';

/**
 * What a mutation hook learns about the change that fired it: its source and its batch
 */
export interface MutationContext {
  /** Source of the mutation (the source of the Store notification) */
  source: UpdateSource;
  /**
   * Batch ID shared by the hooks fired for one Store notification (one transaction), so
   * that a compound mutation can be grouped
   */
  batchId?: string | undefined;
}

/**
 * What a plugin gets in `onInstall`: the draw instance, the Store, and methods to read and
 * change the document
 *
 * It is the only way a plugin reaches core. The host API of the instance is `draw`; the
 * Store itself, for a plugin that works on the document directly, is `getStore()`.
 *
 * Each mutation method is one Store transaction, and its optional `source` becomes the source
 * of the notification (`'local'` when omitted); inside `batch(fn)` the writes form one
 * transaction with the source of the batch. The mutation methods ignore an id that no longer
 * names anything (a plugin often reacts after a change, when a peer may already have deleted
 * what it points at). While the Store is read-only they change nothing, like every other
 * write.
 *
 * The spatial index that hit testing and box selection read is derived from the Store, so
 * there is nothing to call after a mutation.
 *
 * @example
 * ```ts
 * const plugin: Plugin = {
 *   name: 'tagger',
 *   onInstall(ctx) {
 *     ctx.on('feature.create', ({ feature }) => {
 *       ctx.updateFeature(feature.id, { properties: { tag: 'new' } }, 'tagger');
 *     });
 *   },
 * };
 * ```
 */
export interface PluginContext {
  /**
   * Reference to the MapLibreGLDraw instance itself.
   *
   * Used when calling extension point APIs such as registerFeatureHandler /
   * registerMode / addOverlayRenderer, or public APIs that are not exposed on
   * PluginContext. draw.getPluginApi<T>(name) can also be used to look up
   * another plugin.
   *
   * Design guideline: dependencies between plugins should be passed through the
   * constructor (explicit wiring). Lookup via draw.getPluginApi is a fallback.
   */
  draw: MapLibreGLDraw;

  /**
   * The Store of this draw instance, with its write methods
   *
   * For a plugin that works on the document directly. The writes go through the same read-only gate
   * as every other write (they return false while read-only) and are notified to every
   * subscriber. Anything else goes through the methods below or the public API of `draw`.
   */
  getStore(): Store;

  /**
   * The automatic naming of this draw instance (the `autoName` option)
   *
   * A plugin that creates a feature, a layer or a group without a name the user typed names it
   * here, so every generated name takes its words from the host's one naming configuration.
   */
  readonly autoNameGenerator: AutoNameGenerator;

  // === Read API ===
  /** Returns the feature with this ID, or undefined */
  getFeature(id: string): Feature | undefined;
  /** Every feature, in no particular order */
  getAllFeatures(): Feature[];
  /** Returns the group with this ID, or undefined */
  getGroup(id: string): Group | undefined;
  /** Every group, in no particular order */
  getAllGroups(): Group[];
  /** Returns the layer with this ID, or undefined */
  getLayer(id: string): Layer | undefined;
  /** Every layer, in no particular order */
  getAllLayers(): Layer[];
  /** Returns the current selection */
  getSelection(): Selection;
  /** The IDs of the selected features (empty when groups or layers are selected) */
  getSelectedIds(): string[];
  /** Order of the items (features / groups) inside the active layer */
  getLayerOrder(): readonly string[];
  /**
   * Stacking order (back to front)
   *
   * Returns the stacking order of the Store as is. This is a different thing
   * from `getLayerOrder` (the order inside the active layer). The order may
   * also contain IDs of datasets, so a caller that needs only
   * layers should narrow it down to the ones `getLayer` can resolve.
   */
  getLayerIds(): readonly string[];
  /** The current mode */
  getMode(): Mode;

  // === Mutation API (source can be specified) ===
  // Each call is one Store transaction whose notification carries `source` ('local' when
  // omitted). Inside batch() the source of the batch applies.
  /**
   * Adds GeoJSON features to the active layer
   *
   * A feature keeps its `id` when it has one, and gets a new ID otherwise. The geometry
   * becomes the type and the coordinates, and the properties are kept as they are.
   *
   * @returns The IDs of the added features, in the order given; an empty list when the
   *   Store is read-only and nothing was added
   */
  addFeatures(features: GeoJSONFeature[], source?: UpdateSource): string[];
  /**
   * Updates a feature: the fields given replace the old ones, and `properties` is merged key
   * by key into the old properties
   */
  updateFeature(id: string, feature: Partial<Feature>, source?: UpdateSource): void;
  /** Deletes features, taking them out of the selection and of their group and layer */
  deleteFeatures(ids: string[], source?: UpdateSource): void;

  /**
   * Creates a group (`visible` and `locked` default to true and false, and `featureIds` to
   * an empty list)
   */
  createGroup(group: Group, source?: UpdateSource): void;
  /** Updates a group */
  updateGroup(id: string, group: Partial<Group>, source?: UpdateSource): void;
  /** Deletes a group; its members stay, in the group's place in the layer */
  deleteGroup(id: string, source?: UpdateSource): void;
  /**
   * Adds a feature to a group, at `index` of its members or at the end
   *
   * The feature leaves the group or the layer order it was in, and moves to the layer of the
   * group.
   */
  addFeatureToGroup(
    groupId: string,
    featureId: string,
    index?: number,
    source?: UpdateSource,
  ): void;
  /**
   * Takes a feature out of a group; it is placed in the layer right in front of the group
   */
  removeFeatureFromGroup(groupId: string, featureId: string, source?: UpdateSource): void;
  /** The ID of the group the feature belongs to, or undefined */
  findGroupForFeature(featureId: string): string | undefined;

  // Layer mutation API
  /**
   * Creates a layer (`visible`, `locked` and `opacity` default to true, false and 1, and
   * `items` to an empty list)
   */
  createLayer(layer: Layer, source?: UpdateSource): void;
  /** Updates a layer */
  updateLayer(id: string, updates: Partial<Layer>, source?: UpdateSource): void;
  /** Deletes a layer together with its features and groups */
  deleteLayer(id: string, source?: UpdateSource): void;
  /** Appends an item to the order of a layer, when the layer does not list it yet */
  addToLayer(layerId: string, featureId: string, source?: UpdateSource): void;
  /** Removes an item from the order of a layer */
  removeFromLayer(layerId: string, featureId: string, source?: UpdateSource): void;
  /** The ID of the layer whose order lists this feature or group, or undefined */
  findLayerForFeature(featureId: string): string | undefined;
  /**
   * Moves a feature or a group to another layer, at `targetIndex` of its order or at the
   * front
   *
   * A feature leaves its group. The members of a moved group move with it.
   */
  moveItemToLayer(
    itemId: string,
    targetLayerId: string,
    targetIndex?: number,
    source?: UpdateSource,
  ): void;

  /**
   * Replaces the order of the items (features and groups) inside a layer, from the back
   *
   * Not the stacking order of the layers, which `draw.setLayerOrder` changes. A layer ID that
   * names no layer does nothing.
   *
   * @param layerId the ID of the layer whose items are reordered
   * @param order the IDs of the items of the layer, from the back
   */
  setLayerItemOrder(layerId: string, order: string[], source?: UpdateSource): void;
  /** Replaces the selection and tells the current mode about it */
  setSelection(type: SelectionType | null, ids: string[], source?: UpdateSource): void;

  // === Event API ===
  /**
   * Emits an event of the draw instance to every subscriber, the host included (for a plugin
   * that performs an operation core would announce)
   */
  emit<K extends keyof EventMap>(event: K, data: EventMap[K]): void;
  /**
   * Subscribes to an event of the draw instance ({@link EventMap} names them)
   *
   * @returns the function that unsubscribes the handler (the same as calling `off`)
   */
  on<K extends keyof EventMap>(event: K, handler: (data: EventMap[K]) => void): () => void;
  /** Unsubscribes a handler */
  off<K extends keyof EventMap>(event: K, handler: (data: EventMap[K]) => void): void;

  // === Batch mutations ===
  /**
   * Group several mutations into a single transaction
   */
  batch<T>(fn: () => T): T;

  // === Mode control ===
  /**
   * Changes the mode
   *
   * @returns whether the mode is `mode` after the call; false when it was refused (a name
   *   with no registered mode, a mode other than select while the interaction lock is on, or
   *   a mode that writes features while no layer can be written), and nothing changed
   */
  setMode(mode: Mode): boolean;

  // === Notification of external state change (for ModeHandler) ===
  /**
   * Tells the current mode that the document changed under it (a change applied from outside),
   * so that it can drop state that no longer holds
   */
  notifyStateReset(): void;

  // === Vertices while drawing (for drawing modes) ===
  /**
   * Undo the last vertex placed while drawing
   * @returns true when it succeeded
   */
  undoVertex(): boolean;
  /**
   * Restore the undone vertex
   * @returns true when it succeeded
   */
  redoVertex(): boolean;

  // === Derived state ===
  /**
   * Tell core that the extent of every feature of this type changed for a reason the
   * Store does not see
   *
   * The spatial index follows the Store by itself: every create, update and delete, from
   * whatever path, re-derives the entry of that feature. A custom feature type whose
   * bounding box calculator (registerFeatureHandler) depends on something outside the
   * Store, such as a font that arrives after the feature was drawn, calls this when that
   * thing changes. The features of the type are then re-measured with the same calculator.
   *
   * @param type the feature type
   */
  invalidateFeatures(type: string): void;

  // === Terrain anchors of this draw instance ===
  // They read the terrain of the draw instance the plugin is installed on, never that of another
  // instance on the page (a print preview, a thumbnail), so a plugin may call them outside
  // rendering (a debounced placement pass, say). Inside a draw call the same state is
  // `CustomRendererDrawContext.terrain`.
  /**
   * Maps an anchor (longitude / latitude on the ground) to screen coordinates with the same
   * elevation and matrix as the vertex shader
   *
   * @returns null when the terrain is disabled or no frame has been drawn yet (fall back to
   *   `map.project`)
   */
  projectAnchor(lng: number, lat: number): ScreenPoint | null;
  /**
   * The ground elevation of an anchor in meters (0 when the terrain is disabled)
   *
   * Inside the rendered terrain tiles it is the same value as `map.queryTerrainElevation`, so
   * a symbol placed with it sits on the ground the map draws.
   */
  anchorElevationMeters(lng: number, lat: number): number;
  /**
   * The generation of the anchor elevations (it advances when the DEM coverage changes; a
   * plugin that baked elevations rebuilds when it moves)
   */
  getAnchorElevationGeneration(): number;

  // === Selection extents of this draw instance ===
  /**
   * The selection bounding box of a feature, including the custom feature types registered in
   * this draw instance (null when it cannot be computed)
   */
  computeBoundingBox(feature: Feature): BoundingBoxCoords | null;
}

/**
 * What the `drag:start` hook receives
 */
export interface DragStartData {
  /** The IDs of the features being dragged */
  featureIds: string[];
}

/**
 * What the `drag:end` hook receives
 */
export interface DragEndData {
  /** The IDs of the features that were dragged */
  featureIds: string[];
}

/**
 * The hooks a plugin gives in {@link Plugin.hooks}, to react to changes after they happen
 *
 * The mutation hooks (feature / group / layer / selection) are fired from the change
 * notification of the Store, after the change, for every write whatever made it (the public
 * API, a drawing mode, a drag, the Delete key, import, a plugin, a change applied from outside
 * to a replaced Store). The hooks of one notification (one transaction) share the source and the
 * batchId of their MutationContext. The intermediate updates of an edit in progress are not
 * reported; the committing update that follows them is. A write the Store refuses (read-only)
 * fires nothing.
 *
 * The drag hooks are fired by the drag of the select mode, around a move, resize, rotation,
 * vertex or radius drag (not around the drag of an auxiliary handle).
 *
 * There are no before hooks: a hook cannot veto or rewrite a change.
 *
 * @example
 * ```ts
 * const hooks: Partial<Hooks> = {
 *   'feature:afterUpdate': (updated, original, ctx) => {
 *     if (ctx.source === 'remote') return;
 *     console.log(`${updated.length} features changed in batch ${ctx.batchId}`);
 *   },
 * };
 * ```
 */
export interface Hooks {
  // === Feature mutations ===
  /** Features were created */
  'feature:afterCreate'?: (features: Feature[], ctx: MutationContext) => void;
  /**
   * Features were updated (`original[i]` is `updated[i]` before the change)
   */
  'feature:afterUpdate'?: (updated: Feature[], original: Feature[], ctx: MutationContext) => void;
  /** Features were deleted (as they were when they were deleted) */
  'feature:afterDelete'?: (features: Feature[], ctx: MutationContext) => void;

  // === Group mutations ===
  /** A group was created (fired once per group) */
  'group:afterCreate'?: (group: Group, ctx: MutationContext) => void;
  /** A group was updated (a reorder with `reorderInGroup` does not fire it) */
  'group:afterUpdate'?: (updated: Group, original: Group, ctx: MutationContext) => void;
  /** A group was deleted, explicitly or because its last member left */
  'group:afterDelete'?: (group: Group, ctx: MutationContext) => void;

  // === Layer mutations ===
  /** A layer was created (fired once per layer) */
  'layer:afterCreate'?: (layer: Layer, ctx: MutationContext) => void;
  /** A layer was updated (a reorder with `reorderInLayer` does not fire it) */
  'layer:afterUpdate'?: (updated: Layer, original: Layer, ctx: MutationContext) => void;
  /** A layer was deleted */
  'layer:afterDelete'?: (layer: Layer, ctx: MutationContext) => void;

  // === Selection mutations ===
  /** The selection changed (the IDs now selected and those selected before) */
  'selection:afterChange'?: (newIds: string[], previousIds: string[], ctx: MutationContext) => void;

  // === Drag operations ===
  /** A drag of the select mode started */
  'drag:start'?: (data: DragStartData, ctx: MutationContext) => void;
  /** A drag of the select mode ended, committed or cancelled */
  'drag:end'?: (data: DragEndData, ctx: MutationContext) => void;
}

/**
 * Mouse move event (hover)
 */
export interface HoverEvent {
  /** Geographic coordinates */
  lngLat: { lng: number; lat: number };
}

/**
 * Mouse leave event
 *
 * Indicates that the mouse has left the map (no additional data).
 */
export type MouseLeaveEvent = Record<string, never>;

/**
 * A plugin: an object that extends a draw instance, registered with `draw.addPlugin`
 *
 * Only `name` is required. `onInstall` receives the {@link PluginContext}, through which the
 * plugin reads and changes the document and reaches the extension points of the instance
 * (`registerFeatureHandler`, `registerMode`, `addOverlayRenderer`). `hooks` reacts to changes
 * after they happen, `modes` adds custom modes, and `api` is what other code gets from
 * `draw.getPluginApi(name)`. The other members let a plugin take part in the input handling
 * of the select mode.
 *
 * `addPlugin` returns the function that unregisters the plugin: its modes are removed (the
 * select mode is entered first when one of them is the current mode) and `onUninstall` runs.
 * `destroy()` of the draw instance unregisters every plugin. A plugin whose name is already
 * registered is skipped with a warning.
 *
 * @example
 * ```ts
 * import type { Plugin, PluginContext } from '@sakuzu/maplibre-gl-draw';
 *
 * function createCounterPlugin(): Plugin {
 *   let count = 0;
 *   return {
 *     name: 'counter',
 *     hooks: {
 *       'feature:afterCreate': (features) => {
 *         count += features.length;
 *       },
 *     },
 *     api: { getCount: () => count },
 *     onInstall(ctx: PluginContext) {
 *       count = ctx.getAllFeatures().length;
 *     },
 *   };
 * }
 *
 * const remove = draw.addPlugin(createCounterPlugin());
 * draw.getPluginApi<{ getCount(): number }>('counter')?.getCount();
 * remove();
 * ```
 */
export interface Plugin {
  /** The name of the plugin, unique within the draw instance */
  readonly name: string;

  /**
   * Called when the plugin is registered, with the context it works through
   */
  onInstall?(context: PluginContext): void;

  /**
   * Called when the plugin is unregistered, or when the draw instance is destroyed; release
   * what `onInstall` acquired here
   */
  onUninstall?(): void;

  /**
   * The hooks that react to changes after they happen
   */
  hooks?: Partial<Hooks>;

  /**
   * Definitions of custom modes (registered with the plugin and removed when it is
   * unregistered)
   */
  modes?: Record<string, ModeFactory>;

  /**
   * What the plugin offers to other code, returned by `draw.getPluginApi(name)`
   */
  api?: Record<string, unknown>;

  /**
   * Global keyboard handler
   *
   * Called before the mode handler.
   * Returning true "consumes" the event and it is not passed to the mode handler.
   * Returning false passes the event on to the mode handler.
   *
   * @param event Normalized keyboard event
   * @returns true when the event was consumed
   */
  onKeyDown?(event: KeyNormalizedEvent): boolean;

  /**
   * Global mouse move handler
   *
   * Called when the mouse moves over the map (not called while dragging; moves
   * during a drag are received by onDragMove). It is also passed to the mode
   * handler, so there is no notion of consuming the event.
   *
   * @param event Normalized mouse move event
   */
  onMouseMove?(event: MouseNormalizedEvent): void;

  /**
   * Global drag move handler
   *
   * Called when the pointer moves during a drag (the counterpart of
   * onMouseMove; while dragging, dragmove flows instead of mousemove, so a
   * plugin that wants to see both implements both). It is also passed to the
   * mode handler, so there is no notion of consuming the event.
   *
   * @param event Normalized drag event
   */
  onDragMove?(event: DragNormalizedEvent): void;

  /**
   * Global mouse leave handler
   *
   * Called when the mouse leaves the map.
   */
  onMouseLeave?(): void;

  /**
   * Filtering of selection candidates
   *
   * Called when features are selected, to decide the final selection targets.
   * Receives an array of candidate IDs and returns the filtered array.
   *
   * @param candidateIds Array of candidate feature IDs
   * @returns Filtered array of feature IDs
   */
  filterSelection?(candidateIds: string[]): string[];

  // === Interaction hooks ===
  // Generic hooks through which a mode handler (SelectMode and so on) delegates
  // an operation to a plugin, so that a plugin can add an interaction core does
  // not have, such as typing into a feature on the map.

  /**
   * Called when an already selected feature is clicked
   *
   * Called in SelectMode when a feature that is already selected is clicked
   * again.
   * Returning true indicates that the plugin has handled the event.
   *
   * @param featureId ID of the clicked feature
   * @returns true when the plugin handled it
   */
  onFeatureClick?(featureId: string): boolean;

  /**
   * Called when a feature is double-clicked
   *
   * Called in SelectMode when a feature is double-clicked.
   * Returning true indicates that the plugin has handled the event.
   *
   * @param featureId ID of the double-clicked feature
   * @returns true when the plugin handled it
   */
  onFeatureDoubleClick?(featureId: string): boolean;

  /**
   * Whether the plugin is in the middle of an interaction
   *
   * Returns true when the plugin is performing an exclusive operation such as
   * text input or inline editing.
   * The mode handler looks at this state and skips keyboard shortcuts and mouse
   * operations.
   */
  isInteracting?(): boolean;

  /**
   * Complete the interaction
   *
   * Called when the plugin's operation should be completed normally, such as on
   * a mode switch or when a feature is deleted.
   */
  finishInteraction?(): void;

  /**
   * Cancel the interaction
   */
  cancelInteraction?(): void;

  /**
   * Get the DOM element used for the interaction
   *
   * Returns the DOM element that the plugin displays as an overlay on the map.
   * The mode handler skips clicks inside this element.
   */
  getInteractionContainer?(): HTMLElement | null;

  /**
   * Called after a feature is created
   *
   * Called right after a feature has been created in a drawing mode and the
   * transition to SelectMode has happened.
   * The plugin can automatically start an interaction (for example, editing
   * its name).
   *
   * @param featureId ID of the created feature
   * @param featureType Type of the feature
   */
  onFeatureCreated?(featureId: string, featureType: string): void;
}

/**
 * Re-export of the EventEmitter types
 */
export type { EventEmitter, EventMap };
