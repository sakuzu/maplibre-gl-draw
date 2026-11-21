// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `createDraw`: the draw instance on the engine, with its resources
 */

import type { Map as MaplibreMap } from 'maplibre-gl';
import { workCountsOf } from '../../shared/work-counts.js';
import type { UpdateSource } from '../../store/types.js';
import type { Draw, TransactOptions } from '../draw.js';
import { DrawError } from '../errors.js';
import type { DrawOptions } from '../options.js';
import { holdBulkEdits } from './bulk-edits.js';
import { createDatasets } from './datasets.js';
import { guardAfterDestroy } from './destroy-guard.js';
import { createDocument } from './document.js';
import { createDrawing, createDrawingResource } from './drawing.js';
import { createEditingFeatures } from './editing-features.js';
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
  const drawOptions = createOptions(engine, options, setExternalEntry, (payload) =>
    engine.events.emit('options.changed', payload),
  );
  drawOptions.applyCreation();
  const { context, modeManager, events, map } = engine;
  const { store } = context;
  // The state of this client, held by the instance (the Store holds only the document)
  const { client } = store;
  const exposedStore = context.exposedStore;

  const deps: ResourceDeps = {
    store,
    generateId: context.generateFeatureId,
    autoNameGenerator: context.autoNameGenerator,
    getActiveLayerId: context.getActiveLayerId,
    setActiveLayerId: context.setActiveLayerId,
    getStyleOptions: drawOptions.getStyle,
    getZoom: () => map.getZoom(),
    spatialIndex: context.spatialIndex,
  };
  // The edits of any number of features, written in parts, one at a time (made by the engine)
  const { edits } = engine;
  // The bulk edits of the features read the computation set and the feature types, and add to
  // the amounts of work of the Store
  const features = createFeatures(deps, {
    edits,
    extensions: engine.extensions.collections,
    counts: workCountsOf(exposedStore),
  });
  const groups = createGroups(deps);
  // Set once destroy has run to the end, so that the extensions removed by it can still read
  // the instance
  let destroyed = false;
  // How many `draw.transact` of this instance are open (their `fn` runs): a nested one takes the
  // source of the outer one
  let transactDepth = 0;

  const members: Draw = {
    features,
    layers: createLayers(
      deps,
      (id) =>
        engine.datasets.get(id)?.order === 'layerOrder' || context.isExternalEntry?.(id) === true,
      edits,
    ),
    groups,
    datasets: createDatasets(engine.datasets, events, context.eventEmitter),
    hidden: createHidden(deps),
    selection: createSelection(deps, { features, groups, edits }),
    vertexSelection: createVertexSelection(deps),
    editingFeatures: createEditingFeatures(deps),
    drawing: createDrawingResource(engine),
    metadata: createMetadata(deps),
    options: { get: drawOptions.get, update: drawOptions.update },
    document: createDocument(
      deps,
      (result, source) => events.emit('document.loaded', { result, source }),
      (listener, subscribeOptions) => events.subscribe(listener, subscribeOptions),
    ),
    extensions: engine.extensions.collections,

    getMap: () => map,
    getStore: () => exposedStore,

    getMode: () => modeManager.getMode(),
    setMode(mode) {
      if (typeof mode !== 'string') throw invalidInput('The mode must be a string');
      if (!modeManager.hasMode(mode)) throw notFound('mode', mode);
      return modeManager.setMode(mode);
    },

    isReadOnly: () => client.isReadOnly(),
    setReadOnly(value) {
      client.setReadOnly(value === true);
      // Read-only stops the edits being written
      if (value === true) edits.stopAll();
    },
    isInteractionLocked: () => client.isInteractionLocked(),
    setInteractionLocked(value) {
      client.setInteractionLock(value === true);
      // A drawing mode cannot run under the lock
      if (value === true && modeManager.getMode() !== 'select') modeManager.setMode('select');
    },

    transact<T>(fn: () => T, transactOptions?: TransactOptions): T {
      if (transactOptions !== undefined) requireRecord(transactOptions, 'The options');
      const given = transactOptions?.source;
      const ignoreLocks = transactOptions?.ignoreLocks === true;
      const open = (source: UpdateSource, body: () => T): T => {
        const run = () =>
          store.transact(() => {
            transactDepth += 1;
            try {
              return body();
            } finally {
              transactDepth -= 1;
            }
          }, source);
        return ignoreLocks ? withLocksIgnored(store, run) : run();
      };
      if (transactDepth > 0) {
        // Inside a draw.transact of this instance: the source of the outer one, and no other
        const outer = store.currentSource() ?? 'local';
        if (given !== undefined && given !== outer) throw nestedSourceError(given, outer);
        return open(outer, fn);
      }
      // The outermost one: a bulk edit started in `fn` makes its change the first part
      const source = given ?? 'local';
      return edits.inTransaction(source, ignoreLocks, (endOfFn) =>
        open(source, () => {
          // Inside a transaction opened on the Store directly, whose source is another, it writes
          // nothing: what the writes of the instance would fold into is that transaction
          const outer = store.currentSource();
          if (outer !== undefined && outer !== source) throw nestedSourceError(source, outer);
          const result = fn();
          endOfFn();
          return result;
        }),
      );
    },
    waitForWrites: () => edits.waitForWrites(),
    on: (event, listener) => events.on(event, listener),
    off: (event, listener) => events.off(event, listener),
    once: (event, listener) => events.once(event, listener),

    ...createDrawing(engine),

    destroy() {
      if (destroyed) return;
      try {
        // The edit being written ends its operation first, then every edit rejects
        edits.destroy();
        // The operations a caller of the Store left open are taken as ended
        store.releaseOpenOperations();
        engine.destroy();
      } finally {
        destroyed = true;
      }
    },
  };
  // After destroy, every method but destroy throws invalidState
  const draw = guardAfterDestroy(members, () => destroyed, {
    asyncMembers: ASYNC_MEMBERS,
    skip: new Set(['destroy']),
  });
  holdBulkEdits(draw, edits);
  engine.extensions.attach(draw);
  return draw;
}

/** The error of a `draw.transact` inside a transaction of another source */
function nestedSourceError(source: UpdateSource, outer: UpdateSource): DrawError {
  return new DrawError(
    'invalidState',
    `transact: a transaction of the source ${JSON.stringify(source)} inside one of ${JSON.stringify(outer)}`,
  );
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
