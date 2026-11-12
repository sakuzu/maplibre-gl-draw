// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `draw.view`: another document shown read-only in place of the document, read into a Store of
 * rows of its own and shown with `draw.document.setShown`
 */

import { AutoNameGenerator } from '../../shared/utils/name-generator.js';
import { createTableStore } from '../../store/table-memory.js';
import type { StoreView } from '../extension/store.js';
import type { View } from '../view.js';
import type { OpenSource, TaskOptions } from '../write.js';
import { createDocument } from './document.js';
import { invalidInput } from './shared.js';
import { abortedError } from './write.js';

/** What the view takes from the instance */
export interface ViewDeps {
  /** Makes the IDs of what the source brings without one */
  readonly generateId: () => string;
  /** Shows a Store in place of the document, or the document again (`draw.document.setShown`) */
  readonly setShown: (store: StoreView | null) => void;
}

/** Creates `draw.view` @internal */
export function createView(deps: ViewDeps): View {
  // Each call takes a turn: a source read after a later call is not shown
  let turn = 0;
  return {
    async preview(source: OpenSource | null, options?: TaskOptions): Promise<void> {
      if (options !== undefined && (options === null || typeof options !== 'object')) {
        throw invalidInput('The options must be an object');
      }
      const signal = options?.signal;
      if (signal !== undefined && !(signal instanceof AbortSignal)) {
        throw invalidInput('signal must be an AbortSignal');
      }
      if (signal?.aborted) throw abortedError(signal);
      const mine = ++turn;
      if (source === null) {
        deps.setShown(null);
        return;
      }
      const { store } = createTableStore();
      const autoNameGenerator = new AutoNameGenerator(store);
      // GeoJSON goes into one layer, made as it is first asked for (a document of the library
      // brings its own layers)
      const layerOf = (): string => {
        const first = store.listLayers()[0];
        if (first) return first.id;
        const id = deps.generateId();
        store.createLayer({
          id,
          name: autoNameGenerator.generateLayerName(),
          visible: true,
          locked: false,
          opacity: 1,
          styleRule: undefined,
          metadata: undefined,
          items: [],
        });
        return id;
      };
      const loader = createDocument({
        store,
        autoNameGenerator,
        generateId: deps.generateId,
        getActiveLayerId: layerOf,
      });
      const prepared = await loader.prepare(source, { mode: 'replace' }, new Set(), new Set());
      if (signal?.aborted) throw abortedError(signal);
      if (mine !== turn || !prepared) return;
      loader.writeAll([prepared]);
      store.setReadOnly(true);
      deps.setShown(store);
    },
  };
}
