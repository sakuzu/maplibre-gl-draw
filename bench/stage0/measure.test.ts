// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The measurements of the trial without a browser. It measures, it does not check: it runs only
 * when asked
 * (`STAGE0_MEASURE=1 npx vitest run --config bench/vitest.config.ts stage0/measure --pool=forks
 * --execArgv=--expose-gc`, after `node bench/stage0/make-blocks.ts`).
 *
 * - The blocks: every file of every set of blocks in `bench/data/stage0/` decoded as the Worker of
 *   the page decodes it, a file at a time: the time to decompress and decode a segment, and to
 *   make its rows blocks of rows of the tables
 * - Applying batches: 100,000 items applied, a thousand batches of a client waiting for their
 *   serials, then batches of another client of 1, 1,000 and 10,000 writes received, and the own
 *   batches received back. The heap the waiting batches and the table of the last writers of
 *   100,000 fields add (with `--expose-gc`)
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'vitest';
import { decodeFile } from './decode-work.ts';
import { type Batch, Client, Sequencer } from './serial-apply.ts';

const MEASURE = process.env.STAGE0_MEASURE === '1';
const OUT = join(import.meta.dirname, '..', 'data', 'stage0');

const round = (v: number, digits = 2) => Math.round(v * 10 ** digits) / 10 ** digits;

function heapMb(): number {
  (globalThis as { gc?: () => void }).gc?.();
  return process.memoryUsage().heapUsed / 1024 / 1024;
}

describe.skipIf(!MEASURE)('the trial measured', () => {
  it('decodes the blocks into blocks of rows', () => {
    if (!existsSync(OUT)) throw new Error('make the blocks first (bench/stage0/make-blocks.ts)');
    for (const name of readdirSync(OUT).sort()) {
      const dir = join(OUT, name);
      const head = JSON.parse(readFileSync(join(dir, 'head.json'), 'utf8')) as {
        manifest: string;
      };
      const manifest = JSON.parse(readFileSync(join(dir, head.manifest), 'utf8')) as {
        files: { name: string; bytes: number; rows: number }[];
      };
      const files = manifest.files.map((f) => new Uint8Array(readFileSync(join(dir, f.name))));
      // Warm up on the first file
      decodeFile(files[0]);
      decodeFile(files[0]);
      const perSegment: number[] = [];
      const perFile: { rows: number; bytes: number; decodeMs: number; blocksMs: number }[] = [];
      let rows = 0;
      let segments = 0;
      const sum = { unzipMs: 0, decodeMs: 0, rowsMs: 0, addMs: 0, finishMs: 0 };
      for (const bytes of files) {
        const decoded = decodeFile(bytes);
        const t = decoded.times;
        rows += decoded.rows;
        segments += decoded.segments;
        for (const k of Object.keys(sum) as (keyof typeof sum)[]) sum[k] += t[k];
        perSegment.push((t.unzipMs + t.decodeMs) / decoded.segments);
        perFile.push({
          rows: decoded.rows,
          bytes: bytes.length,
          decodeMs: round(t.unzipMs + t.decodeMs, 1),
          blocksMs: round(t.rowsMs + t.addMs + t.finishMs, 1),
        });
      }
      const per1000 = (v: number) => round((v / rows) * 1000);
      console.log(
        JSON.stringify({
          name,
          rows,
          segments,
          files: files.length,
          // One segment of about 1,000 rows: decompressed and decoded to values and geometries
          segmentMs: {
            unzip: per1000(sum.unzipMs),
            decode: per1000(sum.decodeMs),
            both: per1000(sum.unzipMs + sum.decodeMs),
            longestFileAverage: round(Math.max(...perSegment)),
          },
          // The same 1,000 rows made blocks of rows: the rows of the builder, added, cut
          blocksPer1000Ms: {
            rows: per1000(sum.rowsMs),
            add: per1000(sum.addMs),
            finish: per1000(sum.finishMs),
            all: per1000(sum.rowsMs + sum.addMs + sum.finishMs),
          },
          // Every row of the set, on one thread
          totalMs: {
            decode: Math.round(sum.unzipMs + sum.decodeMs),
            blocks: Math.round(sum.rowsMs + sum.addMs + sum.finishMs),
          },
          longestFile: perFile.reduce((a, b) =>
            b.decodeMs + b.blocksMs > a.decodeMs + a.blocksMs ? b : a,
          ),
        }),
      );
    }
  }, 600_000);

  it('applies batches with a thousand of its own waiting', () => {
    const ITEMS = 100_000;
    const WAITING = 1000;
    const heap0 = heapMb();
    const sequencer = new Sequencer();
    const a = new Client('a');
    const ids = Array.from({ length: ITEMS }, (_, i) => `item-${i}`);
    // The items of an import of another client, with fields like the buildings of the files
    const imported: Batch = {
      client: 'import',
      batch: 1,
      base: 0,
      changes: ids.map((item, i) => ({
        kind: 'create' as const,
        item,
        fields: { type: 'building', floors: i % 7, height: (i % 50) * 0.5, name: `b${i}` },
      })),
    };
    a.receive(sequencer.next(imported));
    const heapItems = heapMb();

    // A thousand batches of the client waiting, each writing the color of an item
    const t0 = performance.now();
    const own: Batch[] = [];
    for (let i = 0; i < WAITING; i++) {
      own.push(a.write([{ kind: 'set', item: ids[i * 7], field: 'color', value: `#${i}` }]));
    }
    const writeMs = performance.now() - t0;
    const heapWaiting = heapMb();

    // Batches of another client, made on the items as they were
    const other = (n: number, round: number, overlapping: number): Batch => ({
      client: 'b',
      batch: round,
      base: a.items.serial,
      changes: Array.from({ length: n }, (_, j) => {
        // The first `overlapping` writes are fields a waiting batch wrote
        const item = j < overlapping ? ids[(j % WAITING) * 7] : ids[(j * 13 + round) % ITEMS];
        return { kind: 'set' as const, item, field: 'color', value: `b${round}-${j}` };
      }),
    });
    const received: Record<string, unknown>[] = [];
    let batch = 1;
    for (const [n, overlapping] of [
      [1, 1],
      [1000, 500],
      [10_000, 1000],
    ] as const) {
      const times: number[] = [];
      let overwritten = 0;
      for (let rep = 0; rep < 5; rep++) {
        const b = sequencer.next(other(n, batch++, rep === 0 ? overlapping : 0));
        const r0 = performance.now();
        const r = a.receive(b);
        times.push(performance.now() - r0);
        overwritten += r.overwritten;
      }
      times.sort((x, y) => x - y);
      received.push({
        writes: n,
        medianMs: round(times[2], 3),
        longestMs: round(times[4], 3),
        overwritten,
        waiting: a.waiting.length,
      });
    }
    // The own batches received back with their serials
    const a0 = performance.now();
    let superseded = 0;
    for (const b of own) superseded += a.receive(sequencer.next(b)).applied.superseded.length;
    const ackMs = performance.now() - a0;
    const heapAcked = heapMb();
    const entriesBefore = a.items.lastWrites.size;

    // The table of the last writers: 100,000 fields written after their items were made
    const w0 = performance.now();
    for (let k = 0; k < 100; k++) {
      a.receive(
        sequencer.next({
          client: 'b',
          batch: batch++,
          base: a.items.serial,
          changes: Array.from({ length: 1000 }, (_, j) => ({
            kind: 'set' as const,
            item: ids[k * 1000 + j],
            field: 'height',
            value: 1 + j,
          })),
        }),
      );
    }
    const lastWritesMs = performance.now() - w0;
    const heapLastWrites = heapMb();
    console.log(
      JSON.stringify({
        items: ITEMS,
        heapOfItemsMb: round(heapItems - heap0, 1),
        waiting: {
          batches: WAITING,
          writeMs: round(writeMs, 1),
          heapMb: round(heapWaiting - heapItems, 2),
        },
        received,
        ownBack: { batches: WAITING, ms: round(ackMs, 1), superseded },
        lastWrites: {
          entries: a.items.lastWrites.size,
          added: a.items.lastWrites.size - entriesBefore,
          applyMs: round(lastWritesMs, 1),
          heapMb: round(heapLastWrites - heapAcked, 2),
          bytesPerEntry: Math.round(
            ((heapLastWrites - heapAcked) * 1024 * 1024) /
              (a.items.lastWrites.size - entriesBefore),
          ),
        },
        gc: typeof (globalThis as { gc?: unknown }).gc === 'function',
      }),
    );
  }, 600_000);
});
