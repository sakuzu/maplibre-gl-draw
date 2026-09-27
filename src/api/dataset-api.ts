// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Display API
 *
 * Adds, gets and removes read-only bulk display layers (datasets).
 * It never touches the Store, so it is independent of the editing, undo and event paths.
 */

import type { DatasetManager } from '../dataset/manager.js';
import type { Dataset, DatasetOptions, DatasetPlacement } from '../dataset/types.js';
import type { MapLibreGLDraw } from './api.js';

/** @internal */
export type DisplayApi = Pick<
  MapLibreGLDraw,
  'addDataset' | 'getDataset' | 'getDatasets' | 'moveDataset' | 'removeDataset'
>;

/** @internal */
export interface DisplayApiDeps {
  datasets: DatasetManager;
}

/** @internal */
export function createDisplayApi(deps: DisplayApiDeps): DisplayApi {
  const { datasets } = deps;

  return {
    addDataset(options: DatasetOptions): Dataset {
      return datasets.add(options);
    },

    getDataset(id: string): Dataset | undefined {
      return datasets.get(id);
    },

    getDatasets(): Dataset[] {
      return datasets.list();
    },

    moveDataset(id: string, placement: DatasetPlacement): boolean {
      return datasets.move(id, placement);
    },

    removeDataset(id: string): boolean {
      return datasets.remove(id);
    },
  };
}
