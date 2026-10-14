// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The opening of the measurement of the layers held as rows: several Workers make the features
 * (or read the lines of a part of the file each, sent as it is fetched) and build them into row
 * groups, each Worker a run of the order of the rows, and the groups are taken in a run after the
 * other, in the order of their keys, as they come (the drawing takes them in over the frames
 * meanwhile). See `table-worker-core.ts` for what a Worker does.
 *
 * The number of Workers follows the logical cores of the device (`openWorkerCount`). Rows put in
 * an order at random, or a FeatureCollection, are read and built whole in one Worker: their runs
 * of the order are not runs of the file.
 *
 * The opening never waits silently: a Worker that fails, that cannot run, or a wait in which no
 * Worker answers and no byte comes for `stallMs` stops it with what each Worker had done, and
 * `onProgress` is told how far it went every half second.
 *
 * It depends on neither the map nor the page, so it runs where Workers run (and in the tests).
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
import type { TableWorkerMessage, TableWorkerRequest } from './table-worker-core';

/** A Worker of the opening (`table-worker.ts`) */
export interface OpenWorker {
  postMessage(message: TableWorkerRequest, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent<TableWorkerMessage>) => void) | null;
  /** A Worker that could not run, or that threw outside its work */
  onerror: ((event: ErrorEvent) => void) | null;
  /** A message that could not be read */
  onmessageerror: ((event: MessageEvent) => void) | null;
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
  /** The time nothing may come before the opening stops ({@link OPEN_STALL_MS} when omitted) */
  readonly stallMs?: number;
  /** Told how far the opening went, every half second */
  readonly onProgress?: (text: string) => void;
}

/** What the opening read and built */
export interface OpenedRows {
  /** The time of each step (ms; `workers`, `rows` are counts) */
  readonly open: Record<string, number>;
  /** The extent of the features, `[west, south, east, north]` */
  readonly extent: [number, number, number, number];
  readonly candidates: BenchCandidates;
}

/** The time no Worker may answer and no byte may come before the opening stops (ms) */
export const OPEN_STALL_MS = 30_000;

/**
 * The bytes of a part of the file read whole sent at a time (a file whose size is not known
 * before is read whole first; it is sent in pieces so that no copy holds the page long)
 */
const PIECE_BYTES = 4 * 1024 * 1024;

const MB = 1024 * 1024;

/** What a Worker has done */
interface WorkerState {
  bytes: number;
  counted: number | null;
  based: boolean;
  groups: number;
  built: number | null;
  picked: CandidatePick | null;
}

/** Opens the rows: made or read and built in the Workers, taken in as they come */
export async function openRows(options: OpenRowsOptions): Promise<OpenedRows> {
  const { params, dataUrl, layerId, writer, start: t0 } = options;
  const lines = dataUrl !== null && /\.(ndjson|geojsonl)$/.test(dataUrl);
  const whole = dataUrl !== null && (params.shuffle || !lines);
  const count = whole ? 1 : openWorkerCount(params, options.cores);
  const stallMs = options.stallMs ?? OPEN_STALL_MS;
  const benchParams: TableBenchParams = {
    n: params.n,
    kind: params.kind,
    styles: params.styles,
    translucent: params.translucent,
    data: params.data,
    shuffle: params.shuffle,
  };
  const states: WorkerState[] = Array.from({ length: count }, () => ({
    bytes: 0,
    counted: null,
    based: false,
    groups: 0,
    built: null,
    picked: null,
  }));
  const builds: Array<Extract<TableWorkerMessage, { kind: 'built' }>> = [];
  /** The groups of each Worker not taken in yet */
  const waiting: RowGroupData[][][] = states.map(() => []);
  let taking = 0;
  let adopted = 0;
  let adoptMs = 0;
  let firstGroupAt = 0;
  let countedAt = 0;
  let builtAt = 0;
  let fetchedAt = 0;
  let total = 0;
  let sentBytes = 0;
  let lastNews = performance.now();
  let stopped = false;

  /** Where every Worker is (for the progress and for why the opening stopped) */
  const describe = (): string => {
    const done = (test: (state: WorkerState) => boolean) => states.filter(test).length;
    const bytes =
      dataUrl && !whole
        ? `${(sentBytes / MB).toFixed(0)}${total > 0 ? `/${(total / MB).toFixed(0)}` : ''} MB sent; `
        : '';
    const each = states
      .map(
        (s, w) =>
          `#${w} ${(s.bytes / MB).toFixed(0)} MB ${s.counted ?? '-'} lines ${s.based ? 'based' : '-'} ${s.groups} groups ${s.built === null ? '-' : `built ${s.built}`} ${s.picked ? 'picked' : '-'}`,
      )
      .join(', ');
    return (
      `${bytes}Workers: counted ${done((s) => s.counted !== null)}/${count}, ` +
      `built ${done((s) => s.built !== null)}/${count}, picked ${done((s) => !!s.picked)}/${count}; ` +
      `groups taken in ${adopted} (${each})`
    );
  };

  /** Takes in the groups of the runs in their order: a run once the runs before it are in */
  const takeIn = (): void => {
    while (taking < count) {
      for (const groups of waiting[taking].splice(0)) {
        const a0 = performance.now();
        writer.adopt(layerId, groups);
        adoptMs += performance.now() - a0;
        adopted += groups.length;
        firstGroupAt ||= performance.now();
      }
      if (states[taking].built === null) return;
      taking++;
    }
  };

  const workers = Array.from({ length: count }, () => options.createWorker());
  /** Tells each Worker of a part where its lines begin, once the parts before it are counted */
  let based = 0;
  const base = (): void => {
    while (based < count && states[based].counted !== null) {
      let lineBase = 0;
      for (let k = 0; k < based; k++) lineBase += states[k].counted ?? 0;
      workers[based].postMessage({ kind: 'base', params: benchParams, lineBase });
      states[based].based = true;
      based++;
    }
    if (based === count) countedAt ||= performance.now();
  };
  /** Tells each Worker where its features begin, once every Worker has built them */
  const pick = (): void => {
    if (states.some((state) => state.built === null)) return;
    builtAt = performance.now();
    const features = states.reduce((sum, state) => sum + (state.built ?? 0), 0);
    let featureBase = 0;
    workers.forEach((worker, w) => {
      worker.postMessage({ kind: 'pick', featureBase, step: candidateStep(features) });
      featureBase += states[w].built ?? 0;
    });
  };

  let watchdog: ReturnType<typeof setInterval> | undefined;
  const finished = new Promise<void>((resolve, reject) => {
    const stop = (why: string): void => {
      stopped = true;
      reject(new Error(`${why} (${describe()})`));
    };
    workers.forEach((worker, w) => {
      worker.onmessage = (event) => {
        lastNews = performance.now();
        const message = event.data;
        const state = states[w];
        try {
          switch (message.kind) {
            case 'counted':
              state.counted = message.lines;
              base();
              return;
            case 'groups':
              state.groups += message.groups.length;
              waiting[w].push(message.groups);
              takeIn();
              return;
            case 'built':
              builds[w] = message;
              state.built = message.count;
              takeIn();
              pick();
              return;
            case 'picked':
              state.picked = message.candidates;
              if (states.every((s) => s.picked)) resolve();
              return;
            case 'failed':
              stop(`Worker ${w} failed: ${message.error}`);
              return;
          }
        } catch (error) {
          stop(`taking in what Worker ${w} sent failed: ${String(error)}`);
        }
      };
      worker.onerror = (event) => {
        event.preventDefault?.();
        const where = event.filename ? ` at ${event.filename}:${event.lineno}` : '';
        stop(`Worker ${w} could not run: ${event.message || 'an error without a message'}${where}`);
      };
      worker.onmessageerror = () => stop(`a message of Worker ${w} could not be read`);
    });
    watchdog = setInterval(() => {
      options.onProgress?.(describe());
      if (performance.now() - lastNews > stallMs) {
        stop(`nothing came for ${(stallMs / 1000).toFixed(0)} s`);
      }
    }, 500);
  });
  // Handled where it is awaited (a Worker can fail while the file is still sent)
  finished.catch(() => {});
  try {
    if (whole && dataUrl) {
      workers[0].postMessage({ kind: 'whole', params: benchParams, dataUrl });
    } else if (dataUrl) {
      const send = async (): Promise<void> => {
        await sendParts(dataUrl, workers, options.fetch ?? ((url) => fetch(url)), {
          size: (bytes) => {
            total = bytes;
          },
          sent: (w, bytes) => {
            states[w].bytes += bytes;
            sentBytes += bytes;
            lastNews = performance.now();
          },
          stopped: () => stopped,
        });
        fetchedAt = performance.now();
      };
      // A Worker that fails while the file is sent stops the opening at once (the file is no
      // longer read then)
      const sending = send();
      sending.catch(() => {});
      await Promise.race([sending, finished]);
    } else {
      workers.forEach((worker, w) => {
        const start = Math.floor((params.n * w) / count);
        const end = Math.floor((params.n * (w + 1)) / count);
        worker.postMessage({ kind: 'make', params: benchParams, start, end });
      });
    }
    await finished;
  } finally {
    clearInterval(watchdog);
    for (const worker of workers) worker.terminate();
  }
  const max = (values: number[]): number => Math.max(0, ...values);
  const open: Record<string, number> = {
    workers: count,
    rows: builds.reduce((sum, b) => sum + b.count, 0),
  };
  // The file fetched (its parts sent to the Workers as they came)
  if (fetchedAt > 0) open.fetch = fetchedAt - t0;
  // The lines of every part counted (each Worker reads and builds its lines meanwhile)
  if (countedAt > 0) open.counted = countedAt - t0;
  // The time reading the lines took (the longest of the Workers; made features are made as they
  // are added, a file read whole is fetched and read in its Worker)
  open.generate = max(builds.map((b) => b.generateMs));
  open.addRows = max(builds.map((b) => b.addMs));
  open.buildGroups = max(builds.map((b) => b.buildMs));
  if (firstGroupAt > 0) open.firstGroups = firstGroupAt - t0;
  open.workerTotal = (builtAt || performance.now()) - t0;
  open.adoptQueue = adoptMs;
  return {
    open,
    extent: dataUrl ? unionOfExtents(builds.map((b) => b.extent)) : extentOf(params),
    candidates: mergeCandidates(states.map((state) => state.picked as CandidatePick)),
  };
}

/** What `sendParts` tells as it goes */
interface SendWatch {
  /** The size of the file */
  size(bytes: number): void;
  /** Bytes sent to a Worker */
  sent(worker: number, bytes: number): void;
  /** Whether the opening stopped (the file is no longer read) */
  stopped(): boolean;
}

/**
 * Fetches a file of one feature per line and sends it to the Workers as it comes, about as many
 * bytes to each, cut at the ends of lines: the first part to the first Worker, and so on (the
 * order of the file is kept). A chunk is sent without a copy when it goes whole to one Worker. A
 * file whose size is not known before is read whole first, and sent in pieces of
 * {@link PIECE_BYTES} with the page let go between them
 */
async function sendParts(
  url: string,
  workers: readonly OpenWorker[],
  fetchFile: (url: string) => Promise<Response>,
  watch: SendWatch,
): Promise<void> {
  const response = await fetchFile(url);
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  let total = Number(response.headers.get('content-length')) || 0;
  // Read as it comes when its size is known (the body is not read twice)
  const reader = total > 0 ? response.body?.getReader() : undefined;
  let chunks: AsyncIterable<Uint8Array>;
  if (!reader) {
    const all = new Uint8Array(await response.arrayBuffer());
    total = all.length;
    chunks = (async function* () {
      for (let at = 0; at < all.length; at += PIECE_BYTES) {
        yield all.subarray(at, Math.min(all.length, at + PIECE_BYTES));
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    })();
  } else {
    chunks = (async function* () {
      for (let next = await reader.read(); !next.done; next = await reader.read()) {
        yield next.value;
      }
    })();
  }
  watch.size(total);
  const send = (w: number, bytes: Uint8Array): void => {
    const length = bytes.byteLength;
    const whole = bytes.byteOffset === 0 && length === bytes.buffer.byteLength;
    const own = whole ? bytes : bytes.slice();
    const buffer = own.buffer as ArrayBuffer;
    workers[w].postMessage({ kind: 'part', bytes: buffer }, [buffer]);
    watch.sent(w, length);
  };
  const quota = Math.ceil(total / workers.length);
  let w = 0;
  let sent = 0;
  for await (const chunk of chunks) {
    if (watch.stopped()) {
      await reader?.cancel();
      return;
    }
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
