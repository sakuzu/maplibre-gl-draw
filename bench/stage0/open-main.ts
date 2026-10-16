// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The page of opening a map in steps: a set of blocks of `bench/data/stage0/` (made by
 * `node bench/stage0/make-blocks.ts`) opened over a link of a given speed, the rows of the view
 * first.
 *
 * Open:
 *
 * 1. Fetches the head, the manifest and the small items, and applies the small items: the
 *    background of the map, its layers, the view (`view=city`: zoom 14 over the most rows,
 *    `view=all`: every row). The time until that is drawn is `small`
 * 2. Fetches the files whose bounding box meets the view first, then the rest, the next file
 *    picked when the link is free (one in the view as it is then, when there is one; otherwise
 *    the next in the order of the rows). The Workers decode each file into row blocks as it
 *    comes; the blocks of the files of the view are added to the layer as they come, in whatever
 *    order, each at the place of its keys. The time until they are all drawn is `viewDrawn`
 * 3. The blocks of the other files decoded meanwhile are added then, and the rest as they come.
 *    The time until every row is drawn is `allDrawn`
 *
 * The link is simulated: a file is fetched from the dev server when the link would start to send
 * it, and handed over once its bytes would have come at `mbps` (0: not limited) after a round
 * trip of `rtt` ms; the files are sent one after the other, `inflight` requests at most at once.
 *
 * Attach (once the map is open): the set `attach` is fetched and decoded the same way and added
 * as a layer on top, as the import of another client, while the frames are measured.
 *
 * The page shows, and `window.stage0Result` holds: the times of the steps (ms from the press),
 * the frame intervals (median, 95th percentile, longest) until the view is drawn, after it and in
 * all, the JS heap (Chromium only) and the GPU memory of the drawing after each step, and each
 * file as it came. `window.stage0Open()` and `window.stage0Attach()` run them.
 */

import { createDraw, type Draw } from '@sakuzu/maplibre-gl-draw';
import { createTableStore, type RowBlock } from '@sakuzu/maplibre-gl-draw/kasane';
import * as maplibregl from 'maplibre-gl';
import { heapMb, MB, nextFrame, wait } from '../table-measure';
import type { DecodeReply, DecodeRequest } from './decode-worker.ts';

// Worker URL setup for v6 (side effect). Required before the Map is created.
import '../maplibre-setup';

// === The parameters ===

const query = new URLSearchParams(location.search);
const num = (key: string, fallback: number): number => {
  const v = Number(query.get(key));
  return query.has(key) && Number.isFinite(v) && v >= 0 ? v : fallback;
};
const params = {
  data: query.get('data') || 'fgd-buildings-tokyo-100k',
  view: query.get('view') === 'all' ? ('all' as const) : ('city' as const),
  mbps: num('mbps', 100),
  rtt: num('rtt', 20),
  inflight: Math.max(1, num('inflight', 6)),
  workers: num('workers', 0),
  attach: query.get('attach') || 'overture-buildings-tokyo-attrs',
};
const workerCount =
  params.workers > 0 ? params.workers : Math.min(4, Math.max(1, navigator.hardwareConcurrency - 1));

const statusEl = document.getElementById('status') as HTMLElement;
const resultEl = document.getElementById('result') as HTMLElement;
const openButton = document.getElementById('open') as HTMLButtonElement;
const attachButton = document.getElementById('attach') as HTMLButtonElement;
const setStatus = (text: string, failed = false): void => {
  statusEl.textContent = text;
  statusEl.className = failed ? 'failed' : '';
};

const form = document.getElementById('params') as HTMLFormElement;
for (const [key, value] of Object.entries(params)) {
  const field = form.elements.namedItem(key) as HTMLInputElement | HTMLSelectElement | null;
  if (field) field.value = String(value);
}
// The conditions of the measurement, as links
const presets = document.getElementById('presets') as HTMLElement;
for (const data of ['fgd-buildings-tokyo-100k', 'fgd-buildings-1m']) {
  for (const view of ['city', 'all']) {
    for (const mbps of [100, 20]) {
      const a = document.createElement('a');
      a.href = `?data=${data}&view=${view}&mbps=${mbps}`;
      a.textContent = `${data.replace('fgd-buildings-', '')} ${view} ${mbps}`;
      presets.append(a, ' ');
    }
  }
}

// === The files ===

type Box = [number, number, number, number];

interface FileEntry {
  readonly name: string;
  readonly bytes: number;
  readonly layer: string;
  readonly rows: number;
  readonly firstRow: number;
  readonly bbox: Box;
}

interface Manifest {
  readonly small: { readonly name: string; readonly bytes: number };
  readonly files: readonly FileEntry[];
  readonly summary: { readonly rows: number };
  readonly views: {
    readonly city: { readonly center: [number, number]; readonly zoom: number };
    readonly all: { readonly bounds: Box };
  };
}

interface SmallItems {
  readonly map: { readonly background: string };
  readonly layers: readonly { readonly id: string; readonly name: string; readonly rows: number }[];
}

/** The link the files come over */
class Link {
  readonly #bytesPerMs: number;
  readonly #rtt: number;
  /** When the link has sent what it was asked for */
  #freeAt = 0;
  /** The bytes that came */
  received = 0;

  constructor(mbps: number, rtt: number) {
    this.#bytesPerMs = mbps > 0 ? (mbps * 1e6) / 8 / 1000 : Number.POSITIVE_INFINITY;
    this.#rtt = rtt;
  }

  /** Waits until the link has sent what it was asked for */
  async free(): Promise<void> {
    const left = this.#freeAt - performance.now();
    if (left > 0) await wait(left);
  }

  /**
   * The bytes of a file, once they would have come. The link is taken for the file when it is
   * asked for, when its size is given (when the response is read otherwise)
   */
  async get(url: string, bytes?: number): Promise<ArrayBuffer> {
    const asked = performance.now();
    let due = bytes === undefined ? null : this.#take(asked, bytes);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${url}: ${response.status}`);
    const body = await response.arrayBuffer();
    if (due === null) due = this.#take(asked, body.byteLength);
    const left = due - performance.now();
    if (left > 0) await wait(left);
    this.received += bytes ?? body.byteLength;
    return body;
  }

  /** Takes the link for `size` bytes asked for at `asked`: when they will have come */
  #take(asked: number, size: number): number {
    const start = Math.max(asked, this.#freeAt);
    const send = size / this.#bytesPerMs;
    this.#freeAt = start + send;
    return start + this.#rtt + send;
  }

  async json<T>(url: string): Promise<T> {
    return JSON.parse(new TextDecoder().decode(await this.get(url))) as T;
  }
}

/** The Workers that decode the files */
class Decoders {
  readonly #workers: Worker[] = [];
  readonly #busy: number[] = [];
  readonly #waiting = new Map<number, (reply: DecodeReply) => void>();
  #next = 0;

  constructor(count: number) {
    for (let i = 0; i < count; i++) {
      const worker = new Worker(new URL('./decode-worker.ts', import.meta.url), {
        type: 'module',
      });
      worker.onmessage = (event: MessageEvent<DecodeReply>) => {
        this.#busy[i]--;
        this.#waiting.get(event.data.id)?.(event.data);
        this.#waiting.delete(event.data.id);
      };
      worker.onerror = (event) => setStatus(`A Worker failed: ${event.message}`, true);
      this.#workers.push(worker);
      this.#busy.push(0);
    }
  }

  /** Decodes a file in the Worker with the least to do */
  decode(bytes: ArrayBuffer): Promise<DecodeReply> {
    let k = 0;
    for (let i = 1; i < this.#workers.length; i++) if (this.#busy[i] < this.#busy[k]) k = i;
    this.#busy[k]++;
    const id = this.#next++;
    return new Promise((resolve) => {
      this.#waiting.set(id, resolve);
      const request: DecodeRequest = { id, bytes };
      this.#workers[k].postMessage(request, [bytes]);
    });
  }
}

const decoders = new Decoders(workerCount);

// === The map and the drawing ===

const map = new maplibregl.Map({
  container: 'map',
  style: {
    version: 8,
    sources: {},
    layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#ffffff' } }],
  },
  center: [139.7, 35.68],
  zoom: 10,
  attributionControl: false,
  fadeDuration: 0,
});
const { store, writer } = createTableStore();
const draw: Draw = createDraw(map, {
  defaultMode: 'select',
  autoName: false,
  initDefaultLayer: false,
  store,
});

function createLayer(id: string, name: string): void {
  store.createLayer({
    id,
    name,
    visible: true,
    locked: false,
    opacity: 1,
    kind: 'table',
    styleRule: undefined,
    metadata: undefined,
  });
}

// === Measuring ===

/** The times of the frames while it records */
class Frames {
  readonly times: number[] = [];
  #on = false;

  start(): void {
    this.#on = true;
    const tick = (now: number): void => {
      this.times.push(now);
      map.triggerRepaint();
      if (this.#on) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  stop(): void {
    this.#on = false;
  }

  /** The intervals of the frames that ended from `from` to `to` (ms) */
  stats(
    from: number,
    to: number,
  ): { frames: number; medianMs: number; p95Ms: number; maxMs: number } {
    const intervals: number[] = [];
    for (let i = 1; i < this.times.length; i++) {
      if (this.times[i] > from && this.times[i] <= to) {
        intervals.push(this.times[i] - this.times[i - 1]);
      }
    }
    intervals.sort((a, b) => a - b);
    const pick = (p: number) =>
      intervals.length === 0
        ? 0
        : round(intervals[Math.min(intervals.length - 1, Math.floor(intervals.length * p))]);
    return {
      frames: intervals.length,
      medianMs: pick(0.5),
      p95Ms: pick(0.95),
      maxMs: intervals.length === 0 ? 0 : round(intervals[intervals.length - 1]),
    };
  }
}

const round = (v: number): number => Math.round(v * 10) / 10;

/** The memory after a step */
function memory(): { heapMb: number | null; gpuMb: number } {
  const heap = heapMb();
  return { heapMb: heap === null ? null : round(heap), gpuMb: round(draw.debug.gpu().bytes / MB) };
}

/** Draws frames until the drawing has nothing left to build */
async function settle(timeoutMs = 120_000): Promise<void> {
  const start = performance.now();
  await nextFrame();
  while (draw.hasPendingWork() || !map.loaded()) {
    if (performance.now() - start > timeoutMs) {
      throw new Error(`the drawing still had work after ${timeoutMs / 1000} s`);
    }
    map.triggerRepaint();
    await nextFrame();
  }
}

function meets(a: Box, b: Box): boolean {
  return a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
}

function viewBox(): Box {
  const b = map.getBounds();
  return [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
}

/** A file as it came */
interface FileResult {
  readonly file: number;
  readonly rows: number;
  readonly bytes: number;
  readonly inView: boolean;
  readonly cameMs: number;
  readonly decodedMs: number;
  readonly workerMs: number;
}

/**
 * Fetches the files over the link, the next picked when the link is free (one in the view, when
 * there is one), and hands each to `take` once it is decoded
 */
async function fetchFiles(
  base: URL,
  files: readonly FileEntry[],
  link: Link,
  t0: number,
  take: (index: number, blocks: RowBlock[]) => void,
  results: FileResult[],
): Promise<void> {
  const left = files.map((_, i) => i);
  const running = new Set<Promise<void>>();
  let failure: unknown = null;
  while (left.length > 0 && failure === null) {
    while (running.size >= params.inflight) await Promise.race(running);
    await link.free();
    const view = viewBox();
    let at = left.findIndex((i) => meets(files[i].bbox, view));
    const inView = at >= 0;
    if (at < 0) at = 0;
    const index = left.splice(at, 1)[0];
    const file = files[index];
    const job = (async () => {
      const bytes = await link.get(new URL(file.name, base).href, file.bytes);
      const cameMs = performance.now() - t0;
      const reply = await decoders.decode(bytes);
      if (!reply.ok) throw new Error(`${file.name}: ${reply.error}`);
      results.push({
        file: index,
        rows: reply.rows,
        bytes: file.bytes,
        inView,
        cameMs: round(cameMs),
        decodedMs: round(performance.now() - t0),
        workerMs: round(reply.ms),
      });
      take(index, reply.blocks);
    })().catch((error: unknown) => {
      failure = error;
    });
    running.add(job);
    void job.finally(() => running.delete(job));
  }
  await Promise.all(running);
  if (failure !== null) throw failure;
}

interface OpenResult {
  params: typeof params;
  workers: number;
  rows: number;
  files: number;
  filesInView: number;
  rowsInView: number;
  /** The times of the steps (ms from the press) */
  times: Record<string, number>;
  frames: Record<string, ReturnType<Frames['stats']>>;
  memory: Record<string, ReturnType<typeof memory>>;
  came: FileResult[];
  attach?: AttachResult;
  failed?: string;
}

interface AttachResult {
  data: string;
  rows: number;
  files: number;
  times: Record<string, number>;
  frames: ReturnType<Frames['stats']>;
  /** Frames longer than 100 ms */
  longFrames: number;
  memory: ReturnType<typeof memory>;
  came: FileResult[];
}

declare global {
  interface Window {
    stage0Result?: OpenResult;
    stage0Open: () => Promise<OpenResult>;
    stage0Attach: () => Promise<AttachResult | null>;
    stage0Draw: Draw;
  }
}
window.stage0Draw = draw;

const dataUrl = (name: string): URL => new URL(`../data/stage0/${name}/`, location.href);

let opened = false;

async function open(): Promise<OpenResult> {
  if (opened) throw new Error('the map is open: reload the page to open it again');
  opened = true;
  openButton.disabled = true;
  const result: OpenResult = {
    params,
    workers: workerCount,
    rows: 0,
    files: 0,
    filesInView: 0,
    rowsInView: 0,
    times: {},
    frames: {},
    memory: { before: memory() },
    came: [],
  };
  window.stage0Result = result;
  const frames = new Frames();
  const t0 = performance.now();
  const mark = (name: string) => {
    result.times[name] = round(performance.now() - t0);
  };
  frames.start();
  try {
    const base = dataUrl(params.data);
    const link = new Link(params.mbps, params.rtt);
    setStatus('Opening: the manifest');
    const head = await link.json<{ manifest: string }>(new URL('head.ndjson', base).href);
    const manifest = await link.json<Manifest>(new URL(head.manifest, base).href);
    mark('manifest');
    const small = await link.json<SmallItems>(new URL(manifest.small.name, base).href);
    // The small items: the background, the layers, the view
    map.setPaintProperty('bg', 'background-color', small.map.background);
    for (const layer of small.layers) createLayer(layer.id, layer.name);
    if (params.view === 'city') {
      map.jumpTo({ center: manifest.views.city.center, zoom: manifest.views.city.zoom });
    } else {
      const [w, s, e, n] = manifest.views.all.bounds;
      map.fitBounds(
        [
          [w, s],
          [e, n],
        ],
        { animate: false, padding: 10 },
      );
    }
    await nextFrame();
    await nextFrame();
    mark('small');
    result.memory.small = memory();

    const view = viewBox();
    const files = manifest.files;
    const inView = new Set(files.flatMap((f, i) => (meets(f.bbox, view) ? [i] : [])));
    result.rows = manifest.summary.rows;
    result.files = files.length;
    result.filesInView = inView.size;
    result.rowsInView = files.reduce((s, f, i) => s + (inView.has(i) ? f.rows : 0), 0);
    let viewLeft = inView.size;
    let viewDone = false;
    const held: [string, RowBlock[]][] = [];
    let viewAdded: () => void = () => {};
    const viewAddedPromise = new Promise<void>((resolve) => {
      viewAdded = resolve;
    });
    if (viewLeft === 0) viewAdded();
    let rowsAdded = 0;
    const progress = setInterval(() => {
      setStatus(
        `Opening: ${(link.received / MB).toFixed(1)} MB came, ${rowsAdded} of ${result.rows} rows ` +
          `added (${result.came.length} of ${files.length} files)` +
          (viewDone ? '' : `, ${inView.size - viewLeft} of ${inView.size} files of the view`),
      );
    }, 250);
    const fetching = fetchFiles(
      base,
      files,
      link,
      t0,
      (index, blocks) => {
        const file = files[index];
        if (inView.has(index) || viewDone) {
          writer.addRowBlocks(file.layer, blocks);
          rowsAdded += file.rows;
        } else {
          held.push([file.layer, blocks]);
        }
        if (inView.has(index) && --viewLeft === 0) viewAdded();
      },
      result.came,
    );
    try {
      await Promise.race([viewAddedPromise, fetching]);
      await viewAddedPromise;
      mark('viewAdded');
      await settle();
      mark('viewDrawn');
      result.memory.viewDrawn = memory();
      viewDone = true;
      for (const [layer, blocks] of held) {
        writer.addRowBlocks(layer, blocks);
        rowsAdded += blocks.reduce((s, b) => s + b.length, 0);
      }
      held.length = 0;
      await fetching;
      mark('allCame');
      await settle();
      mark('allDrawn');
      result.memory.allDrawn = memory();
    } finally {
      clearInterval(progress);
    }
    frames.stop();
    const end = t0 + result.times.allDrawn;
    result.frames.untilViewDrawn = frames.stats(t0, t0 + result.times.viewDrawn);
    result.frames.afterViewDrawn = frames.stats(t0 + result.times.viewDrawn, end);
    result.frames.all = frames.stats(t0, end);
    setStatus(`Open: ${result.rows} rows in ${(result.times.allDrawn / 1000).toFixed(2)} s`);
    attachButton.disabled = false;
  } catch (error) {
    frames.stop();
    result.failed = error instanceof Error ? error.message : String(error);
    setStatus(`Stopped: ${result.failed}`, true);
  }
  show(result);
  return result;
}

let attached = false;

async function attach(): Promise<AttachResult | null> {
  const result = window.stage0Result;
  if (!result || result.times.allDrawn === undefined || attached) return null;
  if (params.attach === params.data) {
    setStatus('Attach another set than the one opened (its ids are already rows)', true);
    return null;
  }
  attached = true;
  attachButton.disabled = true;
  const frames = new Frames();
  const t0 = performance.now();
  const times: Record<string, number> = {};
  const mark = (name: string) => {
    times[name] = round(performance.now() - t0);
  };
  frames.start();
  try {
    const base = dataUrl(params.attach);
    const link = new Link(params.mbps, params.rtt);
    const head = await link.json<{ manifest: string }>(new URL('head.ndjson', base).href);
    const manifest = await link.json<Manifest>(new URL(head.manifest, base).href);
    const small = await link.json<SmallItems>(new URL(manifest.small.name, base).href);
    for (const layer of small.layers) createLayer(layer.id, layer.name);
    mark('small');
    const came: FileResult[] = [];
    let rows = 0;
    const progress = setInterval(() => {
      setStatus(`Attaching: ${rows} of ${manifest.summary.rows} rows added`);
    }, 250);
    try {
      await fetchFiles(
        base,
        manifest.files,
        link,
        t0,
        (index, blocks) => {
          writer.addRowBlocks(manifest.files[index].layer, blocks);
          rows += manifest.files[index].rows;
        },
        came,
      );
      mark('allCame');
      await settle();
      mark('allDrawn');
    } finally {
      clearInterval(progress);
    }
    frames.stop();
    const stats = frames.stats(t0, t0 + times.allDrawn);
    let longFrames = 0;
    for (let i = 1; i < frames.times.length; i++) {
      if (frames.times[i] - frames.times[i - 1] > 100) longFrames++;
    }
    const attachResult: AttachResult = {
      data: params.attach,
      rows: manifest.summary.rows,
      files: manifest.files.length,
      times,
      frames: stats,
      longFrames,
      memory: memory(),
      came,
    };
    result.attach = attachResult;
    setStatus(
      `Attached: ${attachResult.rows} rows in ${(times.allDrawn / 1000).toFixed(2)} s, ` +
        `the longest frame ${stats.maxMs} ms`,
    );
    show(result);
    return attachResult;
  } catch (error) {
    frames.stop();
    setStatus(`Attach stopped: ${error instanceof Error ? error.message : String(error)}`, true);
    return null;
  }
}

// === Showing ===

function table(head: string[], rows: (string | number | null)[][]): string {
  const cell = (v: string | number | null) => `<td>${v === null ? '-' : v}</td>`;
  return (
    `<table><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr>` +
    rows.map((r) => `<tr>${r.map(cell).join('')}</tr>`).join('') +
    '</table>'
  );
}

function show(result: OpenResult): void {
  const parts: string[] = [];
  parts.push(
    `<div>${result.rows} rows in ${result.files} files; the view: ${result.filesInView} files, ` +
      `${result.rowsInView} rows; ${result.workers} Workers</div>`,
  );
  parts.push(
    table(
      ['step', 'ms'],
      Object.entries(result.times).map(([k, v]) => [k, v]),
    ),
  );
  parts.push(
    table(
      ['frames', 'count', 'median', 'p95', 'longest'],
      Object.entries(result.frames).map(([k, f]) => [k, f.frames, f.medianMs, f.p95Ms, f.maxMs]),
    ),
  );
  parts.push(
    table(
      ['memory', 'JS heap MB', 'GPU MB'],
      Object.entries(result.memory).map(([k, m]) => [k, m.heapMb, m.gpuMb]),
    ),
  );
  if (result.attach) {
    const a = result.attach;
    parts.push(`<div>Attach: ${a.data}, ${a.rows} rows in ${a.files} files</div>`);
    parts.push(
      table(
        ['step', 'ms'],
        Object.entries(a.times).map(([k, v]) => [k, v]),
      ),
    );
    parts.push(
      table(
        ['frames', 'count', 'median', 'p95', 'longest', '> 100 ms'],
        [
          [
            'attach',
            a.frames.frames,
            a.frames.medianMs,
            a.frames.p95Ms,
            a.frames.maxMs,
            a.longFrames,
          ],
        ],
      ),
    );
    parts.push(
      table(['memory', 'JS heap MB', 'GPU MB'], [['attached', a.memory.heapMb, a.memory.gpuMb]]),
    );
  }
  parts.push(
    table(
      ['file', 'rows', 'KB', 'view', 'came', 'decoded', 'Worker ms'],
      result.came.map((c) => [
        c.file,
        c.rows,
        Math.round(c.bytes / 1024),
        c.inView ? 'yes' : '',
        c.cameMs,
        c.decodedMs,
        c.workerMs,
      ]),
    ),
  );
  resultEl.innerHTML = parts.join('');
}

window.stage0Open = open;
window.stage0Attach = attach;
openButton.addEventListener('click', () => void open());
attachButton.addEventListener('click', () => void attach());
map.on('load', () => setStatus(`Ready: Open fetches ${params.data}`));
