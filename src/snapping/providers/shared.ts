// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Shared helpers of the built-in snapping providers
 *
 * They gather the narrowing down of candidate features and the listing of edges that
 * the providers originating from the Store (vertex, edge, intersection) use in
 * common. The behavior is the same as in the original providers/store.ts; only the
 * location was moved so that the intersection provider can reuse it.
 */

import {
  getSegmentGrid,
  querySegmentIndicesInBBox,
  SEGMENT_INDEX_THRESHOLD,
} from '../../shared/math/segment-grid.js';
import {
  forEachPart,
  hasSnapEdges,
  isClosedCoords,
  isInBBox,
  makeRefFactory,
} from '../../shared/utils/feature-segments.js';
import { isSameVertexRef } from '../../shared/utils/vertex-ref.js';
import { isLocallyHidden } from '../../store/local-visibility.js';
import type { SpatialIndex } from '../../store/spatial/spatial-index.js';
import type { Store } from '../../store/store.js';
import type { BoundingBox, Coordinate, Feature, VertexRef } from '../../store/types.js';
import { computeVertexHandles } from '../../view/ui/handles.js';
import type { SnapTargetsRegistry } from '../custom-targets.js';
import type { SnapProviderContext } from '../types.js';

// The edge listing is defined in shared/ (the tracing graph uses it too); re-exported here for
// the existing imports
export type { SegmentVisitor } from '../../shared/utils/feature-segments.js';
export {
  collectFeatureSegments,
  collectFeatureSegmentsInBBox,
  hasSnapEdges,
  segmentIntersectsBBox,
} from '../../shared/utils/feature-segments.js';

/**
 * The dependencies of the built-in providers
 *
 * @internal
 */
export interface StoreSnapProviderDeps {
  store: Store;
  spatialIndex: SpatialIndex;
  /**
   * The snapping candidates of the custom feature types of this draw instance (when omitted,
   * only the standard types are known)
   */
  snapTargets?: SnapTargetsRegistry;
}

/**
 * Whether the feature is a snapping target (whether it is displayed)
 *
 * It looks at both the shared visible cascade (feature / group / layer) and the local
 * hiding that applies to this client only.
 */
export function isSnapVisible(feature: Feature, store: Store): boolean {
  if (!feature.visible) return false;
  if (!store.getLayer(feature.layerId)?.visible) return false;
  if (feature.groupId && store.getGroup(feature.groupId)?.visible === false) return false;
  return !isLocallyHidden(feature, store);
}

/**
 * Lists the candidate features near the bbox
 */
export function queryFeatures(
  deps: StoreSnapProviderDeps,
  bbox: BoundingBox,
  ctx: SnapProviderContext,
): Feature[] {
  const lng = (bbox.minX + bbox.maxX) / 2;
  const lat = (bbox.minY + bbox.maxY) / 2;
  // findNear queries a square extent, so the larger of the tolerances is used
  const tolerance = Math.max(bbox.maxX - lng, bbox.maxY - lat);

  const features: Feature[] = [];
  const seen = new Set<string>();
  for (const id of deps.spatialIndex.findNear([lng, lat], tolerance)) {
    if (seen.has(id)) continue;
    seen.add(id);
    if (id === ctx.excludeFeatureId) continue;
    if (ctx.excludeFeatureIds?.has(id)) continue;

    const feature = deps.store.getFeature(id);
    if (!feature) continue;
    if (!isSnapVisible(feature, deps.store)) continue;

    features.push(feature);
  }
  return features;
}

/**
 * Whether the vertex is to be excluded
 */
export function isExcludedVertex(
  featureId: string,
  vertex: VertexRef | undefined,
  ctx: SnapProviderContext,
): boolean {
  const exclude = ctx.excludeVertex;
  if (!exclude || !vertex) return false;
  return exclude.featureId === featureId && isSameVertexRef(vertex, exclude.vertex);
}

/**
 * A vertex candidate limited to the bbox
 */
export interface VertexCandidate {
  position: Coordinate;
  vertexRef: VertexRef;
}

/**
 * Gathers the vertices of one coordinate sequence (a line / a ring) that are inside
 * the bbox
 *
 * The vertices and the vertex references listed are exactly the same as in
 * computeVertexHandles (view/ui/handles.ts). The last item of a ring is a copy of the
 * first one, so no handle is produced for it (through the index, the last item is
 * normalized to index 0 and the duplicate is dropped). A line produces a handle on
 * its last vertex even when it is closed, so it is not normalized.
 */
function collectPartVerticesInBBox(
  coords: Coordinate[],
  ring: number,
  part: number | undefined,
  isRing: boolean,
  bbox: BoundingBox,
  out: VertexCandidate[],
): void {
  const closedRing = isRing && isClosedCoords(coords);
  const vertexCount = closedRing ? coords.length - 1 : coords.length;
  if (vertexCount === 0) return;

  const toRef = makeRefFactory(ring, part);

  // For a small part, building an index costs more, so it is scanned as it is
  if (coords.length < SEGMENT_INDEX_THRESHOLD) {
    for (let i = 0; i < vertexCount; i++) {
      if (!isInBBox(coords[i], bbox)) continue;
      out.push({ position: coords[i], vertexRef: toRef(i) });
    }
    return;
  }

  // Both ends of an edge that falls within the bbox become vertex candidates. For a
  // vertex inside the bbox, an edge touching it always falls within the bbox, so
  // nothing is missed
  const seen = new Set<number>();
  const indices: number[] = [];
  for (const segment of querySegmentIndicesInBBox(getSegmentGrid(coords), bbox)) {
    for (const raw of [segment, segment + 1]) {
      const index = closedRing && raw === vertexCount ? 0 : raw;
      if (index >= vertexCount) continue;
      if (seen.has(index)) continue;
      seen.add(index);
      indices.push(index);
    }
  }

  // Aligned to the same order as a full scan (ascending by index)
  indices.sort((a, b) => a - b);
  for (const index of indices) {
    if (!isInBBox(coords[index], bbox)) continue;
    out.push({ position: coords[index], vertexRef: toRef(index) });
  }
}

/**
 * Gathers the vertices of a feature that are inside the bbox
 *
 * The bbox is the cursor position +- the tolerance (in longitude and in latitude),
 * and the distance test of SnapService measures the pixel distance with the same
 * conversion. A vertex outside the bbox can therefore never be inside the tolerance,
 * and discarding it here does not change the candidates.
 *
 * For types without edges (Point / MultiPoint / custom types), the full listing of
 * computeVertexHandles is simply narrowed down by the bbox, as before.
 */
export function collectVertexCandidatesInBBox(
  feature: Feature,
  bbox: BoundingBox,
): VertexCandidate[] {
  const candidates: VertexCandidate[] = [];

  if (!hasSnapEdges(feature.type)) {
    for (const handle of computeVertexHandles(feature)) {
      // Only Point / MultiPoint reach this path, and a vertex reference is always
      // attached
      if (!handle.vertexRef) continue;
      if (!isInBBox(handle.position, bbox)) continue;
      candidates.push({ position: handle.position, vertexRef: handle.vertexRef });
    }
    return candidates;
  }

  forEachPart(feature, (coords, ring, part, isRing) => {
    collectPartVerticesInBBox(coords, ring, part, isRing, bbox, candidates);
  });
  return candidates;
}
