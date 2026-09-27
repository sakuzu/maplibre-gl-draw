// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The public API the contexts of the extensions hand out on an engine that has no draw
 * instance of the contract: the engine behind the first version of the API
 *
 * The built-in modes are written to the extension contract, so they need `ctx.draw` on that
 * engine too. This instance has the resources over the Store and the collections of the
 * extensions; the parts that need the rest of the instance throw. It goes away with the first
 * version of the API.
 */

import type { Map as MapLibreMap } from 'maplibre-gl';
import type { ModeManager } from '../../../modes/manager.js';
import type { Draw } from '../draw.js';
import type { ExtensionsCollections } from '../extensions.js';
import { createDocument } from './document.js';
import { createFeatures } from './features.js';
import { createGroups } from './groups.js';
import { createHidden } from './hidden.js';
import { createLayers } from './layers.js';
import { createMetadata } from './metadata.js';
import { createSelection, createVertexSelection } from './selection.js';
import type { ResourceDeps } from './shared.js';
import { invalidInput, notFound } from './shared.js';

/** A part of the instance this engine cannot give */
function unavailable<T>(name: string): T {
  const fail = (): never => {
    throw new Error(`${name} is not available to the extensions of this instance`);
  };
  return new Proxy(fail, {
    get: (_, key) =>
      typeof key === 'symbol' || key === 'then' ? undefined : unavailable(`${name}.${String(key)}`),
    apply: fail,
  }) as T;
}

/**
 * Builds the public API for the extensions of an engine without a draw instance of the
 * contract
 *
 * @internal
 */
export function createStandaloneDraw(
  map: MapLibreMap,
  deps: ResourceDeps,
  modeManager: ModeManager,
  extensions: ExtensionsCollections,
): Draw {
  const { store } = deps;
  const features = createFeatures(deps);
  const groups = createGroups(deps);
  return {
    features,
    layers: createLayers(deps),
    groups,
    datasets: unavailable('datasets'),
    hidden: createHidden(deps),
    selection: createSelection(deps, { features, groups }),
    vertexSelection: createVertexSelection(deps),
    metadata: createMetadata(deps),
    options: unavailable('options'),
    document: createDocument(deps),
    extensions,
    getMap: () => map,
    getStore: () => store,
    getMode: () => modeManager.getMode(),
    setMode(mode) {
      if (typeof mode !== 'string') throw invalidInput('The mode must be a string');
      if (!modeManager.hasMode(mode)) throw notFound('mode', mode);
      return modeManager.setMode(mode);
    },
    isReadOnly: () => store.isReadOnly(),
    setReadOnly: (value) => store.setReadOnly(value === true),
    isInteractionLocked: () => store.isInteractionLocked(),
    setInteractionLocked(value) {
      store.setInteractionLock(value === true);
      if (value === true && modeManager.getMode() !== 'select') modeManager.setMode('select');
    },
    transact: (fn, options) => store.transact(fn, options?.source),
    on: unavailable('on'),
    off: unavailable('off'),
    once: unavailable('once'),
    hasPendingWork: unavailable('hasPendingWork'),
    getLayerStack: unavailable('getLayerStack'),
    debug: unavailable('debug'),
    destroy: unavailable('destroy'),
  };
}
