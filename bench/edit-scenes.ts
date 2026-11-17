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
import type * as maplibregl from 'maplibre-gl';
import { LAYER_ID } from './edit-document';

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
type MouseKind = 'mousedown' | 'mousemove' | 'mouseup';

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
];
