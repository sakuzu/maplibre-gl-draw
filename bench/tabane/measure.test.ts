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
 *   (Node's), with and without the fills of the polygons
 * - Every row read back and compared with the feature it was written from, the coordinates to
 *   their bits
 * - The time to read the groups as the Worker of a page does: decompress a frame (fzstd, as in a
 *   browser), read the group, make it a block of rows of the tables. Then, for the same rows, the
 *   way before: rows made objects again and given to the builder of the blocks of rows
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import {
  createRowBlockBuilder,
  packTabaneBlock,
  readTabaneGroup,
  type TabaneRow,
  tabaneFrameContent,
  tabaneFrames,
  tabaneIdText,
  tabaneRowBlock,
  tabaneRowSuffix,
  tabaneRows,
  writeTabaneBlocks,
} from '@sakuzu/maplibre-gl-draw/kasane';
import { decompress } from 'fzstd';
import type { Feature } from 'geojson';
import { describe, it } from 'vitest';

const MEASURE = process.env.TABANE_MEASURE === '1';
const DATA = join(import.meta.dirname, '..', 'data');
const FILES = (process.env.TABANE_FILES ?? 'fgd-buildings-tokyo-100k').split(',');
const ORIGIN = '1AAAAAAAAAAAA';

const round = (v: number, digits = 2) => Math.round(v * 10 ** digits) / 10 ** digits;
const nodeZstd = { compress: (raw: Uint8Array) => new Uint8Array(zstdCompressSync(raw)) };
const fzstd = { decompress: (stored: Uint8Array) => decompress(stored) };

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

function rowsOf(file: string): TabaneRow[] {
  const text = readFileSync(join(DATA, `${file}.ndjson`), 'utf8');
  const out: TabaneRow[] = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    const f = JSON.parse(line) as Feature;
    out.push({
      id: tabaneIdText({ origin: ORIGIN, number: out.length + 1 }),
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
        const blocks = writeTabaneBlocks({ parent: 'layer', head: 'V', rows, fills });
        const writeMs = performance.now() - t0;
        const t1 = performance.now();
        const files = blocks.map((b) => packTabaneBlock(b, nodeZstd));
        const zstdMs = performance.now() - t1;
        let content = 0;
        let stored = 0;
        for (const b of blocks) content += b.content.length;
        for (const f of files) stored += f.length;
        const label = fills ? 'withFills' : 'withoutFills';
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
          for (const frame of tabaneFrames(f).slice(1)) {
            const group = readTabaneGroup(tabaneFrameContent(frame, fzstd));
            for (const back of tabaneRows(group)) {
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

        // The time to read the groups into blocks of rows, a frame at a time (warmed up)
        const frames = files.flatMap((f) => tabaneFrames(f).slice(1));
        const pass = () => {
          const t = { unzip: 0, read: 0, block: 0, groups: 0 };
          let longest = 0;
          for (const frame of frames) {
            const a = performance.now();
            const bytes = tabaneFrameContent(frame, fzstd);
            const b = performance.now();
            const group = readTabaneGroup(bytes);
            const c = performance.now();
            tabaneRowBlock(group);
            const d = performance.now();
            t.unzip += b - a;
            t.read += c - b;
            t.block += d - c;
            t.groups++;
            longest = Math.max(longest, d - a);
          }
          return { ...t, longest };
        };
        pass();
        const t = pass();
        const per1000 = (v: number) => round((v / rows.length) * 1000);
        (result[label] as Record<string, unknown>).readPer1000Ms = {
          unzip: per1000(t.unzip),
          read: per1000(t.read),
          block: per1000(t.block),
          all: per1000(t.unzip + t.read + t.block),
          longestGroup: round(t.longest),
          allRowsMs: Math.round(t.unzip + t.read + t.block),
        };
      }

      // The way before, for the same rows: rows given to the builder of the blocks of rows
      const builderPass = () => {
        let ms = 0;
        for (let s = 0; s < rows.length; s += 1000) {
          const chunk = rows.slice(s, s + 1000);
          const a = performance.now();
          const builder = createRowBlockBuilder();
          chunk.forEach((row, i) => {
            builder.addRow({
              id: row.id,
              type: row.type,
              geometry: row.geometry,
              order: `V${tabaneRowSuffix(s + i)}`,
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
