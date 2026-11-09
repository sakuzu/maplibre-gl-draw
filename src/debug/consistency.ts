// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The checks that the state of an instance agrees with itself (`DrawOptions.debug.checks`)
 *
 * They are for development and tests: each reads the whole of what it checks, so it costs as
 * much as the document. The checks of the document, of the selection, of the write marks and of
 * the features kept run once each notification of the Store has gone out (once per outermost
 * transaction); the checks of
 * what is drawn run once a frame is drawn, since what the drawing keeps is made again for the
 * frame after a change, not at the change.
 *
 * - `id-index`: the ids of the rows find their rows, and each row is read where its id says;
 *   the groups of the layers held as rows are found by their ids; the items of a layer of
 *   objects name features and groups of that layer, and the members of a group are its features
 * - `selection`: the rows marked as selected in bulk are the rows of the selection in bulk, and
 *   their copies in the row groups say so; what is selected is there and shown (its own flag,
 *   its group and its layer, and the local hiding); a selection with nothing in it has no type
 * - `write-marks`: a Store of rows has one write mark, which only goes up, and its tables have
 *   it; each frame of writes that wrote rows raised it once, and the rows it wrote and their row
 *   groups have its mark (each frame is read as it ends, from the creation of the checks on); no
 *   row and no row group has a mark past the one of the Store, nor a row a mark past its group
 * - `feature-cache`: a feature kept of a row (`feature-cache.ts`) is given only while its row has
 *   the mark it was made at, and is the feature the row makes then: each one given is made again
 *   and compared, and so is each one kept at the check (a feature kept changed by its reader is
 *   found); what is kept is frozen from the creation of the checks on
 * - `drawing`: what the drawing keeps is made from the state it copies, as it is now (see the
 *   drawings, `checkCopies`)
 * - `drawing-writes`: the rows written in place in the chunks drawn in one draw (their
 *   coordinates, their styles, the rows packed again into their places) draw, as the GPU holds
 *   them, what the same rows packed afresh as a build of their chunk packs them draw (see
 *   `TableLayerRenderer.checkWrites`). Each frame
 * - `drawing-rebuild`: everything the drawing of the rows keeps (the chunks as the GPU holds
 *   them, the kind each row is drawn with, the state of the rows and its texture, the values of
 *   the styles) is what a drawing made again from the rows as they are now makes, its styles
 *   resolved afresh (see `TableLayerRenderer.checkRebuild`). It reads every row, so it runs once
 *   every {@link DRAWING_REBUILD_FRAMES} frames drawn, the first included
 * - `sketches`: each feature a sketch edits that is shown is drawn as the sketches leave it in the
 *   place of the feature, once, and the feature itself is not drawn (over a Store of rows, its row
 *   is hidden by the mark of the sketches, `STATE_HIDDEN_SKETCH`, and the sketch is drawn at its keys);
 *   no other feature is drawn otherwise. The rows a sketch moves on the GPU are in its moving set,
 *   which moves by its edit. The features sketches create are not read. Once each notification of
 *   the Store has gone out and each operation of the sketches is done
 * - `sketch-commits`: when a sketch of this client is committed with no write of the Store since
 *   the sketches were last applied, each feature it edits (and creates) that it drew, and that no
 *   sketch with an owner edits, is written with the geometry it was drawn with, to the bit
 *   (over a Store of rows, as the rows read them; the rows drawn on the GPU are not read). At each
 *   commit
 *
 * The two checks of the drawing of the rows read what the GPU holds from copies the drawing keeps
 * only while one of them runs (decided when the instance is created), and pass over what the
 * drawing marked to be made again and is still making (a chunk being built, styles being
 * resolved again, writes waiting for the next frame).
 *
 * A check that fails throws `DrawError` with the code `invalid-state`, unless it is one of the
 * checks allowed to fail; every failure is given to `onFailure` first.
 */

import { utf8String } from '@sakuzu/tabane';
import { featureTablesInternals } from '../feature-table/feature-tables.js';
import type { RowGroup } from '../feature-table/layer-table.js';
import { STATE_BULK } from '../feature-table/row-state.js';
import { DrawError } from '../shared/draw-error.js';
import type { SketchController } from '../sketches/sketch-controller.js';
import type { Store } from '../store/store.js';
import type { Feature } from '../store/types.js';
import { writeMarkKeeperOf } from '../store/write-mark-keeper.js';
import type { ConsistencyCheck, ConsistencyCheckOptions, ConsistencyFailure } from './types.js';

export type { ConsistencyCheck, ConsistencyCheckOptions, ConsistencyFailure } from './types.js';

/**
 * Every check, in the order they run
 *
 * @internal
 */
export const CONSISTENCY_CHECKS: readonly ConsistencyCheck[] = [
  'id-index',
  'selection',
  'write-marks',
  'feature-cache',
  'drawing',
  'drawing-writes',
  'drawing-rebuild',
  'sketches',
  'sketch-commits',
];

/**
 * The frames drawn between two runs of `drawing-rebuild`, which reads every row (1 runs it each
 * frame)
 *
 * @internal
 */
export const DRAWING_REBUILD_FRAMES = 8;

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
  /** The differences between the rows written in place where they are drawn and the same drawn afresh */
  readonly checkDrawnWrites: () => string[];
  /** The differences between what the drawing of the rows keeps and a drawing made again */
  readonly checkDrawnRebuild: () => string[];
  /** The sketches of the instance (none checked when omitted) */
  readonly sketches?: SketchController;
  /**
   * The differences between what is drawn and the sketches drawn over the features given (by ID,
   * with the feature each is drawn as)
   */
  readonly checkDrawnSketches?: (expected: ReadonlyMap<string, Feature>) => string[];
}

/**
 * The sketches drawn in the places of the features they edit (`sketches`): each feature a sketch edits
 * that is shown is drawn as the sketches leave it, and the drawing draws it so in its place
 *
 * @internal
 */
export function checkSketches(target: ConsistencyTarget): string[] {
  const sketches = target.sketches;
  if (!sketches) return [];
  const problems: string[] = [];
  const expected = sketches.expectedDrawn();
  const drawn = sketches.view.liveFeatures();
  for (const [id, feature] of expected) {
    if (drawn.get(id) !== feature) {
      problems.push(`the feature "${id}" a sketch edits is not drawn as the sketches leave it`);
    }
  }
  for (const id of drawn.keys()) {
    if (!expected.has(id)) problems.push(`the feature "${id}" is drawn as a sketch it has not`);
  }
  problems.push(...(target.checkDrawnSketches?.(expected) ?? []));
  problems.push(...sketches.checkMotions());
  return problems;
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

/**
 * The write marks of a Store of rows: what its frames found since the last check, and the marks
 * of the rows and of their groups now (`write-marks`)
 *
 * @internal
 */
export function checkWriteMarks(store: Store): string[] {
  const tables = featureTablesInternals(store.tables);
  const keeper = writeMarkKeeperOf(store.tables);
  if (!tables) return [];
  const problems = keeper?.takeProblems() ?? [];
  const full = (): boolean => problems.length >= PROBLEM_LIMIT;
  const mark = tables.writeMarks.mark;
  const checkGroup = (layerId: string, group: RowGroup): void => {
    if (group.mark > mark) {
      problems.push(
        `the row group ${group.handle} of the layer "${layerId}" has the write mark ${group.mark}, past the mark ${mark}`,
      );
    }
    for (let r = 0; r < group.data.length && !full(); r++) {
      if (group.marks[r] <= group.mark) continue;
      problems.push(
        `the row ${group.data.handles[r]} has the write mark ${group.marks[r]}, past the mark ${group.mark} of its group`,
      );
    }
  };
  for (const layer of store.listLayers()) {
    if (full()) break;
    const table = tables.layerTable(layer.id);
    if (!table) continue;
    for (let g = 0; g < table.groupCount && !full(); g++) checkGroup(layer.id, table.groupAt(g));
    if (table.delta.group && !full()) checkGroup(layer.id, table.delta.group);
  }
  return problems;
}

/**
 * The features kept of rows: what the ones given since the last check found, and the ones kept
 * now (`feature-cache`)
 *
 * @internal
 */
export function checkFeatureCache(store: Store): string[] {
  return featureTablesInternals(store.tables)?.featureCache.takeProblems() ?? [];
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
  /**
   * The frames drawn between two runs of `drawing-rebuild` for the checks made from now on (the
   * tests set 1, to run it every frame)
   */
  static rebuildEvery = DRAWING_REBUILD_FRAMES;

  readonly #target: ConsistencyTarget;
  readonly #rebuildEvery = Math.max(1, Math.floor(ConsistencyChecks.rebuildEvery));
  /** The frames drawn since the checks were made */
  #frames = 0;
  readonly #run: ReadonlySet<ConsistencyCheck>;
  readonly #allowed: ReadonlySet<ConsistencyCheck>;
  readonly #onFailure: ((failure: ConsistencyFailure) => void) | undefined;

  constructor(options: true | ConsistencyCheckOptions, target: ConsistencyTarget) {
    this.#target = target;
    const given = options === true ? {} : options;
    this.#run = new Set(given.run ?? CONSISTENCY_CHECKS);
    this.#allowed = new Set(given.allowed ?? []);
    this.#onFailure = given.onFailure;
    // The frames of writes are read as they end, from now on
    if (this.#run.has('write-marks')) writeMarkKeeperOf(target.store.tables)?.watch();
    // The features kept are checked as they are given, from now on
    if (this.#run.has('feature-cache')) {
      featureTablesInternals(target.store.tables)?.featureCache.watch();
    }
    // The commits of the sketches are checked as they are made
    if (this.#run.has('sketch-commits')) {
      target.sketches?.setCommitCheck((problems) => this.#check('sketch-commits', () => problems));
    }
  }

  /** Stops the checks the sketches run (at each commit) */
  stop(): void {
    this.#target.sketches?.setCommitCheck(null);
  }

  /** Runs the check of the sketches drawn (once an operation of the sketches is done) */
  afterSketches(): void {
    this.#check('sketches', () => checkSketches(this.#target));
  }

  /**
   * Runs the checks of the document, of the selection, of the write marks and of the features
   * kept (once a notification went out)
   */
  afterNotify(): void {
    this.#check('id-index', () => checkIdIndex(this.#target.store));
    this.#check('selection', () => checkSelection(this.#target.store));
    this.#check('write-marks', () => checkWriteMarks(this.#target.store));
    this.#check('feature-cache', () => checkFeatureCache(this.#target.store));
    this.#check('sketches', () => checkSketches(this.#target));
  }

  /**
   * Runs the checks of what is drawn (once a frame is drawn): `drawing-rebuild` once every few
   * frames
   */
  afterFrame(): void {
    const frame = this.#frames++;
    this.#check('drawing', this.#target.checkDrawing);
    this.#check('drawing-writes', this.#target.checkDrawnWrites);
    if (frame % this.#rebuildEvery === 0) {
      this.#check('drawing-rebuild', this.#target.checkDrawnRebuild);
    }
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
