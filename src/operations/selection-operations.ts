// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Selection operations
 *
 * Deletes what is selected. The Delete key of the select mode (modes/) and
 * `draw.selection.delete()` (api/) both delete the selected features, groups or layers with
 * `startSelectionDeletion` (`bulk-deletion.ts`), a bulk edit in parts, so the two paths delete
 * the same things; the key deletes the selected vertices first.
 */

import { coordinatesOf, geometryFromCoordinates } from '../shared/utils/coordinates.js';
import type { DocumentAccess } from '../store/document-access.js';
import { isFeatureLocked } from '../store/lock.js';
import type { FeatureCoordinates, VertexSelection } from '../store/types.js';
import { startSelectionDeletion } from './bulk-deletion.js';
import type { BulkEditStarter } from './bulk-work.js';
import { deleteVertex as deleteVertexOp, sortVertexRefsForDeletion } from './vertex.js';

/**
 * Deletes what is selected, as the Delete key of the select mode does:
 *
 * - vertices selected: deletes those vertices, as one change
 * - otherwise the selected features, groups or layers, as `draw.selection.delete()` deletes
 *   them (see `startSelectionDeletion`): a bulk edit in parts, which nothing waits for
 *
 * Nothing is deleted while read-only or the interaction lock is on.
 */
export function deleteSelection(edits: BulkEditStarter): void {
  const store = edits.layer;
  // Do not start a deletion while readOnly / the interaction lock is on
  if (store.isReadOnly() || store.isInteractionLocked()) return;

  // Delete the vertices when vertices are selected
  const selectedVertices = store.getVertexSelection();
  if (selectedVertices && selectedVertices.vertices.length > 0) {
    deleteSelectedVertices(store, selectedVertices);
    return;
  }

  startSelectionDeletion(edits).catch((error: unknown) => {
    // A deletion the destroy of the instance ends rejects: nothing waits for the key
    if ((error as { code?: unknown } | null)?.code !== 'invalidState') {
      console.error('Error while the selection was deleted:', error);
    }
  });
}

/**
 * Deletes the selected vertices of one feature as one change
 *
 * @returns The number of vertices deleted
 */
export function deleteSelectedVertices(store: DocumentAccess, selection: VertexSelection): number {
  // The edit being written in parts is applied first to the feature read to be written
  store.applyEditFirst?.(selection.featureId);
  const feature = store.getFeature(selection.featureId);
  if (!feature) return 0;

  // The vertices of a locked feature are not deleted
  if (isFeatureLocked(feature, store)) return 0;

  // Within the same part and the same ring, deletion goes in descending index order
  // (avoiding the shift caused by what was already removed. For MultiPoint the part itself
  // disappears, so parts are in descending order too)
  const sortedRefs = sortVertexRefsForDeletion(selection.vertices);

  // deleteVertex does not mutate its input and returns a new coordinate structure
  // (copy-on-write), so no upfront copy is needed. Successive deletions only need the return
  // value fed into the next input
  let coords: FeatureCoordinates = coordinatesOf(feature);
  let deletedCount = 0;

  for (const ref of sortedRefs) {
    const result = deleteVertexOp(
      { ...feature, geometry: geometryFromCoordinates(feature.type, coords) },
      ref,
    );
    if (result !== null) {
      coords = result;
      deletedCount++;
    }
  }

  if (deletedCount > 0) {
    store.transact(() => {
      store.updateFeature(selection.featureId, {
        geometry: geometryFromCoordinates(feature.type, coords),
      });
      store.setSelectedVertices(null);
    });
  }

  return deletedCount;
}
