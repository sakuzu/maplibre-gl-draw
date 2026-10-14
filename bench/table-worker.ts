// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A Worker of the opening of the measurement of the layers held as rows: it makes features, or
 * reads them from a part of the lines of a file of `bench/data/`, builds them into row groups and
 * sends the groups to the page without a copy, a batch at a time, with the rows the edits change
 * and the extent of the features.
 *
 * The page runs several of them at once, each on a run of the order of the rows: the features
 * `start` to `end` of the ones made, or the lines of one part of a file in the order of the file
 * (sent as it is fetched). A Worker of a part reads its lines first and tells how many it read;
 * the page then tells it the place of its first line among every line and of its first feature
 * among every feature, so its rows get the ids and keys of their places in the file. Rows put in
 * an order at random, or a FeatureCollection, are read and built whole in one Worker.
 */

import {
  circleRowRings,
  createRowGroupBuilder,
  rowGroupTransferList,
} from '@sakuzu/maplibre-gl-draw/table';
import {
  type BenchFeature,
  benchFeature,
  type CandidatePick,
  CandidatePicker,
  candidateKind,
  candidateStep,
  emptyExtent,
  featureOfLine,
  featuresOfText,
  holdsRow,
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
  /** No part comes after: read the last line */
  | { readonly kind: 'end' }
  /** Build the features read, the first line and the first feature at these places */
  | {
      readonly kind: 'build';
      readonly params: TableBenchParams;
      readonly lineBase: number;
      readonly featureBase: number;
    }
  /** Pick the rows taken at random, now that the number of every feature is known */
  | { readonly kind: 'pick'; readonly step: number }
  /** Read the whole file and build it (rows at random, a FeatureCollection) */
  | { readonly kind: 'whole'; readonly params: TableBenchParams; readonly dataUrl: string };

/** The groups of a batch */
type Groups = ReturnType<ReturnType<typeof createRowGroupBuilder>['finish']>;

/** What the Worker sends back */
export type TableWorkerMessage =
  /** The lines of the parts read (and how many of them are features) */
  | {
      readonly kind: 'parsed';
      readonly lines: number;
      readonly features: number;
      readonly parseMs: number;
    }
  /** Row groups built, the ones of the run before them sent already */
  | { readonly kind: 'groups'; readonly groups: Groups }
  /** Every row group is sent; what is left is the pick of the rows taken at random */
  | {
      readonly kind: 'built';
      readonly count: number;
      readonly extent: [number, number, number, number];
      /** The time making (or reading) the features took, when it was apart from adding them */
      readonly generateMs: number;
      /** The time making the rows of the features and adding them to the builders took (ms) */
      readonly addMs: number;
      /** The time sorting them and building the groups took (ms) */
      readonly buildMs: number;
    }
  /** The rows the edits change, of the features of this Worker */
  | { readonly kind: 'picked'; readonly candidates: CandidatePick }
  /** Why the features could not be read */
  | { readonly kind: 'failed'; readonly error: string };

/** The rows of a batch of row groups (a smaller batch reaches the page sooner) */
const BATCH_ROWS = 16_384;

const post = (message: TableWorkerMessage, transfer: Transferable[] = []): void => {
  (self as unknown as Worker).postMessage(message, transfer);
};

/** The lines of the parts, read as they come */
const decoder = new TextDecoder();
let carry = '';
let raw: Array<RawFeature | null> = [];
let parseMs = 0;
/** The first point, the longest line and the polygon of the fewest corners of the rows built */
let noted = new CandidatePicker(1);
/** The ids, kinds and places of the rows built, for the pick of the rows taken at random */
let builtIds: string[] = [];
let builtKinds: number[] = [];
let firstIndex = 0;

/** Reads the whole lines of a text */
function readLines(text: string, last: boolean): void {
  const lines = text.split('\n');
  carry = last ? '' : (lines.pop() ?? '');
  for (const line of lines) {
    if (line.trim().length > 0) raw.push(JSON.parse(line));
  }
}

/**
 * Builds features into row groups a batch at a time and sends them, then what was built
 *
 * @param next The next feature and its place among every feature (null after the last)
 */
function buildAll(next: () => [BenchFeature, number] | null, generateMs: number): void {
  const extent = emptyExtent();
  let builder = createRowGroupBuilder({ rings: circleRowRings });
  let buildMs = 0;
  let count = 0;
  const flush = (): void => {
    const b0 = performance.now();
    const groups = builder.finish();
    buildMs += performance.now() - b0;
    post({ kind: 'groups', groups }, rowGroupTransferList(groups));
    builder = createRowGroupBuilder({ rings: circleRowRings });
  };
  const t0 = performance.now();
  for (let item = next(); item; item = next()) {
    const [feature, index] = item;
    if (count === 0) firstIndex = index;
    noted.note(feature);
    builtIds.push(feature.id);
    builtKinds.push(candidateKind(feature));
    widenExtent(extent, feature.geometry);
    builder.addRow({
      id: feature.id,
      type: feature.type,
      geometry: feature.geometry,
      order: feature.order,
      style: feature.style,
      properties: feature.properties,
    });
    count++;
    if (builder.length >= BATCH_ROWS) flush();
  }
  if (builder.length > 0) flush();
  const addMs = performance.now() - t0 - buildMs;
  post({ kind: 'built', count, extent, generateMs, addMs, buildMs });
}

/** Picks the rows the edits change among the features built, and forgets them */
function pick(step: number): void {
  const picker = new CandidatePicker(step);
  builtIds.forEach((id, k) => {
    picker.take(id, builtKinds[k], firstIndex + k);
  });
  const { point, line, lineVertices, polygon, polygonCorners } = noted;
  const { ids, points, polygons } = picker;
  post({
    kind: 'picked',
    candidates: { point, line, lineVertices, polygon, polygonCorners, ids, points, polygons },
  });
  noted = new CandidatePicker(1);
  builtIds = [];
  builtKinds = [];
}

self.onmessage = async (event: MessageEvent<TableWorkerRequest>) => {
  const request = event.data;
  try {
    switch (request.kind) {
      case 'make': {
        const { params, start, end } = request;
        const styles = stylesOf(params);
        let i = start;
        buildAll(() => (i < end ? [benchFeature(params, styles, i), i++] : null), 0);
        pick(candidateStep(params.n));
        return;
      }
      case 'part': {
        const t0 = performance.now();
        readLines(carry + decoder.decode(new Uint8Array(request.bytes), { stream: true }), false);
        parseMs += performance.now() - t0;
        return;
      }
      case 'end': {
        const t0 = performance.now();
        readLines(carry + decoder.decode(), true);
        parseMs += performance.now() - t0;
        const lines = raw.length;
        let features = 0;
        for (const feature of raw) if (feature && holdsRow(feature)) features++;
        post({ kind: 'parsed', lines, features, parseMs });
        return;
      }
      case 'build': {
        const { params, lineBase, featureBase } = request;
        const styles = stylesOf(params);
        let k = 0;
        let index = featureBase;
        buildAll(() => {
          while (k < raw.length) {
            const line = raw[k] as RawFeature;
            raw[k] = null;
            const i = lineBase + k++;
            const feature = featureOfLine(line, i, i, styles);
            if (feature) return [feature, index++];
          }
          return null;
        }, parseMs);
        raw = [];
        return;
      }
      case 'pick':
        pick(request.step);
        return;
      case 'whole': {
        const t0 = performance.now();
        const response = await fetch(request.dataUrl);
        if (!response.ok) throw new Error(`${request.dataUrl}: ${response.status}`);
        const text = await response.text();
        const features = featuresOfText(
          text,
          /\.(ndjson|geojsonl)$/.test(request.dataUrl),
          request.params,
        );
        const generateMs = performance.now() - t0;
        let i = 0;
        buildAll(() => (i < features.length ? [features[i], i++] : null), generateMs);
        pick(candidateStep(features.length));
        return;
      }
    }
  } catch (error) {
    post({ kind: 'failed', error: String(error) });
  }
};
