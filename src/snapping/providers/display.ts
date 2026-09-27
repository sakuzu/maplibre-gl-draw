// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Snapping providers for datasets (vertex, edge, intersection)
 *
 * They add the reference data imported from the library (datasets)
 * as passive snapping targets. They never touch the data itself; they only read the
 * features the dataset holds.
 *
 * The targets are only the displayed features of a displayed (visible) dataset.
 * Whether it is interactive is not looked at (snapping works on what is visible).
 *
 * The candidates are listed in the same manner as the Store version
 * (providers/store.ts): vertices are gathered with computeVertexHandles and edges
 * with collectFeatureSegments. Both featureId and datasetId are attached to a
 * candidate, and the vertex references of both ends are attached to an edge (tracing
 * reads them).
 *
 * For intersections, the pairs of segments of "display x display" and
 * "display x Store" are computed (Store x Store is the responsibility of
 * providers/intersection.ts).
 */

import type { DatasetManager } from '../../dataset/manager.js';
import type { Dataset } from '../../dataset/types.js';
import { segmentIntersection } from '../../geometry/split.js';
import { MESSAGES_EN, type Messages } from '../../messages.js';
import type { SpatialIndex } from '../../store/spatial/spatial-index.js';
import { RBushSpatialIndex } from '../../store/spatial/spatial-index.js';
import type { Store } from '../../store/store.js';
import type { BoundingBox, Coordinate, Feature } from '../../store/types.js';
import { computeVertexHandles } from '../../view/ui/handles.js';
import type { SnapTargetsRegistry } from '../custom-targets.js';
import type {
  SnapCandidate,
  SnapPointCandidate,
  SnapProvider,
  SnapProviderContext,
  SnapSegmentCandidate,
} from '../types.js';
import {
  collectFeatureSegments,
  hasSnapEdges,
  isExcludedVertex,
  queryFeatures,
  segmentIntersectsBBox,
} from './shared.js';

/**
 * The dependencies of the providers for datasets
 */
export interface DisplaySnapProviderDeps {
  /** The manager of the datasets */
  datasets: DatasetManager;
  /** The Store (used as the counterpart of an intersection) */
  store: Store;
  /** The SpatialIndex (used as the counterpart of an intersection) */
  spatialIndex: SpatialIndex;
  /** Whether snapping to the data is enabled (options.datasets of SnapService) */
  isEnabled: () => boolean;
  /** The snapping candidates of the custom feature types of this draw instance */
  snapTargets?: SnapTargetsRegistry;
  /**
   * The messages table the description of an intersection comes from (the same entry as
   * an intersection originating from the Store; default: English)
   */
  messages?: Pick<Messages, 'snapIntersection'>;
}

/**
 * The full set of providers that were built
 */
export interface DisplaySnapProviders {
  /** The vertex, edge and intersection providers */
  providers: SnapProvider[];
  /**
   * Looks up a feature of a dataset
   *
   * This is the entry point through which tracing resolves the feature of a snapping
   * target (it is wired to ModeContext.getDatasetFeature).
   */
  getFeature(datasetId: string, featureId: string): Feature | null;
  /**
   * Looks up the features of a displayed dataset that fall within an extent
   *
   * This is the entry point through which tracing gathers the material for the graph
   * of edges (it is wired to ModeContext.getDatasetTraceFeatures).
   */
  queryFeatures(bbox: BoundingBox): Feature[];
  /** The same features as `queryFeatures`, each with the ID of its dataset */
  queryRows(bbox: BoundingBox): Array<{ datasetId: string; feature: Feature }>;
}

/**
 * The index of each dataset
 */
interface DatasetIndex {
  index: RBushSpatialIndex;
  byId: Map<string, Feature>;
}

/**
 * The cache entry of each dataset
 */
interface CacheEntry {
  dataset: Dataset;
  /** The index (discarded when the features are replaced, and rebuilt on the next
   * reference) */
  built: DatasetIndex | null;
  /** Unsubscribes from change */
  unsubscribe: () => void;
}

/**
 * The segments of one feature, used in the computation of intersections
 */
interface SegmentGroup {
  /** When it originates from a dataset, that dataset ID */
  datasetId?: string;
  featureId: string;
  segments: Array<{ start: Coordinate; end: Coordinate }>;
}

/**
 * Whether the feature type is a target of vertex snapping
 *
 * It targets the point types in addition to the types that have edges. Types that do
 * not originate from GeoJSON, such as Circle and Image, are out of scope.
 */
function hasSnapVertices(type: string): boolean {
  return hasSnapEdges(type) || type === 'Point' || type === 'MultiPoint';
}

/**
 * Builds the snapping providers for datasets
 */
export function createDisplaySnapProviders(deps: DisplaySnapProviderDeps): DisplaySnapProviders {
  const cache = new Map<string, CacheEntry>();
  // The description of an intersection candidate (read by the status bar and the like)
  const intersectionDescription = deps.messages?.snapIntersection ?? MESSAGES_EN.snapIntersection;

  /**
   * Gets the cache entry of a dataset (building it when there is none)
   */
  function entryOf(dataset: Dataset): CacheEntry {
    const cached = cache.get(dataset.id);
    if (cached && cached.dataset === dataset) return cached;
    cached?.unsubscribe();

    const entry: CacheEntry = { dataset, built: null, unsubscribe: () => {} };
    entry.unsubscribe = dataset.on('change', (payload) => {
      // It is not rebuilt on a change of visibility or of style
      if (payload.reason === 'features') entry.built = null;
    });
    cache.set(dataset.id, entry);
    return entry;
  }

  /**
   * Gets the index (rebuilding it when it was discarded)
   */
  function indexOf(entry: CacheEntry): DatasetIndex {
    if (entry.built) return entry.built;

    const index = new RBushSpatialIndex();
    const byId = new Map<string, Feature>();
    for (const feature of entry.dataset.getFeatures()) {
      index.insert(feature);
      byId.set(feature.id, feature);
    }

    entry.built = { index, byId };
    return entry.built;
  }

  /**
   * Discards the cache of the datasets that were removed
   */
  function prune(alive: Set<string>): void {
    for (const [id, entry] of cache) {
      if (alive.has(id)) continue;
      entry.unsubscribe();
      cache.delete(id);
    }
  }

  /**
   * Lists the snapping target features near the bbox
   *
   * ctx.excludeFeatureId / excludeVertex are not looked at. Both exist to keep a
   * feature being edited in the Store from snapping to itself, and they have nothing
   * to do with the features of datasets, which are never dragged.
   */
  function nearbyFeatures(bbox: BoundingBox): Array<{ datasetId: string; feature: Feature }> {
    const datasets = deps.datasets.list();
    prune(new Set(datasets.map((dataset) => dataset.id)));

    const lng = (bbox.minX + bbox.maxX) / 2;
    const lat = (bbox.minY + bbox.maxY) / 2;
    // findNear queries a square extent, so the larger of the tolerances is used
    const tolerance = Math.max(bbox.maxX - lng, bbox.maxY - lat);

    const result: Array<{ datasetId: string; feature: Feature }> = [];
    for (const dataset of datasets) {
      if (!dataset.visible) continue;

      // A feature that was not drawn because of collision thinning is not a snapping
      // target either (a vertex being pulled towards a point that is not visible is a
      // source of confusion, just as it is in hit testing)
      const drawable = dataset.getVisibleFeatureIds();

      const { index, byId } = indexOf(entryOf(dataset));
      const seen = new Set<string>();
      for (const id of index.findNear([lng, lat], tolerance)) {
        if (seen.has(id)) continue;
        seen.add(id);

        const feature = byId.get(id);
        if (!feature) continue;
        if (feature.visible === false) continue;
        if (drawable !== null && !drawable.has(feature.id)) continue;

        result.push({ datasetId: dataset.id, feature });
      }
    }
    return result;
  }

  /**
   * Gathers the edges of the datasets that fall within the bbox
   */
  function collectDisplaySegments(bbox: BoundingBox): SegmentGroup[] {
    const groups: SegmentGroup[] = [];

    for (const { datasetId, feature } of nearbyFeatures(bbox)) {
      if (!hasSnapEdges(feature.type)) continue;

      const segments: Array<{ start: Coordinate; end: Coordinate }> = [];
      collectFeatureSegments(feature, (start, end) => {
        if (!segmentIntersectsBBox(start, end, bbox)) return;
        segments.push({ start, end });
      });

      if (segments.length > 0) groups.push({ datasetId, featureId: feature.id, segments });
    }

    return groups;
  }

  /**
   * Gathers the edges of the Store that fall within the bbox (the counterpart of an
   * intersection)
   */
  function collectStoreSegments(bbox: BoundingBox, ctx: SnapProviderContext): SegmentGroup[] {
    const groups: SegmentGroup[] = [];

    for (const feature of queryFeatures(
      { store: deps.store, spatialIndex: deps.spatialIndex, snapTargets: deps.snapTargets },
      bbox,
      ctx,
    )) {
      // The candidates of a custom type are returned by the vertex provider
      // (getSnapTargets)
      if (deps.snapTargets?.get(feature.type)) continue;
      if (!hasSnapEdges(feature.type)) continue;

      const segments: Array<{ start: Coordinate; end: Coordinate }> = [];
      collectFeatureSegments(feature, (start, end, startRef, endRef) => {
        if (!segmentIntersectsBBox(start, end, bbox)) return;
        if (isExcludedVertex(feature.id, startRef, ctx)) return;
        if (isExcludedVertex(feature.id, endRef, ctx)) return;
        segments.push({ start, end });
      });

      if (segments.length > 0) groups.push({ featureId: feature.id, segments });
    }

    return groups;
  }

  const vertexProvider: SnapProvider = {
    name: 'core:display-vertex',

    candidates(bbox: BoundingBox): SnapCandidate[] {
      if (!deps.isEnabled()) return [];

      const candidates: SnapCandidate[] = [];
      for (const { datasetId, feature } of nearbyFeatures(bbox)) {
        if (!hasSnapVertices(feature.type)) continue;

        for (const handle of computeVertexHandles(feature)) {
          const candidate: SnapPointCandidate = {
            kind: 'vertex',
            coordinate: handle.position,
            featureId: feature.id,
            datasetId,
            vertex: handle.vertexRef,
          };
          candidates.push(candidate);
        }
      }
      return candidates;
    },
  };

  const edgeProvider: SnapProvider = {
    name: 'core:display-edge',

    candidates(bbox: BoundingBox): SnapCandidate[] {
      if (!deps.isEnabled()) return [];

      const candidates: SnapCandidate[] = [];
      for (const { datasetId, feature } of nearbyFeatures(bbox)) {
        if (!hasSnapEdges(feature.type)) continue;

        collectFeatureSegments(feature, (start, end, startRef, endRef) => {
          if (!segmentIntersectsBBox(start, end, bbox)) return;

          const candidate: SnapSegmentCandidate = {
            kind: 'edge',
            start,
            end,
            startRef,
            endRef,
            featureId: feature.id,
            datasetId,
          };
          candidates.push(candidate);
        });
      }
      return candidates;
    },
  };

  const intersectionProvider: SnapProvider = {
    name: 'core:display-intersection',

    candidates(bbox: BoundingBox, ctx: SnapProviderContext): SnapCandidate[] {
      if (!deps.isEnabled()) return [];

      const displayGroups = collectDisplaySegments(bbox);
      if (displayGroups.length === 0) return [];

      const storeGroups = collectStoreSegments(bbox, ctx);
      if (displayGroups.length < 2 && storeGroups.length === 0) return [];

      const candidates: SnapCandidate[] = [];
      const seen = new Set<string>();

      /** Makes the intersections of the segments of 2 features into candidates (the
       * origin is the display side) */
      const intersect = (source: SegmentGroup, other: SegmentGroup): void => {
        for (const a of source.segments) {
          for (const b of other.segments) {
            const point = segmentIntersection(a.start, a.end, b.start, b.end);
            if (point === null) continue;

            // The same point can come out of several pairs, so they are merged into one
            const key = `${point[0]},${point[1]}`;
            if (seen.has(key)) continue;
            seen.add(key);

            const candidate: SnapPointCandidate = {
              kind: 'intersection',
              coordinate: point,
              featureId: source.featureId,
              datasetId: source.datasetId,
              description: intersectionDescription,
            };
            candidates.push(candidate);
          }
        }
      };

      for (let i = 0; i < displayGroups.length; i++) {
        for (let j = i + 1; j < displayGroups.length; j++) {
          intersect(displayGroups[i], displayGroups[j]);
        }
        for (const group of storeGroups) {
          intersect(displayGroups[i], group);
        }
      }

      return candidates;
    },
  };

  return {
    providers: [vertexProvider, edgeProvider, intersectionProvider],

    queryFeatures(bbox: BoundingBox): Feature[] {
      return nearbyFeatures(bbox).map((entry) => entry.feature);
    },

    queryRows: (bbox) => nearbyFeatures(bbox),

    getFeature(datasetId: string, featureId: string): Feature | null {
      const dataset = deps.datasets.get(datasetId);
      if (!dataset) {
        const stale = cache.get(datasetId);
        stale?.unsubscribe();
        cache.delete(datasetId);
        return null;
      }
      return indexOf(entryOf(dataset)).byId.get(featureId) ?? null;
    },
  };
}
