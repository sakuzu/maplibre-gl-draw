// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The internal writes of an instance, for the tests of its parts (rendering, sketches, modes,
 * events) that need a document and are not about the public writes: they write as the internal
 * resources do (the shape of the Store, synchronously, one transaction of the Store each), where
 * an application writes with `draw.write`. The tests of the public writes use `draw.write`.
 */

import type { Draw } from '../api/draw.js';
import type { UpdateSource } from '../api/extension/store.js';
import { type DrawResources, resourcesOf } from '../api/impl/create-draw.js';
import { withLocksIgnored } from '../api/impl/shared.js';

/** The internal resources of an instance, with a transaction of its Store */
export interface Writes extends DrawResources {
  /** Runs `fn` as one transaction of the Store */
  transact<T>(fn: () => T, options?: { source?: UpdateSource; ignoreLocks?: boolean }): T;
}

/** The internal writes of an instance */
export function writesOf(draw: Draw): Writes {
  const resources = resourcesOf(draw);
  return {
    ...resources,
    transact(fn, options) {
      const run = () => resources.store.transact(fn, options?.source);
      return options?.ignoreLocks === true ? withLocksIgnored(resources.store, run) : run();
    },
  };
}
