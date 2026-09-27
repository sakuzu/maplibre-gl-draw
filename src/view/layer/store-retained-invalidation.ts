// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Detection of the changes that invalidate every retained chunk
 *
 * Some inputs of the retained batches do not arrive as a change of the Store: the set of locally
 * hidden features (updated in place), the registry of companion drawing and the generations of
 * the terrain. They are checked once per frame, and any change discards the whole cache.
 */

import type { Layer, StoreChange } from '../../store/types.js';
import type { FeatureCompanionRegistry } from '../feature-companion.js';
import { getAnchorElevationGeneration } from '../terrain/anchor.js';
import type { TerrainContext } from '../terrain/context.js';

/**
 * Snapshots of the inputs that invalidate every chunk
 *
 * Each method records the current value and reports whether it changed since the previous call.
 * The first call only records (there is no cache yet, so nothing has to be discarded).
 */
export class RetainedInvalidationWatch {
  /** Previous snapshot of the set of locally hidden features */
  private hiddenSnapshot = new Set<string>();
  private hiddenSnapshotReady = false;

  /**
   * Previous generation of the companion drawing (feature companion) registry
   *
   * Registering or unregistering a provider can change the result of classifyFeature, so the
   * cached classification is discarded whenever the generation changes.
   */
  private companionGeneration = -1;

  /**
   * Previous generation of the terrain subdivision
   *
   * The fill and the outline of a polygon bake the subdivision step into the vertex data. When
   * the step changes (terrain switched on or off, a zoom threshold crossed) they have to be
   * rebuilt. A line is split on the GPU side and bakes nothing, so it would not need a rebuild,
   * but the generation only changes on a zoom crossing or when terrain is switched, so discarding
   * everything is acceptable.
   */
  private terrainGeneration = -1;
  /**
   * Previous generation of the cells of the globe
   *
   * On the globe the fill and the outline of a polygon bake the cut along the Mercator plane
   * (`view/globe-subdivision.ts`). The generation changes when the globe starts or stops being
   * drawn and when the zoom crosses an integer that changes a cell.
   */
  private globeGeneration = -1;
  /**
   * Generation of the baked anchor elevation (-1 when not built yet)
   *
   * A point batch bakes the ground elevation into each instance. Unless it is rebuilt when a DEM
   * tile arrives and the elevation changes, only the points are left behind at the old height.
   */
  private anchorElevationGeneration = -1;

  /**
   * Whether the set of locally hidden features changed
   *
   * The Store updates the same Set in place, so a reference comparison is impossible. The hidden
   * set is usually small, so it is compared by count first and then by every element.
   */
  locallyHiddenChanged(current: ReadonlySet<string>): boolean {
    if (!this.hiddenSnapshotReady) {
      this.hiddenSnapshot = new Set(current);
      this.hiddenSnapshotReady = true;
      return false;
    }

    if (current.size === this.hiddenSnapshot.size) {
      let same = true;
      for (const id of current) {
        if (!this.hiddenSnapshot.has(id)) {
          same = false;
          break;
        }
      }
      if (same) return false;
    }

    this.hiddenSnapshot = new Set(current);
    return true;
  }

  /**
   * Whether providers of companion drawing were added or removed
   *
   * When the registrations change, the classification "a feature with a companion goes into an
   * immediate chunk" can change. Comparing the generation is a single integer, so with no change
   * the cost per frame is effectively zero.
   */
  companionsChanged(companions: FeatureCompanionRegistry): boolean {
    const generation = companions.generation();
    if (generation === this.companionGeneration) return false;

    // On the first time there is no cache at all, so nothing has to be discarded
    const first = this.companionGeneration === -1;
    this.companionGeneration = generation;
    return !first;
  }

  /**
   * Whether a generation of the terrain changed
   *
   * There are three things to look at: the subdivision step of the terrain and the cells of the
   * globe (the split points of polygons and lines change), and the anchor elevation (the ground
   * height baked into the points changes). DEM tiles arrive asynchronously, so the last advances
   * several times after the first frame.
   */
  terrainChanged(terrain: TerrainContext): boolean {
    let changed = false;

    const generation = terrain.renderState.generation;
    if (generation !== this.terrainGeneration) {
      const first = this.terrainGeneration === -1;
      this.terrainGeneration = generation;
      if (!first) changed = true;
    }

    if (terrain.globeGeneration !== this.globeGeneration) {
      const first = this.globeGeneration === -1;
      this.globeGeneration = terrain.globeGeneration;
      if (!first) changed = true;
    }

    const anchorGeneration = getAnchorElevationGeneration(terrain);
    if (anchorGeneration !== this.anchorElevationGeneration) {
      const first = this.anchorElevationGeneration === -1;
      this.anchorElevationGeneration = anchorGeneration;
      if (!first) changed = true;
    }

    return changed;
  }

  /**
   * Forgets the snapshot of the hidden set (the next call records it again)
   *
   * The generations are kept: a disposed cache still knows the generations it last saw.
   */
  resetLocallyHidden(): void {
    this.hiddenSnapshot = new Set();
    this.hiddenSnapshotReady = false;
  }
}

/**
 * Whether an update of a layer changed only its opacity
 *
 * The opacity is applied at draw time (a uniform of the retained batches, a factor of the drape
 * source), so such an update needs no rebuild. Any other field that differs, including one this
 * function does not know, counts as a change (the safe side).
 */
export function isOpacityOnlyLayerChange(previous: Layer, layer: Layer): boolean {
  if (previous.opacity === layer.opacity) return false;
  const keys = new Set([...Object.keys(previous), ...Object.keys(layer)]);
  for (const key of keys) {
    if (key === 'opacity') continue;
    if (previous[key as keyof Layer] !== layer[key as keyof Layer]) return false;
  }
  return true;
}

/**
 * Whether a change of the layers consists only of opacity updates (nothing created, deleted or
 * reordered, and every update is {@link isOpacityOnlyLayerChange})
 */
export function isOpacityOnlyLayersChange(layers: NonNullable<StoreChange['layers']>): boolean {
  if (layers.created?.length || layers.deleted?.length || layers.orderChanged) return false;
  const updated = layers.updated ?? [];
  if (updated.length === 0) return false;
  return updated.every(({ layer, previous }) => isOpacityOnlyLayerChange(previous, layer));
}
