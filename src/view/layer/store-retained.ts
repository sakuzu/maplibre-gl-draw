// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Retained-mode rendering of the Store features
 *
 * Immediate mode repeats "resolve the style → compute the relative coordinates → build the
 * vertices on the CPU → upload to the GPU" for every feature on every frame. Here a retained
 * batch (a GPU resource) is prepared per layer in advance and a frame only issues the draw calls.
 * The vertex data does not depend on the camera (projection is done with the projectionData and
 * zoom uniforms of each frame), so it only has to be rebuilt when the set of features or the
 * style rules change.
 *
 * **The rendering result (including the z-order) must be identical to immediate mode.**
 * To that end the feature list is cut into runs at exactly the positions where "the BatchManager
 * of immediate mode flushes a batch", and the runs are drawn in order. Kinds that cannot be
 * retained (dashed lines, images, point shapes without instancing support, custom types) are put
 * into their own run and sent through the immediate-mode path.
 *
 * A change that moves only a few vertices, such as a vertex drag, does not rebuild the chunk.
 * The diff of the vertices that moved is queued, and right before drawing only the corresponding
 * texels of the coordinate texture of the line batch are rewritten. Rebuilding a line with many
 * vertices every frame would overflow the frame (see the comments on queueCoordPatch and
 * SDFLineRenderer.patchRetainedBatchCoords for the details).
 *
 * A retained batch itself does not depend on the camera. Drawing every chunk on every frame
 * would, however, push a large amount of off-screen geometry to the GPU when the data is far
 * wider than the viewport. Each chunk therefore keeps a longitude/latitude bbox, and at draw time
 * only the chunks that do not intersect the expanded viewport are skipped. The unit of thinning
 * is the chunk, and the contents of a batch are not rebuilt for it.
 *
 * This file holds the cache that ties the parts together. The parts are
 *
 * - `store-retained-classify.ts`: the classification of a feature into the kind of its run
 * - `store-retained-chunk.ts`: the chunk, and the building and releasing of its batch
 * - `store-retained-collect.ts`: the conversion of features into the data of a batch
 * - `store-retained-bbox.ts`: the bbox of a chunk and the thinning by the viewport
 * - `store-retained-coord-patch.ts`: the incremental update of the vertices of a line chunk
 * - `store-retained-immediate.ts`: the immediate-mode drawing of the chunks that are not retained
 * - `store-retained-invalidation.ts`: the inputs outside the Store changes that discard the cache
 */

import type { ProjectionData } from 'maplibre-gl';
import { getDisplayFeatures, isLocallyHidden } from '../../store/local-visibility.js';
import type { Store } from '../../store/store.js';
import type { BoundingBox, Feature, Layer, StoreChange } from '../../store/types.js';
import type { FeatureCompanionRegistry } from '../feature-companion.js';
import { layerDrawFactors } from '../renderers/draw-factors.js';
import type { RetainedRendererSet } from '../renderers/retained.js';
import { boundsCenter, rebasedRetainedOrigin } from '../shaders/retained-origin.js';
import { TerrainContext } from '../terrain/context.js';
import type { SelectionExtensionRegistry } from '../ui/selection-ui/index.js';
import {
  bboxIntersects,
  type ChunkBBox,
  chunkBBoxToBounds,
  computeFeaturesBBox,
} from './store-retained-bbox.js';
import {
  buildChunkBatch,
  type ChunkBuildResult,
  type ChunkEntry,
  createChunkEntry,
  disposeChunkBatches,
  type LayerCache,
  STORE_CHUNK_TARGET,
} from './store-retained-chunk.js';
import { classifyFeature, featureOrigin } from './store-retained-classify.js';
import { flushCoordPatches, queueCoordPatch } from './store-retained-coord-patch.js';
import { drawFeaturesImmediate, type StoreRetainedDrawDeps } from './store-retained-immediate.js';
import {
  isOpacityOnlyLayerChange,
  RetainedInvalidationWatch,
} from './store-retained-invalidation.js';

export type { ChunkBBox } from './store-retained-bbox.js';
export { bboxIntersects } from './store-retained-bbox.js';
export { STORE_CHUNK_TARGET } from './store-retained-chunk.js';
export type { RunKind } from './store-retained-classify.js';
export { classifyFeature } from './store-retained-classify.js';
export type { LineCoordSlot } from './store-retained-coord-patch.js';
export { computeCoordinateDiff, computeLineCoordSlots } from './store-retained-coord-patch.js';
export type { StoreImmediateTarget, StoreRetainedDrawDeps } from './store-retained-immediate.js';

/**
 * Retained batch cache of the Store features
 *
 * It keeps a list of chunks per layer and rebuilds them per chunk or per layer according to the
 * changes of the Store.
 */
export class StoreRetainedCache {
  private readonly store: Store;

  /** layerId → cache */
  private readonly layers = new Map<string, LayerCache>();

  /**
   * The set of retained-mode renderers used most recently
   *
   * GPU resources are also released from outside rendering (from the subscription to the Store),
   * so where to release them is remembered.
   */
  private renderers: RetainedRendererSet | null = null;

  /** Feature lists per layer (a memo within the frame) */
  private featuresByLayer: Map<string, Feature[]> | null = null;

  /** Snapshots of the inputs that invalidate every chunk */
  private readonly watch = new RetainedInvalidationWatch();

  /** The terrain state of the draw instance (the generations that invalidate the caches) */
  private readonly terrain: TerrainContext;
  /** The selection extension points of the draw instance (extents of the custom types) */
  private readonly extensions: SelectionExtensionRegistry | undefined;

  /** The number of the current frame (counted by beginFrame) */
  private frame = 0;

  constructor(
    store: Store,
    scope: { terrain?: TerrainContext; extensions?: SelectionExtensionRegistry } = {},
  ) {
    this.store = store;
    this.terrain = scope.terrain ?? new TerrainContext();
    this.extensions = scope.extensions;
  }

  /**
   * Called at the start of a frame
   *
   * It detects a change of the local visibility (the Store updates the same Set in place, so a
   * reference comparison is impossible) and discards the memo within the frame.
   */
  beginFrame(companions: FeatureCompanionRegistry): void {
    this.frame++;
    this.featuresByLayer = null;
    // Every watch is advanced on every frame (no short circuit), so each keeps its snapshot
    const hiddenChanged = this.watch.locallyHiddenChanged(this.store.listHidden());
    const companionsChanged = this.watch.companionsChanged(companions);
    const terrainChanged = this.watch.terrainChanged(this.terrain);
    if (hiddenChanged || companionsChanged || terrainChanged) this.invalidateAll();
  }

  /**
   * Draws a single layer
   *
   * Drawing follows the order of the chunk list (= the draw order of the Store), so the z-order
   * matches immediate mode.
   *
   * When `viewportBounds` is given, the chunks that do not intersect it are skipped. Only a chunk
   * completely out of range is skipped, so the z-order does not change. As long as the expanded
   * viewport (the same range as the ViewportFilter of immediate mode) is passed, what is drawn
   * satisfies "retained mode ⊇ immediate mode" and the appearance matches as well.
   *
   * An immediate chunk is thinned further per feature with `deps.getVisibleIds`. A retained chunk
   * stays at chunk granularity because a batch cannot be split, but an immediate chunk (dashed
   * lines, images, custom types) is drawn one at a time, so drawing even the off-screen features
   * every frame just because the chunk touches the view is avoided. With this, what an immediate
   * chunk draws is the same set as in immediate mode.
   *
   * @param viewportBounds bbox of the expanded viewport (no thinning when omitted)
   */
  drawLayer(
    layerId: string,
    layer: Layer | undefined,
    projectionData: ProjectionData,
    zoom: number,
    deps: StoreRetainedDrawDeps,
    viewportBounds?: BoundingBox,
  ): void {
    this.renderers = deps.renderers;

    const cache = this.ensureLayer(layerId, layer, deps);
    const viewport = deps.renderers.viewport();
    // The opacity of the layer is multiplied in at draw time (the batches do not bake it)
    const factors = layerDrawFactors(layer);

    for (const chunk of cache.chunks) {
      // A chunk outside the screen is not drawn (a chunk with no computed bbox is always drawn)
      if (viewportBounds && chunk.bbox && !bboxIntersects(chunk.bbox, viewportBounds)) continue;

      // A batch whose origin is too far from the view for the zoom is built again around it
      this.rebaseForView(chunk, layer, zoom, deps, viewportBounds);

      // An immediate chunk, and a chunk that could not be built, are drawn in immediate mode
      if (chunk.kind === 'immediate' || chunk.dirty) {
        // Thin per feature as well, but only when the range to thin against is decided.
        // The spatial index query becomes necessary for the first time here.
        const visibleIds = viewportBounds ? deps.getVisibleIds?.() : undefined;
        drawFeaturesImmediate(
          this.store,
          chunk.featureIds,
          layer,
          projectionData,
          zoom,
          deps,
          visibleIds,
        );
        continue;
      }

      if (chunk.polygon) {
        deps.renderers.polygon.drawRetained(chunk.polygon, zoom, projectionData, viewport, factors);
      }
      if (chunk.line) {
        // The vertex diff queued during the drag is written into the coordinate texture here
        flushCoordPatches(chunk, deps.renderers.line);
        deps.renderers.line.drawRetainedBatch(chunk.line, zoom, projectionData, factors);
      }
      if (chunk.point) {
        deps.renderers.point.drawRetained(chunk.point, zoom, projectionData, factors);
      }
    }
  }

  /**
   * Applies the changes of the Store
   *
   * The decisions are conservative (rebuilding too much still renders correctly; rebuilding too
   * little leaves a stale picture).
   */
  applyChanges(changes: StoreChange): void {
    // The visibility and the ordering of a group have no reverse lookup to a layer, so everything
    // is discarded (both are rare operations)
    if (changes.groups || changes.groupReorder) {
      this.invalidateAll();
      return;
    }

    for (const feature of changes.features?.created ?? []) {
      this.invalidateLayer(feature.layerId);
    }
    for (const feature of changes.features?.deleted ?? []) {
      this.invalidateLayer(feature.layerId);
    }

    for (const { feature, previous } of changes.features?.updated ?? []) {
      if (previous.layerId !== feature.layerId) {
        this.invalidateLayer(previous.layerId);
        this.invalidateLayer(feature.layerId);
        continue;
      }
      // A change of the kind, the visibility, the style or the group can change the run split
      // itself
      if (
        previous.type !== feature.type ||
        previous.visible !== feature.visible ||
        previous.style !== feature.style ||
        previous.groupId !== feature.groupId
      ) {
        this.invalidateLayer(feature.layerId);
        continue;
      }
      // Moving a few vertices (= a drag) only needs a partial update of the coordinate texture of
      // the retained batch. No rebuild is required.
      if (this.tryQueueCoordPatch(feature, previous)) continue;

      // A change of the coordinates or properties alone only needs the chunk in question rebuilt
      this.markFeatureDirty(feature.layerId, feature.id);
    }

    // Any change of styleRule / visible / order rebuilds the whole layer. The opacity is a
    // uniform written at draw time, so a change of the opacity alone keeps the batches
    for (const { id, layer, previous } of changes.layers?.updated ?? []) {
      if (isOpacityOnlyLayerChange(previous, layer)) continue;
      this.invalidateLayer(id);
    }
    for (const layer of changes.layers?.deleted ?? []) {
      this.invalidateLayer(layer.id);
    }
    // layers.orderChanged is the order between layers, so it does not affect the chunks
    // (renderLayers calls drawLayer in layer order)

    if (changes.layerReorder) {
      this.invalidateLayer(changes.layerReorder.layerId);
    }
  }

  /**
   * Discards the cache of every layer (the GPU resources are released as well)
   */
  invalidateAll(): void {
    for (const layerId of [...this.layers.keys()]) {
      this.invalidateLayer(layerId);
    }
  }

  /**
   * Discards the cache of a single layer (the GPU resources are released as well)
   */
  invalidateLayer(layerId: string): void {
    const cache = this.layers.get(layerId);
    if (!cache) return;

    for (const chunk of cache.chunks) {
      this.disposeChunk(chunk);
    }
    this.layers.delete(layerId);
  }

  /**
   * Releases every GPU resource (called from onRemove of CustomLayer)
   *
   * @param renderers Where to release them (the ones used in the most recent draw when omitted)
   */
  dispose(renderers?: RetainedRendererSet): void {
    if (renderers) this.renderers = renderers;
    this.invalidateAll();
    this.renderers = null;
    this.watch.resetLocallyHidden();
    this.featuresByLayer = null;
  }

  // === Internals ===

  /**
   * Prepares the cache of a layer and rebuilds the dirty chunks
   *
   * When the classification disagrees with the kind of the chunk (for example when the evaluation
   * of a style rule changed through properties), the whole layer is rebuilt. When it disagrees a
   * second time as well, that frame is drawn in immediate mode and left to the next frame.
   */
  private ensureLayer(
    layerId: string,
    layer: Layer | undefined,
    deps: StoreRetainedDrawDeps,
  ): LayerCache {
    let cache = this.layers.get(layerId);
    if (!cache) {
      cache = this.buildLayerCache(layerId, layer, deps);
      this.layers.set(layerId, cache);
    }

    if (!this.buildDirtyChunks(cache, layer, deps)) return cache;

    this.invalidateLayer(layerId);
    cache = this.buildLayerCache(layerId, layer, deps);
    this.layers.set(layerId, cache);
    this.buildDirtyChunks(cache, layer, deps);
    return cache;
  }

  /**
   * Rebuilds the dirty chunks
   *
   * An immediate chunk has no retained batch, but the bbox used for thinning is recomputed here
   * (so that the timing of the build matches a retained chunk).
   *
   * @returns Whether there was a disagreement of the classification (true = rebuild the layer)
   */
  private buildDirtyChunks(
    cache: LayerCache,
    layer: Layer | undefined,
    deps: StoreRetainedDrawDeps,
  ): boolean {
    for (const chunk of cache.chunks) {
      if (!chunk.dirty) continue;

      if (chunk.kind === 'immediate') {
        chunk.bbox = this.computeChunkBBox(chunk.featureIds);
        chunk.dirty = false;
        continue;
      }

      if (this.buildChunk(chunk, layer, deps) === 'mismatch') return true;
    }
    return false;
  }

  /**
   * Computes the bbox of a list of feature ids (looked up again from the Store)
   */
  private computeChunkBBox(featureIds: readonly string[]): ChunkBBox | null {
    const features: Feature[] = [];
    for (const id of featureIds) {
      const feature = this.store.getFeature(id);
      if (feature) features.push(feature);
    }
    return computeFeaturesBBox(features, this.extensions);
  }

  /**
   * Cuts the feature list of a layer into runs and chunks
   *
   * A run is cut where the classification changes, and within a run it is split into chunks of
   * STORE_CHUNK_TARGET features each. The viewport is not looked at here (the contents of a
   * retained batch must not depend on the camera). Thinning is done per chunk at draw time.
   */
  private buildLayerCache(
    layerId: string,
    layer: Layer | undefined,
    deps: StoreRetainedDrawDeps,
  ): LayerCache {
    const chunks: ChunkEntry[] = [];
    const featureToChunk = new Map<string, number>();

    let current: ChunkEntry | null = null;

    for (const feature of this.getLayerFeatures(layerId)) {
      const kind = classifyFeature(
        feature,
        deps.renderers.styles,
        deps.customRenderers,
        deps.companions,
        layer,
      );

      if (
        current === null ||
        current.kind !== kind ||
        current.featureIds.length >= STORE_CHUNK_TARGET
      ) {
        current = createChunkEntry(kind);
        chunks.push(current);
      }

      current.featureIds.push(feature.id);
      featureToChunk.set(feature.id, chunks.length - 1);
    }

    return { chunks, featureToChunk };
  }

  /**
   * The features of a layer in draw order (visible and not locally hidden)
   *
   * It is never called in a frame where the cache is complete.
   */
  private getLayerFeatures(layerId: string): Feature[] {
    if (!this.featuresByLayer) {
      const byLayer = new Map<string, Feature[]>();
      for (const feature of getDisplayFeatures(this.store)) {
        const list = byLayer.get(feature.layerId);
        if (list) list.push(feature);
        else byLayer.set(feature.layerId, [feature]);
      }
      this.featuresByLayer = byLayer;
    }
    return this.featuresByLayer.get(layerId) ?? [];
  }

  /**
   * Builds the retained batch of a chunk
   */
  private buildChunk(
    chunk: ChunkEntry,
    layer: Layer | undefined,
    deps: StoreRetainedDrawDeps,
  ): ChunkBuildResult {
    const styles = deps.renderers.styles;

    // Re-evaluate the classification (a safety net for when the rebuild was triggered by a change
    // of properties)
    const features: Feature[] = [];
    for (const id of chunk.featureIds) {
      const feature = this.store.getFeature(id);
      if (!feature?.visible || isLocallyHidden(feature, this.store)) return 'mismatch';
      if (
        classifyFeature(feature, styles, deps.customRenderers, deps.companions, layer) !==
        chunk.kind
      ) {
        return 'mismatch';
      }
      features.push(feature);
    }

    this.disposeChunk(chunk);
    chunk.bbox = computeFeaturesBBox(features, this.extensions);

    // The origin is the center of the extent (or the one chosen for the view), not the first
    // feature: the error of the baked offsets grows with the distance from it
    const origin =
      chunk.viewOrigin ??
      (chunk.bbox ? boundsCenter(chunkBBoxToBounds(chunk.bbox)) : featureOrigin(features[0]));
    chunk.origin = origin;
    const result = buildChunkBatch(chunk, features, layer, origin, deps.renderers);
    if (result !== 'retry') chunk.dirty = false;
    return result;
  }

  /**
   * Builds a retained chunk again around the view when its origin leaves a visible error
   *
   * A chunk is cut in draw order, so its extent can be wide; seen at high zoom, the vertices on
   * screen can then be degrees away from the origin. The rule and the tolerance are in
   * `view/shaders/retained-origin.ts`. A chunk that cannot be rebuilt now stays dirty and is
   * drawn in immediate mode (exact) until the next frame.
   */
  private rebaseForView(
    chunk: ChunkEntry,
    layer: Layer | undefined,
    zoom: number,
    deps: StoreRetainedDrawDeps,
    viewportBounds: BoundingBox | undefined,
  ): void {
    if (chunk.kind === 'immediate' || chunk.dirty || !chunk.origin || !chunk.bbox) return;
    if (chunk.rebasedFrame === this.frame) return;
    const next = rebasedRetainedOrigin(
      chunk.origin,
      chunkBBoxToBounds(chunk.bbox),
      viewportBounds ?? null,
      zoom,
    );
    if (!next) return;
    chunk.viewOrigin = next;
    chunk.rebasedFrame = this.frame;
    chunk.dirty = true;
    this.buildChunk(chunk, layer, deps);
  }

  /**
   * Releases the retained batch of a chunk
   */
  private disposeChunk(chunk: ChunkEntry): void {
    disposeChunkBatches(chunk, this.renderers);
  }

  /**
   * Queues a vertex movement as a diff patch against the retained batch of its chunk
   *
   * The conditions are in queueCoordPatch. false = the caller rebuilds the chunk.
   */
  private tryQueueCoordPatch(feature: Feature, previous: Feature): boolean {
    const cache = this.layers.get(feature.layerId);
    const index = cache?.featureToChunk.get(feature.id);
    const chunk = index === undefined ? undefined : cache?.chunks[index];
    return queueCoordPatch(chunk, feature, previous, this.renderers?.line ?? null);
  }

  /**
   * Marks the chunk that carries the feature as dirty
   *
   * If there is no corresponding chunk, the whole layer is rebuilt.
   */
  private markFeatureDirty(layerId: string, featureId: string): void {
    const cache = this.layers.get(layerId);
    if (!cache) return;

    const index = cache.featureToChunk.get(featureId);
    if (index === undefined) {
      this.invalidateLayer(layerId);
      return;
    }
    cache.chunks[index].dirty = true;
  }
}
