// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `createDraw`: the draw instance on the engine, with its resources
 */

import type { Map as MaplibreMap } from 'maplibre-gl';
import { ConsistencyChecks } from '../../debug/consistency.js';
import { DrawStore } from '../../store/draw-store.js';
import type { Store } from '../../store/store.js';
import { createBackendResource } from '../backend/refusals.js';
import { Sender, type SenderOptions } from '../backend/sender.js';
import type { Draw } from '../draw.js';
import { DrawError } from '../errors.js';
import type { StoreView } from '../extension/store.js';
import type { FeaturesCollection } from '../features.js';
import type { DrawOptions } from '../options.js';
import type { Write } from '../write.js';
import { captureImage } from './capture.js';
import { createDatasets } from './datasets.js';
import { guardAfterDestroy } from './destroy-guard.js';
import type { DocumentLoader } from './document.js';
import { createDocument } from './document.js';
import {
  createDrawing,
  createDrawingResource,
  createModeDrawing,
  createModeSet,
} from './drawing.js';
import type { Engine } from './engine.js';
import { createEngine } from './engine.js';
import { observe, requireEventName } from './events.js';
import type { FeatureResource } from './feature-resource.js';
import { toFeature, toFeatureOrUndefined } from './feature-shape.js';
import { createFeatures } from './features.js';
import type { GroupResource } from './group-resource.js';
import { createGroups } from './groups.js';
import { createHidden } from './hidden.js';
import { createHistory } from './history.js';
import type { LayerResource } from './layer-resource.js';
import { createLayers } from './layers.js';
import { createMemory } from './memory.js';
import { createMetadata } from './metadata.js';
import { checkDrawOptions, createOptions, setUserEditing, toEngineOptions } from './options.js';
import { createPick } from './pick.js';
import { createPluginUse } from './plugin-host.js';
import { publishedStore } from './published-store.js';
import { createRendered } from './rendered.js';
import { setCommitSaver } from './saving.js';
import { createSelection, createVertexSelection } from './selection.js';
import type { SelectionWrites } from './selection-resource.js';
import type { ResourceDeps } from './shared.js';
import { invalidInput, notFound } from './shared.js';
import { createSketches } from './sketches.js';
import { createStatus } from './status.js';
import { attachTableDiagnostics } from './table-diagnostics.js';
import { createView } from './view.js';
import { appValuesOf, createWriter, type Writers } from './write.js';

/** The methods of the instance that return a promise: after destroy they reject */
const ASYNC_MEMBERS: ReadonlySet<string> = new Set([
  'write',
  'undo',
  'redo',
  'open',
  'view.preview',
  'captureImage',
  'mode.drawing.commit',
]);

/**
 * The internal resources of an instance: what its transactions are made with
 *
 * @internal
 */
export interface DrawResources {
  readonly store: Store;
  readonly features: FeatureResource;
  readonly layers: LayerResource;
  readonly groups: GroupResource;
  readonly metadata: Writers['metadata'];
  readonly document: DocumentLoader;
  readonly selection: SelectionWrites;
}

const RESOURCES = new WeakMap<Draw, DrawResources>();

/**
 * The internal resources of an instance, which the tests of the parts of the instance write the
 * document with directly
 *
 * @internal
 */
export function resourcesOf(draw: Draw): DrawResources {
  const resources = RESOURCES.get(draw);
  if (!resources) throw new Error('Not an instance of createDraw');
  return resources;
}

/**
 * An object with only the members named: the reads of an internal resource, say. A method is
 * bound once; a value is read from the resource each time (a getter stays one)
 */
function pick<T extends object, K extends keyof T>(from: T, keys: readonly K[]): Pick<T, K> {
  const out = {} as Pick<T, K>;
  for (const key of keys) {
    const value = from[key];
    if (typeof value === 'function') {
      Object.defineProperty(out, key, { value: value.bind(from), enumerable: true });
    } else {
      Object.defineProperty(out, key, { get: () => from[key], enumerable: true });
    }
  }
  return out;
}

/** The reads of the features in the public shape */
function publicFeatures(
  features: FeatureResource,
  pick: FeaturesCollection['pick'],
): FeaturesCollection {
  return {
    get: (id) => toFeatureOrUndefined(features.get(id)),
    getMany: (ids) => features.getMany(ids).map(toFeatureOrUndefined),
    list: (filter, options) => features.list(filter, options).map(toFeature),
    count: (filter) => features.count(filter),
    bbox: (filter) => features.bbox(filter),
    has: (id) => features.has(id),
    isEditable: (id) => features.isEditable(id),
    getAppliedStyle: (id) => features.getAppliedStyle(id),
    appliedStyle: (id) => features.getAppliedStyle(id),
    pick,
    scan: (visit, options) => features.scan(visit, options),
  };
}

/**
 * Builds the draw instance on an engine and hands it to the extensions of the engine
 *
 * @param options - The options the instance was created with
 * @param setExternalEntry - Replaces the function that tells the entries from outside the
 *   document, which the engine asks
 * @internal
 */
export function createDrawOnEngine(
  engine: Engine,
  options: DrawOptions = {},
  setExternalEntry: (fn: ((id: string) => boolean) | undefined) => void = () => {},
  senderOptions: Pick<SenderOptions, 'rowsReadAtOnce' | 'retryDelay'> = {},
): Draw {
  const drawOptions = createOptions(engine, options, setExternalEntry, (payload) =>
    engine.events.emit('options.changed', payload),
  );
  drawOptions.applyCreation();
  const { context, modeManager, events, map } = engine;
  const { store } = context;
  const view: StoreView = store;

  const deps: ResourceDeps = {
    store,
    generateId: context.generateFeatureId,
    autoNameGenerator: context.autoNameGenerator,
    getActiveLayerId: context.getActiveLayerId,
    setActiveLayerId: context.setActiveLayerId,
    appliedStyle: engine.extensions.appliedStyle,
    spatialIndex: context.spatialIndex,
  };
  const featureResource = createFeatures(deps);
  const groupResource = createGroups(deps);
  const isStackEntry = (id: string): boolean =>
    engine.datasets.get(id)?.order === 'layerOrder' || context.isExternalEntry?.(id) === true;
  const layerResource = createLayers(deps, isStackEntry);
  // The reads of the instance read the document committed: the one before a commit over several
  // tasks until its last step, without finishing it
  const readDeps: ResourceDeps = { ...deps, store: publishedStore(store) };
  const features = publicFeatures(createFeatures(readDeps), createPick(engine));
  const groups = pick(createGroups(readDeps), [
    'get',
    'getMany',
    'list',
    'count',
    'has',
    'listMembers',
  ]);
  const layers = pick(createLayers(readDeps, isStackEntry), [
    'get',
    'getMany',
    'list',
    'count',
    'has',
    'listItems',
    'countItems',
    'getOrder',
    'getActive',
    'setActive',
  ]);
  const metadataResource = createMetadata(deps);
  const documentResource = createDocument(deps, (result) => engine.extensions.loaded(result), {
    get: () => engine.customLayer.getShown(),
    set(other) {
      if (other === engine.customLayer.getShown()) return;
      // No mode receives the input while another document is shown: a drawing mode is left
      if (other !== null && modeManager.getMode() !== 'select') modeManager.setMode('select');
      store.setDocumentWritable(other === null);
      engine.customLayer.setShown(other);
    },
  });
  const selectionResource = createSelection(
    deps,
    { features: featureResource, groups: groupResource },
    events,
  );
  const writer = createWriter({
    deps,
    published: readDeps.store,
    writers: {
      features: featureResource,
      layers: layerResource,
      groups: groupResource,
      metadata: metadataResource,
      selection: selectionResource,
      document: documentResource,
    },
    reads: { features, layers, groups },
  });
  const history = createHistory(store, options.history);
  // The storage: the commits of this client are sent to it, and the state tells how far
  let sender: Sender | null = null;
  const status = createStatus({ store, history, events, sender: () => sender });
  if (options.backend) {
    sender = new Sender(store, options.backend, {
      ...senderOptions,
      onChange: () => status.changed(),
      onTakenOut: (commits) => history.drop(commits),
      onReassigned: (ids) => history.rename(ids),
      onSkipped: (skipped) => status.problem({ type: 'skipped', ...skipped }),
    });
    setCommitSaver(store, sender);
    status.changed();
  }
  // A commit that left out writes whose targets were gone is a problem nobody waits for
  const noteSkipped = <T>(write: Write<T>, label: string | undefined): Write<T> => {
    write.result.then(
      ({ skipped }) => {
        if (skipped === 0 || destroyed) return;
        status.problem({
          type: 'skipped',
          error: new DrawError(
            'notFound',
            `The commit left out ${skipped} writes: what they named was gone`,
          ),
          label,
          commit: write.id,
          count: skipped,
        });
      },
      () => {},
    );
    return write;
  };
  // The image mode asks the application for an image (`requestImage`), placed as one commit
  let imageRequest: AbortController | null = null;
  const onImageRequest = (asked: {
    coordinate: [number, number];
    zoom: number;
    layerId: string;
  }): void => {
    const request = drawOptions.get().requestImage;
    if (!request) return;
    // What the image mode made: with `repeat` it stays for the next image
    modeManager.markCreated();
    imageRequest?.abort();
    const controller = new AbortController();
    imageRequest = controller;
    void (async () => {
      try {
        const image = await request([asked.coordinate[0], asked.coordinate[1]], {
          signal: controller.signal,
        });
        if (controller.signal.aborted || destroyed) return;
        const result = await writer.placeImage(image, asked, controller.signal);
        if (result) engine.extensions.loaded(result, true);
      } catch (error) {
        if (controller.signal.aborted || destroyed) return;
        const failure =
          error instanceof DrawError
            ? error
            : new DrawError('unsupportedFormat', String(error), { cause: error });
        events.emit('error', { error: failure, source: 'image' });
      } finally {
        if (imageRequest === controller) imageRequest = null;
      }
    })();
  };
  context.eventEmitter.on('image.request', onImageRequest);
  // The features as this client draws them, and what changed of them once a frame is drawn
  const rendered = createRendered({
    map,
    store,
    shapes: context.shapes,
    selectedIds: () => {
      const selection = store.getSelection();
      return selection.type === 'feature' ? selection.ids : [];
    },
    selectionStyle: context.selectionStyle,
    selectionExtensions: context.selectionScope.extensions,
    events,
    onFrameDrawn: (listener) => engine.customLayer.onFrameDrawn(listener),
  });
  // The checks of the state, in development (`debug.checks`): after each notification of the
  // Store, and after each frame drawn
  const stopChecks = attachChecks(engine, options);
  // Set once destroy has run to the end, so that the extensions removed by it can still read
  // the instance
  let destroyed = false;
  // Counted among the instances of the page until it is destroyed
  const memory = createMemory({
    store,
    shownStores: () => {
      const other = engine.customLayer.getShown();
      return other ? [view, other] : [view];
    },
    gpu: () => engine.customLayer.getGpuMemory(),
  });

  // The plugins of `/extend`, put into the extensions of the engine. Their overlays are not in an
  // image of the map
  let capturing = false;
  const usePlugin = createPluginUse({
    isCapturing: () => capturing,
    collections: engine.extensions.collections,
    map,
    modeManager,
    hitTestService: {
      registerCandidateReach: (type, reach) =>
        context.hitTestService.registerCandidateReach?.(type, reach) ?? (() => {}),
    },
    appliedStyle: engine.extensions.appliedStyle,
    getDraw: () => draw,
    report: (problem, key) => status.problem(problem, key),
    pointSprites: engine.extensions.pointSprites,
  });
  // `editable` and `userEditing` read the read-only and the lock, which setReadOnly and
  // setInteractionLocked change too
  const optionsObservable = observe(
    events,
    ['options.changed', 'readOnly.changed', 'interactionLock.changed'],
    drawOptions.get,
    { kept: true },
  );
  const drawingResource = createDrawingResource(engine);
  const modeObservable = observe(events, ['mode.changed'], () => modeManager.getMode());
  const members: Draw = {
    features,
    layers,
    groups,
    datasets: createDatasets(engine.datasets, events, context.eventEmitter),
    hidden: createHidden(deps, events),
    sketches: createSketches(engine.sketches, events),
    rendered: rendered.rendered,
    selection: pick(selectionResource, [
      'value',
      'subscribe',
      'target',
      'set',
      'setAll',
      'add',
      'remove',
      'clear',
      'features',
      'count',
      'scan',
    ]),
    vertexSelection: createVertexSelection(deps, events),
    drawing: drawingResource,
    options: {
      get value() {
        return optionsObservable.value;
      },
      subscribe: optionsObservable.subscribe,
      get: drawOptions.get,
      update: drawOptions.update,
    },
    document: {
      ...pick(documentResource, ['setShown', 'getShown', 'toJSON', 'toGeoJSON']),
      get title() {
        return store.getMetadata().title ?? '';
      },
      get description() {
        return store.getMetadata().description ?? '';
      },
      get metadata() {
        return appValuesOf(store.getMetadata() as Record<string, unknown>);
      },
    },
    view: createView({
      setShown: (other) => documentResource.setShown(other),
      isDestroyed: () => destroyed,
    }),
    extensions: engine.extensions.collections,
    use: (plugin, useOptions) => usePlugin(plugin, useOptions),
    memory: memory.memory,
    status: status.status,
    backend: createBackendResource({ store, sender: () => sender }),

    getMap: () => map,
    getStore: () => view,

    mode: {
      get value() {
        return modeObservable.value;
      },
      subscribe: modeObservable.subscribe,
      set: createModeSet(engine),
      drawing: createModeDrawing(engine, drawingResource),
    },
    getMode: () => modeManager.getMode(),
    setMode(mode) {
      if (typeof mode !== 'string') throw invalidInput('The mode must be a string');
      if (!modeManager.hasMode(mode)) throw notFound('mode', mode);
      return modeManager.setMode(mode);
    },

    isReadOnly: () => store.isReadOnly(),
    setReadOnly(value) {
      store.setReadOnly(value === true);
    },
    isInteractionLocked: () => store.isInteractionLocked(),
    setInteractionLocked(value) {
      setUserEditing(engine, value !== true);
    },

    write: (fn, writeOptions) => noteSkipped(writer.write(fn, writeOptions), writeOptions?.label),
    undo: (taskOptions) => history.undo(taskOptions),
    redo: (taskOptions) => history.redo(taskOptions),
    open: (source, taskOptions) =>
      writer.open(source, taskOptions).then((result) => {
        history.clear();
        return result;
      }),
    on(event, listener) {
      requireEventName(event);
      return events.on(event, listener);
    },
    off(event, listener) {
      requireEventName(event);
      events.off(event, listener);
    },
    once(event, listener) {
      requireEventName(event);
      return events.once(event, listener);
    },

    ...createDrawing(engine),
    captureImage: (captureOptions) =>
      captureImage(
        map,
        (hidden) => {
          capturing = hidden;
          engine.customLayer.setEditingHidden(hidden);
        },
        captureOptions,
      ),

    destroy() {
      if (destroyed) return;
      try {
        stopChecks();
        sender?.stop();
        setCommitSaver(store, null);
        status.stop();
        history.stop();
        imageRequest?.abort();
        context.eventEmitter.off('image.request', onImageRequest);
        rendered.stop();
        engine.destroy();
      } finally {
        memory.dispose();
        destroyed = true;
        // Extensions may give back what they share in a microtask of their removal
        queueMicrotask(() => engine.customLayer.drainGpu());
      }
    },
  };
  // After destroy, every method but destroy throws invalidState
  const draw = guardAfterDestroy(members, () => destroyed, {
    asyncMembers: ASYNC_MEMBERS,
    skip: new Set(['destroy']),
  });
  attachTableDiagnostics(draw, engine);
  RESOURCES.set(draw, {
    store,
    features: featureResource,
    layers: layerResource,
    groups: groupResource,
    metadata: metadataResource,
    document: documentResource,
    selection: selectionResource,
  });
  engine.extensions.attach(draw, drawOptions.getStyle, options.store);
  // The plugins of the options, in their order: one that cannot be added leaves no instance
  try {
    for (const plugin of options.plugins ?? []) draw.use(plugin);
  } catch (error) {
    draw.destroy();
    throw error;
  }
  return draw;
}

/**
 * Runs the checks of the state `debug.checks` asks for: those of the document, the selection, the
 * write marks and the features kept of rows once each notification of the Store has gone out,
 * that of what is drawn once each frame is drawn
 *
 * @returns the function that stops them
 */
function attachChecks(engine: Engine, options: DrawOptions): () => void {
  const asked = options.debug?.checks;
  const { store } = engine.context;
  if (!asked || !(store instanceof DrawStore)) return () => {};
  const checks = new ConsistencyChecks(asked, {
    store,
    checkDrawing: () => engine.customLayer.checkDrawnCopies(),
    checkDrawnWrites: () => engine.customLayer.checkDrawnWrites(),
    checkDrawnRebuild: () => engine.customLayer.checkDrawnRebuild(),
    sketches: engine.sketches,
    // A frame of an image of the map draws no sketch: none is expected drawn while it is drawn
    checkDrawnSketches: (expected) =>
      engine.customLayer.checkDrawnSketches(engine.context.shapes.written ? new Map() : expected),
  });
  store.setAfterNotify(() => checks.afterNotify());
  engine.sketches.setAfterOperate(() => checks.afterSketches());
  const stopFrames = engine.customLayer.onFrameDrawn(() => checks.afterFrame());
  return () => {
    store.setAfterNotify(null);
    engine.sketches.setAfterOperate(null);
    checks.stop();
    stopFrames();
  };
}

/**
 * Puts a draw instance on a map and returns it.
 *
 * @internal
 */
export function createDraw(map: MaplibreMap, options: DrawOptions = {}): Draw {
  checkDrawOptions(options);
  // The engine asks this function, so that the option can change while the instance runs
  let isExternalEntry = options.isExternalEntry;
  const engine = createEngine(
    map,
    toEngineOptions(options, (id) => isExternalEntry?.(id) === true),
    { deferDefaultMode: true },
  );
  const draw = createDrawOnEngine(engine, options, (fn) => {
    isExternalEntry = fn;
  });
  engine.enterDefaultMode();
  return draw;
}
