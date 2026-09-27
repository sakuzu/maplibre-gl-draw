// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The context of the engine: the options it was built with, resolved, and the components
 * every part of the engine shares
 */

import type { Map as MapLibreMap } from 'maplibre-gl';
import { createCoreBoxSelectionStrategies } from '../../dispatcher/hit-test/box-strategies.js';
import { BoxSelectionStrategyRegistry } from '../../dispatcher/hit-test/box-strategy.js';
import { createGlobeShapeResolver } from '../../dispatcher/hit-test/globe-shape.js';
import type { HitTestService } from '../../dispatcher/hit-test/service.js';
import { HitTestServiceImpl } from '../../dispatcher/hit-test/service.js';
import { DEFAULT_HIT_TEST_OPTIONS } from '../../dispatcher/hit-test/strategies/base.js';
import { type Messages, resolveMessages } from '../../messages.js';
import type { ModeManager } from '../../modes/manager.js';
import { ModeManagerImpl } from '../../modes/manager.js';
import type { FeatureStyleConfig } from '../../shared/config/feature-style.js';
import {
  DEFAULT_FEATURE_STYLE_CONFIG,
  mergeFeatureStyleConfig,
} from '../../shared/config/feature-style.js';
import type { RenderingConfig } from '../../shared/config/rendering.js';
import { DEFAULT_RENDERING_CONFIG, mergeRenderingConfig } from '../../shared/config/rendering.js';
import type { SelectionUIConfig } from '../../shared/config/selection.js';
import { DEFAULT_SELECTION_CONFIG, mergeSelectionUIConfig } from '../../shared/config/selection.js';
import type { TopologyConfig } from '../../shared/config/topology.js';
import { DEFAULT_TOPOLOGY_CONFIG, mergeTopologyConfig } from '../../shared/config/topology.js';
import type { TraceConfig, TraceOptions } from '../../shared/config/trace.js';
import { DEFAULT_TRACE_CONFIG, mergeTraceConfig } from '../../shared/config/trace.js';
import { getAnchorProjector } from '../../shared/math/index.js';
import type { EventEmitter } from '../../shared/utils/event-emitter.js';
import { EventEmitterImpl } from '../../shared/utils/event-emitter.js';
import { createId } from '../../shared/utils/id.js';
import type { AutoNameConfig } from '../../shared/utils/name-generator.js';
import { AutoNameGenerator } from '../../shared/utils/name-generator.js';
import type { PixelRatioSource } from '../../shared/utils/pixel-ratio.js';
import { createPixelRatioSource } from '../../shared/utils/pixel-ratio.js';
import {
  createSnapTargetsRegistry,
  type SnapTargetsRegistry,
} from '../../snapping/custom-targets.js';
import { createSnapIndicatorLook, type SnapIndicatorLook } from '../../snapping/indicator.js';
import { createSnapService } from '../../snapping/service.js';
import type { ResolvedSnapOptions, SnapOptions, SnapService } from '../../snapping/types.js';
import {
  DEFAULT_SNAP_OPTIONS,
  resolveGuideStepDegrees,
  resolveSnapKinds,
} from '../../snapping/types.js';
import { toStore } from '../../store/draw-store.js';
import { MemoryStore } from '../../store/memory.js';
import { StoreSpatialIndex } from '../../store/spatial/store-spatial-index.js';
import type { Store, StoreContract } from '../../store/store.js';
import type { Layer, Mode } from '../../store/types.js';
import { resolveWritableLayerId } from '../../store/writable-layer.js';
import { createSelectionScope, type SelectionScope } from '../../view/ui/selection-scope.js';

/**
 * The options of the engine, in the shapes of its components. `createDraw` translates the
 * options of the draw instance into these (see `toEngineOptions` of `impl/options.ts`).
 *
 * @internal
 */
export interface EngineOptions {
  /** The mode entered when the engine starts */
  defaultMode?: Mode;
  /** How far from a feature a click still hits it, in pixels */
  clickTolerance?: number;
  /** How far the mouse moves before a press becomes a drag, in pixels */
  dragThreshold?: number;
  /** The default look of the features */
  style?: Partial<FeatureStyleConfig>;
  /** The look of the selection */
  selectionStyle?: Partial<SelectionUIConfig>;
  /** The switches and looks of the rendering */
  renderingStyle?: Partial<RenderingConfig>;
  /** The automatic names of new features, layers and groups */
  autoName?: AutoNameConfig | boolean;
  /** Whether the line widths of new features follow the zoom */
  scaleWithZoom?: boolean;
  /** The snapping */
  snap?: SnapOptions;
  /** The shared vertices */
  topology?: Partial<TopologyConfig>;
  /** The tracing along edges */
  trace?: TraceOptions;
  /**
   * The Store to keep the document and the state of this client in, instead of an in-memory
   * one: a Store of core, or one of the host that is read and written only through the public
   * contract
   */
  store?: StoreContract | Store;
  /** Whether the document starts with one empty layer (true by default) */
  initDefaultLayer?: boolean;
  /** Tells the entries of the stacking order that are outside the document */
  isExternalEntry?: (entryId: string) => boolean;
  /** The pixel ratio to draw with, instead of the one of the map */
  pixelRatio?: number;
  /** The strings the engine shows */
  messages?: Partial<Messages>;
}

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
 * The container that holds the internal components of one engine
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
   * The topology configuration (the actual object `draw.options.update` changes at runtime)
   */
  topology: TopologyConfig;
  /**
   * The trace configuration (the actual object `draw.options.update` changes at runtime)
   */
  trace: TraceConfig;
  options: Required<
    Omit<
      EngineOptions,
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
   * The messages table of this instance (EngineOptions.messages over `MESSAGES_EN`). Every string
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
   * (EngineOptions.isExternalEntry) */
  isExternalEntry?: (entryId: string) => boolean;
  /**
   * The source of the render scale (it includes the render scale that can be changed at
   * runtime)
   *
   * `pixelRatioSource.resolve` is distributed to each renderer and retained batch as a
   * `PixelRatioInput`. A change made through `draw.options.update` propagates through here to
   * every place that reads it directly.
   */
  pixelRatioSource: PixelRatioSource;
  /** The snapping options with the defaults filled in */
  snapOptions: ResolvedSnapOptions;
  /** The snapping service (the InputRouter uses it to replace the coordinates) */
  snapService: SnapService;
  /** The look of the snapping indicator, which the options change in place */
  snapIndicator: SnapIndicatorLook;
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
export function createContext(map: MapLibreMap, options: EngineOptions = {}): Context {
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
  // object the runtime options change, so always copy it so that the default is not shared
  const topology: TopologyConfig = mergeTopologyConfig(
    DEFAULT_TOPOLOGY_CONFIG,
    options.topology ?? {},
  );

  // Merge the trace configuration (it is enabled by default). It is the actual object the
  // runtime options change, so always copy it so that the default is not shared
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
  // with Alt). The candidates come from the built-in providers (the vertices and edges of the
  // Store); the snap providers of the extensions are added through the extension host.
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
      items: [],
      styleRule: undefined,
      metadata: undefined,
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
      const layers = store.listLayers();
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
    snapIndicator: createSnapIndicatorLook(),
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
