// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What is made of the rows of a selection of many features, after a row is written in place
 *
 * In the next frame, the instances of the frames of the rows and the reading of the selection are
 * those made anew of the rows as they are written: for a row of every built-in kind, in a row group
 * or in a part of a delta, written each value a feature has. What was not read of the rows makes
 * nothing again when it is written: the styles and the attributes of the lines and the areas, the
 * attributes of the points.
 */

import type { Map as MapLibreMap } from 'maplibre-gl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDrawOnEngine } from '../../api/impl/create-draw.js';
import { createEngine } from '../../api/impl/engine.js';
import { checkDrawOptions, toEngineOptions } from '../../api/impl/options.js';
import { createStore } from '../../store/built-in/create-store.js';
import { drawnRowsOf, type RowGroup } from '../../store/built-in/drawn-rows.js';
import { FEATURES_KEPT } from '../../store/document-access.js';
import { createCountingGL, createDrawingMapStub } from '../../test-utils.js';
import { BulkFramesRenderer, buildFrameInstances } from './bulk-frames.js';
import { type ManySelection, SelectedRows } from './bulk-selection.js';

const KEY = (name: string): string => `maplibre-gl-draw:${name}`;
const RADIUS = KEY('radiusMeters');

/** The features selected: more than a few */
const COUNT = FEATURES_KEPT + 6;

interface Instance {
  readonly draw: ReturnType<typeof createDrawOnEngine>;
  readonly engine: ReturnType<typeof createEngine>;
  readonly map: ReturnType<typeof createDrawingMapStub>;
  /** The data last given to each buffer */
  readonly uploads: ReadonlyMap<object, unknown>;
}

const instances: Instance[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const instance of instances.splice(0)) instance.draw.destroy();
});

/** An instance on a GL that keeps the data given to the buffers */
function instanceOf(): Instance {
  const uploads = new Map<object, unknown>();
  let bound: object | null = null;
  const gl = new Proxy(createCountingGL().gl, {
    get(target, prop) {
      const value = Reflect.get(target, prop);
      if (prop !== 'bindBuffer' && prop !== 'bufferData') return value;
      return (...args: unknown[]) => {
        if (prop === 'bindBuffer') bound = (args[1] as object | null) ?? null;
        else if (bound) uploads.set(bound, args[1]);
        return (value as (...a: unknown[]) => unknown)(...args);
      };
    },
  }) as WebGL2RenderingContext;
  const map = createDrawingMapStub(gl);
  const options = { store: createStore() };
  checkDrawOptions(options);
  const engine = createEngine(
    map.map as MapLibreMap,
    toEngineOptions(options, () => false),
    { deferDefaultMode: true },
  );
  const draw = createDrawOnEngine(engine, options);
  engine.enterDefaultMode();
  const instance = { draw, engine, map, uploads };
  instances.push(instance);
  return instance;
}

/** Draws frames until the drawing has no work left */
function settle({ map, draw }: Instance): void {
  for (let frame = 0; frame < 60; frame++) {
    map.render();
    if (!draw.hasPendingWork()) return;
  }
  throw new Error('the drawing still has work after 60 frames');
}

/** The IDs of the features made */
function idsOf(made: unknown): string[] {
  return (made as Array<{ id: string }>).map((feature) => feature.id);
}

/** The place of a feature in the grid */
const placeOf = (i: number): [number, number] => [(i % 40) / 40, Math.floor(i / 40) / 40];

/** The features of each type, by their place in the grid */
const TYPES = {
  'Circle with a radius': (i: number) => ({
    type: 'Circle',
    geometry: { type: 'Point', coordinates: placeOf(i) },
    properties: { [RADIUS]: 100 },
    style: { pointRadius: 5 },
  }),
  'Circle without a radius': (i: number) => ({
    type: 'Circle',
    geometry: { type: 'Point', coordinates: placeOf(i) },
    style: { pointRadius: 5 },
  }),
  Point: (i: number) => ({
    type: 'Point',
    geometry: { type: 'Point', coordinates: placeOf(i) },
    style: { pointRadius: 5 },
  }),
  LineString: (i: number) => ({
    type: 'LineString',
    geometry: { type: 'LineString', coordinates: [placeOf(i), [1, 1 + i / 1000]] },
  }),
  Polygon: (i: number) => {
    const [x, y] = placeOf(i);
    const ring = [placeOf(i), [x + 0.02, y], [x, y + 0.02], placeOf(i)];
    return { type: 'Polygon', geometry: { type: 'Polygon', coordinates: [ring] } };
  },
  Image: (i: number) => ({
    type: 'Image',
    geometry: { type: 'Point', coordinates: placeOf(i) },
    properties: {
      [KEY('imageWidth')]: 20,
      [KEY('imageHeight')]: 10,
      [KEY('createdZoom')]: 10,
    },
  }),
} as const;

type TypeName = keyof typeof TYPES;

/** The geometry written to a feature of a type */
function geometryOf(type: TypeName): unknown {
  const at = [1.3, 1.6];
  if (type === 'LineString') return { type: 'LineString', coordinates: [at, [1.4, 1.8]] };
  if (type === 'Polygon') {
    return { type: 'Polygon', coordinates: [[at, [1.5, 1.6], [1.3, 1.9], at]] };
  }
  return { type: 'Point', coordinates: at };
}

/** The values written, each alone */
const WRITES: Record<string, (type: TypeName) => unknown> = {
  'the radius': () => ({ properties: { [RADIUS]: 400_000 } }),
  'the radius, taken away': () => ({ properties: { [RADIUS]: undefined } }),
  'the radius, 0': () => ({ properties: { [RADIUS]: 0 } }),
  'another attribute': () => ({ properties: { name: 'x' } }),
  'the created zoom': () => ({ properties: { [KEY('createdZoom')]: 3 } }),
  'the scale of an image': () => ({ properties: { [KEY('scale')]: 200 } }),
  'the rotation of an image': () => ({ properties: { [KEY('rotation')]: 30 } }),
  'the width of an image': () => ({ properties: { [KEY('imageWidth')]: 4_000 } }),
  pointRadius: () => ({ style: { pointRadius: 30 } }),
  pointShape: () => ({ style: { pointShape: 'star' } }),
  pointStrokeWidth: () => ({ style: { pointStrokeWidth: 20 } }),
  strokeWidth: () => ({ style: { strokeWidth: 30 } }),
  fillColor: () => ({ style: { fillColor: '#123456' } }),
  'the geometry': (type) => ({ geometry: geometryOf(type) }),
  locked: () => ({ locked: true }),
  visible: () => ({ visible: false }),
};

/** The frames a renderer holds of a row group, as it holds them */
interface HeldFrames {
  readonly buffer: object | null;
  readonly origin: [number, number];
  readonly second: [number, number];
  readonly count: number;
  readonly longest: number;
}

/** The instances a renderer of the frames holds, by row group */
function heldBy(renderer: BulkFramesRenderer): ReadonlyMap<RowGroup, HeldFrames> {
  return (renderer as unknown as { frames: Map<RowGroup, HeldFrames> }).frames;
}

/** Draws a frame, and gives what it drew the frames of the rows with and read the selection as */
function drawFrame(instance: Instance) {
  const draws = vi.spyOn(BulkFramesRenderer.prototype, 'drawGroups');
  const reads = vi.spyOn(SelectedRows.prototype, 'read');
  instance.map.render();
  expect(draws).toHaveBeenCalledTimes(1);
  const renderer = draws.mock.contexts[0] as BulkFramesRenderer;
  const [, rows, groups] = draws.mock.calls[0];
  const at = reads.mock.contexts.indexOf(renderer.selection);
  expect(at).toBeGreaterThanOrEqual(0);
  const readArgs = reads.mock.calls[at];
  const used = reads.mock.results[at].value as ManySelection;
  draws.mockRestore();
  reads.mockRestore();
  return { renderer, rows, groups: [...groups], readArgs, used };
}

/** Checks that what a frame used is what is made anew of the rows */
function expectMadeAnew(instance: Instance, frame: ReturnType<typeof drawFrame>): void {
  const { renderer, rows, groups, readArgs, used } = frame;
  const entries = new Map(groups.map((entry) => [entry.group, entry]));
  for (const [group, held] of heldBy(renderer)) {
    const entry = entries.get(group);
    if (!entry) throw new Error('frames of a row group not drawn');
    const built = buildFrameInstances(group, rows, (row) => entry.drawnAtOnce(row));
    expect(held.count).toBe(built.count);
    expect(held.origin).toEqual(built.origin);
    expect(held.second).toEqual(built.second);
    expect(held.longest).toBe(built.longest);
    const data = held.buffer ? (instance.uploads.get(held.buffer) as Float32Array) : [];
    expect([...data]).toEqual([...built.data]);
  }
  const anew = new SelectedRows().read(...readArgs);
  expect({
    bbox: used.bbox,
    areaBbox: used.areaBbox,
    hasArea: used.hasArea,
    locked: used.locked,
  }).toEqual({
    bbox: anew.bbox,
    areaBbox: anew.areaBbox,
    hasArea: anew.hasArea,
    locked: anew.locked,
  });
}

/** The row group the row of a feature is read from */
function groupOf(instance: Instance, id: string): RowGroup {
  const rows = drawnRowsOf(instance.engine.context.store.getTables());
  const place = rows?.placeOf(rows.refOfId(id) as number);
  if (!place) throw new Error('no row');
  return place.group;
}

/** Makes features and selects them, once they are drawn; their IDs */
function selectMany(instance: Instance, features: readonly unknown[]): string[] {
  const ids = idsOf(instance.draw.features.createMany(features as never));
  settle(instance);
  instance.draw.selection.set('feature', ids);
  instance.map.render();
  return ids;
}

describe('a row written in place', () => {
  for (const type of Object.keys(TYPES) as TypeName[]) {
    for (const place of ['a row group', 'a part of a delta'] as const) {
      for (const [what, patchOf] of Object.entries(WRITES)) {
        it(`of a ${type} in ${place}: ${what}`, () => {
          const instance = instanceOf();
          const { draw, map } = instance;
          const ids = selectMany(
            instance,
            Array.from({ length: COUNT }, (_, i) => TYPES[type](i)),
          );
          let id = ids[500];
          if (place === 'a part of a delta') {
            [id] = idsOf(draw.features.createMany([TYPES[type](COUNT)] as never));
            draw.selection.set('feature', [...ids, id]);
            map.render();
          }
          expect(groupOf(instance, id).delta).toBe(place === 'a part of a delta');
          draw.features.update(id, patchOf(type) as never);
          for (let frame = 0; frame < 2; frame++) {
            expectMadeAnew(instance, drawFrame(instance));
          }
        });
      }
    }
  }

  it('of the Circle that makes the edge of the box of all of them: its radius taken away', () => {
    const instance = instanceOf();
    const { draw } = instance;
    const circles = Array.from({ length: COUNT }, (_, i) => TYPES['Circle with a radius'](i));
    circles[0].properties[RADIUS] = 200_000;
    const ids = selectMany(instance, circles);
    const west = () => drawFrame(instance).used.bbox?.topLeft[0] as number;
    expect(west()).toBeLessThan(-1);
    draw.features.update(ids[0], { properties: { [RADIUS]: undefined } });
    expect(west()).toBeGreaterThan(-0.1);
  });
});

describe('the work after a row is written in place', () => {
  /** The frames made again and the readings made in the next frame */
  function workOfNextFrame(instance: Instance, renderer: BulkFramesRenderer) {
    const before = new Map([...heldBy(renderer)].map(([group, { buffer }]) => [group, buffer]));
    const readings = renderer.selection.readings;
    instance.map.render();
    let frames = 0;
    for (const [group, { buffer }] of heldBy(renderer)) {
      if (before.get(group) !== buffer) frames++;
    }
    return { frames, readings: renderer.selection.readings - readings };
  }

  /** The features of types, in turn */
  const featuresOf = (types: readonly TypeName[]) =>
    Array.from({ length: COUNT }, (_, i) => TYPES[types[i % types.length]](i));

  const NAME = { properties: { name: 'x' } };
  const NOTHING = { frames: 0, readings: 0 };

  it('is none for a style or an attribute of the lines and the areas', () => {
    const instance = instanceOf();
    const { draw } = instance;
    const ids = selectMany(instance, featuresOf(['LineString', 'Polygon']));
    const { renderer } = drawFrame(instance);
    expect(heldBy(renderer).size).toBeGreaterThan(0);
    for (const id of [ids[500], ids[501]]) {
      draw.features.update(id, { style: { strokeWidth: 5 } });
      expect(workOfNextFrame(instance, renderer)).toEqual(NOTHING);
      draw.features.update(id, NAME);
      expect(workOfNextFrame(instance, renderer)).toEqual(NOTHING);
      expect(groupOf(instance, id).delta).toBe(false);
    }
  });

  it('is none for an attribute of the points, and the instances alone for a style', () => {
    const instance = instanceOf();
    const { draw } = instance;
    const ids = selectMany(instance, featuresOf(['Point']));
    const { renderer } = drawFrame(instance);
    draw.features.update(ids[500], NAME);
    expect(workOfNextFrame(instance, renderer)).toEqual(NOTHING);
    draw.features.update(ids[500], { style: { pointRadius: 9 } });
    expect(workOfNextFrame(instance, renderer)).toEqual({ frames: 1, readings: 0 });
    expect(workOfNextFrame(instance, renderer)).toEqual(NOTHING);
  });

  it('is the instances and the reading once for the radius of a circle', () => {
    const instance = instanceOf();
    const { draw } = instance;
    const ids = selectMany(instance, featuresOf(['Circle with a radius']));
    const { renderer } = drawFrame(instance);
    draw.features.update(ids[500], { properties: { [RADIUS]: 900 } });
    expect(workOfNextFrame(instance, renderer)).toEqual({ frames: 1, readings: 1 });
    expect(workOfNextFrame(instance, renderer)).toEqual(NOTHING);
  });
});
