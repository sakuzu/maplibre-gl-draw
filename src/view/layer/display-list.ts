// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The display list of the immediate path
 *
 * The immediate path draws the features in view in draw order every frame. Building that list
 * from the Store each frame (the ordered list, the local visibility, then the viewport) walks
 * every feature and allocates arrays of that size, which costs milliseconds on a store of 100k
 * features even when a handful are on screen.
 *
 * The ordered list of the features to display depends only on the Store, so it is kept here and
 * rebuilt only after a change that can alter it. The features in view are then taken from the
 * spatial index (the ids inside the view) and put in draw order by their rank in the list, which
 * costs in proportion to what is on screen rather than to the whole store.
 */

import { type DisplayStore, getDisplayFeatures } from '../../store/local-visibility.js';
import type { Feature, StateChanges } from '../../store/types.js';

/**
 * Above this share of the list, the ids in view are taken by walking the list (sorting that
 * many ranks would cost more than one pass over the list)
 */
const SORT_SHARE_LIMIT = 0.25;

/**
 * The ordered list of the features to display, rebuilt only when the Store changes it
 *
 * @internal
 */
export class DisplayListCache {
  private readonly store: DisplayStore;
  private list: Feature[] | null = null;
  /** featureId → position in the list (built when first needed) */
  private rank: Map<string, number> | null = null;

  constructor(store: DisplayStore) {
    this.store = store;
  }

  /** The features to display, in draw order (the same list as getDisplayFeatures) */
  features(): Feature[] {
    if (!this.list) this.list = getDisplayFeatures(this.store);
    return this.list;
  }

  /**
   * The features among `ids` that are displayed, in draw order
   *
   * @param ids The ids to keep (the features inside the view)
   */
  inOrder(ids: ReadonlySet<string>): Feature[] {
    const list = this.features();
    if (ids.size > list.length * SORT_SHARE_LIMIT) {
      return list.filter((feature) => ids.has(feature.id));
    }

    const rank = this.rankOf(list);
    const positions = new Int32Array(ids.size);
    let count = 0;
    for (const id of ids) {
      const position = rank.get(id);
      if (position !== undefined) positions[count++] = position;
    }
    const sorted = positions.subarray(0, count).sort();
    const result: Feature[] = new Array(count);
    for (let i = 0; i < count; i++) result[i] = list[sorted[i]];
    return result;
  }

  /**
   * Follows a change of the Store
   *
   * The list depends on the features (their visibility and membership), the layers, the groups,
   * their order and the local visibility (reported as a change of the UI state). A change of the
   * selection alone, for example, keeps it.
   */
  applyChanges(changes: StateChanges): void {
    if (
      changes.features !== undefined ||
      changes.layers !== undefined ||
      changes.groups !== undefined ||
      changes.layerReorder !== undefined ||
      changes.groupReorder !== undefined ||
      changes.uiStateChanged === true
    ) {
      this.invalidate();
    }
  }

  /** Forgets the list (the next use rebuilds it) */
  invalidate(): void {
    this.list = null;
    this.rank = null;
  }

  private rankOf(list: Feature[]): Map<string, number> {
    if (!this.rank) {
      const rank = new Map<string, number>();
      for (let i = 0; i < list.length; i++) rank.set(list[i].id, i);
      this.rank = rank;
    }
    return this.rank;
  }
}
