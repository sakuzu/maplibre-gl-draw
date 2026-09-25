// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Built-in snapping provider (intersections between edges)
 *
 * It gathers the edges that fall near the cursor (within the bbox of the tolerance)
 * and returns the intersections of pairs of segments from different features as
 * point candidates with kind: 'intersection'. Self-intersections within the same
 * feature are out of scope (a self-intersecting polygon is an invalid shape, and
 * there is no demand for snapping to the self-intersection point of a polyline).
 *
 * The bbox is the size of the tolerance (10px by default), so the number of edges
 * that fall within it stays at a few. Combining them by brute force is small enough,
 * so no dedicated index is kept.
 *
 * The rules of exclusion are the same as for the vertex and edge providers: the
 * edges of an excluded feature and the edges touching the vertex being dragged are
 * not used in the computation of the intersections.
 */

import { segmentIntersection } from '../../geometry/split.js';
import { MESSAGES_EN, type Messages } from '../../messages.js';
import type { BoundingBox, Coordinate } from '../../store/types.js';
import type {
  SnapCandidate,
  SnapPointCandidate,
  SnapProvider,
  SnapProviderContext,
} from '../types.js';
import type { StoreSnapProviderDeps } from './shared.js';
import {
  collectFeatureSegmentsInBBox,
  hasSnapEdges,
  isExcludedVertex,
  queryFeatures,
  segmentIntersectsBBox,
} from './shared.js';

/**
 * The dependencies of the intersection provider
 *
 * @internal
 */
export interface StoreIntersectionSnapProviderDeps extends StoreSnapProviderDeps {
  /** The messages table the description of the candidates comes from (default: English) */
  messages?: Pick<Messages, 'snapIntersection'>;
}

/**
 * A segment used in the computation of intersections
 */
interface FeatureSegments {
  featureId: string;
  segments: Array<{ start: Coordinate; end: Coordinate }>;
}

/**
 * Gathers the edges that fall within the bbox, per feature
 */
function collectNearbySegments(
  deps: StoreSnapProviderDeps,
  bbox: BoundingBox,
  ctx: SnapProviderContext,
): FeatureSegments[] {
  const result: FeatureSegments[] = [];

  for (const feature of queryFeatures(deps, bbox, ctx)) {
    // The candidates of a custom type are returned by the vertex provider
    // (getSnapTargets)
    if (deps.snapTargets?.get(feature.type)) continue;
    if (!hasSnapEdges(feature.type)) continue;

    const segments: Array<{ start: Coordinate; end: Coordinate }> = [];
    collectFeatureSegmentsInBBox(feature, bbox, (start, end, startRef, endRef) => {
      if (!segmentIntersectsBBox(start, end, bbox)) return;
      if (isExcludedVertex(feature.id, startRef, ctx)) return;
      if (isExcludedVertex(feature.id, endRef, ctx)) return;
      segments.push({ start, end });
    });

    if (segments.length > 0) result.push({ featureId: feature.id, segments });
  }

  return result;
}

/**
 * Builds the intersection provider for the Store
 *
 * @internal
 */
export function createStoreIntersectionSnapProvider(
  deps: StoreIntersectionSnapProviderDeps,
): SnapProvider {
  // The description of the candidates (read by the status bar and the like)
  const description = deps.messages?.snapIntersection ?? MESSAGES_EN.snapIntersection;

  return {
    name: 'core:store-intersection',

    candidates(bbox: BoundingBox, ctx: SnapProviderContext): SnapCandidate[] {
      const nearby = collectNearbySegments(deps, bbox, ctx);
      if (nearby.length < 2) return [];

      const candidates: SnapCandidate[] = [];
      const seen = new Set<string>();

      for (let i = 0; i < nearby.length; i++) {
        for (let j = i + 1; j < nearby.length; j++) {
          for (const a of nearby[i].segments) {
            for (const b of nearby[j].segments) {
              const point = segmentIntersection(a.start, a.end, b.start, b.end);
              if (point === null) continue;

              // The same point can come out of several pairs, so they are merged into one
              const key = `${point[0]},${point[1]}`;
              if (seen.has(key)) continue;
              seen.add(key);

              const candidate: SnapPointCandidate = {
                kind: 'intersection',
                coordinate: point,
                featureId: nearby[i].featureId,
                description,
              };
              candidates.push(candidate);
            }
          }
        }
      }

      return candidates;
    },
  };
}
