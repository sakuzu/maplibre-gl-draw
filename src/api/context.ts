// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Context
 *
 * The dependency container of MapLibreGLDraw
 */

import type { Map as MapLibreMap } from 'maplibre-gl';
import { createCoreBoxSelectionStrategies } from '../dispatcher/hit-test/box-strategies.js';
import { BoxSelectionStrategyRegistry } from '../dispatcher/hit-test/box-strategy.js';
import { createGlobeShapeResolver } from '../dispatcher/hit-test/globe-shape.js';
import type { HitTestService } from '../dispatcher/hit-test/service.js';
import { HitTestServiceImpl } from '../dispatcher/hit-test/service.js';
import { DEFAULT_HIT_TEST_OPTIONS } from '../dispatcher/hit-test/strategies/base.js';
import { type Messages, resolveMessages } from '../messages.js';
import type { ModeManager } from '../modes/manager.js';
import { ModeManagerImpl } from '../modes/manager.js';
import type { FeatureStyleConfig } from '../shared/config/feature-style.js';
import {
  DEFAULT_FEATURE_STYLE_CONFIG,
  mergeFeatureStyleConfig,
} from '../shared/config/feature-style.js';
import type { RenderingConfig } from '../shared/config/rendering.js';
import { DEFAULT_RENDERING_CONFIG, mergeRenderingConfig } from '../shared/config/rendering.js';
import type { SelectionUIConfig } from '../shared/config/selection.js';
import { DEFAULT_SELECTION_CONFIG, mergeSelectionUIConfig } from '../shared/config/selection.js';
import type { TopologyConfig } from '../shared/config/topology.js';
import { DEFAULT_TOPOLOGY_CONFIG, mergeTopologyConfig } from '../shared/config/topology.js';
import type { TraceConfig, TraceOptions } from '../shared/config/trace.js';
import { DEFAULT_TRACE_CONFIG, mergeTraceConfig } from '../shared/config/trace.js';
import { getAnchorProjector } from '../shared/math/index.js';
import type { EventEmitter } from '../shared/utils/event-emitter.js';
import { EventEmitterImpl } from '../shared/utils/event-emitter.js';
import { createId } from '../shared/utils/id.js';
import type { AutoNameConfig } from '../shared/utils/name-generator.js';
import { AutoNameGenerator } from '../shared/utils/name-generator.js';
import type { PixelRatioSource } from '../shared/utils/pixel-ratio.js';
import { createPixelRatioSource } from '../shared/utils/pixel-ratio.js';
import { createSnapTargetsRegistry, type SnapTargetsRegistry } from '../snapping/custom-targets.js';
import { createSnapService } from '../snapping/service.js';
import type { ResolvedSnapOptions, SnapOptions, SnapService } from '../snapping/types.js';
import {
  DEFAULT_SNAP_OPTIONS,
  resolveGuideStepDegrees,
  resolveSnapKinds,
} from '../snapping/types.js';
import { toStore } from '../store/draw-store.js';
import { MemoryStore } from '../store/memory.js';
import { StoreSpatialIndex } from '../store/spatial/store-spatial-index.js';
import type { DocumentStore, Store } from '../store/store.js';
import type { Layer, Mode } from '../store/types.js';
import { resolveWritableLayerId } from '../store/writable-layer.js';
import { createSelectionScope, type SelectionScope } from '../view/ui/selection-scope.js';

/**
 * The options of {@link createMapLibreGLDraw}. Every option can be omitted.
 *
 * @example
 * ```typescript
 * const draw = createMapLibreGLDraw(map, {
 *   defaultMode: 'select',
 *   clickTolerance: 8,
 *   snap: { tolerancePx: 12, kinds: { guide: false } },
 *   trace: { enabled: false },
 *   topology: { sharedVertexDrag: true },
 *   autoName: false,
 * });
 * ```
 */
export interface Options {
  /** The mode the instance starts in (default `'select'`) */
  defaultMode?: Mode;
  /**
   * How far from a feature a click still hits it, in CSS pixels (default 6)
   */
  clickTolerance?: number;
  /**
   * How far the mouse moves with the button down before a press becomes a drag, in CSS
   * pixels (default 3)
   */
  dragThreshold?: number;
  /**
   * The default drawing style of the features, per geometry (points, lines, polygons and so
   * on); the given parts replace the built-in defaults, and a feature's own `style` wins over
   * both
   */
  style?: Partial<FeatureStyleConfig>;
  /**
   * The look of the selection UI: the bounding box, the resize, rotate, vertex and midpoint
   * handles, and the radius handle, center marker and radius line of a circle (see
   * {@link SelectionUIConfig} for the defaults)
   */
  selectionStyle?: Partial<SelectionUIConfig>;
  /**
   * The look of the box selection rectangle and the switches of the rendering paths (see
   * {@link RenderingConfig} for the defaults)
   */
  renderingStyle?: Partial<RenderingConfig>;
  /**
   * The automatic names of new features, layers and groups, such as `Polygon 1` and
   * `Layer 2` (default: enabled)
   *
   * `false` turns it off, and an {@link AutoNameConfig} changes the words or the format. A
   * number used once is not reused. The words are English by default; a host that shows
   * another language translates them here (`typeNames`), not through {@link Options.messages}.
   */
  autoName?: AutoNameConfig | boolean;

  /**
   * Whether the line widths of the features drawn in a drawing mode follow the zoom (default
   * true)
   *
   * By default a drawing mode records the zoom a feature is drawn at in `properties`, under
   * `maplibre-gl-draw:createdZoom`, and the widths of its lines and outlines are those of that
   * zoom: they double with each zoom level in and halve with each level out, like lines drawn
   * on paper. An application that wants the widths to stay the same on the screen at every
   * zoom sets `false`; a drawn feature then gets no created zoom, like a feature added through
   * the API. It does not change features already drawn: the widths follow
   * `maplibre-gl-draw:createdZoom` wherever it is set, so a feature added through the API can
   * set it too. An Image always scales with the map.
   */
  scaleWithZoom?: boolean;

  /**
   * The snapping configuration
   *
   * When omitted, it is enabled with a tolerance of 10 CSS pixels, it is released while Alt
   * is held, every kind of target (vertex, edge, intersection, guide) is on, and the
   * datasets are targets. The candidates come from the vertices and edges of
   * the Store; more are added with `draw.snapping.register()`. Change it at runtime with
   * {@link MapLibreGLDraw.snapping}.
   */
  snap?: SnapOptions;

  /**
   * The topology configuration (when omitted, everything is disabled)
   *
   * The settings that keep editing from breaking boundaries shared by adjacent features.
   * With `sharedVertexDrag: true`, dragging a vertex in select mode also moves, by the same
   * amount, every vertex of other visible, unlocked features at exactly the same coordinates,
   * and the drag commits as one change. The modifier of `snap.disableKey` held at the start of
   * a drag releases it for that drag. Change it at runtime with
   * {@link MapLibreGLDraw.topology}.
   */
  topology?: Partial<TopologyConfig>;

  /**
   * The trace configuration (when omitted, it is enabled)
   *
   * While drawing (draw_line / draw_polygon), when the previous click and this click both
   * snapped to the boundary of the same feature, the vertex sequence between them is taken in
   * automatically. With `enabled: false` a click adds only the point clicked. Change it at
   * runtime with {@link MapLibreGLDraw.tracing}.
   */
  trace?: TraceOptions;

  /**
   * The document store (when omitted, a new {@link MemoryStore} is used)
   *
   * Give a {@link DocumentStore} of your own to keep the document elsewhere; the library
   * keeps the local state (selection, mode, read-only and so on) around
   * it. A {@link Store} such as a MemoryStore is used as it is.
   */
  store?: DocumentStore | Store;

  /**
   * Whether to create a default layer on initialization (default: true)
   *
   * When it is false, creating the layers becomes the responsibility of the application.
   * Use it when restoring the layer structure from an external data source, or
   * when managing the layers on your own. Until a layer exists, the drawing modes cannot be
   * entered.
   */
  initDefaultLayer?: boolean;

  /**
   * The predicate that identifies the "external entries" of the stacking order (when omitted,
   * it is always false)
   *
   * The entries of the layer order for which it returns true are separators, and this library
   * does not draw them. Each interval between separators is drawn by its own MapLibre custom
   * layer (a frame), so the host can place its native layers (vector tiles, raster) between
   * the frames. {@link MapLibreGLDraw.getRenderSlots} lists the frames, and the
   * `draw.renderslots.change` event announces their changes.
   *
   * @example
   * ```typescript
   * const draw = createMapLibreGLDraw(map, {
   *   isExternalEntry: (id) => id.startsWith('native:'),
   * });
   * draw.on('draw.renderslots.change', ({ slots }) => placeNativeLayers(slots));
   * ```
   */
  isExternalEntry?: (entryId: string) => boolean;

  /**
   * The render scale (when omitted, the map's `getPixelRatio()` is read each time)
   *
   * Line widths, point sizes and outlines are drawn by converting CSS pixels into physical
   * pixels, so the scale of the backing store being drawn into is needed. By default it is
   * the ratio of the map, which follows the `pixelRatio` the maplibre Map was created with
   * and the device. Pass a value only to draw at another scale than the map's.
   */
  pixelRatio?: number;

  /**
   * The strings the library returns as values (when omitted, {@link MESSAGES_EN})
   *
   * The given entries replace the English defaults for this instance only; the entries
   * left out keep the default. Legend labels and the descriptions of the snapping guides
   * come from this table. The library ships English only and does no locale detection.
   * The words of generated names ("Layer 1") are not here: they come from
   * {@link Options.autoName}.
   *
   * @example
   * ```typescript
   * const draw = createMapLibreGLDraw(map, {
   *   messages: {
   *     legendOther: 'Autres',
   *     legendBelow: (upper) => `Moins de ${upper}`,
   *   },
   * });
   * ```
   */
  messages?: Partial<Messages>;
}

/**
 * The default options
 *
 * @internal
 */
export const DEFAULT_OPTIONS = {
  defaultMode: 'select' as Mode,
  // One default for the hit test and the topmost hit (see DEFAULT_HIT_TEST_OPTIONS)
  clickTolerance: DEFAULT_HIT_TEST_OPTIONS.clickTolerance,
  dragThreshold: 3,
  scaleWithZoom: true,
};

/**
 * Context
 *
 * The container that holds the internal components of MapLibreGLDraw
 *
 * @internal
 */
export interface Context {
  map: MapLibreMap;
  store: Store;
  /** The spatial index, derived from the Store (it follows every Store change by itself) */
  spatialIndex: StoreSpatialIndex;
  hitTestService: HitTestService;
  eventEmitter: EventEmitter;
  modeManager: ModeManager;
  featureStyle: FeatureStyleConfig;
  selectionStyle: SelectionUIConfig;
  renderingConfig: RenderingConfig;
  /**
   * The topology configuration (it is rewritten at runtime; the actual object draw.topology
   * operates on)
   */
  topology: TopologyConfig;
  /**
   * The trace configuration (it is rewritten at runtime; the actual object draw.tracing
   * operates on)
   */
  trace: TraceConfig;
  options: Required<
    Omit<
      Options,
      | 'style'
      | 'selectionStyle'
      | 'renderingStyle'
      | 'autoName'
      | 'store'
      | 'initDefaultLayer'
      | 'topology'
      | 'snap'
      | 'trace'
      | 'pixelRatio'
      | 'isExternalEntry'
      | 'messages'
    >
  >;
  /**
   * The messages table of this instance (Options.messages over `MESSAGES_EN`). Every string
   * the library returns as a value is read from here
   */
  messages: Messages;
  /**
   * The injected render scale (undefined when nothing was injected)
   *
   * References must always go through `pixelRatioSource`. When it is undefined, the map's
   * `getPixelRatio()` is read on every call.
   */
  pixelRatio?: number;
  /** The predicate that identifies the "external entries" of the stacking order
   * (Options.isExternalEntry) */
  isExternalEntry?: (entryId: string) => boolean;
  /**
   * The source of the render scale (it includes the render scale that can be changed at
   * runtime)
   *
   * `pixelRatioSource.resolve` is distributed to each renderer and retained batch as a
   * `PixelRatioInput`. A change made by `draw.setRenderScale()` propagates through here to
   * every place that reads it directly.
   */
  pixelRatioSource: PixelRatioSource;
  /** The snapping options with the defaults filled in */
  snapOptions: ResolvedSnapOptions;
  /** The snapping service (the InputRouter uses it to replace the coordinates) */
  snapService: SnapService;
  /** The automatic name generation utility */
  autoNameGenerator: AutoNameGenerator;
  /** The box selection strategy registry */
  boxSelectionRegistry: BoxSelectionStrategyRegistry;
  /**
   * The selection scope of this instance (the selection UI extension points of the custom
   * feature types, the auxiliary handles and the thinned handle sets). Shared by the
   * CustomLayer, the modes and the extension API, and never by another instance
   */
  selectionScope: SelectionScope;
  /** The snapping candidates of the custom feature types of this instance */
  snapTargets: SnapTargetsRegistry;
  generateFeatureId: () => string;
  getCurrentLayerId: () => string;
  setActiveLayerId: (id: string) => void;
  getActiveLayerId: () => string;
  /**
   * The layer that user drawing writes new features into (see `resolveWritableLayerId` in
   * store/writable-layer)
   *
   * An empty string when no layer can be written. The modes receive it as
   * `ModeContext.getCurrentLayerId`, and the ModeManager refuses to enter a mode that declares
   * `writesFeatures` while it is empty.
   */
  getWritableLayerId: () => string;
}

/**
 * Creates a Context
 *
 * @internal
 */
export function createContext(map: MapLibreMap, options: Options = {}): Context {
  const opts = {
    ...DEFAULT_OPTIONS,
    ...options,
    defaultMode: options.defaultMode ?? DEFAULT_OPTIONS.defaultMode,
    clickTolerance: options.clickTolerance ?? DEFAULT_OPTIONS.clickTolerance,
    dragThreshold: options.dragThreshold ?? DEFAULT_OPTIONS.dragThreshold,
    scaleWithZoom: options.scaleWithZoom ?? DEFAULT_OPTIONS.scaleWithZoom,
  };

  // Merge the style configuration
  const featureStyle = options.style
    ? mergeFeatureStyleConfig(DEFAULT_FEATURE_STYLE_CONFIG, options.style)
    : DEFAULT_FEATURE_STYLE_CONFIG;

  // Merge the selection UI style configuration
  const selectionStyle = options.selectionStyle
    ? mergeSelectionUIConfig(DEFAULT_SELECTION_CONFIG, options.selectionStyle)
    : DEFAULT_SELECTION_CONFIG;

  // Merge the rendering configuration
  const renderingConfig = options.renderingStyle
    ? mergeRenderingConfig(DEFAULT_RENDERING_CONFIG, options.renderingStyle)
    : DEFAULT_RENDERING_CONFIG;

  // Merge the topology configuration (everything is disabled by default). It is the actual
  // object draw.topology rewrites, so always copy it so that the default object is not shared
  const topology: TopologyConfig = mergeTopologyConfig(
    DEFAULT_TOPOLOGY_CONFIG,
    options.topology ?? {},
  );

  // Merge the trace configuration (it is enabled by default). It is the actual object
  // draw.tracing rewrites, so always copy it so that the default object is not shared
  const trace: TraceConfig = mergeTraceConfig(DEFAULT_TRACE_CONFIG, options.trace ?? {});

  // The internal components
  const store: Store = options.store ? toStore(options.store) : new MemoryStore();
  // Derived from the Store: it subscribes before any other component, so a listener that
  // queries it during a notification already sees the change
  const spatialIndex = new StoreSpatialIndex(store);
  // Hit testing for symbols (points) is done in screen space while terrain is enabled.
  // What is injected is the anchor projection of this map, identical to the one the rendering
  // uses. When terrain is disabled, project returns null and the conventional longitude and
  // latitude path keeps working as before.
  const hitTestService: HitTestService = new HitTestServiceImpl(store, spatialIndex, {
    clickTolerance: opts.clickTolerance,
    anchorScreen: {
      project: (coord) => getAnchorProjector(map)?.project(coord[0], coord[1]) ?? null,
    },
    // On the globe the edges are tested along the path they are drawn along
    drawnShape: createGlobeShapeResolver(map),
  });

  // Create the BoxSelectionStrategyRegistry and register the core strategies
  const boxSelectionRegistry = new BoxSelectionStrategyRegistry();
  for (const strategy of createCoreBoxSelectionStrategies()) {
    boxSelectionRegistry.register(strategy);
  }

  const eventEmitter: EventEmitter = new EventEmitterImpl();
  // A mode that writes features is entered only while a layer can be written.
  // getWritableLayerId is defined below; the closure reads it only when a mode is set
  const modeManager: ModeManager = new ModeManagerImpl(store, {
    canEnter: (handler) => !handler.writesFeatures || getWritableLayerId() !== '',
  });

  // Create the snapping service (enabled by default, tolerance 10px, temporarily disabled
  // with Alt). The candidates come only from the built-in providers (the vertices and edges of
  // the Store); external providers are added with draw.snapping.register().
  const snapOptions: ResolvedSnapOptions = {
    ...DEFAULT_SNAP_OPTIONS,
    ...options.snap,
    // kinds is nested, so copy it (so that the default object is not shared)
    kinds: resolveSnapKinds(options.snap?.kinds),
    guideStepDegrees: resolveGuideStepDegrees(options.snap?.guideStepDegrees),
  };
  // The registries of the extension points belong to this instance (nothing is module-level)
  const selectionScope = createSelectionScope();
  const snapTargets = createSnapTargetsRegistry();
  // The messages table belongs to this instance as well
  const messages = resolveMessages(options.messages);

  const snapService: SnapService = createSnapService({
    store,
    spatialIndex,
    snapTargets,
    eventEmitter,
    options: snapOptions,
    guide: { messages },
  });

  // Create the AutoNameGenerator
  const autoNameGenerator = new AutoNameGenerator(store, options.autoName);

  // Create the default layer (only when initDefaultLayer !== false)
  let activeLayerId: string;
  if (options.initDefaultLayer !== false) {
    const defaultLayerName = autoNameGenerator.generateLayerName();
    const defaultLayer: Layer = {
      id: 'default-layer',
      name: defaultLayerName,
      visible: true,
      locked: false,
      opacity: 1.0,
      order: [],
    };
    store.createLayer(defaultLayer);
    activeLayerId = 'default-layer';
  } else {
    // Creating the layers is the responsibility of the application
    // The initial value is an empty string (it is set later)
    activeLayerId = '';
  }

  // Feature ID generation (a ULID is used to guarantee uniqueness)
  const generateFeatureId = () => createId();

  const setActiveLayerId = (id: string): void => {
    if (store.getLayer(id)) {
      activeLayerId = id;
    }
  };

  const getActiveLayerId = (): string => {
    // If the active layer was deleted, make the first layer active
    if (!store.getLayer(activeLayerId)) {
      const layers = store.getAllLayers();
      if (layers.length > 0) {
        activeLayerId = layers[0].id;
      }
    }
    return activeLayerId;
  };

  const getWritableLayerId = (): string => resolveWritableLayerId(store, getActiveLayerId());

  return {
    map,
    store,
    spatialIndex,
    hitTestService,
    eventEmitter,
    modeManager,
    featureStyle,
    selectionStyle,
    renderingConfig,
    topology,
    trace,
    options: opts,
    messages,
    pixelRatio: options.pixelRatio,
    isExternalEntry: options.isExternalEntry,
    // The ratio of the map is the default: it follows a pixelRatio the map was created with
    pixelRatioSource: createPixelRatioSource(options.pixelRatio, () => map.getPixelRatio()),
    snapOptions,
    snapService,
    autoNameGenerator,
    boxSelectionRegistry,
    selectionScope,
    snapTargets,
    generateFeatureId,
    getCurrentLayerId: getActiveLayerId,
    setActiveLayerId,
    getActiveLayerId,
    getWritableLayerId,
  };
}
