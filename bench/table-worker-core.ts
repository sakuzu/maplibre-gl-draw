// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The work of a Worker of the opening of the measurement of the layers held as rows: it makes
 * features, or reads them from a part of the lines of a file of `bench/data/`, builds them into
 * row groups and sends the groups to the page without a copy, a batch at a time, then the rows
 * the edits change.
 *
 * The page runs several of them at once, each on a run of the order of the rows: the features
 * `start` to `end` of the ones made, or the lines of one part of a file in the order of the file,
 * sent as it is fetched. A Worker of a part counts its lines from their bytes as they come (the
 * blank ones left out) and tells how many there are once its part has come; the page tells it the
 * place of its first line among every line as soon as the parts before it are counted. From then
 * on its parts are read and built as they come, one part of the bytes at a time: a Worker holds
 * the bytes it has not read yet (outside the heap of the scripts), one part as text and the
 * features of one batch, not the features of its whole part. Rows put in an order at random, or a
 * FeatureCollection, are read and built whole in one Worker.
 *
 * Once every Worker has built its rows, the page tells each the place of its first feature among
 * every feature and how far apart the rows taken at random are, and it picks them.
 *
 * It depends on neither the Worker nor the page (`table-worker.ts` connects it), so it runs in
 * the tests as it is.
 */

import {
  createRowBlockBuilder,
  type RowBlock,
  transferList,
} from '@sakuzu/maplibre-gl-draw/kasane';
import {
  type BenchFeature,
  benchFeature,
  type CandidatePick,
  CandidatePicker,
  candidateKind,
  countFeatureLines,
  emptyExtent,
  featureOfLine,
  featuresOfText,
  isFeatureLine,
  type RawFeature,
  stylesOf,
  type TableBenchParams,
  widenExtent,
} from './table-data';

/** What the page asks for */
export type TableWorkerRequest =
  /** Make the features `start` to `end` and build them */
  | {
      readonly kind: 'make';
      readonly params: TableBenchParams;
      readonly start: number;
      readonly end: number;
    }
  /** A part of the lines of a file, in the order of the file */
  | { readonly kind: 'part'; readonly bytes: ArrayBuffer }
  /** No part comes after */
  | { readonly kind: 'end' }
  /** The place of the first line among every line: read and build the lines */
  | { readonly kind: 'base'; readonly params: TableBenchParams; readonly lineBase: number }
  /** Pick the rows taken at random: the place of the first feature, and how far apart they are */
  | { readonly kind: 'pick'; readonly featureBase: number; readonly step: number }
  /** Read the whole file and build it (rows at random, a FeatureCollection) */
  | { readonly kind: 'whole'; readonly params: TableBenchParams; readonly dataUrl: string };

/** What the Worker sends back */
export type TableWorkerMessage =
  /** Every part has come: the lines of them (the blank ones left out) */
  | { readonly kind: 'counted'; readonly lines: number }
  /** Row groups built, the ones of the run before them sent already */
  | { readonly kind: 'groups'; readonly groups: RowBlock[] }
  /** Every row group is sent */
  | {
      readonly kind: 'built';
      /** The features built */
      readonly count: number;
      readonly extent: [number, number, number, number];
      /** The time reading the lines (or making the features, or fetching and reading) took */
      readonly generateMs: number;
      /** The time making the rows of the features and adding them to the builders took (ms) */
      readonly addMs: number;
      /** The time sorting them and building the groups took (ms) */
      readonly buildMs: number;
    }
  /** The rows the edits change, of the features of this Worker */
  | { readonly kind: 'picked'; readonly candidates: CandidatePick }
  /** Why the work stopped */
  | { readonly kind: 'failed'; readonly error: string };

/** Sends a message to the page */
export type PostOpen = (message: TableWorkerMessage, transfer?: Transferable[]) => void;

/** The rows of a batch of row groups (a smaller batch reaches the page sooner, and holds less) */
export const BATCH_ROWS = 16_384;

/**
 * The work of one Worker: a function that takes each request in turn (a request that fails sends
 * why, and the Worker does nothing more)
 *
 * @param fetchFile Fetches the file read whole (`fetch` when omitted)
 */
export function createOpenWork(
  post: PostOpen,
  fetchFile: (url: string) => Promise<Response> = (url) => fetch(url),
): (request: TableWorkerRequest) => Promise<void> {
  const decoder = new TextDecoder();
  let carry = '';
  /** The parts come and not read yet, as bytes (they are read a part at a time) */
  const parts: Uint8Array[] = [];
  /** The lines of the parts that hold a feature, counted from their bytes as they come */
  let counted = 0;
  let filled = false;
  /** The lines read so far */
  let read = 0;
  let ended = false;
  let finished = false;
  let lineBase: number | null = null;
  let styles: Record<string, unknown>[] = [];
  let failed = false;
  /** What is being built */
  let builder = createRowBlockBuilder();
  const extent = emptyExtent();
  let built = 0;
  let readMs = 0;
  let addMs = 0;
  let buildMs = 0;
  /** The first point, the longest line and the polygon of the fewest corners of the rows built */
  const noted = new CandidatePicker(1);
  /** The ids and kinds of the rows built, for the pick of the rows taken at random */
  const builtIds: string[] = [];
  const builtKinds: number[] = [];

  const flush = (): void => {
    if (builder.length === 0) return;
    const b0 = performance.now();
    const groups = builder.finish();
    buildMs += performance.now() - b0;
    builder = createRowBlockBuilder();
    post({ kind: 'groups', groups }, transferList(groups));
  };

  const add = (feature: BenchFeature): void => {
    const a0 = performance.now();
    noted.note(feature);
    builtIds.push(feature.id);
    builtKinds.push(candidateKind(feature));
    widenExtent(extent, feature.geometry);
    builder.addRow({
      id: feature.id,
      type: feature.type,
      geometry: feature.geometry,
      key: feature.order,
      style: feature.style,
      properties: feature.properties,
    });
    built++;
    addMs += performance.now() - a0;
    if (builder.length >= BATCH_ROWS) flush();
  };

  const finish = (generateMs: number): void => {
    flush();
    post({ kind: 'built', count: built, extent, generateMs, addMs, buildMs });
  };

  /** Reads the lines of a text, the last one kept for the next part when the part is not the last */
  const readText = (text: string, last: boolean): void => {
    const lines = text.split('\n');
    carry = last ? '' : (lines.pop() ?? '');
    for (const line of lines) {
      if (!isFeatureLine(line)) continue;
      const t0 = performance.now();
      const i = (lineBase as number) + read++;
      const feature = featureOfLine(JSON.parse(line) as RawFeature, i, i, styles);
      readMs += performance.now() - t0;
      if (feature) add(feature);
    }
  };

  /** Reads and builds the parts come, once the place of the first line is known */
  const drain = (): void => {
    if (lineBase === null || finished) return;
    for (let part = parts.shift(); part; part = parts.shift()) {
      const t0 = performance.now();
      const text = carry + decoder.decode(part, { stream: true });
      readMs += performance.now() - t0;
      readText(text, false);
    }
    if (!ended) return;
    readText(carry + decoder.decode(), true);
    if (read !== counted) {
      throw new Error(`${read} lines read of the ${counted} lines counted in the part`);
    }
    finished = true;
    finish(readMs);
  };

  return async (request) => {
    if (failed) return;
    try {
      switch (request.kind) {
        case 'make': {
          const { params, start, end } = request;
          const made = stylesOf(params);
          const t0 = performance.now();
          for (let i = start; i < end; i++) add(benchFeature(params, made, i));
          // Making the features is counted with adding them
          addMs = performance.now() - t0 - buildMs;
          finish(0);
          return;
        }
        case 'part': {
          const bytes = new Uint8Array(request.bytes);
          const t0 = performance.now();
          const lines = countFeatureLines(bytes, filled);
          readMs += performance.now() - t0;
          counted += lines.lines;
          filled = lines.open;
          parts.push(bytes);
          drain();
          return;
        }
        case 'end':
          if (filled) counted++;
          post({ kind: 'counted', lines: counted });
          ended = true;
          drain();
          return;
        case 'base':
          styles = stylesOf(request.params);
          lineBase = request.lineBase;
          drain();
          return;
        case 'pick': {
          const picker = new CandidatePicker(request.step);
          builtIds.forEach((id, k) => {
            picker.take(id, builtKinds[k], request.featureBase + k);
          });
          const { point, line, lineVertices, polygon, polygonCorners } = noted;
          const { ids, points, polygons } = picker;
          post({
            kind: 'picked',
            candidates: {
              point,
              line,
              lineVertices,
              polygon,
              polygonCorners,
              ids,
              points,
              polygons,
            },
          });
          builtIds.length = 0;
          builtKinds.length = 0;
          return;
        }
        case 'whole': {
          const t0 = performance.now();
          const response = await fetchFile(request.dataUrl);
          if (!response.ok) throw new Error(`${request.dataUrl}: ${response.status}`);
          const features = featuresOfText(
            await response.text(),
            /\.(ndjson|geojsonl)$/.test(request.dataUrl),
            request.params,
          );
          const generateMs = performance.now() - t0;
          for (let i = 0; i < features.length; i++) add(features[i]);
          finish(generateMs);
          return;
        }
      }
    } catch (error) {
      failed = true;
      post({ kind: 'failed', error: error instanceof Error ? error.message : String(error) });
    }
  };
}
