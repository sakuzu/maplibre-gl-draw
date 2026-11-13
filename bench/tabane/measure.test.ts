// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The Tabane format measured on the files of bench/data. It measures, it does not check: it runs
 * only when asked (`TABANE_MEASURE=1 npx vitest run --config bench/vitest.config.ts tabane`).
 *
 * For every file of `TABANE_FILES` (the 100,000 buildings of FGD when not given), the rows of
 * its features (the ids a run of one origin, the style empty) are written as blocks:
 *
 * - The time to write them, and the bytes of the content and of the files compressed with zstd
 *   (Node's), with and without the caches of the triangles of the polygons
 * - Every row read back and compared with the feature it was written from, the coordinates to
 *   their bits
 * - The time to read the pages as the Worker of a page does: decompress a part (fzstd, as in
 *   a browser), read the page, make it a page of the tables (the triangles copied from
 *   the cache of the file, or made without one). Then, for the same rows, the
 *   way before: rows made objects again and given to the builder of the pages
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import {
  featureRowOfTabane,
  type TabaneFeatureRow,
  writeTabaneFeatureBlocks,
} from '@sakuzu/maplibre-gl-draw/kasane';
import { createPageBuilder, toPage } from '@sakuzu/maplibre-gl-draw/table';
import {
  formatId,
  listFileParts,
  packBlock,
  readFileCache,
  readFilePart,
  readPage,
  readRows,
  rowSuffixOf,
  type TabaneCache,
} from '@sakuzu/tabane';
import { decompress } from 'fzstd';
import type { Feature } from 'geojson';
import { describe, it } from 'vitest';

const MEASURE = process.env.TABANE_MEASURE === '1';
const DATA = join(import.meta.dirname, '..', 'data');
const FILES = (process.env.TABANE_FILES ?? 'fgd-buildings-tokyo-100k').split(',');
const ORIGIN = '1AAAAAAAAAAAA';

const round = (v: number, digits = 2) => Math.round(v * 10 ** digits) / 10 ** digits;
/** Compressed with Node's zstd, decompressed with fzstd (as in a browser) */
const zstd = {
  compress: (raw: Uint8Array) => new Uint8Array(zstdCompressSync(raw)),
  decompress: (stored: Uint8Array) => decompress(stored),
};

/** Whether two values are the same, numbers by their bits */
function same(a: unknown, b: unknown): boolean {
  if (typeof a === 'number' || typeof b === 'number') return Object.is(a, b);
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return a === b;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a as object);
  const kb = new Set(Object.keys(b as object));
  return (
    ka.length === kb.size &&
    ka.every(
      (k) =>
        kb.has(k) && same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
    )
  );
}

function rowsOf(file: string): TabaneFeatureRow[] {
  const text = readFileSync(join(DATA, `${file}.ndjson`), 'utf8');
  const out: TabaneFeatureRow[] = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    const f = JSON.parse(line) as Feature;
    out.push({
      id: formatId({ origin: ORIGIN, number: out.length + 1 }),
      type: f.geometry?.type ?? 'Point',
      geometry: f.geometry,
      properties: f.properties ?? {},
    });
  }
  return out;
}

describe.skipIf(!MEASURE)('Tabane measured', () => {
  for (const file of FILES) {
    it(`writes and reads ${file}`, () => {
      const rows = rowsOf(file);
      const result: Record<string, unknown> = { file, rows: rows.length };
      for (const fills of [true, false]) {
        const t0 = performance.now();
        const blocks = writeTabaneFeatureBlocks({ parent: 'layer', head: 'V', rows });
        const writeMs = performance.now() - t0;
        const t1 = performance.now();
        const files = blocks.map((b) => packBlock(b.block, zstd, fills ? b.caches : undefined));
        const zstdMs = performance.now() - t1;
        let content = 0;
        let stored = 0;
        for (const b of blocks) content += b.block.content.length;
        for (const f of files) stored += f.length;
        const label = fills ? 'withTriangles' : 'withoutTriangles';
        result[label] = {
          blocks: blocks.length,
          writeMs: Math.round(writeMs),
          zstdMs: Math.round(zstdMs),
          contentMB: round(content / 1e6),
          fileMB: round(stored / 1e6),
          bytesPerRow: round(stored / rows.length, 1),
          fileMBEach: files.map((f) => round(f.length / 1e6)),
        };

        // Read back: every row the same
        let at = 0;
        let differ = 0;
        for (const f of files) {
          for (const part of listFileParts(f).slice(1)) {
            const rowBlock = readPage(readFilePart(part, zstd));
            for (const back of readRows(rowBlock).map(featureRowOfTabane)) {
              const row = rows[at++];
              if (
                back.id !== row.id ||
                !same(back.geometry, row.geometry) ||
                !same(back.properties, row.properties) ||
                back.type !== row.type
              )
                differ++;
            }
          }
        }
        (result[label] as Record<string, unknown>).readBack = { rows: at, differ };

        // The time to read the pages into pages of the tables, a part at a time (warmed up)
        const parts = files.flatMap((f) => listFileParts(f).slice(1));
        const pass = () => {
          const t = { unzip: 0, read: 0, block: 0, rowBlocks: 0 };
          const each: number[] = [];
          for (const part of parts) {
            const a = performance.now();
            const bytes = readFilePart(part, zstd);
            const caches: TabaneCache[] = part.caches.map((c) => ({
              part: 0,
              name: c.name,
              content: readFileCache(c, zstd),
            }));
            const b = performance.now();
            const rowBlock = readPage(bytes);
            const c = performance.now();
            toPage(rowBlock, { caches });
            const d = performance.now();
            t.unzip += b - a;
            t.read += c - b;
            t.block += d - c;
            t.rowBlocks++;
            each.push(d - a);
          }
          each.sort((x, y) => x - y);
          const at = (q: number) => each[Math.min(each.length - 1, Math.floor(q * each.length))];
          return { ...t, p50: at(0.5), p95: at(0.95), longest: each[each.length - 1] };
        };
        pass();
        const t = pass();
        const per1000 = (v: number) => round((v / rows.length) * 1000);
        (result[label] as Record<string, unknown>).readPer1000Ms = {
          unzip: per1000(t.unzip),
          read: per1000(t.read),
          block: per1000(t.block),
          all: per1000(t.unzip + t.read + t.block),
          groupP50: round(t.p50),
          groupP95: round(t.p95),
          longestGroup: round(t.longest),
          allRowsMs: Math.round(t.unzip + t.read + t.block),
        };
      }

      // The way before, for the same rows: rows given to the builder of the pages
      const builderPass = () => {
        let ms = 0;
        for (let s = 0; s < rows.length; s += 1000) {
          const chunk = rows.slice(s, s + 1000);
          const a = performance.now();
          const builder = createPageBuilder();
          chunk.forEach((row, i) => {
            builder.addRow({
              id: row.id,
              type: row.type,
              geometry: row.geometry,
              key: `V${rowSuffixOf(s + i)}`,
              properties: row.properties,
            });
          });
          builder.finish();
          ms += performance.now() - a;
        }
        return ms;
      };
      builderPass();
      result.builderPer1000Ms = round((builderPass() / rows.length) * 1000);

      console.log(JSON.stringify(result, null, 1));
    }, 600_000);
  }
});
