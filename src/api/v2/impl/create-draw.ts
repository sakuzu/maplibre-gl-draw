// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `createDraw`: the draw instance on the engine, with its resources
 */

import { DrawStore } from '../../../store/draw-store.js';
import type { Options } from '../../context.js';
import { createEngine } from '../../engine.js';
import type { CreateDraw, Draw } from '../draw.js';
import type { StoreView } from '../extension/store.js';
import type { DrawOptions } from '../options.js';
import { createDocument } from './document.js';
import { createFeatures } from './features.js';
import { createGroups } from './groups.js';
import { createHidden } from './hidden.js';
import { createLayers } from './layers.js';
import { createMetadata } from './metadata.js';
import { createSelection, createVertexSelection } from './selection.js';
import type { ResourceDeps } from './shared.js';
import { invalidInput, notFound } from './shared.js';

/** The options the engine takes as they are */
const ENGINE_OPTION_KEYS = [
  'defaultMode',
  'initDefaultLayer',
  'messages',
  'scaleWithZoom',
  'clickTolerance',
  'dragThreshold',
  'isExternalEntry',
] as const;

/** Throws for a part of the API that a later step of the 2.0 work provides */
function notImplemented(name: string): never {
  throw new Error(`not implemented (api-2): ${name}`);
}

/**
 * A stand-in for a resource that is not built yet: reading a member gives a function that
 * throws when it is called
 */
function pending<T>(name: string): T {
  const target = () => notImplemented(name);
  return new Proxy(target, {
    get: (_, key) =>
      typeof key === 'symbol' || key === 'then' ? undefined : pending(`${name}.${key}`),
    apply: () => notImplemented(name),
  }) as T;
}

/** The options of the engine for the options of `createDraw` */
function toEngineOptions(options: DrawOptions): Options {
  const result: Options = {};
  for (const [key, value] of Object.entries(options)) {
    if (value === undefined) continue;
    if ((ENGINE_OPTION_KEYS as readonly string[]).includes(key)) {
      (result as Record<string, unknown>)[key] = value;
    } else if (key === 'store') {
      // Only a Store of this library is taken until the option of a Store of the application
      if (!(value instanceof DrawStore)) notImplemented('the store option with another Store');
      result.store = value;
    } else if (key === 'rendering' && Object.keys(value).every((k) => k === 'pixelRatio')) {
      result.pixelRatio = (value as { pixelRatio?: number }).pixelRatio;
    } else {
      notImplemented(`the option ${key}`);
    }
  }
  return result;
}

/**
 * Puts a draw instance on a map and returns it.
 *
 * @internal
 */
export const createDraw: CreateDraw = (map, options = {}) => {
  const engine = createEngine(map, toEngineOptions(options));
  const { context, modeManager } = engine;
  const { store } = context;
  const view: StoreView = store;

  const deps: ResourceDeps = {
    store,
    generateId: context.generateFeatureId,
    autoNameGenerator: context.autoNameGenerator,
    getActiveLayerId: context.getActiveLayerId,
    setActiveLayerId: context.setActiveLayerId,
    featureStyle: context.featureStyle,
    eventEmitter: context.eventEmitter,
  };
  const features = createFeatures(deps);
  const groups = createGroups(deps);

  const draw: Draw = {
    features,
    layers: createLayers(deps),
    groups,
    datasets: pending('datasets'),
    hidden: createHidden(deps),
    selection: createSelection(deps, { features, groups }),
    vertexSelection: createVertexSelection(deps),
    metadata: createMetadata(deps),
    options: pending('options'),
    document: createDocument(deps),
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
    on: () => notImplemented('on'),
    off: () => notImplemented('off'),
    once: () => notImplemented('once'),

    hasPendingWork: () => notImplemented('hasPendingWork'),
    getLayerStack: () => notImplemented('getLayerStack'),
    debug: { terrain: () => notImplemented('debug.terrain') },

    destroy: () => engine.destroy(),
  };
  engine.extensions.attach(draw);
  return draw;
};
