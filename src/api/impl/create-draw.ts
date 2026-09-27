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
import { createDocument } from './document.js';
import { createDrawing } from './drawing.js';
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
import { invalidInput, notFound } from './shared.js';

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

  const draw: Draw = {
    features,
    layers: createLayers(deps),
    groups,
    datasets: createDatasets(engine.datasets, events, context.eventEmitter),
    hidden: createHidden(deps),
    selection: createSelection(deps, { features, groups }),
    vertexSelection: createVertexSelection(deps),
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

    transact: (fn, transactOptions) => store.transact(fn, transactOptions?.source),
    on: (event, listener) => events.on(event, listener),
    off: (event, listener) => events.off(event, listener),
    once: (event, listener) => events.once(event, listener),

    ...createDrawing(engine),

    destroy: () => engine.destroy(),
  };
  engine.extensions.attach(draw);
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
