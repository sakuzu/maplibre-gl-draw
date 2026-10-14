// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The opening of the measurement of the layers held as rows: several Workers make the features
 * (or read the lines of a part of the file each, sent as it is fetched) and build them into row
 * groups, each Worker a run of the order of the rows, and the groups are taken in a run after the
 * other, in the order of their keys, as they come (the drawing takes them in over the frames
 * meanwhile).
 *
 * The number of Workers follows the logical cores of the device (`openWorkerCount`). Rows put in
 * an order at random, or a FeatureCollection, are read and built whole in one Worker: their runs
 * of the order are not runs of the file.
 *
 * It depends on neither the map nor the page, so it runs where Workers run.
 */

import type { RowGroupData } from '@sakuzu/maplibre-gl-draw/table';
import {
  type BenchCandidates,
  type CandidatePick,
  candidateStep,
  extentOf,
  mergeCandidates,
  openWorkerCount,
  type TableBenchPageParams,
  type TableBenchParams,
  unionOfExtents,
} from './table-data';
import type { TableWorkerMessage, TableWorkerRequest } from './table-worker';

/** A Worker of the opening (`table-worker.ts`) */
export interface OpenWorker {
  postMessage(message: TableWorkerRequest, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent<TableWorkerMessage>) => void) | null;
  terminate(): void;
}

/** What the opening is given */
export interface OpenRowsOptions {
  readonly params: TableBenchPageParams;
  /** The address of the file the features are read from (made in the Workers when null) */
  readonly dataUrl: string | null;
  readonly layerId: string;
  /** What takes the row groups in */
  readonly writer: { adopt(layerId: string, groups: readonly RowGroupData[]): void };
  readonly createWorker: () => OpenWorker;
  /** The logical cores of the device */
  readonly cores: number;
  /** When the opening began (`performance.now()`) */
  readonly start: number;
  /** Fetches the file (`fetch` when omitted) */
  readonly fetch?: (url: string) => Promise<Response>;
}

/** What the opening read and built */
export interface OpenedRows {
  /** The time of each step (ms; `workers`, `rows` are counts) */
  readonly open: Record<string, number>;
  /** The extent of the features, `[west, south, east, north]` */
  readonly extent: [number, number, number, number];
  readonly candidates: BenchCandidates;
}

/** What a Worker picked before it sent its pick */
const EMPTY_PICK: CandidatePick = {
  point: null,
  line: null,
  lineVertices: 0,
  polygon: null,
  polygonCorners: Number.POSITIVE_INFINITY,
  ids: [],
  points: [],
  polygons: [],
};

/** Opens the rows: made or read and built in the Workers, taken in as they come */
export async function openRows(options: OpenRowsOptions): Promise<OpenedRows> {
  const { params, dataUrl, layerId, writer, start: t0 } = options;
  const lines = dataUrl !== null && /\.(ndjson|geojsonl)$/.test(dataUrl);
  const whole = dataUrl !== null && (params.shuffle || !lines);
  const count = whole ? 1 : openWorkerCount(params, options.cores);
  const benchParams: TableBenchParams = {
    n: params.n,
    kind: params.kind,
    styles: params.styles,
    translucent: params.translucent,
    data: params.data,
    shuffle: params.shuffle,
  };
  const workers = Array.from({ length: count }, () => options.createWorker());
  /** The groups of each Worker not taken in yet, and whether it sent its last ones */
  const waiting: RowGroupData[][][] = workers.map(() => []);
  const built = workers.map(() => false);
  let taking = 0;
  let adoptMs = 0;
  let firstGroupAt = 0;
  /** Takes in the groups of the runs in their order: a run once the runs before it are in */
  const takeIn = (): void => {
    while (taking < count) {
      for (const groups of waiting[taking].splice(0)) {
        const a0 = performance.now();
        writer.adopt(layerId, groups);
        adoptMs += performance.now() - a0;
        firstGroupAt ||= performance.now();
      }
      if (!built[taking]) return;
      taking++;
    }
  };
  const parsed: Array<{ lines: number; features: number } | null> = workers.map(() => null);
  const builds: Array<Extract<TableWorkerMessage, { kind: 'built' }>> = [];
  const picks: CandidatePick[] = workers.map(() => EMPTY_PICK);
  let parsedAt = 0;
  let builtAt = 0;
  let fetchedAt = 0;
  /** Tells each Worker of a part where its lines are, once the parts before it are read */
  let based = 0;
  const base = (): void => {
    while (based < count && parsed[based]) {
      let lineBase = 0;
      let featureBase = 0;
      for (let k = 0; k < based; k++) {
        lineBase += parsed[k]?.lines ?? 0;
        featureBase += parsed[k]?.features ?? 0;
      }
      workers[based].postMessage({ kind: 'build', params: benchParams, lineBase, featureBase });
      based++;
    }
    if (based === count && parsedAt === 0) {
      parsedAt = performance.now();
      const features = parsed.reduce((sum, part) => sum + (part?.features ?? 0), 0);
      for (const worker of workers) {
        worker.postMessage({ kind: 'pick', step: candidateStep(features) });
      }
    }
  };
  const finished = new Promise<void>((resolve, reject) => {
    let picked = 0;
    workers.forEach((worker, w) => {
      worker.onmessage = (event) => {
        const message = event.data;
        switch (message.kind) {
          case 'parsed':
            parsed[w] = message;
            base();
            return;
          case 'groups':
            waiting[w].push(message.groups);
            takeIn();
            return;
          case 'built':
            builds[w] = message;
            built[w] = true;
            takeIn();
            if (built.every(Boolean)) builtAt = performance.now();
            return;
          case 'picked':
            picks[w] = message.candidates;
            if (++picked === count) resolve();
            return;
          case 'failed':
            reject(new Error(message.error));
            return;
        }
      };
    });
  });
  // Handled where it is awaited (a Worker can fail while the file is still sent)
  finished.catch(() => {});
  try {
    if (whole && dataUrl) {
      workers[0].postMessage({ kind: 'whole', params: benchParams, dataUrl });
    } else if (dataUrl) {
      await sendParts(dataUrl, workers, options.fetch ?? ((url) => fetch(url)));
      fetchedAt = performance.now();
    } else {
      workers.forEach((worker, w) => {
        const start = Math.floor((params.n * w) / count);
        const end = Math.floor((params.n * (w + 1)) / count);
        worker.postMessage({ kind: 'make', params: benchParams, start, end });
      });
    }
    await finished;
  } finally {
    for (const worker of workers) worker.terminate();
  }
  const max = (values: number[]): number => Math.max(0, ...values);
  const open: Record<string, number> = {
    workers: count,
    rows: builds.reduce((sum, b) => sum + b.count, 0),
  };
  // The file fetched (its parts sent to the Workers as they came)
  if (fetchedAt > 0) open.fetch = fetchedAt - t0;
  // The features read: the lines of every part read (the file fetched meanwhile), or the file
  // read whole in its Worker; the features made are made as they are added
  open.generate = parsedAt > 0 ? parsedAt - t0 : max(builds.map((b) => b.generateMs));
  open.addRows = max(builds.map((b) => b.addMs));
  open.buildGroups = max(builds.map((b) => b.buildMs));
  if (firstGroupAt > 0) open.firstGroups = firstGroupAt - t0;
  open.workerTotal = (builtAt || performance.now()) - t0;
  open.adoptQueue = adoptMs;
  return {
    open,
    extent: dataUrl ? unionOfExtents(builds.map((b) => b.extent)) : extentOf(params),
    candidates: mergeCandidates(picks),
  };
}

/**
 * Fetches a file of one feature per line and sends it to the Workers as it comes, about as many
 * bytes to each, cut at the ends of lines: the first part to the first Worker, and so on (the
 * order of the file is kept). A chunk is sent without a copy when it goes whole to one Worker
 */
async function sendParts(
  url: string,
  workers: readonly OpenWorker[],
  fetchFile: (url: string) => Promise<Response>,
): Promise<void> {
  const response = await fetchFile(url);
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  let total = Number(response.headers.get('content-length')) || 0;
  // Read as it comes when its size is known (the body is not read twice)
  const reader = total > 0 ? response.body?.getReader() : undefined;
  let chunks: AsyncIterable<Uint8Array> | Iterable<Uint8Array>;
  if (!reader) {
    // The size is not known before: the whole of it first
    const all = new Uint8Array(await response.arrayBuffer());
    total = all.length;
    chunks = [all];
  } else {
    chunks = (async function* () {
      for (let next = await reader.read(); !next.done; next = await reader.read()) {
        yield next.value;
      }
    })();
  }
  const send = (w: number, bytes: Uint8Array): void => {
    const whole = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength;
    const own = whole ? bytes : bytes.slice();
    const buffer = own.buffer as ArrayBuffer;
    workers[w].postMessage({ kind: 'part', bytes: buffer }, [buffer]);
  };
  const quota = Math.ceil(total / workers.length);
  let w = 0;
  let sent = 0;
  for await (const chunk of chunks) {
    // Its length is read first: a chunk sent whole is detached
    const length = chunk.length;
    let start = 0;
    while (start < length) {
      if (w < workers.length - 1 && sent + (length - start) >= quota) {
        // The end of the line where the part of this Worker is full
        const end = chunk.indexOf(10, start + Math.max(0, quota - sent - 1));
        if (end >= 0) {
          send(w, chunk.subarray(start, end + 1));
          workers[w].postMessage({ kind: 'end' });
          w++;
          sent = 0;
          start = end + 1;
          continue;
        }
      }
      send(w, chunk.subarray(start));
      sent += length - start;
      break;
    }
  }
  for (; w < workers.length; w++) workers[w].postMessage({ kind: 'end' });
}
