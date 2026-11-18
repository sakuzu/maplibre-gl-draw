// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The write of the built-in Store that takes in pages built in a Worker (`createRowsFromPages`)
 *
 * The pages are checked before anything is taken in, so that the write applies to all of their
 * rows or to none: that each is a page the builder made and nothing took in yet, built for the
 * dimensions of the layer; that every group a row names is a group of the layer; that no id is that
 * of a row in use or of a group, nor the id of another row of the pages. The ids are compared as
 * their bytes in the pages, with the hashes the builder made of them: nothing is made per row.
 *
 * The pages are then given to the tables as they are: the tables hold their columns, and give
 * their rows references. Only the column of the groups of each page is written over, in place,
 * with the references of the groups (a Worker cannot know them, see `pages.ts`).
 *
 * A row whose id is that of a deleted row nothing keeps is taken in with the reference of that row
 * once the tables hold it no more (after `clear`, or after the next version of its page); while
 * they still hold it, the tables cannot take the page, and the write returns false.
 *
 * @internal
 */

import { KasaneError } from '@sakuzu/kasane';
import { listPages } from '@sakuzu/kasane/render';
import { DrawError } from '../../shared/errors.js';
import { countWork } from '../../shared/work-counts.js';
import { addRows, readsValuesBefore, readValuesBefore, write } from './changes.js';
import { dimensionsOfPositions, positionsOf, type StoreDocument } from './document.js';
import { isKept } from './kept-rows.js';
import { type BuiltPage, isBuiltPage, writeGroupPlaces, writeGroupRefs } from './pages.js';
import { dimensionsOfValues } from './row-columns.js';
import type { FeatureRowField, Store } from './types.js';

/** The bit of the flags of a row of a page that is deleted */
const ROW_DELETED = 1;

/** The fields every row of a page is written with, besides its attributes */
const PAGE_FIELDS: readonly FeatureRowField[] = [
  'type',
  'parent',
  'orderKey',
  'visible',
  'locked',
  'style',
  'geometry',
];

/** Runs a call of the tables, throwing an error of the tables as a `DrawError` of the same code */
function tables<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    if (error instanceof KasaneError) throw new DrawError(error.code, error.message, error);
    throw error;
  }
}

/** The FNV-1a hash of the bytes `[from, to)` */
function hashBytes(bytes: Uint8Array, from: number, to: number): number {
  let hash = 0x811c9dc5;
  for (let i = from; i < to; i++) {
    hash ^= bytes[i];
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Whether the bytes `[from, to)` of two arrays are the same */
function sameBytes(
  a: Uint8Array,
  aFrom: number,
  aTo: number,
  b: Uint8Array,
  bFrom: number,
  bTo: number,
): boolean {
  if (aTo - aFrom !== bTo - bFrom) return false;
  for (let i = 0; i < aTo - aFrom; i++) if (a[aFrom + i] !== b[bFrom + i]) return false;
  return true;
}

/** The id of row `r` of a page, read from its bytes (for a message only) */
function idOf(page: BuiltPage, r: number): string {
  const { offsets, bytes } = page.ids;
  return new TextDecoder().decode(bytes.subarray(offsets[r], offsets[r + 1]));
}

/**
 * The ids of the groups of the document as bytes, by the hash of their bytes: what the ids of the
 * rows of pages are compared with
 */
function groupIdBytesOf(document: StoreDocument): Map<number, Uint8Array[]> {
  const out = new Map<number, Uint8Array[]>();
  const encoder = new TextEncoder();
  for (const id of document.groups.keys()) {
    const bytes = encoder.encode(id);
    const hash = hashBytes(bytes, 0, bytes.length);
    const list = out.get(hash);
    if (list) list.push(bytes);
    else out.set(hash, [bytes]);
  }
  return out;
}

/**
 * `createRowsFromPages` of the built-in Store over a document
 *
 * @internal
 */
export function createRowsFromPagesOf(document: StoreDocument): Store['createRowsFromPages'] {
  const { changes, counts, rowWrites } = document;
  const { kept } = changes;

  return (layerId, pages) =>
    write(changes, 'createRowsFromPages', () => {
      const what = 'createRowsFromPages';
      if (typeof layerId !== 'string' || !document.layers.has(layerId)) {
        throw new DrawError('notFound', `${what}: no layer has the id ${JSON.stringify(layerId)}`);
      }
      if (!Array.isArray(pages))
        throw new DrawError('invalidInput', `${what}: the pages are not an array`);
      const positions = positionsOf(document, layerId);
      const dimensions = dimensionsOfPositions(positions);
      let total = 0;
      for (const page of pages) {
        if (!isBuiltPage(page)) {
          throw new DrawError(
            'invalidInput',
            `${what}: a value is not a page built by createRowPageBuilder that no Store took in yet`,
          );
        }
        if (dimensionsOfValues(page.valuesPerPosition, page.thirdValue) !== dimensions) {
          throw new DrawError(
            'invalidInput',
            `${what}: a page was built for ${page.valuesPerPosition} values per position, the layer ${JSON.stringify(layerId)} has ${positions.valuesPerPosition}`,
          );
        }
        total += page.length;
      }
      const built = pages as readonly BuiltPage[];

      // The references of the groups each list of the ids of groups names: one array per list
      // (the pages of one builder share theirs)
      const refsOf = new Map<readonly string[], Int32Array>();
      countWork(counts, 'objectsCreated');
      for (const page of built) {
        let refs = refsOf.get(page.groupIds);
        if (!refs) {
          refs = new Int32Array(page.groupIds.length).fill(-1);
          countWork(counts, 'objectsCreated');
          refsOf.set(page.groupIds, refs);
        }
        const groups = page.groups;
        for (let r = 0; r < groups.length; r++) {
          const at = groups[r];
          if (at < 0 || refs[at] >= 0) continue;
          const id = page.groupIds[at];
          const group = document.groups.get(id);
          if (!group || group.layerId !== layerId) {
            throw new DrawError(
              'notFound',
              `${what}: a row names the group ${JSON.stringify(id)}, which the layer ${JSON.stringify(layerId)} does not have`,
            );
          }
          const ref = tables(() => document.rows.getGroupRef(id));
          if (ref === undefined) {
            throw new DrawError(
              'notFound',
              `${what}: the group ${JSON.stringify(id)} is not there`,
            );
          }
          refs[at] = ref;
        }
      }

      // The ids: none of a row in use or of a group, nor twice in the pages
      const index = tables(() => listPages(document.rows));
      const groupIds = document.groups.size > 0 ? groupIdBytesOf(document) : null;
      if (groupIds) countWork(counts, 'objectsCreated');
      /** The hashes of the ids of the rows of the pages met so far (one page has no id twice) */
      const hashes = built.length > 1 ? new Set<number>() : null;
      if (hashes) countWork(counts, 'objectsCreated');
      /** The rows whose ids are those of deleted rows the tables no longer hold */
      const again: number[] = [];
      countWork(counts, 'objectsCreated');
      let held = false;
      for (let p = 0; p < built.length; p++) {
        const page = built[p];
        const { offsets, bytes } = page.ids;
        for (let r = 0; r < page.length; r++) {
          const from = offsets[r];
          const to = offsets[r + 1];
          if (groupIds) {
            const same = groupIds.get(hashBytes(bytes, from, to));
            if (same?.some((id) => sameBytes(id, 0, id.length, bytes, from, to))) {
              throw new DrawError(
                'alreadyExists',
                `${what}: ${JSON.stringify(idOf(page, r))} is the id of a group`,
              );
            }
          }
          if (hashes) {
            const hash = page.idHashes[r];
            if (!hashes.has(hash)) {
              hashes.add(hash);
            } else {
              // A hash met again: the ids are compared with every row of the pages before of it
              for (let q = 0; q <= p; q++) {
                const other = built[q];
                const end = q === p ? r : other.length;
                for (let s = 0; s < end; s++) {
                  if (other.idHashes[s] !== hash) continue;
                  if (
                    sameBytes(
                      other.ids.bytes,
                      other.ids.offsets[s],
                      other.ids.offsets[s + 1],
                      bytes,
                      from,
                      to,
                    )
                  ) {
                    throw new DrawError(
                      'alreadyExists',
                      `${what}: ${JSON.stringify(idOf(page, r))} is given twice`,
                    );
                  }
                }
              }
            }
          }
          const handle = index.ids.handleOfEntry(page.ids, r, page.idHashes[r]);
          if (handle < 0) continue;
          const place = index.placeOf(handle);
          if (!place) {
            again.push(handle);
            continue;
          }
          const deleted = (place.group.data.flags[place.row] & ROW_DELETED) !== 0;
          if (!deleted || isKept(kept, handle)) {
            throw new DrawError(
              'alreadyExists',
              `${what}: ${JSON.stringify(idOf(page, r))} is the id of a row`,
            );
          }
          // A deleted row nothing keeps that the tables still hold
          held = true;
        }
      }
      if (held) return false;
      if (total === 0) return true;

      // The values before of the rows whose ids come back
      if (again.length > 0 && readsValuesBefore(changes)) {
        const fields = new Set<FeatureRowField>(PAGE_FIELDS);
        for (const page of built) {
          const keyed = (
            page as unknown as { keyed: readonly ({ keys?: readonly string[] } | null)[] }
          ).keyed;
          for (const key of keyed[0]?.keys ?? []) fields.add(`properties:${key}`);
        }
        readValuesBefore(changes, Int32Array.from(again), fields);
      }

      for (const page of built) writeGroupRefs(page, refsOf.get(page.groupIds) as Int32Array);
      const taken = built.filter((page) => page.length > 0);
      countWork(counts, 'objectsCreated');
      let written: ReturnType<typeof rowWrites.addPages>;
      try {
        written = tables(() => rowWrites.addPages(layerId, taken));
      } catch (error) {
        // Nothing was taken in: the pages name their groups by their places again
        for (const page of built) writeGroupPlaces(page, refsOf.get(page.groupIds) as Int32Array);
        throw error;
      }
      addRows(changes, written.rows);
      countWork(counts, 'rowsWritten', total);
      countWork(counts, 'rowsTouched', total);
      return true;
    });
}
