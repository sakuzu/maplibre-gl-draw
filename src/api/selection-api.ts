// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Selection API
 *
 * Provides the Selection and Vertex Selection operations of MapLibreGLDraw.
 */

import { deleteSelection } from '../operations/selection-operations.js';
import { deleteVertex as deleteVertexOp, sortVertexRefsForDeletion } from '../operations/vertex.js';
import type { Store } from '../store/store.js';
import type {
  Feature,
  FeatureCoordinates,
  Selection,
  SelectionType,
  VertexRef,
  VertexSelection,
} from '../store/types.js';
import type { MapLibreGLDraw } from './api.js';

export type SelectionApi = Pick<
  MapLibreGLDraw,
  | 'getSelection'
  | 'select'
  | 'deselect'
  | 'getSelectedFeatures'
  | 'getSelectedIds'
  | 'deleteSelection'
  | 'selectVertices'
  | 'deselectVertices'
  | 'getSelectedVertices'
  | 'deleteVertices'
>;

export interface SelectionApiDeps {
  store: Store;
}

export function createSelectionApi(deps: SelectionApiDeps): SelectionApi {
  const { store } = deps;

  return {
    getSelection(): Selection {
      return store.getSelection();
    },

    select(ids: string | string[], type: SelectionType = 'feature'): void {
      const idsArray = Array.isArray(ids) ? ids : [ids];
      store.setSelection(type, idsArray);
    },

    deselect(): void {
      store.setSelection(null, []);
    },

    getSelectedFeatures(): Feature[] {
      const selection = store.getSelection();
      if (selection.type !== 'feature') return [];
      return selection.ids
        .map((id) => store.getFeature(id))
        .filter((f): f is Feature => f !== undefined);
    },

    getSelectedIds(): string[] {
      return [...store.getSelection().ids];
    },

    deleteSelection(): boolean {
      return deleteSelection(store);
    },

    selectVertices(featureId: string, vertices: VertexRef[]): void {
      store.setSelectedVertices({ featureId, vertexIndices: vertices });
    },

    deselectVertices(): void {
      store.setSelectedVertices(null);
    },

    getSelectedVertices(): VertexSelection | null {
      return store.getSelectedVertices();
    },

    deleteVertices(featureId: string, vertices: VertexRef[]): number {
      if (vertices.length === 0) return 0;

      const feature = store.getFeature(featureId);
      if (!feature) return 0;

      // Within the same part and the same ring, delete in descending index order
      // (avoids the shift caused by earlier deletions; for MultiPoint the part itself
      // disappears, so parts are in descending order too)
      const sortedRefs = sortVertexRefsForDeletion(vertices);

      let coords: FeatureCoordinates = JSON.parse(JSON.stringify(feature.coordinates));
      let deletedCount = 0;

      for (const ref of sortedRefs) {
        const result = deleteVertexOp({ ...feature, coordinates: coords }, ref);
        if (result !== null) {
          coords = result;
          deletedCount++;
        }
      }

      if (deletedCount > 0) {
        store.transact(() => {
          store.updateFeature(featureId, { coordinates: coords });
          // If the deleted vertices were selected, clear the selection
          const selectedVertices = store.getSelectedVertices();
          if (selectedVertices?.featureId === featureId) {
            store.setSelectedVertices(null);
          }
        });
      }

      return deletedCount;
    },
  };
}
