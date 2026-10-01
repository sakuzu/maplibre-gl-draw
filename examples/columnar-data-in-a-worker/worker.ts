// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// The Worker of columnar-data-in-a-worker: it fetches a GeoParquet file, reads its columns with
// hyparquet, decodes the WKB geometry straight into the arrays of a table in the layout of
// GeoArrow, prepares the table for the dataset, and sends it to the page without a copy.

import {
  type DictionaryColumn,
  prepareTable,
  type Table,
  transferList,
} from '@sakuzu/maplibre-gl-draw/table';
import { decompress } from 'fzstd';
import { type ColumnData, parquetRead } from 'hyparquet';

/** What the page asks for: the address of the file */
export interface Request {
  url: string;
}

/** What the Worker answers: the prepared table and the time of each step (ms) */
export interface Reply {
  prepared: ReturnType<typeof prepareTable>;
  times: { fetch: number; read: number; table: number; prepare: number };
}

/** The columns the page reads: the rule reads `area`, a click the others */
const COLUMNS = ['id', 'geometry', 'area', 'height', 'floors', 'class', 'name'];

/** Reads the columns of a Parquet file, each as one array (the chunks of its row groups joined) */
async function readColumns(file: ArrayBuffer): Promise<Record<string, unknown[]>> {
  const chunks: ColumnData[] = [];
  await parquetRead({
    file,
    columns: COLUMNS,
    // hyparquet decompresses Snappy itself; ZSTD comes from fzstd
    compressors: { ZSTD: (input, length) => decompress(input, new Uint8Array(length)) },
    // The geometry stays WKB: it is decoded below, into the arrays of the table
    parsers: { geometryFromBytes: (bytes: Uint8Array) => bytes },
    onChunk: (chunk) => chunks.push(chunk),
  });
  const columns: Record<string, unknown[]> = {};
  for (const name of COLUMNS) {
    const parts = chunks
      .filter((chunk) => chunk.columnName === name)
      .sort((a, b) => a.rowStart - b.rowStart);
    columns[name] = parts.flatMap((part) => Array.from(part.columnData as ArrayLike<unknown>));
  }
  return columns;
}

/**
 * A MultiPolygon geometry column from WKB polygons and multipolygons (a Polygon is a
 * MultiPolygon of one), in two passes: one counts, one fills the typed arrays
 */
function multiPolygonsFromWkb(rows: unknown[]): Table['geometry'] {
  let polygons = 0;
  let rings = 0;
  let coords = 0;
  // Walks one geometry: calls onPolygon for each polygon and onRing for each of its rings
  const walk = (
    wkb: Uint8Array,
    onPolygon: () => void,
    onRing: (view: DataView, offset: number, count: number, little: boolean) => void,
  ): void => {
    const view = new DataView(wkb.buffer, wkb.byteOffset, wkb.byteLength);
    let offset = 0;
    const readPolygon = (): void => {
      const little = view.getUint8(offset) === 1;
      const type = view.getUint32(offset + 1, little) % 1000;
      if (type !== 3) throw new Error(`A polygon was expected, not the WKB type ${type}`);
      const ringCount = view.getUint32(offset + 5, little);
      offset += 9;
      onPolygon();
      for (let r = 0; r < ringCount; r++) {
        const count = view.getUint32(offset, little);
        onRing(view, offset + 4, count, little);
        offset += 4 + count * 16;
      }
    };
    const little = view.getUint8(0) === 1;
    const type = view.getUint32(1, little) % 1000;
    if (type === 3) {
      readPolygon();
      return;
    }
    if (type !== 6) throw new Error(`A polygon was expected, not the WKB type ${type}`);
    const count = view.getUint32(5, little);
    offset = 9;
    for (let p = 0; p < count; p++) readPolygon();
  };

  for (const wkb of rows) {
    if (!(wkb instanceof Uint8Array)) continue;
    walk(
      wkb,
      () => polygons++,
      (_view, _offset, count) => {
        rings++;
        coords += count;
      },
    );
  }

  const xy = new Float64Array(coords * 2);
  const rowOffsets = new Int32Array(rows.length + 1);
  const polygonOffsets = new Int32Array(polygons + 1);
  const ringOffsets = new Int32Array(rings + 1);
  let [polygon, ring, coord] = [0, 0, 0];
  rows.forEach((wkb, i) => {
    // A row without a geometry is an empty run: no polygon
    if (wkb instanceof Uint8Array) {
      walk(
        wkb,
        () => {
          polygon++;
          polygonOffsets[polygon] = ring;
        },
        (view, offset, count, little) => {
          for (let k = 0; k < count; k++) {
            xy[coord * 2] = view.getFloat64(offset + k * 16, little);
            xy[coord * 2 + 1] = view.getFloat64(offset + k * 16 + 8, little);
            coord++;
          }
          ring++;
          ringOffsets[ring] = coord;
          polygonOffsets[polygon] = ring;
        },
      );
    }
    rowOffsets[i + 1] = polygon;
  });
  return { type: 'MultiPolygon', coords: xy, offsets: [rowOffsets, polygonOffsets, ringOffsets] };
}

/** A column of numbers, NaN where the file has no value */
function numbers(values: unknown[]): Float64Array {
  return Float64Array.from(values, (v) => (typeof v === 'number' ? v : Number.NaN));
}

/** A column of text as a dictionary: each row holds the index of its value, -1 for none */
function dictionary(values: unknown[]): DictionaryColumn {
  const index = new Map<string, number>();
  const codes = new Int32Array(values.length);
  values.forEach((value, i) => {
    if (typeof value !== 'string') {
      codes[i] = -1;
      return;
    }
    let code = index.get(value);
    if (code === undefined) {
      code = index.size;
      index.set(value, code);
    }
    codes[i] = code;
  });
  return { codes, dictionary: [...index.keys()] };
}

self.onmessage = async (event: MessageEvent<Request>) => {
  const t0 = performance.now();
  const response = await fetch(event.data.url);
  if (!response.ok) throw new Error(`${event.data.url}: ${response.status}`);
  const file = await response.arrayBuffer();
  const t1 = performance.now();
  const columns = await readColumns(file);
  const t2 = performance.now();
  const table: Table = {
    length: columns.id.length,
    geometry: multiPolygonsFromWkb(columns.geometry),
    ids: columns.id,
    columns: {
      area: numbers(columns.area),
      height: numbers(columns.height),
      floors: numbers(columns.floors),
      class: dictionary(columns.class),
      name: dictionary(columns.name),
    },
  };
  const t3 = performance.now();
  // The extents of the rows, the pieces and the index of the clicks, computed here
  const prepared = prepareTable(table);
  const t4 = performance.now();
  const reply: Reply = {
    prepared,
    times: { fetch: t1 - t0, read: t2 - t1, table: t3 - t2, prepare: t4 - t3 },
  };
  // The transfer list moves every array to the page instead of copying it
  self.postMessage(reply, { transfer: transferList(prepared) });
};
