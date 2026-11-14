// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The parts of a large commit: how a commit is cut into batches no larger than a storage takes
 * (`batchesOf`), and how a storage puts them together again (`createPartCollector`), on a server
 * as well
 */

import { DrawError } from '../../shared/draw-error.js';
import type { BatchHeader, ValueBatch, ValueOperation } from './values.js';

/**
 * Puts the parts of the commits together: what a storage that receives batches applies once
 * every part of a commit is there. It runs as it is on a server.
 */
export interface PartCollector {
  /**
   * Takes a batch. A batch of one part gives its operations at once; the part that completes a
   * commit gives every operation of the commit, in the order of its parts; any other part gives
   * `null`. A batch whose `Batch.id` it took is not counted again (`null`): a part sent again, of
   * a commit being put together or of one it gave (a batch of one part included). The IDs of the
   * batches of the commits it gave are kept for that.
   *
   * @throws `DrawError` with the code `invalidInput` for a part that is not one of its commit
   *   (an index outside the count, or a count other than the one of the parts before)
   */
  add(batch: ValueBatch): readonly ValueOperation[] | null;
  /** Lets go of the parts of a commit that will not be completed */
  abandon(commit: string): void;
}

/** The parts of one commit received so far */
interface Collecting {
  readonly count: number;
  readonly parts: (readonly ValueOperation[] | undefined)[];
  readonly ids: Set<string>;
  received: number;
}

/**
 * A collector of the parts of the commits: it holds the parts of the commits not complete, and
 * the IDs of the batches of those it gave
 */
export function createPartCollector(): PartCollector {
  const commits = new Map<string, Collecting>();
  // The batches of the commits given
  const given = new Set<string>();
  return {
    add(batch) {
      const { index, count } = batch.part;
      if (!Number.isInteger(count) || count < 1 || !Number.isInteger(index)) {
        throw invalidPart(batch, 'its part has no whole index and count');
      }
      if (index < 0 || index >= count) throw invalidPart(batch, 'its index is outside its count');
      if (given.has(batch.id)) return null;
      let collecting = commits.get(batch.commit);
      if (!collecting) {
        if (count === 1) {
          given.add(batch.id);
          return batch.operations;
        }
        collecting = { count, parts: new Array(count), ids: new Set(), received: 0 };
        commits.set(batch.commit, collecting);
      } else if (collecting.count !== count) {
        throw invalidPart(batch, 'its count is not the one of the parts before');
      }
      if (collecting.ids.has(batch.id) || collecting.parts[index] !== undefined) return null;
      collecting.ids.add(batch.id);
      collecting.parts[index] = batch.operations;
      collecting.received++;
      if (collecting.received < collecting.count) return null;
      commits.delete(batch.commit);
      for (const id of collecting.ids) given.add(id);
      return (collecting.parts as (readonly ValueOperation[])[]).flat();
    },
    abandon(commit) {
      commits.delete(commit);
    },
  };
}

function invalidPart(batch: ValueBatch, reason: string): DrawError {
  return new DrawError(
    'invalidInput',
    `The batch ${JSON.stringify(batch.id)} of the commit ${JSON.stringify(batch.commit)} is not a part of it: ${reason}`,
  );
}

/**
 * What tells one commit, for the batches it is cut into
 *
 * @internal
 */
export type CommitHeader = Pick<BatchHeader, 'commit' | 'label' | 'writtenAtMilliseconds'>;

/**
 * The batches of a commit: its operations in their order, cut so that the JSON of each batch is
 * no larger than `maxBytes` where it can be. An operation on many IDs larger than that is cut by
 * its IDs; one on one ID (a feature created with a large geometry) goes alone in its batch,
 * whatever its size. A commit with no operation has no batch. The batch of the part `i` has the
 * ID `${commit}.${i}`, the same each time the commit is cut.
 *
 * @internal
 */
export function batchesOf(
  header: CommitHeader,
  operations: readonly ValueOperation[],
  maxBytes: number,
): ValueBatch[] {
  const cutting = batchesInSteps(header, operations, maxBytes);
  let next = cutting.next();
  while (!next.done) next = cutting.next();
  return next.value;
}

/** The operations measured between two yields of {@link batchesInSteps} */
const OPERATIONS_PER_YIELD = 256;

/**
 * {@link batchesOf} a few operations at a time: it yields between them, so that the one who cuts
 * a commit of many operations looks at the time and goes on in a later task
 *
 * @returns The batches, once every operation is cut
 * @internal
 */
export function* batchesInSteps(
  header: CommitHeader,
  operations: readonly ValueOperation[],
  maxBytes: number,
): Generator<void, ValueBatch[], undefined> {
  if (operations.length === 0) return [];
  const base = {
    schema: 1 as const,
    commit: header.commit,
    ...(header.label !== undefined && { label: header.label }),
    writtenAtMilliseconds: header.writtenAtMilliseconds,
  };
  // What a batch holds besides its operations, with a part of the largest index and count
  const room =
    maxBytes -
    bytesOf({ ...base, id: `${header.commit}.000000`, part: { index: 999999, count: 999999 } }) -
    bytesOf({ operations: [] });
  const parts: ValueOperation[][] = [];
  let current: ValueOperation[] = [];
  let used = 0;
  const close = (): void => {
    if (current.length === 0) return;
    parts.push(current);
    current = [];
    used = 0;
  };
  const put = (operation: ValueOperation, size: number): void => {
    // The comma between two operations
    const added = current.length === 0 ? size : size + 1;
    if (current.length > 0 && used + added > room) close();
    used += current.length === 0 ? size : size + 1;
    current.push(operation);
  };
  for (let i = 0; i < operations.length; i++) {
    for (const piece of piecesOf(operations[i], room)) put(piece.operation, piece.size);
    if ((i + 1) % OPERATIONS_PER_YIELD === 0) yield;
  }
  close();
  return parts.map((part, index) => ({
    ...base,
    id: `${header.commit}.${index}`,
    part: { index, count: parts.length },
    operations: part,
  }));
}

/** An operation and the bytes of its JSON */
interface Piece {
  readonly operation: ValueOperation;
  readonly size: number;
}

/** An operation, cut by its IDs into operations no larger than `room` where it can be */
function piecesOf(operation: ValueOperation, room: number): Piece[] {
  const size = bytesOf(operation);
  if (size <= room || !('ids' in operation) || operation.ids.length < 2) {
    return [{ operation, size }];
  }
  const half = Math.ceil(operation.ids.length / 2);
  return [
    ...piecesOf(slicedOperation(operation, 0, half), room),
    ...piecesOf(slicedOperation(operation, half, operation.ids.length), room),
  ];
}

/** The operation on the IDs from `start` to `end` of an operation on many IDs */
function slicedOperation(
  operation: Extract<ValueOperation, { ids: readonly string[] }>,
  start: number,
  end: number,
): ValueOperation {
  const ids = operation.ids.slice(start, end);
  if (operation.type === 'place') {
    return { ...operation, ids, keys: operation.keys.slice(start, end) };
  }
  return { ...operation, ids } as ValueOperation;
}

const ENCODER = new TextEncoder();

/** The bytes of the JSON of a value, in UTF-8 */
function bytesOf(value: unknown): number {
  const text = JSON.stringify(value);
  // Most of the text is ASCII: its bytes are its characters
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the range of ASCII
  return /^[\u0000-\u007f]*$/.test(text) ? text.length : ENCODER.encode(text).length;
}
