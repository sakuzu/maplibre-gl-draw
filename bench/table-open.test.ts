// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The opening of the table page in several Workers (`table-open.ts`, `table-worker-core.ts`),
 * with Workers that run in the test: their work as it is, their messages copied and transferred
 * as a Worker's are, each kept in its order and late by a random time, so that the answers of the
 * Workers come in any order. The rows taken in, their order, the rows the edits change and the
 * extent are the ones of the file read whole; a Worker much later than the others, a file cut in
 * small pieces and one of unknown size change nothing; a Worker that fails, that cannot run or
 * that never answers stops the opening with why, and the opening never waits silently.
 */

import type { RowBlock } from '@sakuzu/maplibre-gl-draw/kasane';
import { describe, expect, it } from 'vitest';
import {
  candidatesOf,
  extentOfFeatures,
  featuresOfText,
  parseParams,
  type TableBenchPageParams,
} from './table-data';
import { type OpenWorker, openRows } from './table-open';
import {
  createOpenWork,
  type TableWorkerMessage,
  type TableWorkerRequest,
} from './table-worker-core';

/** A file of one feature per line: points, lines and buildings, blank lines, rows without one */
function fileOf(lines: number, seed = 1): string {
  let state = seed;
  const random = (): number => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
  const out: string[] = [];
  for (let i = 0; i < lines; i++) {
    const x = 139 + random();
    const y = 35 + random();
    const r = random();
    if (r < 0.03) {
      out.push(i % 2 === 0 ? '' : '  \r');
      continue;
    }
    const geometry =
      r < 0.06
        ? null
        : r < 0.3
          ? { type: 'Point', coordinates: [x, y] }
          : r < 0.5
            ? {
                type: 'LineString',
                coordinates: [
                  [x, y],
                  [x + 0.001, y],
                  [x + 0.001, y + 0.002],
                ],
              }
            : {
                type: 'Polygon',
                coordinates: [
                  [
                    [x, y],
                    [x + 0.001, y],
                    [x + 0.001, y + 0.001],
                    [x, y + 0.001],
                    [x, y],
                  ],
                ],
              };
    const feature = {
      type: 'Feature',
      id: `f${i}`,
      properties: { name: `建物 ${i}`, height: Math.floor(random() * 30) },
      geometry,
    };
    out.push(`${JSON.stringify(feature)}${r > 0.9 ? '\r' : ''}`);
  }
  return `${out.join('\n')}\n`;
}

/** Waits a time (not at all for none: a message on time comes in the same turn of the tasks) */
const sleep = (ms: number): Promise<void> =>
  ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();

/** How a Worker of the test behaves */
interface FakeOptions {
  /** The time each message of it (to it, and from it) is late, in ms */
  readonly late?: () => number;
  /** Whether it cannot run (its error comes once it is made, and it does no work) */
  readonly broken?: boolean;
  /** Whether it never answers */
  readonly silent?: boolean;
}

/**
 * A Worker that runs in the test: the messages are copied and their buffers transferred (the
 * sender's are detached), each direction keeps its order, and each message is late
 */
function fakeWorker(options: FakeOptions = {}): OpenWorker {
  const late = options.late ?? (() => 0);
  let alive = true;
  let toWorker: Promise<void> = Promise.resolve();
  let toPage: Promise<void> = Promise.resolve();
  const fake: OpenWorker = {
    onmessage: null,
    onerror: null,
    onmessageerror: null,
    postMessage(message: TableWorkerRequest, transfer: Transferable[] = []) {
      const copy = structuredClone(message, { transfer: transfer as Transferable[] });
      toWorker = toWorker.then(async () => {
        await sleep(late());
        if (alive && !options.silent && !options.broken) await work(copy);
      });
    },
    terminate() {
      alive = false;
    },
  };
  const work = createOpenWork((message: TableWorkerMessage, transfer: Transferable[] = []) => {
    const copy = structuredClone(message, { transfer: transfer as Transferable[] });
    toPage = toPage.then(async () => {
      await sleep(late());
      if (alive) fake.onmessage?.({ data: copy } as MessageEvent<TableWorkerMessage>);
    });
  });
  if (options.broken) {
    setTimeout(() => {
      fake.onerror?.({
        message: 'SyntaxError: the module could not be read',
        filename: 'table-worker.ts',
        lineno: 1,
        preventDefault() {},
      } as unknown as ErrorEvent);
    }, 5);
  }
  return fake;
}

/** A response of a text, in chunks of `chunk` bytes, with its size or without */
function responseOf(text: string, chunk: number, sized = true): Response {
  const bytes = new TextEncoder().encode(text);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let at = 0; at < bytes.length; at += chunk) {
        controller.enqueue(bytes.slice(at, at + chunk));
      }
      controller.close();
    },
  });
  return new Response(body, {
    headers: sized ? { 'content-length': String(bytes.length) } : {},
  });
}

/** The ids of the rows of row groups, in the order the groups were taken in */
function idsOf(groups: readonly RowBlock[]): string[] {
  const decoder = new TextDecoder();
  const out: string[] = [];
  for (const group of groups) {
    const { offsets, bytes } = group.ids;
    for (let r = 0; r < group.length; r++) {
      out.push(decoder.decode(bytes.subarray(offsets[r], offsets[r + 1])));
    }
  }
  return out;
}

interface Run {
  readonly text: string;
  readonly workers: number;
  readonly fake?: (w: number) => FakeOptions;
  readonly chunk?: number;
  readonly sized?: boolean;
  readonly stallMs?: number;
}

/** Opens a file with Workers of the test; what was taken in */
async function open(run: Run) {
  const params: TableBenchPageParams = parseParams(
    `?mode=table&data=test.ndjson&workers=${run.workers}`,
  );
  const taken: RowBlock[] = [];
  const opened = await openRows({
    params,
    dataUrl: 'http://localhost/data/test.ndjson',
    layerId: 'rows',
    writer: { addBlocks: (_layerId, blocks) => taken.push(...blocks) },
    createWorker: (() => {
      let w = 0;
      return () => fakeWorker(run.fake?.(w++));
    })(),
    cores: 16,
    start: performance.now(),
    fetch: async () => responseOf(run.text, run.chunk ?? 4096, run.sized ?? true),
    stallMs: run.stallMs ?? 2_000,
  });
  return { opened, taken, params };
}

/** What reading the file whole in one place gives */
function reference(text: string, params: TableBenchPageParams) {
  const features = featuresOfText(text, true, params);
  return {
    ids: features.map((feature) => feature.id),
    candidates: candidatesOf(features),
    extent: extentOfFeatures(features),
  };
}

describe('the opening of the table page in several Workers', () => {
  it('takes in the rows of the file in its order, the answers of the Workers in any order', async () => {
    const text = fileOf(5_000);
    let state = 7;
    const late = () => {
      state = (state * 48_271) % 2_147_483_647;
      return state % 4;
    };
    for (const workers of [1, 2, 3, 8]) {
      const { opened, taken, params } = await open({ text, workers, fake: () => ({ late }) });
      const expected = reference(text, params);
      expect(idsOf(taken), `${workers} Workers`).toEqual(expected.ids);
      expect(opened.open.rows).toBe(expected.ids.length);
      expect(opened.open.workers).toBe(workers);
      expect(opened.candidates).toEqual(expected.candidates);
      expect(opened.extent).toEqual(expected.extent);
    }
  });

  it('waits for a Worker much later than the others, and keeps the order', async () => {
    const text = fileOf(3_000, 2);
    const { taken, params } = await open({
      text,
      workers: 4,
      fake: (w) => ({ late: () => (w === 0 ? 15 : 0) }),
    });
    expect(idsOf(taken)).toEqual(reference(text, params).ids);
  });

  it('reads a file sent in pieces of a few bytes, and a file of unknown size', async () => {
    const text = fileOf(400, 3);
    const small = await open({ text, workers: 3, chunk: 7, stallMs: 1000 });
    expect(idsOf(small.taken)).toEqual(reference(text, small.params).ids);
    const unsized = await open({ text, workers: 3, sized: false });
    expect(idsOf(unsized.taken)).toEqual(reference(text, unsized.params).ids);
  });

  it('opens a file of fewer lines than Workers', async () => {
    const text = fileOf(3, 4);
    const { taken, params } = await open({ text, workers: 8 });
    expect(idsOf(taken)).toEqual(reference(text, params).ids);
  });

  it('stops with why when a Worker fails, cannot run or never answers', async () => {
    const text = fileOf(2_000, 5);
    // A line that is not JSON in the part of the second Worker
    const lines = text.split('\n');
    lines[1_500] = '{"type": "Feature", "geometry": ';
    await expect(open({ text: lines.join('\n'), workers: 2 })).rejects.toThrow(
      /Worker 1 failed: .*JSON/,
    );
    await expect(open({ text, workers: 3, fake: (w) => ({ broken: w === 2 }) })).rejects.toThrow(
      /Worker 2 could not run: SyntaxError/,
    );
    const t0 = performance.now();
    await expect(
      open({ text, workers: 3, fake: (w) => ({ silent: w === 1 }), stallMs: 300 }),
    ).rejects.toThrow(/nothing came for 0 s \(.*Workers: counted 2\/3/);
    expect(performance.now() - t0).toBeLessThan(3_000);
  });
});
