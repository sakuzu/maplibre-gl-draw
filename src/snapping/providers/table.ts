// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Built-in snapping providers (the vertices and edges of the rows held as columns)
 *
 * A Store that holds its features as rows has the features of the rows held only in its spatial
 * index (the Store providers snap to them). The other rows are found in the indexes of their
 * layers and read on their columns (`feature-table/snap-rows.ts`): the same candidates, with the
 * same vertex references, as the Store providers give for the features of the rows, and no row
 * is made a feature (a row of the type of an extension is, to list its own targets). The same
 * rows are left out: hidden ones, the excluded ones, the vertex being dragged and the edges
 * touching it.
 */

import {
  rowHasEdges,
  rowSegmentsInBBox,
  rowVerticesInBBox,
  type SnapRow,
} from '../../feature-table/snap-rows.js';
import type { BoundingBox, Coordinate, Feature } from '../../store/types.js';
import type {
  SnapCandidate,
  SnapProvider,
  SnapProviderContext,
  SnapTargetsProvider,
} from '../types.js';
import type { StoreSnapProviderDeps } from './shared.js';
import { isExcludedEdge, isExcludedVertex } from './shared.js';

/**
 * The rows near a box that are snapping targets
 *
 * @internal
 */
export function forEachTargetRow(
  deps: StoreSnapProviderDeps,
  bbox: BoundingBox,
  ctx: SnapProviderContext,
  visit: (row: SnapRow) => void,
): void {
  const { store, shapes } = deps;
  if (!store.tables) return;
  const hidden = store.listHidden();
  shapes.forEachSnapRow(
    bbox,
    (layerId, groupId) => {
      if (!store.getLayer(layerId)?.visible || hidden.has(layerId)) return false;
      if (groupId === undefined) return true;
      return store.getGroup(groupId)?.visible !== false && !hidden.has(groupId);
    },
    (id) => id === ctx.excludeFeatureId || ctx.excludeFeatureIds?.has(id) === true,
    visit,
  );
}

/**
 * Builds the vertex provider for the rows held as columns
 *
 * @internal
 */
export function createTableVertexSnapProvider(deps: StoreSnapProviderDeps): SnapProvider {
  return {
    name: 'core:table-vertex',

    candidates(bbox: BoundingBox, ctx: SnapProviderContext): SnapCandidate[] {
      const candidates: SnapCandidate[] = [];
      forEachTargetRow(deps, bbox, ctx, (row) => {
        // A row of the type of an extension lists its own targets, as its feature does
        const custom = customTargetsOf(deps, row);
        if (custom) {
          const { feature, targets } = custom;
          for (const candidate of targets(feature, ctx)) {
            const featureId = candidate.featureId ?? feature.id;
            if (!('start' in candidate) && isExcludedVertex(featureId, candidate.vertex, ctx)) {
              continue;
            }
            candidates.push({ ...candidate, featureId });
          }
          return;
        }
        rowVerticesInBBox(row, bbox, (coordinate, vertex) => {
          if (isExcludedVertex(row.id, vertex, ctx)) return;
          candidates.push({ kind: 'vertex', coordinate, featureId: row.id, vertex });
        });
      });
      return candidates;
    },
  };
}

/**
 * Builds the edge provider for the rows held as columns
 *
 * @internal
 */
export function createTableEdgeSnapProvider(deps: StoreSnapProviderDeps): SnapProvider {
  return {
    name: 'core:table-edge',

    candidates(bbox: BoundingBox, ctx: SnapProviderContext): SnapCandidate[] {
      const candidates: SnapCandidate[] = [];
      forEachTargetRow(deps, bbox, ctx, (row) => {
        if (customTargetsOf(deps, row) || !rowHasEdges(row.type)) return;
        rowSegmentsInBBox(row, bbox, (start, end, startRef, endRef) => {
          // An edge the drag changes passes over the cursor
          if (isExcludedEdge(row.id, startRef, ctx)) return;
          candidates.push({ kind: 'edge', start, end, startRef, endRef, featureId: row.id });
        });
      });
      return candidates;
    },
  };
}

/**
 * The edges of the rows near a box, per row, for the intersections
 *
 * @internal
 */
export function collectRowSegments(
  deps: StoreSnapProviderDeps,
  bbox: BoundingBox,
  ctx: SnapProviderContext,
): Array<{ featureId: string; segments: Array<{ start: Coordinate; end: Coordinate }> }> {
  const out: Array<{ featureId: string; segments: Array<{ start: Coordinate; end: Coordinate }> }> =
    [];
  forEachTargetRow(deps, bbox, ctx, (row) => {
    if (customTargetsOf(deps, row) || !rowHasEdges(row.type)) return;
    const segments: Array<{ start: Coordinate; end: Coordinate }> = [];
    rowSegmentsInBBox(row, bbox, (start, end, startRef) => {
      if (isExcludedEdge(row.id, startRef, ctx)) return;
      segments.push({ start, end });
    });
    if (segments.length > 0) out.push({ featureId: row.id, segments });
  });
  return out;
}

/**
 * The targets a row of the type of an extension lists itself, with the feature made of it (null
 * for a row its standard vertices and edges are listed for)
 */
function customTargetsOf(
  deps: StoreSnapProviderDeps,
  row: SnapRow,
): { feature: Feature; targets: SnapTargetsProvider } | null {
  if (!deps.snapTargets?.get(row.type)) return null;
  const feature = row.feature();
  const targets = deps.snapTargets.forFeature(feature);
  return targets ? { feature, targets } : null;
}
