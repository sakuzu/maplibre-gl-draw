// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `createDraw`: the draw instance on the engine, with its resources
 */

import type { Map as MaplibreMap } from 'maplibre-gl';
import type { Draw } from '../draw.js';
import type { StoreView } from '../extension/store.js';
import type { DrawOptions } from '../options.js';
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
import { createMetadata } from './metadata.js';
import { checkDrawOptions, createOptions, toEngineOptions } from './options.js';
import { createSelection, createVertexSelection } from './selection.js';
import type { ResourceDeps } from './shared.js';
import { invalidInput, notFound, requireRecord, withLocksIgnored } from './shared.js';

/** The methods of the instance that return a promise: after destroy they reject */
const ASYNC_MEMBERS: ReadonlySet<string> = new Set(['document.load', 'document.loadMany']);

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
  const drawOptions = createOptions(engine, options, setExternalEntry);
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
    featureStyle: context.featureStyle,
    spatialIndex: context.spatialIndex,
  };
  const features = createFeatures(deps);
  const groups = createGroups(deps);
  // Set once destroy has run to the end, so that the extensions removed by it can still read
  // the instance
  let destroyed = false;

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
    selection: createSelection(deps, { features, groups }),
    vertexSelection: createVertexSelection(deps),
    drawing: createDrawingResource(engine),
    metadata: createMetadata(deps),
    options: { get: drawOptions.get, update: drawOptions.update },
    document: createDocument(deps, (result, source) =>
      events.emit('document.loaded', { result, source }),
    ),
    extensions: engine.extensions.collections,

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

    destroy() {
      if (destroyed) return;
      try {
        engine.destroy();
      } finally {
        destroyed = true;
      }
    },
  };
  // After destroy, every method but destroy throws invalid-state
  const draw = guardAfterDestroy(members, () => destroyed, {
    asyncMembers: ASYNC_MEMBERS,
    skip: new Set(['destroy']),
  });
  engine.extensions.attach(draw, options.store);
  return draw;
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
