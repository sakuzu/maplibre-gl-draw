// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The scenes of the editing benchmark (`edit.html`)
 *
 * A scene is a name and the functions it runs: `prepare` puts the page in the state the scene
 * starts from and makes what the edit takes (not measured), and `run` does the edit with it
 * while the page records. A scene times the calls it makes with `ctx.input`, and an edit done
 * in parts tells the time of each part with `ctx.part`. A new scene is a new entry of
 * {@link SCENES}.
 *
 * The edits that the select mode makes (the box and the drag) are made with the events of the
 * mouse sent to the canvas of the map, as a hand would make them.
 */

import type { Draw, DrawDocument } from '@sakuzu/maplibre-gl-draw';
import {
  createStore,
  type FeatureRowField,
  type GeometryColumn,
  type NewRows,
  type RowPage,
  type RowPageWorker,
  type Store,
} from '@sakuzu/maplibre-gl-draw/store';
import type * as maplibregl from 'maplibre-gl';
import { gridOf, LAYER_ID } from './edit-document';
import type { StorePageAnswer, StorePageAsk, StorePageRequest } from './store-page-worker';

/** What a scene is given */
export interface SceneContext {
  readonly map: maplibregl.Map;
  readonly draw: Draw;
  /** The number of features of the page */
  readonly n: number;
  /** The IDs of the features of the document, in its order */
  readonly featureIds: readonly string[];
  /** Opens the document of `n` features, unless it is open and unchanged */
  openDocument(): Promise<void>;
  /** Opens a document with the one layer and no features */
  openEmpty(): Promise<void>;
  /** Tells that the document is open as made (after a scene opened it) */
  markOpened(): void;
  /** Tells that the document is no longer as made (a later scene opens it again) */
  markChanged(): void;
  /** Makes a document of `n` features, anew */
  makeDocument(): DrawDocument;
  /** Makes the `n` features as the text of a GeoJSON file */
  makeGeoJsonText(): string;
  /** Puts the camera back where every scene starts: the whole grid in view */
  home(): void;
  /** Runs a call and times it */
  input<T>(run: () => T): T;
  /** Runs a call that settles later and times it until it settles */
  inputAsync<T>(run: () => Promise<T>): Promise<T>;
  /** Tells the time of one part of an edit done in parts (ms) */
  part(ms: number): void;
  /** Notes a value of the scene */
  note(key: string, value: number | string): void;
  /** Waits for the next frame */
  frame(): Promise<void>;
  /** Draws frames until the drawing has nothing left to do (false when the time ran out) */
  settle(): Promise<boolean>;
  /** Whether the time of the scene has run out (a scene that loops stops then) */
  expired(): boolean;
}

/** A scene of the page */
export interface Scene<T = unknown> {
  /** The name used by the buttons, `runEditBench` and the results */
  readonly name: string;
  /** What it does, for the page */
  readonly label: string;
  /** Puts the page in the state the scene starts from and makes what `run` takes (not measured) */
  prepare(ctx: SceneContext): Promise<T>;
  /** The edit, measured */
  run(ctx: SceneContext, prepared: T): Promise<void>;
}

/** A scene, with the type of what its `prepare` makes taken from it */
function scene<T>(definition: Scene<T>): Scene {
  return definition;
}

/** The kinds of the events of the mouse a scene sends */
type MouseKind = 'mousedown' | 'mousemove' | 'mouseup' | 'click';

/** Sends an event of the mouse to the canvas of the map, at a point of the map (CSS px) */
function mouse(
  map: maplibregl.Map,
  type: MouseKind,
  x: number,
  y: number,
  options: { readonly pressed: boolean; readonly shift?: boolean },
): void {
  const canvas = map.getCanvas();
  const rect = canvas.getBoundingClientRect();
  canvas.dispatchEvent(
    new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX: rect.left + x,
      clientY: rect.top + y,
      button: 0,
      buttons: options.pressed ? 1 : 0,
      shiftKey: options.shift ?? false,
      view: window,
    }),
  );
}

/** The frames a pan takes each way */
const PAN_FRAMES = 90;
/** How far a pan moves the map in a frame (CSS px) */
const PAN_STEP_PX = 6;

/** The moves of the pointer of a box or a drag, one per frame */
const DRAG_MOVES = 10;
/** How far the pointer of a drag moves in a move (CSS px) */
const DRAG_STEP_PX = 6;
/** The margin of the box around the grid in view (CSS px) */
const BOX_MARGIN_PX = 8;

/** Presses, moves the pointer to `to` in steps (one per frame) and lets go, each timed */
async function pressAndMove(
  ctx: SceneContext,
  from: readonly [number, number],
  to: (step: number) => readonly [number, number],
  shift: boolean,
): Promise<number> {
  const { map } = ctx;
  ctx.input(() => mouse(map, 'mousedown', from[0], from[1], { pressed: true, shift }));
  await ctx.frame();
  let last = from;
  let moves = 0;
  for (let step = 1; step <= DRAG_MOVES; step++) {
    // A press is always let go, even when the time ran out
    if (ctx.expired()) break;
    last = to(step);
    const [x, y] = last;
    ctx.input(() => mouse(map, 'mousemove', x, y, { pressed: true, shift }));
    moves++;
    await ctx.frame();
  }
  ctx.input(() => mouse(map, 'mouseup', last[0], last[1], { pressed: false, shift }));
  return moves;
}

/** The rows a part of a write of the Store without a map writes */
const STORE_PART_ROWS = 5_000;

/**
 * The rows of points on the grid of `n` features, from the `from`-th, `count` of them, as new
 * rows of the layer of the page
 */
function gridRows(n: number, from: number, count: number): NewRows {
  const grid = gridOf(n);
  const ids: string[] = [];
  const keys: string[] = [];
  const coordinates = new Float64Array(count * 2);
  const starts = new Int32Array(count + 1);
  const cellWidth = (grid.east - grid.west) / grid.columns;
  const cellHeight = (grid.north - grid.south) / grid.rows;
  for (let i = 0; i < count; i++) {
    const cell = from + i;
    ids.push(`row-${cell}`);
    keys.push(`k${String(cell).padStart(7, '0')}`);
    coordinates[i * 2] = grid.west + ((cell % grid.columns) + 0.5) * cellWidth;
    coordinates[i * 2 + 1] = grid.south + (Math.floor(cell / grid.columns) + 0.5) * cellHeight;
    starts[i + 1] = i + 1;
  }
  return {
    ids,
    fields: new Map<FeatureRowField, unknown[]>([
      ['type', ids.map(() => 'Point')],
      ['parent', ids.map(() => LAYER_ID)],
      ['orderKey', keys],
    ]),
    geometry: {
      types: new Uint8Array(count),
      coordinates,
      valuesPerPosition: 2,
      partStarts: starts,
      ringStarts: starts,
      positionStarts: starts,
    },
  };
}

/**
 * A Store without a map that holds the `n` rows of the grid in the layer of the page, and the
 * references of its rows in their order
 */
function storeOfGrid(n: number): { store: Store; rows: Int32Array } {
  const store = createStore();
  store.createLayer({
    id: LAYER_ID,
    name: 'Rows',
    visible: true,
    locked: false,
    opacity: 1,
    styleRule: undefined,
    metadata: undefined,
  });
  store.createRows(gridRows(n, 0, n));
  const view = store.tables.get(LAYER_ID);
  return { store, rows: view ? view.listRowRefs(0, view.rowCount) : new Int32Array(0) };
}

/** The points of rows moved by a small offset: the geometries of `count` of them from `from` */
function movedPoints(n: number, from: number, count: number): GeometryColumn {
  const { geometry } = gridRows(n, from, count);
  const coordinates = Float64Array.from(geometry.coordinates, (value) => value + 0.001);
  return { ...geometry, coordinates };
}

/** The pages a part of an opening of a Store from pages takes in */
const STORE_PAGES_PER_PART = 4;

/** The Worker that builds pages (`store-page-worker.ts`), as the scenes ask it */
interface PageWorker {
  /** Asks for pages, and the time the Worker took to make them (ms) */
  ask(request: StorePageAsk): Promise<{ pages: RowPage[]; buildMs: number }>;
  /** The Worker as a Store hands it its work */
  readonly worker: RowPageWorker;
  terminate(): void;
}

/** Starts the Worker that builds pages */
function startPageWorker(): PageWorker {
  const worker = new Worker(new URL('./store-page-worker.ts', import.meta.url), {
    type: 'module',
  });
  const waiting = new Map<number, (answer: StorePageAnswer) => void>();
  let next = 0;
  worker.onmessage = (event: MessageEvent<StorePageAnswer>) => {
    const settle = waiting.get(event.data.id);
    waiting.delete(event.data.id);
    settle?.(event.data);
  };
  const ask = (request: StorePageAsk) =>
    new Promise<{ pages: RowPage[]; buildMs: number }>((resolve, reject) => {
      const id = next++;
      waiting.set(id, (answer) => {
        if ('error' in answer) reject(new Error(answer.error));
        else resolve({ pages: answer.pages, buildMs: answer.buildMs });
      });
      const message: StorePageRequest = { ...request, id };
      worker.postMessage(message);
    });
  return {
    ask,
    worker: {
      merge: async (task) => (await ask({ kind: 'merge', task })).pages,
      build: async (rows, options) => (await ask({ kind: 'build', rows, options })).pages,
    },
    terminate: () => worker.terminate(),
  };
}

/** Puts the camera home and draws until the drawing has nothing left to do */
async function rest(ctx: SceneContext): Promise<void> {
  ctx.home();
  await ctx.settle();
}

/** The scenes, in the order of the page */
export const SCENES: readonly Scene[] = [
  scene({
    name: 'open',
    label: 'Open the document (draw.document.load of a document of the library)',
    async prepare(ctx) {
      await ctx.openEmpty();
      await rest(ctx);
      return ctx.makeDocument();
    },
    async run(ctx, document) {
      const result = await ctx.inputAsync(() => ctx.draw.document.load(document));
      ctx.markOpened();
      ctx.note('features', result?.featureIds.length ?? 0);
      await ctx.settle();
    },
  }),
  scene({
    name: 'pan',
    label: 'Pan the map right and back, a step per frame',
    async prepare(ctx) {
      await ctx.openDocument();
      ctx.draw.selection.clear();
      await rest(ctx);
    },
    async run(ctx) {
      const { map } = ctx;
      for (let i = 0; i < PAN_FRAMES * 2; i++) {
        if (ctx.expired()) break;
        const dx = i < PAN_FRAMES ? PAN_STEP_PX : -PAN_STEP_PX;
        map.panBy([dx, 0], { animate: false });
        await ctx.frame();
      }
      await ctx.settle();
    },
  }),
  scene({
    name: 'selectAll',
    label: 'Select every feature (draw.selection.set)',
    async prepare(ctx) {
      await ctx.openDocument();
      ctx.draw.selection.clear();
      await rest(ctx);
    },
    async run(ctx) {
      const { draw, featureIds } = ctx;
      ctx.input(() => draw.selection.set('feature', featureIds));
      ctx.note('selected', draw.selection.get().ids.length);
      await ctx.settle();
    },
  }),
  scene({
    name: 'selectOne',
    label: 'Select one feature (draw.selection.set with one ID)',
    async prepare(ctx) {
      await ctx.openDocument();
      ctx.draw.selection.clear();
      await rest(ctx);
      return ctx.featureIds[Math.floor(ctx.featureIds.length / 2)];
    },
    async run(ctx, id) {
      const { draw } = ctx;
      ctx.input(() => draw.selection.set('feature', [id]));
      ctx.note('selected', draw.selection.get().ids.length);
      await ctx.settle();
    },
  }),
  scene({
    name: 'hideOne',
    label: 'Hide one feature in this client only (draw.hidden.add)',
    async prepare(ctx) {
      await ctx.openDocument();
      ctx.draw.hidden.clear();
      await rest(ctx);
      return ctx.featureIds[Math.floor(ctx.featureIds.length / 2)];
    },
    async run(ctx, id) {
      const { draw } = ctx;
      ctx.input(() => draw.hidden.add(id));
      ctx.note('hidden', draw.hidden.count());
      await ctx.settle();
    },
  }),
  scene({
    name: 'clickOne',
    label: 'Select one feature with a click inside it (the hit of a point of the screen)',
    async prepare(ctx) {
      await ctx.openDocument();
      ctx.draw.selection.clear();
      await rest(ctx);
      // A polygon in the middle of the grid, clicked inside its ring
      const id = ctx.featureIds[Math.floor(ctx.featureIds.length / 4)];
      const geometry = ctx.draw.features.get(id)?.geometry;
      if (geometry?.type !== 'Polygon') throw new Error(`the feature ${id} is not a polygon`);
      const ring = geometry.coordinates[0].slice(0, -1);
      const center: [number, number] = [
        ring.reduce((sum, [x]) => sum + x, 0) / ring.length,
        ring.reduce((sum, [, y]) => sum + y, 0) / ring.length,
      ];
      const at = ctx.map.project(center);
      return [at.x, at.y] as const;
    },
    async run(ctx, [x, y]) {
      const { map } = ctx;
      ctx.input(() => {
        mouse(map, 'mousemove', x, y, { pressed: false });
        mouse(map, 'mousedown', x, y, { pressed: true });
        mouse(map, 'mouseup', x, y, { pressed: false });
        mouse(map, 'click', x, y, { pressed: false });
      });
      ctx.note('selected', ctx.draw.selection.get().ids.length);
      await ctx.settle();
    },
  }),
  scene({
    name: 'boxSelect',
    label: 'Draw a box over the whole view with Shift, a move per frame',
    async prepare(ctx) {
      await ctx.openDocument();
      ctx.draw.selection.clear();
      await rest(ctx);
    },
    async run(ctx) {
      const canvas = ctx.map.getCanvas();
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      const from: [number, number] = [BOX_MARGIN_PX, BOX_MARGIN_PX];
      const to = (step: number): [number, number] => [
        BOX_MARGIN_PX + ((width - 2 * BOX_MARGIN_PX) * step) / DRAG_MOVES,
        BOX_MARGIN_PX + ((height - 2 * BOX_MARGIN_PX) * step) / DRAG_MOVES,
      ];
      ctx.note('moves', await pressAndMove(ctx, from, to, true));
      ctx.note('selected', ctx.draw.selection.get().ids.length);
      await ctx.settle();
    },
  }),
  scene({
    name: 'updateOne',
    label: 'Write an attribute of one feature, and its change (document.changed)',
    async prepare(ctx) {
      await ctx.openDocument();
      await rest(ctx);
      return ctx.featureIds[Math.floor(ctx.featureIds.length / 2)];
    },
    async run(ctx, id) {
      const { draw } = ctx;
      let updated = 0;
      const stop = draw.on('document.changed', (change) => {
        updated = change.features.updated.count();
      });
      ctx.markChanged();
      ctx.input(() => draw.features.update(id, { properties: { edited: true } }));
      stop();
      ctx.note('updated', updated);
      await ctx.settle();
    },
  }),
  scene({
    name: 'updateAll',
    label: 'Write an attribute of every feature in one change (draw.features.updateMany)',
    async prepare(ctx) {
      await ctx.openDocument();
      await rest(ctx);
      return ctx.featureIds.map((id) => ({ id, patch: { properties: { edited: true } } }));
    },
    async run(ctx, patches) {
      const { draw } = ctx;
      let updated = 0;
      const stop = draw.on('document.changed', (change) => {
        updated = change.features.updated.count();
      });
      ctx.markChanged();
      ctx.input(() => draw.features.updateMany(patches));
      stop();
      ctx.note('updated', updated);
      await ctx.settle();
    },
  }),
  scene({
    name: 'drag',
    label: 'Drag every feature selected from the middle of the map, a move per frame',
    async prepare(ctx) {
      await ctx.openDocument();
      ctx.draw.selection.set('feature', ctx.featureIds);
      await rest(ctx);
    },
    async run(ctx) {
      const canvas = ctx.map.getCanvas();
      const cx = canvas.clientWidth / 2;
      const cy = canvas.clientHeight / 2;
      const to = (step: number): [number, number] => [cx + DRAG_STEP_PX * step, cy];
      ctx.markChanged();
      ctx.note('selected', ctx.draw.selection.get().ids.length);
      ctx.note('moves', await pressAndMove(ctx, [cx, cy], to, false));
      await ctx.settle();
    },
  }),
  scene({
    name: 'delete',
    label: 'Delete every feature selected (draw.selection.delete)',
    async prepare(ctx) {
      await ctx.openDocument();
      ctx.draw.selection.set('feature', ctx.featureIds);
      await rest(ctx);
    },
    async run(ctx) {
      const { draw } = ctx;
      ctx.markChanged();
      ctx.input(() => draw.selection.delete());
      ctx.note('features', draw.features.count());
      await ctx.settle();
    },
  }),
  scene({
    name: 'import',
    label: 'Import a GeoJSON file into the layer (draw.document.load of a File)',
    async prepare(ctx) {
      await ctx.openEmpty();
      await rest(ctx);
      return new File([ctx.makeGeoJsonText()], 'features.geojson', {
        type: 'application/geo+json',
      });
    },
    async run(ctx, file) {
      ctx.markChanged();
      ctx.note('bytes', file.size);
      const result = await ctx.inputAsync(() =>
        ctx.draw.document.load(file, { layerId: LAYER_ID }),
      );
      ctx.note('features', result?.featureIds.length ?? 0);
      await ctx.settle();
    },
  }),
  scene({
    name: 'export',
    label: 'Write the document out as the text of a file (draw.document.toJSON)',
    async prepare(ctx) {
      await ctx.openDocument();
      ctx.draw.selection.clear();
      await rest(ctx);
    },
    async run(ctx) {
      const { draw } = ctx;
      const document = ctx.input(() => draw.document.toJSON());
      const text = ctx.input(() => JSON.stringify(document));
      ctx.note('features', document.features.length);
      ctx.note('bytes', text.length);
      await ctx.settle();
    },
  }),
  scene({
    name: 'iterate',
    label: 'Read every feature one at a time (draw.features.iterate)',
    async prepare(ctx) {
      await ctx.openDocument();
      ctx.draw.selection.clear();
      await rest(ctx);
    },
    async run(ctx) {
      const { draw } = ctx;
      const read = ctx.input(() => {
        let count = 0;
        for (const feature of draw.features.iterate()) if (feature.id !== '') count += 1;
        return count;
      });
      ctx.note('features', read);
      await ctx.settle();
    },
  }),
  scene({
    name: 'getProperty',
    label:
      'Read one attribute of every feature without the features made (draw.features.getProperty)',
    async prepare(ctx) {
      await ctx.openDocument();
      ctx.draw.selection.clear();
      await rest(ctx);
    },
    async run(ctx) {
      const { draw, featureIds } = ctx;
      const named = ctx.input(() => {
        let count = 0;
        for (const id of featureIds)
          if (draw.features.getProperty(id, 'name') !== undefined) count += 1;
        return count;
      });
      ctx.note('features', featureIds.length);
      ctx.note('named', named);
      await ctx.settle();
    },
  }),
  scene({
    name: 'storeParts',
    label: `Write the rows into a Store without a map, ${STORE_PART_ROWS.toLocaleString('en')} at a time as the parts of one operation, a frame between them`,
    async prepare(ctx): Promise<{ store: Store; parts: NewRows[]; changes: number[] }> {
      await rest(ctx);
      const store = createStore();
      store.createLayer({
        id: LAYER_ID,
        name: 'Rows',
        visible: true,
        locked: false,
        opacity: 1,
        styleRule: undefined,
        metadata: undefined,
      });
      const parts: NewRows[] = [];
      for (let from = 0; from < ctx.n; from += STORE_PART_ROWS) {
        parts.push(gridRows(ctx.n, from, Math.min(STORE_PART_ROWS, ctx.n - from)));
      }
      // The rows each change tells as created
      const changes: number[] = [];
      store.subscribe((change) => {
        changes.push(change.rows?.layers.get(LAYER_ID)?.created.length ?? 0);
      });
      return { store, parts, changes };
    },
    async run(ctx, { store, parts, changes }) {
      const operationId = store.newOperationId();
      let ended = false;
      try {
        for (let i = 0; i < parts.length; i++) {
          if (ctx.expired()) break;
          const hasMoreParts = i < parts.length - 1;
          ended = !hasMoreParts;
          const t0 = performance.now();
          ctx.input(() =>
            store.transact(() => store.createRows(parts[i]), 'remote', {
              operationId,
              hasMoreParts,
            }),
          );
          ctx.part(performance.now() - t0);
          if (hasMoreParts) await ctx.frame();
        }
      } finally {
        // A write stopped before its last part ends the operation with nothing written
        if (!ended) store.transact(() => {}, 'remote', { operationId, stopped: true });
      }
      ctx.note('rows', store.tables.get(LAYER_ID)?.rowCount ?? 0);
      ctx.note('parts', parts.length);
      ctx.note('changes', changes.length);
      ctx.note('mostRowsInAChange', Math.max(0, ...changes));
      await ctx.settle();
    },
  }),
  scene({
    name: 'storeRead',
    label: 'Read every field and the geometries of the rows of a Store without a map, in one read',
    async prepare(ctx): Promise<{ store: Store }> {
      await rest(ctx);
      return { store: storeOfGrid(ctx.n).store };
    },
    async run(ctx, { store }) {
      const view = store.tables.get(LAYER_ID);
      const rows = ctx.input(() => view?.listRowRefs(0, view.rowCount) ?? new Int32Array(0));
      const values = ctx.input(() =>
        store.tables.readValues(rows, [
          'type',
          'parent',
          'orderKey',
          'visible',
          'locked',
          'style',
          'geometry',
        ]),
      );
      ctx.note('rows', values.rows.length);
      ctx.note('positions', (values.geometry?.coordinates.length ?? 0) / 2);
      await ctx.settle();
    },
  }),
  scene({
    name: 'storeMoveBefore',
    label: `Move the rows of a Store without a map for a listener that asks for the values before, ${STORE_PART_ROWS.toLocaleString('en')} at a time as the parts of one operation, a frame between them`,
    async prepare(
      ctx,
    ): Promise<{ store: Store; rows: Int32Array; parts: GeometryColumn[]; before: number[] }> {
      await rest(ctx);
      const { store, rows } = storeOfGrid(ctx.n);
      const parts: GeometryColumn[] = [];
      for (let from = 0; from < rows.length; from += STORE_PART_ROWS) {
        parts.push(movedPoints(ctx.n, from, Math.min(STORE_PART_ROWS, rows.length - from)));
      }
      // The rows whose values before each change carries
      const before: number[] = [];
      store.subscribe(
        (change) => {
          before.push(change.previousValues?.get(LAYER_ID)?.rows.length ?? 0);
        },
        { previousValues: true },
      );
      return { store, rows, parts, before };
    },
    async run(ctx, { store, rows, parts, before }) {
      const operationId = store.newOperationId();
      let ended = false;
      try {
        for (let i = 0; i < parts.length; i++) {
          if (ctx.expired()) break;
          const hasMoreParts = i < parts.length - 1;
          ended = !hasMoreParts;
          const from = i * STORE_PART_ROWS;
          const t0 = performance.now();
          ctx.input(() =>
            store.transact(
              () =>
                store.writeRows({
                  rows: rows.subarray(from, from + parts[i].types.length),
                  fields: new Map(),
                  geometry: parts[i],
                }),
              'remote',
              { operationId, hasMoreParts },
            ),
          );
          ctx.part(performance.now() - t0);
          if (hasMoreParts) await ctx.frame();
        }
      } finally {
        // A move stopped before its last part ends the operation with nothing written
        if (!ended) store.transact(() => {}, 'remote', { operationId, stopped: true });
      }
      ctx.note('rows', rows.length);
      ctx.note('parts', parts.length);
      ctx.note(
        'rowsWithValuesBefore',
        before.reduce((sum, count) => sum + count, 0),
      );
      await ctx.settle();
    },
  }),
  scene({
    name: 'storePages',
    label: `Open the rows of a Store without a map from pages built in a Worker, ${STORE_PAGES_PER_PART} pages at a time as the parts of one operation, a frame between them`,
    async prepare(ctx): Promise<{
      store: Store;
      pages: RowPage[];
      buildMs: number;
      changes: number[];
      pageWorker: PageWorker;
    }> {
      await rest(ctx);
      const pageWorker = startPageWorker();
      const store = createStore({ worker: pageWorker.worker });
      store.createLayer({
        id: LAYER_ID,
        name: 'Rows',
        visible: true,
        locked: false,
        opacity: 1,
        styleRule: undefined,
        metadata: undefined,
      });
      // The pages are built in the Worker and posted without a copy (not measured)
      const { pages, buildMs } = await pageWorker.ask({ kind: 'grid', n: ctx.n });
      // The rows each change tells as created
      const changes: number[] = [];
      store.subscribe((change) => {
        changes.push(change.rows?.layers.get(LAYER_ID)?.created.length ?? 0);
      });
      return { store, pages, buildMs, changes, pageWorker };
    },
    async run(ctx, { store, pages, buildMs, changes, pageWorker }) {
      const operationId = store.newOperationId();
      let ended = false;
      try {
        for (let from = 0; from < pages.length; from += STORE_PAGES_PER_PART) {
          if (ctx.expired()) break;
          const hasMoreParts = from + STORE_PAGES_PER_PART < pages.length;
          ended = !hasMoreParts;
          const part = pages.slice(from, from + STORE_PAGES_PER_PART);
          const t0 = performance.now();
          ctx.input(() =>
            store.transact(() => store.createRowsFromPages(LAYER_ID, part), 'remote', {
              operationId,
              hasMoreParts,
            }),
          );
          ctx.part(performance.now() - t0);
          if (hasMoreParts) await ctx.frame();
        }
      } finally {
        // An opening stopped before its last part ends the operation with nothing written
        if (!ended) store.transact(() => {}, 'remote', { operationId, stopped: true });
        pageWorker.terminate();
      }
      ctx.note('rows', store.tables.get(LAYER_ID)?.rowCount ?? 0);
      ctx.note('pages', pages.length);
      ctx.note('changes', changes.length);
      ctx.note('mostRowsInAChange', Math.max(0, ...changes));
      ctx.note('buildMsInTheWorker', Math.round(buildMs));
      await ctx.settle();
    },
  }),
  scene({
    name: 'storeStyleKey',
    label: `Write one key of the style of the rows of a Store without a map (style:fillColor), ${STORE_PART_ROWS.toLocaleString('en')} at a time as the parts of one operation, a frame between them`,
    async prepare(ctx): Promise<{ store: Store; rows: Int32Array }> {
      await rest(ctx);
      return storeOfGrid(ctx.n);
    },
    async run(ctx, { store, rows }) {
      const operationId = store.newOperationId();
      let ended = false;
      let parts = 0;
      try {
        for (let from = 0; from < rows.length; from += STORE_PART_ROWS) {
          if (ctx.expired()) break;
          const hasMoreParts = from + STORE_PART_ROWS < rows.length;
          ended = !hasMoreParts;
          const part = rows.subarray(from, from + STORE_PART_ROWS);
          const colors = new Array<unknown>(part.length).fill('#e0457b');
          const t0 = performance.now();
          ctx.input(() =>
            store.transact(
              () => store.writeRows({ rows: part, fields: new Map([['style:fillColor', colors]]) }),
              'remote',
              { operationId, hasMoreParts },
            ),
          );
          ctx.part(performance.now() - t0);
          parts += 1;
          if (hasMoreParts) await ctx.frame();
        }
      } finally {
        // A write stopped before its last part ends the operation with nothing written
        if (!ended) store.transact(() => {}, 'remote', { operationId, stopped: true });
      }
      ctx.note('rows', rows.length);
      ctx.note('parts', parts);
      await ctx.settle();
    },
  }),
  scene({
    name: 'storePropertyKeys',
    label: 'List the keys of the attributes of every row of a Store without a map, in one read',
    async prepare(ctx): Promise<{ store: Store }> {
      await rest(ctx);
      const { store, rows } = storeOfGrid(ctx.n);
      const names = Array.from({ length: rows.length }, (_, i) => `n${i}`);
      store.writeRows({ rows, fields: new Map([['properties:name', names]]) });
      return { store };
    },
    async run(ctx, { store }) {
      const keys = ctx.input(() => store.listPropertyKeys());
      ctx.note('keys', keys.length);
      await ctx.settle();
    },
  }),
];
