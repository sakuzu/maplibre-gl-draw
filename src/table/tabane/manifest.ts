// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The manifest of the Tabane format: the blocks of a set of rows, and what a reader needs to
 * choose which to fetch first
 *
 * The content of a manifest is the magic `TBNM` and the canonical bytes (`canonical-value.ts`) of
 * one object:
 *
 * - `tabane`: the version of the format (1)
 * - `coordinates`: the convention of the coordinates of every block, `{system, dimensions}`. The
 *   system is a name the writer and the reader agree on (`lnglat` for longitude and latitude in
 *   degrees, `plane` for a plane without bounds); the dimensions are `xy`, `xyz`, `xym` or `xyzm`
 * - `partition`: how the rows were cut into blocks, `{kind}`. `order`: each block is a run of
 *   rows in the order of their keys, and says the keys of its first and its last row. Other kinds
 *   (cells of space, overviews) are for later versions; a reader refuses a kind it does not know
 * - `blocks`: one entry per block, in the order of the rows
 * - `extra` (optional): an object of values the user of the format keeps with the manifest,
 *   which the format does not read
 *
 * An entry of a block:
 *
 * - `name`: the name of the block (the SHA-256 of its content, in lowercase hex)
 * - `rows`: its number of rows; `bytes`: the length of its content
 * - `box`: the smallest and the largest value of each dimension over the coordinates of its rows,
 *   `[[min, max], ...]` in the order of the dimensions (a dimension without a value, NaN only, is
 *   null; the whole box is null for a block without coordinates)
 * - `ids`: the runs of the ids of its rows, `[origin, first, count]`
 * - `order` (partition `order`): `{parent, first, last}`: the parent of its rows and the keys of
 *   its first and its last row
 *
 * A pure module: it depends on nothing outside `/table`, so it runs in a Worker as well.
 */

import { decodeCanonicalValue, encodeCanonicalValue } from '../canonical-value.js';
import { type CoordinateDimensions, isCoordinateDimensions, strideOf } from '../coordinates.js';
import { readBlockHead, type TabaneBlock } from './block.js';
import { formatError } from './bytes.js';
import { tabaneNameOf } from './file.js';
import { isTabaneOrigin, tabaneRowSuffixOf } from './ids.js';
import { readRowBlockData } from './row-block-read.js';

/** The first bytes of the content of a manifest: `TBNM` */
export const MANIFEST_MAGIC = Uint8Array.of(0x54, 0x42, 0x4e, 0x4d);

/**
 * The entry of a block in a manifest
 *
 * @experimental
 */
export interface TabaneManifestEntry {
  readonly name: string;
  readonly rows: number;
  readonly bytes: number;
  readonly box: readonly (readonly [number, number] | null)[] | null;
  readonly ids: readonly (readonly [origin: string, first: number, count: number])[];
  readonly order: { readonly parent: string; readonly first: string; readonly last: string };
}

/**
 * A manifest
 *
 * @experimental
 */
export interface TabaneManifest {
  readonly coordinates: {
    readonly system: string;
    readonly dimensions: CoordinateDimensions;
  };
  readonly partition: { readonly kind: 'order' };
  readonly blocks: readonly TabaneManifestEntry[];
  readonly extra?: Readonly<Record<string, unknown>>;
}

/**
 * The entry of a block in a manifest of the partition `order`, read from its content
 *
 * @throws `DrawError` with the code `unsupported-format` when the content is not a block
 *
 * @experimental
 */
export async function tabaneManifestEntryOf(block: TabaneBlock): Promise<TabaneManifestEntry> {
  const content = block.content;
  const layout = readBlockHead(content);
  const ids: [string, number, number][] = [];
  let box: ([number, number] | null)[] | null = null;
  let parent = '';
  let firstKey = '';
  let lastKey = '';
  layout.rowBlocks.forEach((g, k) => {
    const rowBlock = readRowBlockData(content, g.start, g.end);
    for (const [origin, first, count] of rowBlock.ids) {
      const last = ids[ids.length - 1];
      if (last && last[0] === origin && last[1] + last[2] === first) last[2] += count;
      else ids.push([origin, first, count]);
    }
    if (k === 0) {
      parent = rowBlock.place.parent;
      firstKey = rowBlock.place.head + tabaneRowSuffixOf(rowBlock.place.firstIndex);
    }
    lastKey =
      rowBlock.place.head + tabaneRowSuffixOf(rowBlock.place.firstIndex + rowBlock.length - 1);
    const stride = strideOf(rowBlock.dimensions);
    for (const child of rowBlock.geometry.children) {
      const c = child.coords;
      if (c.length === 0) continue;
      box ??= new Array(stride).fill(null);
      for (let k = 0; k < c.length; k++) {
        const v = c[k];
        if (Number.isNaN(v)) continue;
        const d = k % stride;
        const pair = box[d];
        if (pair === null) box[d] = [v, v];
        else if (v < pair[0]) pair[0] = v;
        else if (v > pair[1]) pair[1] = v;
      }
    }
  });
  return {
    name: await tabaneNameOf(content),
    rows: layout.rows,
    bytes: content.length,
    box,
    ids,
    order: { parent, first: firstKey, last: lastKey },
  };
}

/**
 * The content of a manifest
 *
 * @throws `DrawError` with the code `invalid-input` when a value cannot be written
 *
 * @experimental
 */
export function writeTabaneManifest(manifest: TabaneManifest): Uint8Array {
  const value: Record<string, unknown> = {
    tabane: 1,
    coordinates: {
      system: manifest.coordinates.system,
      dimensions: manifest.coordinates.dimensions,
    },
    partition: { kind: manifest.partition.kind },
    blocks: manifest.blocks.map((b) => ({
      name: b.name,
      rows: b.rows,
      bytes: b.bytes,
      box: b.box === null ? null : b.box.map((p) => (p === null ? null : [p[0], p[1]])),
      ids: b.ids.map((r) => [r[0], r[1], r[2]]),
      order: { parent: b.order.parent, first: b.order.first, last: b.order.last },
    })),
  };
  if (manifest.extra !== undefined) value.extra = manifest.extra;
  const bytes = encodeCanonicalValue(value);
  const out = new Uint8Array(MANIFEST_MAGIC.length + bytes.length);
  out.set(MANIFEST_MAGIC);
  out.set(bytes, MANIFEST_MAGIC.length);
  return out;
}

function fail(what: string): never {
  throw formatError(`a manifest whose ${what} is not one`);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isCount(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
}

/**
 * Reads the content of a manifest
 *
 * @throws `DrawError` with the code `unsupported-format` when the bytes are not a manifest of a
 *   version and a partition this reader knows
 *
 * @experimental
 */
export function readTabaneManifest(content: Uint8Array): TabaneManifest {
  if (content.length < 4 || MANIFEST_MAGIC.some((b, i) => content[i] !== b))
    throw formatError('not a manifest');
  let v: unknown;
  try {
    v = decodeCanonicalValue(content, 4, content.length);
  } catch {
    throw formatError('a manifest that is not a value');
  }
  if (!isRecord(v)) fail('value');
  if (v.tabane !== 1) throw formatError(`a manifest of the version ${String(v.tabane)}`);
  const c = v.coordinates;
  if (!isRecord(c) || typeof c.system !== 'string' || !isCoordinateDimensions(c.dimensions))
    fail('coordinates');
  const p = v.partition;
  if (!isRecord(p) || p.kind !== 'order') fail('partition');
  if (!Array.isArray(v.blocks)) fail('blocks');
  const dims = strideOf(c.dimensions);
  const blocks = v.blocks.map((b: unknown): TabaneManifestEntry => {
    if (!isRecord(b)) fail('block');
    if (typeof b.name !== 'string' || !/^[0-9a-f]{64}$/.test(b.name)) fail('name of a block');
    if (!isCount(b.rows) || !isCount(b.bytes)) fail('size of a block');
    let box: ([number, number] | null)[] | null = null;
    if (b.box !== null) {
      if (!Array.isArray(b.box) || b.box.length !== dims) fail('box of a block');
      box = b.box.map((pair: unknown) => {
        if (pair === null) return null;
        if (
          !Array.isArray(pair) ||
          pair.length !== 2 ||
          typeof pair[0] !== 'number' ||
          typeof pair[1] !== 'number'
        )
          fail('box of a block');
        return [pair[0], pair[1]] as [number, number];
      });
    }
    if (!Array.isArray(b.ids)) fail('ids of a block');
    const ids = b.ids.map((run: unknown) => {
      if (
        !Array.isArray(run) ||
        run.length !== 3 ||
        typeof run[0] !== 'string' ||
        !isTabaneOrigin(run[0]) ||
        !isCount(run[1]) ||
        !isCount(run[2])
      )
        fail('ids of a block');
      return [run[0], run[1], run[2]] as const;
    });
    const o = b.order;
    if (
      !isRecord(o) ||
      typeof o.parent !== 'string' ||
      typeof o.first !== 'string' ||
      typeof o.last !== 'string'
    )
      fail('order of a block');
    return {
      name: b.name,
      rows: b.rows,
      bytes: b.bytes,
      box,
      ids,
      order: { parent: o.parent, first: o.first, last: o.last },
    };
  });
  if (v.extra !== undefined && !isRecord(v.extra)) fail('extra');
  return {
    coordinates: { system: c.system, dimensions: c.dimensions },
    partition: { kind: 'order' },
    blocks,
    ...(v.extra !== undefined && { extra: v.extra as Record<string, unknown> }),
  };
}
