// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `createDraw`: the draw instance on the engine, with its resources
 */

import type { Map as MaplibreMap } from 'maplibre-gl';
import { ConsistencyChecks } from '../../debug/consistency.js';
import { DrawStore } from '../../store/draw-store.js';
import type { Draw } from '../draw.js';
import type { StoreView } from '../extension/store.js';
import type { DrawOptions } from '../options.js';
import { captureImage } from './capture.js';
import { createDatasets } from './datasets.js';
import { guardAfterDestroy } from './destroy-guard.js';
import { createDocument } from './document.js';
import { createDrawing, createDrawingResource } from './drawing.js';
import type { Engine } from './engine.js';
import { createEngine } from './engine.js';
import { createFeatures } from './features.js';
import { createGroups } from './groups.js';
import { createHidden } from './hidden.js';
import { createLayers } from './layers.js';
import { createMemory } from './memory.js';
import { createMetadata } from './metadata.js';
import { checkDrawOptions, createOptions, toEngineOptions } from './options.js';
import { createRendered } from './rendered.js';
import { createSelection, createVertexSelection } from './selection.js';
import type { ResourceDeps } from './shared.js';
import { invalidInput, notFound, requireRecord, withLocksIgnored } from './shared.js';
import { createSketches } from './sketches.js';
import { attachTableDiagnostics } from './table-diagnostics.js';

/** The methods of the instance that return a promise: after destroy they reject */
const ASYNC_MEMBERS: ReadonlySet<string> = new Set([
  'document.load',
  'document.loadMany',
  'captureImage',
]);

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
  const features = createFeatures(deps);
  const groups = createGroups(deps);
  // The features as this client draws them, and what changed of them once a frame is drawn
  const rendered = createRendered({
    map,
    store,
    appliedFeature: (id) => engine.sketches.appliedFeature(id),
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

  const members: Draw = {
    features,
    layers: createLayers(
      deps,
      (id) =>
        engine.datasets.get(id)?.order === 'layer-order' || context.isExternalEntry?.(id) === true,
    ),
    groups,
    datasets: createDatasets(engine.datasets, events, context.eventEmitter),
    hidden: createHidden(deps),
    sketches: createSketches(engine.sketches),
    rendered: rendered.rendered,
    selection: createSelection(deps, { features, groups }),
    vertexSelection: createVertexSelection(deps),
    drawing: createDrawingResource(engine),
    metadata: createMetadata(deps),
    options: { get: drawOptions.get, update: drawOptions.update },
    document: createDocument(
      deps,
      (result, source) => events.emit('document.loaded', { result, source }),
      {
        get: () => engine.customLayer.getShown(),
        set(other) {
          if (other === engine.customLayer.getShown()) return;
          // No mode receives the input while another document is shown: a drawing mode is left
          if (other !== null && modeManager.getMode() !== 'select') modeManager.setMode('select');
          store.setDocumentWritable(other === null);
          engine.customLayer.setShown(other);
        },
      },
    ),
    extensions: engine.extensions.collections,
    memory: memory.memory,

    getMap: () => map,
    getStore: () => view,

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
      store.setInteractionLock(value === true);
      // A drawing mode cannot run under the lock
      if (value === true && modeManager.getMode() !== 'select') modeManager.setMode('select');
    },

    transact(fn, transactOptions) {
      if (transactOptions !== undefined) requireRecord(transactOptions, 'The options');
      const run = () => store.transact(fn, transactOptions?.source);
      return transactOptions?.ignoreLocks === true ? withLocksIgnored(store, run) : run();
    },
    on: (event, listener) => events.on(event, listener),
    off: (event, listener) => events.off(event, listener),
    once: (event, listener) => events.once(event, listener),

    ...createDrawing(engine),
    captureImage: (captureOptions) =>
      captureImage(map, (hidden) => engine.customLayer.setEditingHidden(hidden), captureOptions),

    destroy() {
      if (destroyed) return;
      try {
        stopChecks();
        rendered.stop();
        engine.destroy();
      } finally {
        memory.dispose();
        destroyed = true;
      }
    },
  };
  // After destroy, every method but destroy throws invalid-state
  const draw = guardAfterDestroy(members, () => destroyed, {
    asyncMembers: ASYNC_MEMBERS,
    skip: new Set(['destroy']),
  });
  attachTableDiagnostics(draw, engine);
  engine.extensions.attach(draw, drawOptions.getStyle, options.store);
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
    checkDrawnSketches: (expected) => engine.customLayer.checkDrawnSketches(expected),
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
