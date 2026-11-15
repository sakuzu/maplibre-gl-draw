// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The commits a storage of the first shape refused, taken out of the document here, so that every
 * client settles on the document the storage has (the last write to arrive at the storage stays)
 *
 * The commits not sent are taken back from the newest (their inverse written to the Store), then
 * those not refused are written again in their order, the operations they send (`writeOperations`):
 * the storage applies the same operations to the document it has without the refused ones, by the
 * same rules (a `create` of an ID there is is left out, a write to what is not there is left out),
 * so both come to the same document. What each written again takes back is read again as it writes.
 *
 * - A later commit not sent that names what a refused commit created (its own creations too) is
 *   refused with it (`dependsOnRefused`); one that only wrote the same values does not depend on it
 * - Only the commits that touch what a refused commit touched, or what one of those touched, are
 *   taken back and written again: the others name other things, and give the same document
 *   whatever comes before them. Unless one of those makes or deletes a layer or a group, or puts
 *   a group elsewhere: a move of what is not live is skipped, and whether a feature is live hangs
 *   on its layer and its group, which a commit that moves it need not name. Then every commit from
 *   the first refused one is taken back and written again
 * - A refused commit is as if it was never made: an undo or a redo of a commit written again
 *   writes what takes that commit back now (or nothing, when that commit is refused), and the
 *   steps of undo of the commits written again take them back as they are written now (the
 *   caller gives them what takes each back)
 *
 * @internal
 */

import type { Store } from '../../store/store.js';
import type { CommitValues } from './commit-values.js';
import { writeOperations } from './store-writes.js';
import type { ValueOperation } from './values.js';

const LAYER_KEY = 'maplibre-gl-draw:layerId';
const GROUP_KEY = 'maplibre-gl-draw:groupId';

/** What the title and the description are named by among the things a commit touches */
const DOCUMENT = '\u0000document';

/**
 * A commit of this client as operations: what it did, and what takes it back (read again when it
 * is written again)
 *
 * @internal
 */
export interface CommitOperations {
  /** The ID of the commit (none in the tests that write operations only) */
  readonly commit?: string;
  /** For an undo or a redo, the commit whose step it took (see `History.originOf`) */
  readonly origin?: string;
  operations: readonly ValueOperation[];
  inverse: ValueOperation[];
}

/**
 * Which of the later commits depend on a refused one: those that name what it created, or what a
 * commit that depends on it created
 *
 * @param later - The later commits not sent, in their order
 * @returns The indexes of `later` that depend on it
 * @internal
 */
export function dependentsOf(
  refused: CommitOperations,
  later: readonly CommitOperations[],
): number[] {
  const made = new Set<string>();
  createdIds(refused.operations, made);
  const out: number[] = [];
  later.forEach((commit, i) => {
    if (!names(commit.operations, made)) return;
    out.push(i);
    createdIds(commit.operations, made);
  });
  return out;
}

/**
 * Takes refused commits out of the document, in a transaction of the caller: the commits not sent
 * from the first refused one are taken back from the newest, and those not refused written again
 * in their order (their inverse read again)
 *
 * @param commits - The commits not sent, in their order (the first refused among them)
 * @param refused - Which of them are refused
 * @param options.every - True to take back and write again every commit, not only those that
 *   touch what the refused ones touched (for the tests, which compare both)
 * @returns What the Store refused to write (the rest is written), and the commits not refused
 *   written again, in their order (their inverse read again)
 * @internal
 */
export function takeOut(
  store: Store,
  values: CommitValues,
  commits: readonly CommitOperations[],
  refused: ReadonlySet<CommitOperations>,
  options: { readonly every?: boolean } = {},
): { readonly failed: readonly unknown[]; readonly written: readonly CommitOperations[] } {
  const touched = options.every ? null : touching(commits, refused);
  const again =
    touched === null || touched.some((i) => movesContainers(commits[i]))
      ? commits.map((_, i) => i)
      : touched;
  const failed: unknown[] = [];
  for (let k = again.length - 1; k >= 0; k--) {
    failed.push(...writeOperations(store, values, commits[again[k]].inverse).failed);
  }
  // The commits taken back, by their IDs: what an undo or a redo of one of them writes now
  const taken = new Map<string, CommitOperations>();
  for (const i of again) {
    const id = commits[i].commit;
    if (id !== undefined) taken.set(id, commits[i]);
  }
  const written: CommitOperations[] = [];
  for (const i of again) {
    const commit = commits[i];
    if (refused.has(commit)) continue;
    const from = commit.origin === undefined ? undefined : taken.get(commit.origin);
    if (from) commit.operations = refused.has(from) ? [] : from.inverse;
    const before = values.namedBefore(commit.operations);
    failed.push(...writeOperations(store, values, commit.operations).failed);
    commit.inverse = values.inverseSince(before);
    written.push(commit);
  }
  return { failed, written };
}

/**
 * The indexes of the commits refused, and of those that touch what one before them in the list
 * touches, in their order: the commits a take-out takes back and writes again
 *
 * @internal
 */
export function touching(
  commits: readonly CommitOperations[],
  refused: ReadonlySet<CommitOperations>,
): number[] {
  const touched = new Set<string>();
  const out: number[] = [];
  commits.forEach((commit, i) => {
    const ids = touchedBy(commit);
    let taken = refused.has(commit);
    if (!taken) {
      for (const id of ids) {
        if (!touched.has(id)) continue;
        taken = true;
        break;
      }
    }
    if (!taken) return;
    out.push(i);
    for (const id of ids) touched.add(id);
  });
  return out;
}

/**
 * What a commit touches: the IDs its operations and its inverse name, as what they write and as
 * the parents they put things in (where the things were before included)
 */
function touchedBy(commit: CommitOperations): Set<string> {
  const out = new Set<string>();
  for (const list of [commit.operations, commit.inverse]) {
    for (const operation of list) {
      switch (operation.type) {
        case 'create':
          out.add(operation.id);
          if (operation.kind === 'feature') {
            const layer = operation.record.properties[LAYER_KEY];
            const group = operation.record.properties[GROUP_KEY];
            if (typeof layer === 'string') out.add(layer);
            if (typeof group === 'string') out.add(group);
          } else if (operation.kind === 'group') {
            out.add(operation.record.layerId);
          }
          break;
        case 'set':
          if (operation.kind === 'document') out.add(DOCUMENT);
          else for (const id of operation.ids) out.add(id);
          break;
        case 'place':
          for (const id of operation.ids) out.add(id);
          if (operation.parentId !== null) out.add(operation.parentId);
          break;
        case 'delete':
          for (const id of operation.ids) out.add(id);
          break;
      }
    }
  }
  return out;
}

/**
 * Whether a commit makes or deletes a layer or a group, or puts a group elsewhere (taking it back
 * included): what is live under them changes
 */
function movesContainers(commit: CommitOperations): boolean {
  for (const list of [commit.operations, commit.inverse]) {
    for (const operation of list) {
      if (operation.kind !== 'layer' && operation.kind !== 'group') continue;
      if (operation.type === 'create' || operation.type === 'delete') return true;
      if (operation.type === 'place' && operation.kind === 'group') return true;
    }
  }
  return false;
}

/** Adds the IDs of what operations create */
function createdIds(operations: readonly ValueOperation[], out: Set<string>): void {
  for (const operation of operations) if (operation.type === 'create') out.add(operation.id);
}

/** Whether operations name one of the IDs given (as what they write, or as a parent) */
function names(operations: readonly ValueOperation[], ids: ReadonlySet<string>): boolean {
  if (ids.size === 0) return false;
  for (const operation of operations) {
    switch (operation.type) {
      case 'create': {
        if (ids.has(operation.id)) return true;
        if (operation.kind === 'feature') {
          const properties = operation.record.properties;
          const layer = properties[LAYER_KEY];
          const group = properties[GROUP_KEY];
          if (typeof layer === 'string' && ids.has(layer)) return true;
          if (typeof group === 'string' && ids.has(group)) return true;
        } else if (operation.kind === 'group' && ids.has(operation.record.layerId)) {
          return true;
        }
        break;
      }
      case 'set':
        if (operation.kind !== 'document' && operation.ids.some((id) => ids.has(id))) return true;
        break;
      case 'place':
        if (operation.parentId !== null && ids.has(operation.parentId)) return true;
        if (operation.ids.some((id) => ids.has(id))) return true;
        break;
      case 'delete':
        if (operation.ids.some((id) => ids.has(id))) return true;
        break;
    }
  }
  return false;
}
