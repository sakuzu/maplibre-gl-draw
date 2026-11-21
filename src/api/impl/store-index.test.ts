// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The hits, the box selection and the snapping of an instance, whose candidates come from the
 * spatial index of the Store, on the Store the instance makes and on a Store of the application
 * spread from a built-in one
 *
 * - A click, a box and the pointer of a line being drawn reach an Image, a Circle and a type with
 *   an extent of its own away from their positions, by the boxes they cover
 * - A box lists what it selects in stacking order, from the back, across layers too, whatever
 *   order the features were created in
 * - A row moved by a write to the Store directly is hit with its new box
 * - A feature in a hidden layer, one hidden by this client and one deleted are neither hit nor
 *   snapped to; `features.list({ bbox })` returns the hidden features as well
 * - A group and a layer take the id of a feature deleted in the same transaction
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStore } from '../../store/built-in/create-store.js';
import type { Store } from '../../store/built-in/types.js';
import { createParityMap, type ParityMap, rowWrites } from '../../test-utils.js';
import { createDraw, type Draw } from '../draw.js';
import type { Feature, FeatureInput } from '../model.js';

const draws: Draw[] = [];

afterEach(() => {
  for (const draw of draws.splice(0)) draw.destroy();
});

/** The Stores the scenes run on: none given (the instance makes one), and one spread */
const STORES: ReadonlyArray<[string, () => Store | undefined]> = [
  ['the Store the instance makes', () => undefined],
  ['a Store of the application spread from the built-in one', () => ({ ...createStore() })],
];

/**
 * An instance on the map of the table of what the instance does (one degree is 100 pixels, the
 * zoom is 10) with:
 *
 * - `img`: an Image at (-2, 0), 1,000 pixels square at zoom 10 (about 0.34 degrees each way)
 * - `cir`: a Circle at (2, 0) of 30 km (about 0.27 degrees)
 * - `wide`: a feature of the type `wide` at (0, 2), which covers 0.5 degrees around its point and
 *   offers a snapping candidate at (0.4, 2.4)
 * - `sq`: a square from (0, -2) to (1, -1)
 */
function instanceOf(store: Store | undefined): { draw: Draw; map: ParityMap; store: Store } {
  const map = createParityMap();
  let n = 0;
  const draw = createDraw(map.map, {
    generateId: () => `id${++n}`,
    ...(store !== undefined && { store }),
  });
  draws.push(draw);
  draw.extensions.featureTypes.add({
    type: 'wide',
    geometry: 'Point',
    renderer: { onAdd: vi.fn(), draw: vi.fn(), onRemove: vi.fn() },
    bbox(feature) {
      const [x, y] = (feature.geometry as GeoJSON.Point).coordinates;
      return [x - 0.5, y - 0.5, x + 0.5, y + 0.5];
    },
    hitTest(feature, ctx) {
      const [x, y] = ctx.screen.project((feature.geometry as GeoJSON.Point).coordinates);
      const distancePx = Math.hypot(x - ctx.point[0], y - ctx.point[1]);
      return distancePx <= 50 ? { kind: 'feature', id: feature.id, distancePx } : null;
    },
    snapCandidates: () => [{ position: [0.4, 2.4], kind: 'anchor', source: 'wide' }],
  });
  const create = (input: FeatureInput) => {
    if (!draw.features.create(input)) throw new Error(`${input.id} not created`);
  };
  create({
    id: 'img',
    type: 'Image',
    geometry: { type: 'Point', coordinates: [-2, 0] },
    properties: {
      'maplibre-gl-draw:imageFileId': 'file-1',
      'maplibre-gl-draw:imageWidth': 1000,
      'maplibre-gl-draw:imageHeight': 1000,
      'maplibre-gl-draw:createdZoom': 10,
    },
  });
  create({
    id: 'cir',
    type: 'Circle',
    geometry: { type: 'Point', coordinates: [2, 0] },
    properties: { 'maplibre-gl-draw:radiusMeters': 30_000 },
  });
  create({ id: 'wide', type: 'wide', geometry: { type: 'Point', coordinates: [0, 2] } });
  create({
    id: 'sq',
    type: 'Polygon',
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [0, -2],
          [1, -2],
          [1, -1],
          [0, -1],
          [0, -2],
        ],
      ],
    },
  });
  return { draw, map, store: draw.getStore() as Store };
}

/** What a click at a place selects */
function clicked(draw: Draw, map: ParityMap, at: [number, number]): readonly string[] {
  draw.selection.clear();
  map.click(at);
  return draw.selection.get().ids.toArray();
}

/** What a box from one corner to the other selects */
function boxed(
  draw: Draw,
  map: ParityMap,
  from: [number, number],
  to: [number, number],
): readonly string[] {
  draw.selection.clear();
  map.drag(from, to, { modifiers: { shift: true } });
  return draw.selection.get().ids.toArray().sort();
}

/** The features a line being drawn snaps to when its pointer moves to a place */
function snappedTo(draw: Draw, map: ParityMap, at: [number, number]): string[] {
  const targets: string[] = [];
  const stop = draw.on('snap.changed', ({ result }) => {
    if (result?.target?.featureId) targets.push(result.target.featureId);
  });
  draw.setMode('drawLine');
  map.click([-3.5, 2.5]);
  map.move(at);
  map.key('Escape');
  draw.setMode('select');
  stop();
  return targets;
}

describe.each(STORES)('on %s', (_name, make) => {
  it('hits an Image, a Circle and a type with an extent of its own away from their positions', () => {
    const { draw, map } = instanceOf(make());
    expect(clicked(draw, map, [-1.8, 0.2])).toEqual(['img']);
    expect(clicked(draw, map, [2.2, 0])).toEqual(['cir']);
    expect(clicked(draw, map, [0.3, 2.3])).toEqual(['wide']);
    expect(clicked(draw, map, [0.5, -1.5])).toEqual(['sq']);
    // Beyond what they cover
    expect(clicked(draw, map, [-1.5, 0.6])).toEqual([]);
    expect(clicked(draw, map, [2.4, 0])).toEqual([]);
  });

  it('selects in a box what it holds', () => {
    const { draw, map } = instanceOf(make());
    expect(boxed(draw, map, [-2.6, -0.6], [-1.4, 0.6])).toEqual(['img']);
    expect(boxed(draw, map, [1.6, -0.4], [2.4, 0.4])).toEqual(['cir']);
    expect(boxed(draw, map, [-0.2, -2.2], [1.2, -0.8])).toEqual(['sq']);
  });

  it('lists what a box selects in stacking order, from the back, also across two layers', () => {
    const { draw, map } = instanceOf(make());
    const back = draw.layers.list()[0].id;
    const front = draw.layers.create({ id: 'front' });
    if (!front) throw new Error('no layer');
    const point = (id: string, x: number, layerId: string) =>
      draw.features.create({
        id,
        type: 'Point',
        geometry: { type: 'Point', coordinates: [x, -2.6] },
        layerId,
      });
    // Created in another order than the one they are stacked in
    point('k3', 3.5, front.id);
    point('k1', 3.1, back);
    point('k2', 3.3, back);
    point('k4', 3.7, front.id);
    point('k5', 3.9, back);
    draw.features.move('k2', { layerId: back, index: 0 });
    draw.groups.create({ id: 'kg', featureIds: ['k5', 'k1'] });
    const stacked = (): string[] =>
      draw.features
        .list()
        .map((feature: Feature) => feature.id)
        .filter((id) => id.startsWith('k'));

    const order = stacked();
    expect(order).not.toEqual(['k3', 'k1', 'k2', 'k4', 'k5']);
    map.drag([2.9, -2.8], [4, -2.4], { modifiers: { shift: true } });
    expect(draw.selection.get().ids.toArray()).toEqual(order);

    // The layers the other way round
    draw.layers.reorder([...draw.layers.getOrder()].reverse());
    const reordered = stacked();
    expect(reordered).not.toEqual(order);
    draw.selection.clear();
    map.drag([2.9, -2.8], [4, -2.4], { modifiers: { shift: true } });
    expect(draw.selection.get().ids.toArray()).toEqual(reordered);
  });

  it('snaps to a vertex, and to a candidate of a type with an extent of its own away from its position', () => {
    const { draw, map } = instanceOf(make());
    expect(snappedTo(draw, map, [1.003, -1.002])).toContain('sq');
    expect(snappedTo(draw, map, [0.401, 2.401])).toContain('wide');
  });

  it('hits a row moved by a write to the Store directly with its new box', () => {
    const { draw, map, store } = instanceOf(make());
    store.transact(() => {
      rowWrites(store).updateFeature('img', {
        geometry: { type: 'Point', coordinates: [-2, -2] },
      });
    }, 'remote');
    expect(clicked(draw, map, [-1.8, 0.2])).toEqual([]);
    expect(clicked(draw, map, [-1.8, -1.8])).toEqual(['img']);
  });

  it('neither hits nor snaps to a feature in a hidden layer, one hidden by this client or one deleted', () => {
    const { draw, map, store } = instanceOf(make());
    const hiddenLayer = draw.layers.create({ id: 'hl', visible: false });
    if (!hiddenLayer) throw new Error('no layer');
    const point = (id: string, x: number, extra: Partial<FeatureInput> = {}) =>
      draw.features.create({
        id,
        type: 'Point',
        geometry: { type: 'Point', coordinates: [x, -2.5] },
        ...extra,
      });
    point('inHidden', -3, { layerId: 'hl' });
    point('local', -2);
    point('gone', -1);
    draw.hidden.add('local');
    store.transact(() => rowWrites(store).deleteFeature('gone'), 'remote');

    for (const [id, x] of [
      ['inHidden', -3],
      ['local', -2],
      ['gone', -1],
    ] as const) {
      expect(clicked(draw, map, [x, -2.5])).toEqual([]);
      expect(snappedTo(draw, map, [x + 0.002, -2.5])).not.toContain(id);
    }
  });

  it('lists the hidden features in a box as well', () => {
    const { draw } = instanceOf(make());
    draw.layers.create({ id: 'hl', visible: false });
    draw.features.create({
      id: 'off',
      type: 'Point',
      geometry: { type: 'Point', coordinates: [3, 2] },
      visible: false,
    });
    draw.features.create({
      id: 'inHidden',
      type: 'Point',
      geometry: { type: 'Point', coordinates: [3.1, 2] },
      layerId: 'hl',
    });
    draw.features.create({
      id: 'local',
      type: 'Point',
      geometry: { type: 'Point', coordinates: [3.2, 2] },
    });
    draw.hidden.add('local');
    const listed = draw.features.list({ bbox: [2.9, 1.9, 3.3, 2.1] }).map((f: Feature) => f.id);
    expect(listed.sort()).toEqual(['inHidden', 'local', 'off']);
  });

  it('makes a group and a layer with the ids of features deleted in the same transaction', () => {
    const { draw } = instanceOf(make());
    draw.features.create({
      id: 'p',
      type: 'Point',
      geometry: { type: 'Point', coordinates: [3, -2] },
    });
    draw.features.create({
      id: 'q',
      type: 'Point',
      geometry: { type: 'Point', coordinates: [3.5, -2] },
    });
    draw.transact(() => {
      draw.features.delete('cir');
      draw.features.delete('wide');
      expect(draw.groups.create({ id: 'cir', featureIds: ['p', 'q'] })?.id).toBe('cir');
      expect(draw.layers.create({ id: 'wide' })?.id).toBe('wide');
    });
    expect(draw.features.get('cir')).toBeUndefined();
    expect(draw.features.get('wide')).toBeUndefined();
    expect(draw.groups.get('cir')?.id).toBe('cir');
    expect(draw.layers.get('wide')?.id).toBe('wide');
  });
});
