// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The blocks of the Tabane format: a run of rows of one parent, cut into row blocks of about a
 * thousand rows
 *
 * The content of a block is a head (the magic `TBNB`, the version, the number of rows and of
 * bytes of each row block) and the bytes of its row blocks. A file of a block puts the head in one part
 * and each row block in a part of its own, so a reader decompresses and reads the row blocks one at a
 * time, in a Worker, each as it comes.
 *
 * A pure module: it depends on nothing outside `/table`, so it runs in a Worker as well.
 */

import { DrawError } from '../../shared/draw-error.js';
import type { CoordinateDimensions } from '../coordinates.js';
import { ByteSink, ByteSource, formatError } from './bytes.js';
import {
  listTabaneFileParts,
  packTabaneFile,
  readTabaneFilePart,
  type TabaneCompressor,
  unpackTabaneFile,
} from './file.js';
import { formatTabaneId, isTabaneOrigin, type TabaneId, tabaneRowSuffixOf } from './ids.js';
import { readRowBlockData } from './row-block-read.js';
import { writeRowBlock } from './row-block-write.js';
import { tabaneRowsOf } from './rows.js';
import { sha256Hex } from './sha256.js';
import type { TabaneRow, TabaneRowBlock, TabaneRowBlockData } from './types.js';

/** The first bytes of the content of a block: `TBNB` */
export const BLOCK_MAGIC = Uint8Array.of(0x54, 0x42, 0x4e, 0x42);
/**
 * The version of the format the writer writes
 *
 * @experimental
 */
export const TABANE_VERSION = 1;

/**
 * The most rows of a row block the writer makes when not told
 *
 * @experimental
 */
export const TABANE_TARGET_ROWS = 1000;
/**
 * The most coordinates of a row block the writer makes when not told (a larger row is alone)
 *
 * @experimental
 */
export const TABANE_TARGET_VERTICES = 40_000;
/**
 * The most bytes of the row blocks of a block the writer makes when not told
 *
 * @experimental
 */
export const TABANE_TARGET_BYTES = 4 << 20;

/**
 * What a block is written from: a run of rows of one parent
 *
 * @experimental
 */
export interface TabaneBlockInput {
  /** The id of the parent of the rows (the empty string for none) */
  readonly parent: string;
  /** The key the rows follow: row `i` has the key `head` followed by `tabaneRowSuffixOf(i)` */
  readonly head: string;
  /** The dimensions of the coordinates (those the positions of the rows need when omitted) */
  readonly dimensions?: CoordinateDimensions;
  /** The rows, in their order */
  readonly rows: readonly TabaneRow[];
  /** Whether the fills of the polygon rows are written (true when omitted) */
  readonly fills?: boolean;
  /** The most rows of a row block ({@link TABANE_TARGET_ROWS} when omitted) */
  readonly targetRows?: number;
  /**
   * The most coordinates of a row block ({@link TABANE_TARGET_VERTICES} when omitted); a row of more
   * is a row block of its own
   */
  readonly targetVertices?: number;
}

/**
 * A block written: its content and the offsets of its parts
 *
 * @experimental
 */
export interface TabaneBlock {
  /** The content (what the name is the hash of) */
  readonly content: Uint8Array;
  /** Where the parts of its file end: after the head, after each row block */
  readonly partEnds: readonly number[];
  /** The number of rows */
  readonly rows: number;
}

/** The number of coordinates of a row (0 without a geometry) */
function positionsOf(row: TabaneRow): number {
  let count = 0;
  const walk = (v: unknown): void => {
    if (!Array.isArray(v)) return;
    if (v.length > 0 && typeof v[0] === 'number') {
      count++;
      return;
    }
    for (const item of v) walk(item);
  };
  walk((row.geometry as { coordinates?: unknown } | null)?.coordinates);
  return count;
}

/** The dimensions every position of the rows fits */
function dimensionsOf(rows: readonly TabaneRow[]): CoordinateDimensions {
  let most = 2;
  const walk = (v: unknown): void => {
    if (!Array.isArray(v)) return;
    if (v.length > 0 && typeof v[0] === 'number') {
      if (v.length > most) most = v.length;
      return;
    }
    for (const item of v) walk(item);
  };
  for (const row of rows) walk((row.geometry as { coordinates?: unknown } | null)?.coordinates);
  return most >= 4 ? 'xyzm' : most === 3 ? 'xyz' : 'xy';
}

/**
 * The row blocks of a run of rows: at most `targetRows` rows each, and no more coordinates than
 * `targetVertices` unless a row alone has more
 *
 * @returns The number of rows of each row block
 * @internal
 */
export function cutRowBlocks(
  rows: readonly TabaneRow[],
  targetRows = TABANE_TARGET_ROWS,
  targetVertices = TABANE_TARGET_VERTICES,
): number[] {
  const out: number[] = [];
  let count = 0;
  let vertices = 0;
  for (const row of rows) {
    const v = positionsOf(row);
    if (count > 0 && (count >= targetRows || vertices + v > targetVertices)) {
      out.push(count);
      count = 0;
      vertices = 0;
    }
    count++;
    vertices += v;
  }
  if (count > 0) out.push(count);
  return out;
}

/**
 * Writes a block: the rows cut into row blocks
 *
 * @throws `DrawError` with the code `invalid-input` when a row cannot be written
 *
 * @experimental
 */
export function writeTabaneBlock(input: TabaneBlockInput): TabaneBlock {
  const rows = input.rows;
  if (rows.length === 0) throw new DrawError('invalid-input', 'Tabane: a block of no rows');
  const dimensions = input.dimensions ?? dimensionsOf(rows);
  const sizes = cutRowBlocks(rows, input.targetRows, input.targetVertices);
  const rowBlocks: Uint8Array[] = [];
  let first = 0;
  for (const size of sizes) {
    rowBlocks.push(
      writeRowBlock({
        place: { parent: input.parent, head: input.head, firstIndex: first },
        dimensions,
        rows: rows.slice(first, first + size),
        fills: input.fills ?? true,
      }),
    );
    first += size;
  }
  return blockOfRowBlocks(rowBlocks, sizes);
}

/**
 * The content of a block of the bytes of its row blocks
 *
 * @internal
 */
export function blockOfRowBlocks(
  rowBlocks: readonly Uint8Array[],
  sizes: readonly number[],
): TabaneBlock {
  const head = new ByteSink();
  head.bytes(BLOCK_MAGIC);
  head.uint(TABANE_VERSION);
  head.uint(rowBlocks.length);
  rowBlocks.forEach((g, k) => {
    head.uint(sizes[k]);
    head.uint(g.length);
  });
  const headBytes = head.finish();
  let total = headBytes.length;
  for (const g of rowBlocks) total += g.length;
  const content = new Uint8Array(total);
  content.set(headBytes);
  const partEnds = [headBytes.length];
  let at = headBytes.length;
  for (const g of rowBlocks) {
    content.set(g, at);
    at += g.length;
    partEnds.push(at);
  }
  let rows = 0;
  for (const s of sizes) rows += s;
  return { content, partEnds, rows };
}

/**
 * Writes the blocks of a long run of rows: the row blocks cut into blocks of at most `targetBytes`
 * bytes of row blocks each (a row block larger alone is a block of its own). Block `j` holds the rows
 * that follow it under the key `head` followed by `tabaneRowSuffixOf(j)`, its rows numbered from 0
 *
 * @throws `DrawError` with the code `invalid-input` when a row cannot be written
 *
 * @experimental
 */
export function writeTabaneBlocks(
  input: TabaneBlockInput & { readonly targetBytes?: number },
): TabaneBlock[] {
  const rows = input.rows;
  if (rows.length === 0) return [];
  const dimensions = input.dimensions ?? dimensionsOf(rows);
  const targetBytes = input.targetBytes ?? TABANE_TARGET_BYTES;
  const sizes = cutRowBlocks(rows, input.targetRows, input.targetVertices);
  const out: TabaneBlock[] = [];
  let rowBlocks: Uint8Array[] = [];
  let rowBlockSizes: number[] = [];
  let bytes = 0;
  let firstOfBlock = 0;
  let first = 0;
  const close = (): void => {
    out.push(blockOfRowBlocks(rowBlocks, rowBlockSizes));
    rowBlocks = [];
    rowBlockSizes = [];
    bytes = 0;
  };
  for (const size of sizes) {
    // The row block as a row block of the block being made, or of the next when it does not fit
    const write = (): Uint8Array =>
      writeRowBlock({
        place: {
          parent: input.parent,
          head: input.head + tabaneRowSuffixOf(out.length),
          firstIndex: first - firstOfBlock,
        },
        dimensions,
        rows: rows.slice(first, first + size),
        fills: input.fills ?? true,
      });
    let g = write();
    if (rowBlocks.length > 0 && bytes + g.length > targetBytes) {
      close();
      firstOfBlock = first;
      g = write();
    }
    rowBlocks.push(g);
    rowBlockSizes.push(size);
    bytes += g.length;
    first += size;
  }
  if (rowBlocks.length > 0) close();
  return out;
}

/**
 * The head of the content of a block: its row blocks, each with its number of rows and where its
 * bytes are in the content, and the number of its rows
 *
 * @experimental
 */
export interface TabaneBlockHead {
  /** The row blocks, in their order: the number of rows of each and its bytes `[start, end)` */
  readonly rowBlocks: readonly {
    readonly rows: number;
    readonly start: number;
    readonly end: number;
  }[];
  /** The number of rows of the block */
  readonly rows: number;
}

/**
 * Reads the head of the content of a block, not its row blocks: a row block is read on its own
 * with `readTabaneRowBlock(content, start, end)`
 *
 * @throws `DrawError` with the code `unsupported-format` when the bytes are not a block
 * @experimental
 */
export function readTabaneBlockHead(content: Uint8Array): TabaneBlockHead {
  const r = new ByteSource(content);
  const magic = r.take(4);
  if (BLOCK_MAGIC.some((b, i) => magic[i] !== b)) throw formatError('not a block');
  const version = r.uint();
  if (version !== TABANE_VERSION) throw formatError(`a block of the version ${version}`);
  const count = r.count(2);
  if (count < 1) throw formatError('a block of no row block');
  const heads: { rows: number; length: number }[] = [];
  for (let k = 0; k < count; k++) heads.push({ rows: r.uint(), length: r.uint() });
  let at = r.pos;
  let rows = 0;
  const rowBlocks = heads.map((h) => {
    const g = { rows: h.rows, start: at, end: at + h.length };
    at += h.length;
    rows += h.rows;
    return g;
  });
  if (at !== content.length) throw formatError('the row blocks of a block do not fill it');
  return { rowBlocks, rows };
}

/**
 * Reads the row blocks of the content of a block
 *
 * @throws `DrawError` with the code `unsupported-format` when the bytes are not a block
 *
 * @experimental
 */
export function readTabaneBlock(content: Uint8Array): TabaneRowBlock[] {
  return readBlockData(content);
}

/**
 * Reads the row blocks of the content of a block with every column
 *
 * @internal
 */
export function readBlockData(content: Uint8Array): TabaneRowBlockData[] {
  const layout = readTabaneBlockHead(content);
  return layout.rowBlocks.map((g) => {
    const rowBlock = readRowBlockData(content, g.start, g.end);
    if (rowBlock.length !== g.rows) {
      throw formatError('a row block of other rows than the head says');
    }
    return rowBlock;
  });
}

/**
 * Reads the row blocks of a file of a block, a part at a time when its parts are those of its
 * row blocks (as the writer cuts them), else from its whole content
 *
 * @throws `DrawError` with the code `unsupported-format` when the bytes are not a block
 *
 * @experimental
 */
export function readTabaneBlockFile(
  file: Uint8Array,
  compressor?: TabaneCompressor,
): TabaneRowBlock[] {
  return readBlockFileData(file, compressor);
}

/**
 * Reads the row blocks of a file of a block with every column
 *
 * @internal
 */
export function readBlockFileData(
  file: Uint8Array,
  compressor?: TabaneCompressor,
): TabaneRowBlockData[] {
  const parts = listTabaneFileParts(file);
  if (parts.length >= 2) {
    const headBytes = readTabaneFilePart(parts[0], compressor);
    const r = new ByteSource(headBytes);
    const magic = r.take(4);
    if (BLOCK_MAGIC.some((b, i) => magic[i] !== b)) throw formatError('not a block');
    const version = r.uint();
    if (version !== TABANE_VERSION) throw formatError(`a block of the version ${version}`);
    const count = r.count(2);
    const heads: { rows: number; length: number }[] = [];
    for (let k = 0; k < count; k++) heads.push({ rows: r.uint(), length: r.uint() });
    if (
      r.done &&
      count === parts.length - 1 &&
      heads.every((h, k) => parts[k + 1].contentBytes === h.length)
    ) {
      return heads.map((h, k) => {
        const bytes = readTabaneFilePart(parts[k + 1], compressor);
        const rowBlock = readRowBlockData(bytes);
        if (rowBlock.length !== h.rows) {
          throw formatError('a row block of other rows than the head says');
        }
        return rowBlock;
      });
    }
  }
  return readBlockData(unpackTabaneFile(file, compressor));
}

/**
 * The file of a block: its head and each row block in a part of its own
 *
 * @experimental
 */
export function packTabaneBlock(block: TabaneBlock, compressor?: TabaneCompressor): Uint8Array {
  return packTabaneFile(block.content, block.partEnds, compressor);
}

/**
 * Writes a block again with other ids: row `i` of the block (over its row blocks, in their order)
 * gets the origin of `first` and the number `first.number + i`. Everything else of its rows is
 * kept to the same bits (their place, coordinates, values, fills, what created them and the
 * revisions of their cells), so the rows of the block made again are the rows of the block, under
 * new ids. It answers at once, with the name of the new content (the SHA-256 that
 * `tabaneNameOf` gives): for a caller that cannot wait, as one that gives the rows of a
 * block another origin while it makes its writes again.
 *
 * @param content - The content of the block
 * @param first - The id of its first row from now on
 * @returns The block written again, and its name
 * @throws `DrawError` with the code `unsupported-format` when the bytes are not a block, or
 *   `invalid-input` when `first` is not an id (its origin, or a number that is not a whole number
 *   of at least 1 the last row can take)
 *
 * @experimental
 */
export function rewriteTabaneBlock(
  content: Uint8Array,
  first: TabaneId,
): { readonly block: TabaneBlock; readonly name: string } {
  if (!isTabaneOrigin(first.origin)) {
    throw new DrawError('invalid-input', `Tabane: not an origin: ${first.origin}`);
  }
  const rowBlocks = readBlockData(content);
  let count = 0;
  for (const rowBlock of rowBlocks) count += rowBlock.length;
  if (
    !Number.isSafeInteger(first.number) ||
    first.number < 1 ||
    !Number.isSafeInteger(first.number + count - 1)
  ) {
    throw new DrawError('invalid-input', `Tabane: not the number of a first id: ${first.number}`);
  }
  const bytes: Uint8Array[] = [];
  const sizes: number[] = [];
  let at = first.number;
  for (const rowBlock of rowBlocks) {
    const rows = tabaneRowsOf(rowBlock).map((row) => ({
      ...row,
      id: formatTabaneId({ origin: first.origin, number: at++ }),
    }));
    bytes.push(
      writeRowBlock({
        place: rowBlock.place,
        dimensions: rowBlock.dimensions,
        rows,
        fills: rowBlock.fills !== null,
      }),
    );
    sizes.push(rowBlock.length);
  }
  const block = blockOfRowBlocks(bytes, sizes);
  return { block, name: sha256Hex(block.content) };
}
