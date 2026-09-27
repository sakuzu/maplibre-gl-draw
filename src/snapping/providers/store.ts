// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Built-in snapping providers (the vertices and edges of the Store)
 *
 * It narrows down the features near the cursor with SpatialIndex.findNear and lists
 * the vertex and edge candidates per type. Intersections are handled by
 * providers/intersection.ts, and construction guides by providers/guide.ts.
 *
 * What is left out.
 *
 *   - Hidden features (both the shared visible flag and local hiding)
 *   - The features of ctx.excludeFeatureId / ctx.excludeFeatureIds
 *   - The vertex of ctx.excludeVertex and the edges touching it (the vertex being
 *     dragged sits on the cursor, so the edges touching it would always be at a
 *     distance of 0)
 *   - The tentative feature being drawn (it is not a feature of the Store, so it never
 *     enters in the first place)
 *
 * For a custom feature type, FeatureTypeHandler.getSnapTargets is used when it is
 * registered (the vertex provider calls it).
 */

import { type Messages, resolveMessages } from '../../messages.js';
import type { BoundingBox } from '../../store/types.js';
import {
  DEFAULT_SNAP_OPTIONS,
  type SnapCandidate,
  type SnapPointCandidate,
  type SnapProvider,
  type SnapProviderContext,
  type SnapSegmentCandidate,
} from '../types.js';
import { createSteppedGuideSnapProvider } from './guide.js';
import { createStoreIntersectionSnapProvider } from './intersection.js';
import type { StoreSnapProviderDeps } from './shared.js';
import {
  collectFeatureSegmentsInBBox,
  collectVertexCandidatesInBBox,
  hasSnapEdges,
  isExcludedVertex,
  queryFeatures,
  segmentIntersectsBBox,
} from './shared.js';

export type { StoreSnapProviderDeps } from './shared.js';

/**
 * Builds the vertex provider for the Store
 *
 * The vertices and the vertex references per type are aligned with the vertex
 * handles of the selection UI (computeVertexHandles). The inner rings (holes) of a
 * Polygon and the parts of the Multi variants are targets as they are. The listing
 * is narrowed down to the extent that falls within the bbox (a huge feature uses the
 * index).
 *
 * @internal
 */
export function createStoreVertexSnapProvider(deps: StoreSnapProviderDeps): SnapProvider {
  return {
    name: 'core:store-vertex',

    candidates(bbox: BoundingBox, ctx: SnapProviderContext): SnapCandidate[] {
      const candidates: SnapCandidate[] = [];

      for (const feature of queryFeatures(deps, bbox, ctx)) {
        // A custom type is left to the registered getSnapTargets
        const custom = deps.snapTargets?.get(feature.type);
        if (custom) {
          for (const candidate of custom(feature, ctx)) {
            const featureId = candidate.featureId ?? feature.id;
            if (!('start' in candidate) && isExcludedVertex(featureId, candidate.vertex, ctx)) {
              continue;
            }
            candidates.push({ ...candidate, featureId });
          }
          continue;
        }

        for (const vertex of collectVertexCandidatesInBBox(feature, bbox)) {
          if (isExcludedVertex(feature.id, vertex.vertexRef, ctx)) continue;
          const candidate: SnapPointCandidate = {
            kind: 'vertex',
            coordinate: vertex.position,
            featureId: feature.id,
            vertex: vertex.vertexRef,
          };
          candidates.push(candidate);
        }
      }

      return candidates;
    },
  };
}

/**
 * Builds the edge provider for the Store
 *
 * The candidates are returned as segments (2 end points), and the computation of the
 * point closest to the cursor is left to SnapService. The vertex references of both
 * ends are included as well (tracing reads them).
 *
 * @internal
 */
export function createStoreEdgeSnapProvider(deps: StoreSnapProviderDeps): SnapProvider {
  return {
    name: 'core:store-edge',

    candidates(bbox: BoundingBox, ctx: SnapProviderContext): SnapCandidate[] {
      const candidates: SnapCandidate[] = [];

      for (const feature of queryFeatures(deps, bbox, ctx)) {
        // The candidates of a custom type are returned by the vertex provider
        // (getSnapTargets)
        if (deps.snapTargets?.get(feature.type)) continue;
        if (!hasSnapEdges(feature.type)) continue;

        collectFeatureSegmentsInBBox(feature, bbox, (start, end, startRef, endRef) => {
          if (!segmentIntersectsBBox(start, end, bbox)) return;
          // An edge touching the vertex being dragged passes over the cursor, so it is
          // excluded
          if (isExcludedVertex(feature.id, startRef, ctx)) return;
          if (isExcludedVertex(feature.id, endRef, ctx)) return;

          const candidate: SnapSegmentCandidate = {
            kind: 'edge',
            start,
            end,
            startRef,
            endRef,
            featureId: feature.id,
          };
          candidates.push(candidate);
        });
      }

      return candidates;
    },
  };
}

/**
 * The arguments for building the full set of built-in providers
 *
 * @internal
 */
export interface BuiltInSnapProvidersOptions {
  /**
   * Returns the step angle of the north-based guide (degrees; default: 45). It is read at
   * every query, so a change takes effect from the next resolution
   */
  getNorthStepDegrees?: () => number;
  /** The tile size (used to convert the length of a guide; default: 512) */
  tileSize?: number;
  /**
   * The messages table the descriptions of the candidates come from (the intersections
   * and the guides; missing entries fall back to English)
   */
  messages?: Partial<Messages>;
}

/**
 * Builds the full set of built-in providers (in the order vertex -> edge ->
 * intersection -> guide)
 *
 * @internal
 */
export function createBuiltInSnapProviders(
  deps: StoreSnapProviderDeps,
  options: BuiltInSnapProvidersOptions = {},
): SnapProvider[] {
  const messages = resolveMessages(options.messages);
  return [
    createStoreVertexSnapProvider(deps),
    createStoreEdgeSnapProvider(deps),
    createStoreIntersectionSnapProvider({ ...deps, messages }),
    createSteppedGuideSnapProvider(
      { store: deps.store },
      options.getNorthStepDegrees ?? (() => DEFAULT_SNAP_OPTIONS.guideStepDegrees),
      { tileSize: options.tileSize, messages },
    ),
  ];
}
