// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Makes the blocks of the trial of opening a map in steps from the files of one feature per line
 * of `bench/data/`, into `bench/data/stage0/<name>/` (not committed), then reads every row back
 * and checks that it is the feature of its line.
 *
 * ```sh
 * node bench/stage0/make-blocks.ts                      # the four files of the trial
 * node bench/stage0/make-blocks.ts fgd-buildings-tokyo-100k --segment-rows 1000 --file-mb 2
 * ```
 *
 * Each file is the import of one client into one layer: the rows are its items of the serials
 * 2, 3, ... (the layer is the serial 1), in the order of the lines, a run of the order under the
 * key `a0`, written by the batch 1 of the client. The client is made from the name of the file,
 * so that the same file makes the same blocks. The id of a feature in the file is kept as the
 * attribute `source_id`.
 *
 * The rows are cut into segments of `--segment-rows` rows (1,000), each compressed with zstd
 * (`--level`, 3), and the segments into files of about `--file-mb` MB (2) compressed, each named
 * by the SHA-256 of its bytes (`blocks/<hash>.bin`). Beside them:
 *
 * - The small items (`<hash>.ndjson`): the settings of the map and the layer, read first
 * - The manifest (`<hash>.ndjson`): the name of the small items and of every file, with its bytes,
 *   its rows, its place in the run, its bounding box and its runs of ids; the table of the fields
 *   written after the import (empty), and the views of the page (`city`, a view of zoom 14 over
 *   the most rows, and `all`, the bounds of every row)
 * - `head.ndjson`: the name of the manifest
 *
 * The small items, the manifest and the head are JSON of one line, named `.ndjson` as the other
 * files of `bench/data/` (which the formatter of the repository does not read).
 *
 * `--no-check` leaves the check out.
 */

import { createHash } from 'node:crypto';
import {
  createReadStream,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { constants, zstdCompressSync, zstdDecompressSync } from 'node:zlib';
import type { Geometry } from 'geojson';
import {
  decodeSegment,
  encodeSegment,
  type ItemId,
  type PackedSegment,
  packFile,
  type SegmentParts,
  type SegmentRows,
  sameValue,
  unpackFile,
} from './codec.ts';
import { idText } from './rows.ts';

const DEFAULT_FILES = [
  'fgd-buildings-tokyo-100k',
  'overture-buildings-tokyo-attrs',
  'fgd-roadedges-tokyo-100k',
  'fgd-buildings-1m',
];

const here = dirname(fileURLToPath(import.meta.url));
const DATA = join(here, '..', 'data');
const OUT = join(DATA, 'stage0');

/** The key of the head of the run of the import */
export const IMPORT_HEAD = 'a0';
/** The batch of the client that imports the rows */
const IMPORT_BATCH = 1;
/** The attribute that keeps the id of a feature in its file */
export const SOURCE_ID = 'source_id';

/** The extent of the map the page shows at zoom 14 (1280 x 800 pixels near 35.7 degrees north) */
const CITY_SPAN: [number, number] = [0.11, 0.0557];

interface Options {
  readonly segmentRows: number;
  readonly fileBytes: number;
  readonly level: number;
  readonly check: boolean;
  readonly names: string[];
}

function parseArgs(argv: readonly string[]): Options {
  let segmentRows = 1000;
  let fileMb = 2;
  let level = 3;
  let check = true;
  const names: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--segment-rows') segmentRows = Number(argv[++i]);
    else if (a === '--file-mb') fileMb = Number(argv[++i]);
    else if (a === '--level') level = Number(argv[++i]);
    else if (a === '--no-check') check = false;
    else names.push(a.replace(/\.ndjson$/, ''));
  }
  if (!(segmentRows > 0) || !(fileMb > 0)) throw new Error('--segment-rows and --file-mb > 0');
  return {
    segmentRows,
    fileBytes: fileMb * 1024 * 1024,
    level,
    check,
    names: names.length > 0 ? names : DEFAULT_FILES,
  };
}

/** The client of the import of a file (64 bits, from its name) */
export function clientOfName(name: string): string {
  return createHash('sha256').update(`client:${name}`).digest('hex').slice(0, 16);
}

/** A color of a layer, from its name */
function colorOf(name: string): string {
  const h = createHash('sha256').update(name).digest();
  const hue = (h[0] / 255) * 360;
  // A dark, saturated color of that hue
  const f = (n: number) => {
    const k = (n + hue / 30) % 12;
    const c = 0.45 - 0.3 * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(c * 255)
      .toString(16)
      .padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

/** The style of the rows of a layer */
export function styleOf(name: string): Record<string, unknown> {
  const color = colorOf(name);
  return {
    fillColor: color,
    fillOpacity: 0.5,
    strokeColor: color,
    strokeOpacity: 0.9,
    strokeWidth: 1,
  };
}

type Box = [number, number, number, number];

function emptyBox(): Box {
  return [Infinity, Infinity, -Infinity, -Infinity];
}

function widen(box: Box, g: Geometry | null): void {
  const walk = (v: unknown): void => {
    if (!Array.isArray(v)) return;
    if (typeof v[0] === 'number') {
      const [x, y] = v as number[];
      if (x < box[0]) box[0] = x;
      if (y < box[1]) box[1] = y;
      if (x > box[2]) box[2] = x;
      if (y > box[3]) box[3] = y;
      return;
    }
    for (const item of v) walk(item);
  };
  if (g && g.type !== 'GeometryCollection') walk(g.coordinates);
}

function unionBox(a: Box, b: Box): void {
  a[0] = Math.min(a[0], b[0]);
  a[1] = Math.min(a[1], b[1]);
  a[2] = Math.max(a[2], b[2]);
  a[3] = Math.max(a[3], b[3]);
}

interface Feature {
  readonly id?: unknown;
  readonly geometry: Geometry | null;
  readonly properties?: Record<string, unknown> | null;
}

/** The lines of a file that hold a feature, read as they come */
async function* featuresOf(path: string): AsyncGenerator<Feature> {
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!/[^ \t\r\n]/.test(line)) continue;
    yield JSON.parse(line) as Feature;
  }
}

/** The attributes of a feature kept in its row: its own, and its id in the file */
export function propertiesOf(f: Feature): Record<string, unknown> {
  const props = { ...(f.properties ?? {}) };
  if (Object.keys(props).includes(SOURCE_ID)) {
    throw new Error(`a feature already has the attribute ${SOURCE_ID}`);
  }
  if (f.id !== undefined) props[SOURCE_ID] = f.id;
  return props;
}

interface FileEntry {
  readonly name: string;
  readonly bytes: number;
  readonly layer: string;
  readonly rows: number;
  readonly firstRow: number;
  readonly segments: number;
  readonly bbox: Box;
  readonly ids: { client: string; serial: number; count: number }[];
}

const PART_NAMES = ['ids', 'place', 'geometry', 'properties', 'style'] as const;

async function makeOne(name: string, options: Options): Promise<void> {
  const source = join(DATA, `${name}.ndjson`);
  const out = join(OUT, name);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(join(out, 'blocks'), { recursive: true });
  const client = clientOfName(name);
  const layer = idText({ client, serial: 1 });
  const style = styleOf(name);
  const compress = (b: Uint8Array) =>
    new Uint8Array(
      zstdCompressSync(b, { params: { [constants.ZSTD_c_compressionLevel]: options.level } }),
    );

  const t0 = performance.now();
  let encodeMs = 0;
  let compressMs = 0;
  const files: FileEntry[] = [];
  let segments: PackedSegment[] = [];
  let fileBytes = 0;
  let fileBox = emptyBox();
  let fileFirstRow = 0;
  const allBox = emptyBox();
  const cells = new Map<string, number>();
  let rows = 0;
  let segmentCount = 0;
  const raw = { total: 0, ...Object.fromEntries(PART_NAMES.map((p) => [p, 0])) } as Record<
    string,
    number
  >;
  const packed = { ...raw };

  const flushFile = (): void => {
    if (segments.length === 0) return;
    const bytes = packFile(segments);
    const hash = createHash('sha256').update(bytes).digest('hex');
    writeFileSync(join(out, 'blocks', `${hash}.bin`), bytes);
    const fileRows = segments.reduce((s, x) => s + x.rows, 0);
    files.push({
      name: `blocks/${hash}.bin`,
      bytes: bytes.length,
      layer,
      rows: fileRows,
      firstRow: fileFirstRow,
      segments: segments.length,
      bbox: fileBox,
      // One run: the serials follow the rows (the layer is the serial 1)
      ids: [{ client, serial: 2 + fileFirstRow, count: fileRows }],
    });
    fileFirstRow += fileRows;
    segments = [];
    fileBytes = 0;
    fileBox = emptyBox();
  };

  let pending: Feature[] = [];
  const flushSegment = (): void => {
    if (pending.length === 0) return;
    const firstRow = rows - pending.length;
    const segment: SegmentRows = {
      ids: pending.map((_, i) => ({ client, serial: 2 + firstRow + i })),
      place: { layer, head: IMPORT_HEAD, firstRow },
      sources: pending.map(() => ({ client, batch: IMPORT_BATCH })),
      deleted: pending.map(() => false),
      geometries: pending.map((f) => f.geometry),
      properties: pending.map(propertiesOf),
      styles: pending.map(() => style),
    };
    const e0 = performance.now();
    const { bytes, parts } = encodeSegment(segment);
    const c0 = performance.now();
    const compressed = compress(bytes);
    compressMs += performance.now() - c0;
    encodeMs += c0 - e0;
    // The parts compressed one by one, to see where the bytes go (not the bytes of the file)
    let at = bytes.length - PART_NAMES.reduce((s, p) => s + parts[p as keyof SegmentParts], 0);
    raw.total += bytes.length;
    packed.total += compressed.length;
    for (const p of PART_NAMES) {
      const size = parts[p as keyof SegmentParts];
      raw[p] += size;
      packed[p] += compress(bytes.subarray(at, at + size)).length;
      at += size;
    }
    const box = emptyBox();
    for (const g of segment.geometries) widen(box, g);
    unionBox(fileBox, box);
    unionBox(allBox, box);
    segments.push({ rows: pending.length, bytes: compressed });
    fileBytes += compressed.length;
    segmentCount++;
    pending = [];
    if (fileBytes >= options.fileBytes) flushFile();
  };

  for await (const f of featuresOf(source)) {
    pending.push(f);
    rows++;
    // The cell of the view of zoom 14 the first position falls in
    const b = emptyBox();
    widen(b, f.geometry);
    if (Number.isFinite(b[0])) {
      const cx = Math.floor((b[0] + b[2]) / 2 / CITY_SPAN[0]);
      const cy = Math.floor((b[1] + b[3]) / 2 / CITY_SPAN[1]);
      const key = `${cx},${cy}`;
      cells.set(key, (cells.get(key) ?? 0) + 1);
    }
    if (pending.length >= options.segmentRows) flushSegment();
  }
  flushSegment();
  flushFile();
  const makeMs = performance.now() - t0;

  let best = { key: '0,0', count: -1 };
  for (const [key, count] of cells) if (count > best.count) best = { key, count };
  const [bx, by] = best.key.split(',').map(Number);
  const city = {
    center: [(bx + 0.5) * CITY_SPAN[0], (by + 0.5) * CITY_SPAN[1]],
    zoom: 14,
    rowsInCell: best.count,
  };

  const writeNamed = (value: unknown): { name: string; bytes: number } => {
    const bytes = Buffer.from(JSON.stringify(value));
    const hash = createHash('sha256').update(bytes).digest('hex');
    writeFileSync(join(out, `${hash}.ndjson`), bytes);
    return { name: `${hash}.ndjson`, bytes: bytes.length };
  };
  const small = writeNamed({
    map: { background: '#eef0f4', view: { center: city.center, zoom: city.zoom } },
    layers: [{ id: layer, name, key: 'a0', dimensions: 'xy', style, rows }],
  });
  const blockBytes = files.reduce((s, f) => s + f.bytes, 0);
  const perRow = (v: number) => Math.round((v / rows) * 10) / 10;
  const made = {
    source: `${name}.ndjson`,
    rows,
    segments: segmentCount,
    files: files.length,
    segmentRows: options.segmentRows,
    fileMb: options.fileBytes / 1024 / 1024,
    level: options.level,
    blockBytes,
    bytesPerRow: perRow(blockBytes),
    partsPerRow: Object.fromEntries(
      Object.keys(raw).map((k) => [k, { raw: perRow(raw[k]), zstd: perRow(packed[k]) }]),
    ),
    makeMs: Math.round(makeMs),
    encodeMs: Math.round(encodeMs),
    compressMs: Math.round(compressMs),
  };
  const manifest = writeNamed({
    format: 'stage0-blocks-1',
    serial: 1,
    small,
    files,
    // The fields written after the items were made, with the serial and the client that wrote
    // them: none after an import
    lastWrites: [],
    summary: { items: rows + 1, rows },
    views: { city, all: { bounds: allBox } },
    made,
  });
  writeFileSync(join(out, 'head.ndjson'), JSON.stringify({ manifest: manifest.name, serial: 1 }));
  console.log(JSON.stringify({ name, ...made }));

  if (options.check) {
    const c0 = performance.now();
    const checked = await checkOne(name, source, out);
    console.log(JSON.stringify({ name, checked, checkMs: Math.round(performance.now() - c0) }));
  }
}

/** Reads every row back from the files of the manifest and compares it with its line */
async function checkOne(name: string, source: string, out: string): Promise<number> {
  const head = JSON.parse(readFileSync(join(out, 'head.ndjson'), 'utf8')) as { manifest: string };
  const manifest = JSON.parse(readFileSync(join(out, head.manifest), 'utf8')) as {
    files: FileEntry[];
  };
  const client = clientOfName(name);
  const style = styleOf(name);
  const lines = featuresOf(source);
  let row = 0;
  for (const file of manifest.files) {
    const bytes = new Uint8Array(readFileSync(join(out, file.name)));
    const hash = createHash('sha256').update(bytes).digest('hex');
    if (`blocks/${hash}.bin` !== file.name) throw new Error(`${file.name}: another hash`);
    if (row !== file.firstRow) throw new Error(`${file.name}: the first row ${file.firstRow}`);
    for (const packed of unpackFile(bytes)) {
      const segment = decodeSegment(new Uint8Array(zstdDecompressSync(packed.bytes)));
      if (segment.ids.length !== packed.rows) throw new Error('the rows of a segment');
      if (segment.place.firstRow !== row) throw new Error(`the first row of a segment ${row}`);
      for (let i = 0; i < segment.ids.length; i++, row++) {
        const next = await lines.next();
        if (next.done) throw new Error(`more rows than lines (${row})`);
        const f = next.value;
        const id: ItemId = segment.ids[i];
        const what = `${name}: the row ${row}`;
        if (id.client !== client || id.serial !== 2 + row) throw new Error(`${what}: its id`);
        if (!sameValue(segment.geometries[i], f.geometry)) throw new Error(`${what}: geometry`);
        if (!sameValue(segment.properties[i], propertiesOf(f))) {
          throw new Error(`${what}: attributes`);
        }
        if (!sameValue(segment.styles[i], style)) throw new Error(`${what}: style`);
        if (segment.deleted[i]) throw new Error(`${what}: deleted`);
        if (segment.sources[i].client !== client || segment.sources[i].batch !== IMPORT_BATCH) {
          throw new Error(`${what}: source`);
        }
      }
    }
  }
  if (!(await lines.next()).done) throw new Error(`${name}: lines left after ${row} rows`);
  return row;
}

const isMain =
  process.argv[1] !== undefined &&
  realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
if (isMain) {
  const options = parseArgs(process.argv.slice(2));
  for (const name of options.names) await makeOne(name, options);
}
