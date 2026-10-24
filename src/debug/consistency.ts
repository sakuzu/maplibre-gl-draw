// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The checks that the state of an instance agrees with itself (`DrawOptions.debug.checks`)
 *
 * They are for development and tests: each reads the whole of what it checks, so it costs as
 * much as the document. The checks of the document and of the selection run once each
 * notification of the Store has gone out (once per outermost transaction); the check of what is
 * drawn runs once a frame is drawn, since what the drawing keeps is made again for the frame after
 * a change, not at the change.
 *
 * - `id-index`: the ids of the rows find their rows, and each row is read where its id says;
 *   the groups of the layers held as rows are found by their ids; the items of a layer of
 *   objects name features and groups of that layer, and the members of a group are its features
 * - `selection`: the rows marked as selected in bulk are the rows of the selection in bulk, and
 *   their copies in the row groups say so; what is selected is there and shown (its own flag,
 *   its group and its layer, and the local hiding); a selection with nothing in it has no type
 * - `drawing`: what the drawing keeps is made from the state it copies, as it is now (see the
 *   drawings, `checkCopies`)
 *
 * A check that fails throws `DrawError` with the code `invalid-state`, unless it is one of the
 * checks allowed to fail; every failure is given to `onFailure` first.
 */

import { utf8String } from '@sakuzu/tabane';
import { featureTablesInternals } from '../feature-table/feature-tables.js';
import { STATE_BULK } from '../feature-table/row-state.js';
import { DrawError } from '../shared/draw-error.js';
import type { Store } from '../store/store.js';
import type { ConsistencyCheck, ConsistencyCheckOptions, ConsistencyFailure } from './types.js';

export type { ConsistencyCheck, ConsistencyCheckOptions, ConsistencyFailure } from './types.js';

/**
 * Every check, in the order they run
 *
 * @internal
 */
export const CONSISTENCY_CHECKS: readonly ConsistencyCheck[] = ['id-index', 'selection', 'drawing'];

/** The problems a check gives at most (the rest are not read) */
const PROBLEM_LIMIT = 20;

/**
 * What the checks read
 *
 * @internal
 */
export interface ConsistencyTarget {
  readonly store: Store;
  /** The differences between what the drawing keeps and what it copies (none while not drawn) */
  readonly checkDrawing: () => string[];
}

/**
 * The ids of the rows and the places they are read at, and the containment of the layers of
 * objects (`id-index`)
 *
 * @internal
 */
export function checkIdIndex(store: Store): string[] {
  const problems: string[] = [];
  const full = (): boolean => problems.length >= PROBLEM_LIMIT;
  const tables = featureTablesInternals(store.tables);
  if (tables) {
    const ids = tables.ids;
    for (let handle = 0; handle < ids.size && !full(); handle++) {
      if (!ids.isLinked(handle)) continue;
      const id = ids.idOf(handle) as string;
      const found = ids.handleOf(id);
      if (found !== handle) {
        problems.push(`the id "${id}" of the row ${handle} finds the row ${found}`);
        continue;
      }
      const place = tables.placeOf(handle);
      if (!place) continue;
      const handleThere = place.group.data.handles[place.row];
      const idThere = utf8String(place.group.data.ids, place.row);
      if (handleThere !== handle || idThere !== id) {
        problems.push(
          `the row ${handle} of the id "${id}" is read where the row ${handleThere} of the id "${idThere}" is`,
        );
      }
    }
  }
  for (const layer of store.listLayers()) {
    if (full()) break;
    if (layer.kind === 'table') {
      if (!tables) problems.push(`the layer "${layer.id}" is held as rows, and there are no rows`);
      continue;
    }
    for (const item of layer.items) {
      const feature = store.getFeature(item);
      const group = feature ? undefined : store.getGroup(item);
      if (feature) {
        if (feature.layerId !== layer.id || feature.groupId !== undefined) {
          problems.push(
            `the feature "${item}" is an item of the layer "${layer.id}", and says it is in the layer "${feature.layerId}"${feature.groupId === undefined ? '' : ` and the group "${feature.groupId}"`}`,
          );
        }
      } else if (group) {
        if (group.layerId !== layer.id) {
          problems.push(
            `the group "${item}" is an item of the layer "${layer.id}", and says it is in the layer "${group.layerId}"`,
          );
        }
        if (group.kind === 'table') continue;
        for (const member of group.featureIds) {
          const memberFeature = store.getFeature(member);
          if (memberFeature?.groupId !== group.id || memberFeature.layerId !== layer.id) {
            problems.push(
              `the feature "${member}" is a member of the group "${group.id}" of the layer "${layer.id}", and ${memberFeature ? `says it is in the group "${memberFeature.groupId}" of the layer "${memberFeature.layerId}"` : 'is not there'}`,
            );
          }
        }
      } else {
        problems.push(`the item "${item}" of the layer "${layer.id}" names nothing`);
      }
    }
  }
  if (tables) {
    for (const group of store.listGroups()) {
      if (full()) break;
      if (group.kind !== 'table') continue;
      const handle = tables.groups.handleOfId(group.id);
      if (handle < 0 || tables.groups.idOf(handle) !== group.id) {
        problems.push(
          `the group "${group.id}" is not found by its id among the groups of the rows`,
        );
      }
    }
  }
  return problems;
}

/**
 * The selection: the marks of the rows, and what is selected (`selection`)
 *
 * @internal
 */
export function checkSelection(store: Store): string[] {
  const problems: string[] = [];
  const full = (): boolean => problems.length >= PROBLEM_LIMIT;
  const selection = store.getSelection();
  const tables = featureTablesInternals(store.tables);
  const bulkRows = selection.bulk ? store.getSelectedRows() : null;
  if (selection.bulk && !bulkRows) problems.push('the selection is in bulk, and has no rows');
  if (tables) {
    const marked = tables.states.bulkHandles();
    const rows = bulkRows?.handles ?? new Int32Array(0);
    const selected = new Set(rows);
    for (const handle of marked) {
      if (full()) break;
      if (!selected.has(handle)) {
        problems.push(
          `the row ${handle} is marked as selected in bulk, and is not in the selection`,
        );
      }
      const place = tables.placeOf(handle);
      if (place && (place.group.state[place.row] & STATE_BULK) === 0) {
        problems.push(
          `the row ${handle} is marked as selected in bulk, and its copy in its row group is not`,
        );
      }
    }
    for (const handle of rows) {
      if (full()) break;
      if (!marked.has(handle)) {
        problems.push(`the row ${handle} is selected in bulk, and is not marked as selected`);
      }
    }
  }
  const ids =
    bulkRows && tables
      ? Array.from(bulkRows.handles, (handle) => tables.ids.idOf(handle) ?? `(row ${handle})`)
      : selection.ids;
  if (selection.type === null && (ids.length > 0 || selection.bulk)) {
    problems.push(`nothing is selected, and the selection holds ${ids.length} items`);
  }
  if (selection.type !== null && ids.length === 0 && !selection.bulk) {
    problems.push(`the selection is of the type "${selection.type}", and holds nothing`);
  }
  for (const id of ids) {
    if (full()) break;
    const hidden = hiddenReason(store, selection.type, id);
    if (hidden) problems.push(`the selected ${selection.type ?? 'item'} "${id}" ${hidden}`);
  }
  return problems;
}

/** Why a selected item should not be selected: not there, or hidden (null when it may be) */
function hiddenReason(
  store: Store,
  type: 'feature' | 'group' | 'layer' | null,
  id: string,
): string | null {
  const layerHidden = (layerId: string): string | null => {
    const layer = store.getLayer(layerId);
    if (!layer) return `is in the layer "${layerId}", which is not there`;
    if (!layer.visible) return `is in the layer "${layerId}", which is hidden`;
    if (store.isHidden(layerId)) return `is in the layer "${layerId}", which is hidden here`;
    return null;
  };
  const groupHidden = (groupId: string | undefined): string | null => {
    if (groupId === undefined) return null;
    const group = store.getGroup(groupId);
    if (!group) return `is in the group "${groupId}", which is not there`;
    if (!group.visible) return `is in the group "${groupId}", which is hidden`;
    if (store.isHidden(groupId)) return `is in the group "${groupId}", which is hidden here`;
    return null;
  };
  switch (type) {
    case 'feature': {
      const feature = store.getFeature(id);
      if (!feature) return 'is not there';
      if (!feature.visible) return 'is hidden';
      if (store.isHidden(id)) return 'is hidden here';
      return groupHidden(feature.groupId) ?? layerHidden(feature.layerId);
    }
    case 'group': {
      const group = store.getGroup(id);
      if (!group) return 'is not there';
      if (!group.visible) return 'is hidden';
      if (store.isHidden(id)) return 'is hidden here';
      return layerHidden(group.layerId);
    }
    case 'layer': {
      const layer = store.getLayer(id);
      if (!layer) return 'is not there';
      if (!layer.visible) return 'is hidden';
      if (store.isHidden(id)) return 'is hidden here';
      return null;
    }
    default:
      return null;
  }
}

/**
 * The checks of an instance, run as `DrawOptions.debug.checks` asks
 *
 * @internal
 */
export class ConsistencyChecks {
  readonly #target: ConsistencyTarget;
  readonly #run: ReadonlySet<ConsistencyCheck>;
  readonly #allowed: ReadonlySet<ConsistencyCheck>;
  readonly #onFailure: ((failure: ConsistencyFailure) => void) | undefined;

  constructor(options: true | ConsistencyCheckOptions, target: ConsistencyTarget) {
    this.#target = target;
    const given = options === true ? {} : options;
    this.#run = new Set(given.run ?? CONSISTENCY_CHECKS);
    this.#allowed = new Set(given.allowed ?? []);
    this.#onFailure = given.onFailure;
  }

  /** Runs the checks of the document and of the selection (once a notification went out) */
  afterNotify(): void {
    this.#check('id-index', () => checkIdIndex(this.#target.store));
    this.#check('selection', () => checkSelection(this.#target.store));
  }

  /** Runs the check of what is drawn (once a frame is drawn) */
  afterFrame(): void {
    this.#check('drawing', this.#target.checkDrawing);
  }

  #check(check: ConsistencyCheck, read: () => string[]): void {
    if (!this.#run.has(check)) return;
    const problems = read();
    if (problems.length === 0) return;
    const failure: ConsistencyFailure = { check, problems: problems.slice(0, PROBLEM_LIMIT) };
    this.#onFailure?.(failure);
    if (this.#allowed.has(check)) return;
    throw new DrawError(
      'invalid-state',
      `The state does not agree with itself (${check}): ${problems[0]}`,
      failure,
    );
  }
}
