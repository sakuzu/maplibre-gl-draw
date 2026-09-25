// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * ModeHandler
 *
 * Handler interface for the drawing modes.
 * Every mode implements this interface.
 */

import type { Map as MapLibreMap } from 'maplibre-gl';

import type {
  DragNormalizedEvent,
  KeyNormalizedEvent,
  MouseNormalizedEvent,
} from '../dispatcher/types.js';
import type { Mode } from '../store/types.js';

/**
 * An input whose coordinates go through snapping, as asked about by
 * {@link ModeHandler.isSnapEnabledFor}.
 *
 * Corresponds one to one with the inputs whose coordinates InputRouter passes through snapping
 * (click / mousemove / dragstart / dragmove / dragend).
 */
export type SnapInputType = 'click' | 'mousemove' | 'dragstart' | 'dragmove' | 'dragend';

/**
 * The services of the draw instance a mode works with, passed to
 * {@link ModeHandler.onStart}.
 *
 * Note: the redraw is triggered automatically by RenderCoordinator subscribing to Store changes,
 *       so a mode does not need to call requestRepaint() explicitly.
 */
export interface ModeContext {
  /** The map the draw instance is attached to */
  map: MapLibreMap;
  /** The Store of the document; a mode writes features through it */
  store: import('../store/store.js').Store;
  /**
   * The queries of the spatial index (it is derived from the Store, so a mode only reads it)
   */
  spatialIndex: import('../store/spatial/spatial-index.js').SpatialQuery;
  /** The hit test of the features of the Store alone */
  hitTestService: import('../dispatcher/hit-test/service.js').HitTestService;
  /**
   * Returns the foreground hit in the visual stacking order (unified z traversal)
   *
   * Traverses the features of the Store and the datasets in a single
   * stacking order. Selection, drag and cursor decisions use this one (`hitTestService.hitTest`
   * looks only at the Store, so it would grab a feature that is occluded by a dataset).
   */
  hitTestTopmost: import('../dispatcher/hit-test/topmost.js').HitTestTopmost;
  /**
   * Provider of the companion rendering and the companion hits (the ones of this draw instance)
   *
   * Used to return a consumed companion hit to the provider.
   */
  featureCompanions: import('../view/feature-companion.js').FeatureCompanionRegistry;
  /**
   * The selection scope of this draw instance (the extension points of the custom feature
   * types, the auxiliary handles and the thinned handle sets)
   *
   * The same object the CustomLayer draws the selection UI with, so hit testing and rendering
   * agree, and a second draw instance on the page never takes part.
   */
  selectionScope: import('../view/ui/selection-scope.js').SelectionScope;
  /** The emitter of the `draw.*` events of the draw instance */
  eventEmitter: import('../shared/utils/event-emitter.js').EventEmitter;
  /** The resolved colors and sizes of the selection UI */
  selectionStyle: import('../shared/config/selection.js').SelectionUIConfig;
  /**
   * Topology configuration (simultaneous movement of shared vertices, and so on)
   *
   * When omitted, it is treated as the default value (everything disabled).
   */
  topology?: import('../shared/config/topology.js').TopologyConfig;
  /**
   * Trace configuration (whether edge tracing is enabled or disabled)
   *
   * When omitted, it is treated as the default value (enabled). It is the same object that
   * draw.tracing rewrites, so a switch at runtime takes effect on the very next input.
   */
  trace?: import('../shared/config/trace.js').TraceConfig;
  /**
   * The resolved snapping options
   *
   * Read so that the simultaneous movement of shared vertices shares the "modifier key for
   * temporary disabling" with snapping. When snapping is not configured, it is omitted and
   * the default 'alt' is assumed.
   */
  snapOptions?: import('../snapping/types.js').ResolvedSnapOptions;
  /** Generates the default name of a new feature (such as "Polygon 3") */
  autoNameGenerator: import('../shared/utils/name-generator.js').AutoNameGenerator;
  /** The box selection strategies by feature type */
  boxSelectionRegistry: import('../dispatcher/hit-test/box-strategy.js').BoxSelectionStrategyRegistry;
  /** The plugin manager of the draw instance (omitted when none is set up) */
  pluginManager?: import('../plugins/plugin-manager.js').PluginManager;
  /** Requests a mode change, as `draw.setMode` does (the same refusals apply) */
  setMode: (mode: Mode) => void;
  /** Generates a new unique feature id */
  generateFeatureId: () => string;
  /**
   * Gets the ID of the writable layer, the layer that new features are written into
   *
   * The active layer when it exists, is not locked, is visible and is not locally hidden,
   * otherwise the first such layer, otherwise an empty string. A mode reads it when it
   * commits a feature; when it is an empty string the mode must not create the feature: it
   * discards the drawing (clears the tentative state) and returns to select.
   */
  getCurrentLayerId: () => string;
  /**
   * Whether the line widths of the features a drawing mode creates follow the zoom (the
   * `scaleWithZoom` option of the instance)
   *
   * When it is true, a mode writes the zoom of the commit into `properties.createdZoom`, and
   * the widths of the feature grow and shrink with the map from there. When it is false, it
   * writes no created zoom and the widths stay the same on the screen.
   */
  scaleWithZoom: boolean;
  /**
   * Gets the most recent snapping result (always null when snapping is not configured)
   *
   * This is the only read port through which a mode learns about snapping. InputRouter passes
   * the coordinates of click / mousemove through snapping before delivering them to the mode,
   * so at the time of onClick / onMouseMove the result readable here is the snapping result
   * corresponding to the event that was just delivered (tracing reads it).
   */
  getSnapResult?: () => import('../snapping/types.js').SnapResult | null;
  /**
   * Gets a feature of a dataset (omitted when it is not configured)
   *
   * This is the port through which a mode resolves to a feature a snap target that was snapped
   * to data (a dataset). It is a feature that is not in the Store, so it cannot
   * be looked up with store.getFeature (tracing reads it).
   */
  getDatasetFeature?: (
    datasetId: string,
    featureId: string,
  ) => import('../store/types.js').Feature | null;
  /**
   * Looks up, by extent, the features of the datasets usable for tracing
   *
   * This is the port for adding the features of data (a dataset) to the material
   * of the edge graph. It returns an empty array when snapping to data is disabled.
   */
  getDatasetTraceFeatures?: (
    bbox: import('../store/types.js').BoundingBox,
  ) => import('../store/types.js').Feature[];
}

/**
 * The implementation of an interaction mode: it receives the normalized input while it is the
 * current mode.
 *
 * Register a custom mode with `draw.registerMode(name, factory)` or `Plugin.modes`, and enter
 * it with `draw.setMode(name)`. The context is passed in `onStart()` and the implementation
 * keeps it in a field; it is not passed to the event handlers. Every handler is optional. The
 * coordinates of the pointer events have already gone through snapping (see
 * `isSnapEnabledFor`).
 *
 * @example
 * ```ts
 * import type { ModeContext, ModeHandler, MouseNormalizedEvent } from '@sakuzu/maplibre-gl-draw';
 *
 * // A mode that logs the clicked position and returns to select on Escape
 * class ProbeMode implements ModeHandler {
 *   readonly modeName = 'probe';
 *   private context: ModeContext | null = null;
 *
 *   onStart(context: ModeContext): void {
 *     this.context = context;
 *   }
 *   onClick(event: MouseNormalizedEvent): void {
 *     console.log(event.lngLat.lng, event.lngLat.lat);
 *   }
 *   onKeyDown(event: { key: string }): void {
 *     if (event.key === 'Escape') this.context?.setMode('select');
 *   }
 * }
 *
 * draw.registerMode('probe', () => new ProbeMode());
 * draw.setMode('probe');
 * ```
 */
export interface ModeHandler {
  /** The name the mode is registered under */
  readonly modeName: Mode;

  /**
   * Whether the mode writes new features into a layer
   *
   * A mode that declares true is entered only while a layer can be written (while
   * `ModeContext.getCurrentLayerId` returns a non-empty string); otherwise setMode is ignored
   * and the current mode is kept. The built-in drawing modes declare it, and a plugin mode
   * that creates features declares it to get the same gate. The declaration does not remove
   * the check at commit time: the layer can stop being writable while the mode is active.
   */
  readonly writesFeatures?: boolean;

  /** Called when the mode becomes the current mode; keep the context for later */
  onStart?(context: ModeContext): void;

  /** Called when another mode replaces it or the draw instance is destroyed */
  onStop?(): void;

  /** Called on a click */
  onClick?(event: MouseNormalizedEvent): void;

  /** Called on a double click */
  onDoubleClick?(event: MouseNormalizedEvent): void;

  /** Called on a mouse move */
  onMouseMove?(event: MouseNormalizedEvent): void;

  /**
   * Called on a mouse down
   * @returns returning true consumes the event (stops the propagation to MapLibre)
   */
  onMouseDown?(event: MouseNormalizedEvent): boolean | undefined;

  /** Called on a mouse up */
  onMouseUp?(event: MouseNormalizedEvent): void;

  /** Called when a drag starts */
  onDragStart?(event: DragNormalizedEvent): void;

  /** Called during a drag */
  onDragMove?(event: DragNormalizedEvent): void;

  /** Called when a drag ends */
  onDragEnd?(event: DragNormalizedEvent): void;

  /**
   * Called when a press ends without a release (a second finger touched the screen, or the
   * browser cancelled the touch)
   *
   * Nothing is decided: the mode abandons the press, restores what the press changed and
   * gives the pan back to MapLibre. It can arrive before onDragStart (a press that has not
   * become a drag yet). The coordinates are the last known position.
   */
  onDragCancel?(event: DragNormalizedEvent): void;

  /** Called on a key down (normalized) */
  onKeyDown?(event: KeyNormalizedEvent): void;

  /** Called on a key up (normalized) */
  onKeyUp?(event: KeyNormalizedEvent): void;

  /**
   * Called after an external state change
   *
   * Used to reset the internal state of the mode after an external state change
   * (a change applied from outside the mode) has been carried out.
   * Example: when the state is changed externally while drawing in the Circle mode,
   * the drawing state is reset.
   */
  onExternalStateChange?(): void;

  /**
   * Called after a selection change
   *
   * Used to update the internal state of the mode when the selection is changed from a plugin.
   */
  onSelectionChange?(): void;

  /**
   * Undoes a vertex while drawing
   *
   * Called when Cmd+Z/Ctrl+Z is pressed while drawing a LineString/Polygon.
   * @returns whether the undo was carried out
   */
  undoVertex?(): boolean;

  /**
   * Redoes a vertex that was undone
   *
   * Called when Cmd+Shift+Z/Ctrl+Y is pressed while drawing.
   * @returns whether the redo was carried out
   */
  redoVertex?(): boolean;

  /**
   * Returns the feature to prefer when snapping candidates are tied
   *
   * Read by InputRouter right before it passes the coordinates through snapping, and passed as
   * the preferFeature of SnapContext. A drawing mode returns the anchor of the trace (the
   * boundary it started tracing along), which prevents the snap target from jumping to another
   * feature whose coordinates overlap exactly.
   *
   * @returns the feature to prefer, or null if there is none
   */
  getSnapPreference?(): { featureId: string; datasetId?: string } | null;

  /**
   * Returns, per input type, whether snapping is to be applied
   *
   * Read by InputRouter right before it passes the coordinates through snapping. An input type
   * for which false is returned does not go through SnapService and reaches the mode with its
   * raw coordinates. When this is omitted (and when true is returned), snapping is applied as
   * before.
   *
   * The tolerance (10 pixels by default) is a value premised on "once per click", so in a
   * drag-driven drawing that passes several hundred points in a single stroke (freehand), the
   * intermediate sample points are pulled one after another to nearby vertices and a line drawn
   * straight ends up bent. A port that can be switched off per input type is provided so that
   * only the inside of the stroke can be let through untouched (the start point and the end
   * point can remain snapped).
   *
   * @param inputType the type of the input for which snapping is about to be applied
   * @returns true if snapping is to be applied
   */
  isSnapEnabledFor?(inputType: SnapInputType): boolean;
}

/**
 * Creates a new {@link ModeHandler}; called every time the mode is entered.
 */
export type ModeFactory = () => ModeHandler;
