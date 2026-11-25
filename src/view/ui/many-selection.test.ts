// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The reading of a selection of many features, which its frame is drawn with and the select mode
 * answers the pointer from
 *
 * The reading is held to what is worked out from the features selected, on documents made at random
 * (points, lines, areas, circles and images, some locked, some in groups) and the three kinds of
 * selection. The pointer over the selection makes no feature, the frame of
 * all of them is grabbed as the frame of a few is, and the handles not drawn (those of points alone)
 * are not hit. The features of the groups and the layers selected are the ones they were when they
 * were listed into an array.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { SelectModeDragHandler } from '../../modes/select/drag-handler.js';
import { DEFAULT_SELECTION_CONFIG } from '../../shared/config/selection.js';
import { applyMarginToBoundingBox, createCoordinateTransform } from '../../shared/math/index.js';
import { FEATURES_KEPT } from '../../store/document-access.js';
import { isInteractionBlocked } from '../../store/lock.js';
import type { Feature } from '../../store/types.js';
import {
  createCountedInstance,
  createSyntheticDrag,
  expectNotProportional,
  gridPoints,
  workDuring,
} from '../../test-utils.js';
import { computeResizeHandles, computeRotateHandle } from './handles.js';
import {
  computeSelectionBoundingBox,
  getSelectedFeatureIdSet,
  type SelectionDocument,
} from './helper.js';
import { type BoundingBoxCoords, computeCombinedBoundingBox } from './selection-ui/index.js';

type Instance = ReturnType<typeof createCountedInstance>;

const instances: Instance[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const instance of instances.splice(0)) instance.draw.destroy();
});

function instanceOf(): Instance {
  const instance = createCountedInstance();
  instances.push(instance);
  return instance;
}

/** Draws frames until the drawing has no work left */
function settle(instance: Instance): void {
  for (let frame = 0; frame < 30; frame++) {
    instance.map.render();
    if (!instance.draw.hasPendingWork()) return;
  }
  throw new Error('the drawing still has work after 30 frames');
}

/** The IDs of the features made */
function idsOf(made: unknown): string[] {
  return (made as Array<{ id: string }>).map((feature) => feature.id);
}

/** Numbers from 0 to 1, the same for a seed */
function randomOf(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A feature made at random */
function shapeOf(random: () => number, layerId: string, types: readonly string[]) {
  const type = types[Math.floor(random() * types.length)];
  const at: [number, number] = [random() * 20 - 10, random() * 20 - 10];
  const to: [number, number] = [at[0] + random() / 10, at[1] + random() / 10];
  switch (type) {
    case 'LineString':
      return { type, layerId, geometry: { type: 'LineString', coordinates: [at, to] } };
    case 'Polygon':
      return {
        type,
        layerId,
        geometry: { type: 'Polygon', coordinates: [[at, [to[0], at[1]], to, at]] },
      };
    case 'Circle':
      return {
        type,
        layerId,
        geometry: { type: 'Point', coordinates: at },
        properties: {
          'maplibre-gl-draw:radiusMeters': random() < 0.1 ? 0 : 100 + random() * 10_000,
        },
      };
    case 'Image':
      return {
        type,
        layerId,
        geometry: { type: 'Point', coordinates: at },
        properties: {
          'maplibre-gl-draw:imageWidth': 50 + random() * 100,
          'maplibre-gl-draw:imageHeight': 50 + random() * 100,
          'maplibre-gl-draw:createdZoom': 10,
          'maplibre-gl-draw:rotation': random() * 360,
        },
      };
    default:
      return { type, layerId, geometry: { type: 'Point', coordinates: at } };
  }
}

const EVERY_TYPE = ['Point', 'LineString', 'Polygon', 'Circle', 'Image'];

/** The features selected, made one by one */
function selectedOf(instance: Instance): Feature[] {
  const store = instance.engine.context.store as unknown as SelectionDocument;
  return [...getSelectedFeatureIdSet(store).iterate()].map((id) => store.getFeature(id) as Feature);
}

/** Expects the reading of the selection to be what is worked out from the features selected */
function expectReading(instance: Instance): void {
  const { store, selectionScope } = instance.engine.context;
  const features = selectedOf(instance);
  expect(features.length).toBeGreaterThan(FEATURES_KEPT);
  const many = instance.engine.customLayer.getManySelection();
  if (!many) throw new Error('no reading of the selection');
  const { extensions } = selectionScope;
  expect(many.bbox).toEqual(computeCombinedBoundingBox(features, extensions));
  expect(many.areaBbox ?? many.bbox).toEqual(computeSelectionBoundingBox(features, extensions));
  expect(many.locked).toBe(features.some((feature) => isInteractionBlocked(feature, store)));
  expect(many.count).toBe(features.length);
}

describe('the reading of a selection of many features', () => {
  for (const seed of [1, 2, 3, 4]) {
    it(`is what is worked out from the features selected (document ${seed})`, () => {
      const random = randomOf(seed);
      const instance = instanceOf();
      const { draw } = instance;
      const layers = [0, 1, 2].map((i) => draw.layers.create({ name: `l${i}` })?.id as string);
      const made = layers.map((layerId) =>
        idsOf(
          draw.features.createMany(
            Array.from({ length: 1_300 }, () => shapeOf(random, layerId, EVERY_TYPE)) as never,
          ),
        ),
      );
      const all = made.flat();
      // Groups of many and of few, in the first two layers
      const groups = [0, 1].flatMap((i) => [
        draw.groups.create({ featureIds: made[i].slice(0, 700) })?.id as string,
        draw.groups.create({ featureIds: made[i].slice(700, 740) })?.id as string,
      ]);
      const select = [
        () =>
          draw.selection.set(
            'feature',
            all.filter(() => random() < 0.5),
          ),
        () => draw.selection.set('feature', made[1]),
        () => draw.selection.set('group', groups),
        () => draw.selection.set('layer', layers.slice(0, 2)),
        () => draw.selection.set('layer', layers),
      ];
      // Before a frame is drawn, and after
      select[0]();
      expectReading(instance);
      settle(instance);
      for (const each of select) {
        each();
        expectReading(instance);
        settle(instance);
        expectReading(instance);
      }
      // A lock of a layer, of a group and of a feature, each alone, without a frame between
      for (const lock of [
        (locked: boolean) => draw.layers.update(layers[1], { locked }),
        (locked: boolean) => draw.groups.update(groups[1], { locked }),
        (locked: boolean) =>
          draw.transact(() => draw.features.update(made[1][3], { locked }), { ignoreLocks: true }),
      ]) {
        lock(true);
        for (const each of select) {
          each();
          expectReading(instance);
        }
        lock(false);
        expectReading(instance);
      }
      // Features written after the frame, read from the rows written since
      draw.features.createMany(
        Array.from({ length: 30 }, () => shapeOf(random, layers[0], EVERY_TYPE)) as never,
      );
      draw.features.update(made[0][0], { geometry: { type: 'Point', coordinates: [30, 30] } });
      draw.layers.update(layers[0], { locked: true });
      for (const each of select) {
        each();
        expectReading(instance);
      }
    });
  }

  it('gives the box of the only feature that has an area as its own', () => {
    for (const type of ['Image', 'Circle', 'Polygon', 'LineString']) {
      const random = randomOf(7);
      const instance = instanceOf();
      const { draw } = instance;
      const layerId = draw.layers.list()[0].id;
      const ids = idsOf(
        draw.features.createMany([
          ...gridPoints(1_100),
          {
            ...shapeOf(random, layerId, [type]),
            ...(type === 'Circle' && { properties: { 'maplibre-gl-draw:radiusMeters': 5_000 } }),
          },
        ] as never),
      );
      settle(instance);
      draw.selection.set('feature', ids);
      expectReading(instance);
    }
  });

  it('spans the circles and not their centers', () => {
    const instance = instanceOf();
    const { draw } = instance;
    const circles = gridPoints(1_025).map((each) => ({
      ...each,
      type: 'Circle',
      properties: { 'maplibre-gl-draw:radiusMeters': 20_000 },
    }));
    const ids = idsOf(draw.features.createMany(circles as never));
    settle(instance);
    draw.selection.set('feature', ids);
    expectReading(instance);
    const many = instance.engine.customLayer.getManySelection();
    expect(many?.hasArea).toBe(true);
    expect(many?.bbox?.topLeft[0]).toBeLessThan(-1.1);
    expect(many?.bbox?.bottomRight[1]).toBeLessThan(-1.1);
  });

  it('is none with a few selected, and when the features are drawn one by one', () => {
    const instance = instanceOf();
    const ids = idsOf(instance.draw.features.createMany(gridPoints(FEATURES_KEPT + 1) as never));
    settle(instance);
    instance.draw.selection.set('feature', ids.slice(0, FEATURES_KEPT));
    expect(instance.engine.customLayer.getManySelection()).toBeNull();
    instance.draw.selection.set('feature', ids);
    expect(instance.engine.customLayer.getManySelection()).not.toBeNull();

    const immediate = createCountedInstance({ rendering: { cacheGeometry: false } });
    instances.push(immediate);
    const made = idsOf(immediate.draw.features.createMany(gridPoints(FEATURES_KEPT + 1) as never));
    immediate.map.render();
    immediate.draw.selection.set('feature', made);
    expect(immediate.engine.customLayer.getManySelection()).toBeNull();
  });
});

/** The box of the frame drawn of a selection */
function frameOf(instance: Instance, features: Feature[]): BoundingBoxCoords {
  const bbox = computeCombinedBoundingBox(features);
  if (!bbox) throw new Error('no box');
  const transform = createCoordinateTransform(instance.engine.map, null);
  return {
    ...applyMarginToBoundingBox(bbox, DEFAULT_SELECTION_CONFIG.boundingBox.margin, transform),
    center: bbox.center,
  };
}

/** Where the rotate handle of a frame is (or would be) */
function rotateHandleOf(instance: Instance, frame: BoundingBoxCoords): [number, number] {
  const { distance } = DEFAULT_SELECTION_CONFIG.rotateHandle;
  const { position } = computeRotateHandle(frame, distance, instance.engine.map.getZoom());
  return [position[0], position[1]];
}

/** Where a resize handle of a frame is (or would be) */
function resizeHandleOf(frame: BoundingBoxCoords, type: string): [number, number] {
  const handle = computeResizeHandles(frame).find((each) => each.type === type);
  if (!handle) throw new Error('no handle');
  return [handle.position[0], handle.position[1]];
}

/** The cursor over a position */
function cursorAt(instance: Instance, at: [number, number]): string {
  instance.input.move(at, { snap: false });
  return (instance.engine.map.getCanvas() as HTMLCanvasElement).style.cursor;
}

/** `count` points, lines and areas of the grid */
function shapes(count: number) {
  const step = 2 / Math.ceil(Math.sqrt(count)) / 3;
  return gridPoints(count).map(({ geometry }, i) => {
    const [x, y] = geometry.coordinates;
    if (i % 3 === 0) return { type: 'Point', geometry };
    const coordinates = [
      [x, y],
      [x + step, y],
      [x, y + step],
      [x, y],
    ];
    return i % 3 === 1
      ? { type: 'LineString', geometry: { type: 'LineString', coordinates } }
      : { type: 'Polygon', geometry: { type: 'Polygon', coordinates: [coordinates] } };
  });
}

/** What the pointer does over a selection: the moves, the presses and the starts of a drag */
function pointerWork(instance: Instance): number {
  // The drag itself reads what it moves: what is measured ends where it starts
  vi.spyOn(SelectModeDragHandler.prototype, 'startDrag').mockImplementation(() => {});
  const frame = frameOf(instance, selectedOf(instance));
  const places: [number, number][] = [
    [0.1, 0.1],
    rotateHandleOf(instance, frame),
    resizeHandleOf(frame, 'resize-ne'),
    [6, 6],
  ];
  settle(instance);
  const drag = createSyntheticDrag(instance.engine);
  const over = () => {
    for (const place of places) {
      instance.input.move(place, { snap: false });
      drag.start(place);
      drag.end(place);
    }
  };
  // What the hit test of the candidates keeps is made once
  over();
  return workDuring(instance.counts, over).objectsCreated;
}

describe('the pointer over a selection of many features', () => {
  it('makes no feature with 1,025 features selected', () => {
    const instance = instanceOf();
    const ids = idsOf(instance.draw.features.createMany(shapes(1_025) as never));
    instance.draw.selection.set('feature', ids);
    expect(pointerWork(instance)).toBe(0);
  });

  it('makes as many objects with a layer of 1,000 and of 10,000 features selected', () => {
    expectNotProportional(
      (size) => {
        const instance = instanceOf();
        instance.draw.features.createMany(shapes(size) as never);
        instance.draw.selection.set('layer', [instance.draw.layers.list()[0].id]);
        return pointerWork(instance);
      },
      'the objects made',
      { zero: true },
    );
  });

  it('drags a resize handle of the frame of all of them, and all of them are scaled', () => {
    const instance = instanceOf();
    const { draw } = instance;
    const ids = idsOf(draw.features.createMany(shapes(1_025) as never));
    draw.selection.set('feature', ids);
    settle(instance);
    const before = ids.map((id) => JSON.stringify(draw.features.get(id)?.geometry));
    const frame = frameOf(instance, selectedOf(instance));
    const at = resizeHandleOf(frame, 'resize-ne');
    const drag = createSyntheticDrag(instance.engine);
    drag.start(at);
    drag.move([at[0] + 0.5, at[1] + 0.5]);
    drag.end([at[0] + 0.5, at[1] + 0.5]);
    const after = ids.map((id) => JSON.stringify(draw.features.get(id)?.geometry));
    // The corner the others are scaled from stays
    const moved = after.filter((each, i) => each !== before[i]).length;
    expect(moved).toBeGreaterThanOrEqual(ids.length - 1);
  });

  it('drags the inside of the frame, and all of them are moved', () => {
    const instance = instanceOf();
    const { draw } = instance;
    const ids = idsOf(draw.features.createMany(shapes(1_025) as never));
    // Far from any feature, inside the frame of all of them
    const far = idsOf(
      draw.features.createMany([
        { type: 'Point', geometry: { type: 'Point', coordinates: [4, 4] } },
      ] as never),
    );
    draw.selection.set('feature', [...ids, ...far]);
    settle(instance);
    const before = [...ids, ...far].map((id) => JSON.stringify(draw.features.get(id)?.geometry));
    expect(cursorAt(instance, [3, 0])).toBe('move');
    const drag = createSyntheticDrag(instance.engine);
    drag.start([3, 0]);
    drag.move([3.5, 0.5]);
    drag.end([3.5, 0.5]);
    const after = [...ids, ...far].map((id) => JSON.stringify(draw.features.get(id)?.geometry));
    expect(after.every((each, i) => each !== before[i])).toBe(true);
  });

  it('starts no drag and shows no cursor of one when a feature selected is locked', () => {
    const instance = instanceOf();
    const { draw } = instance;
    const ids = idsOf(draw.features.createMany(shapes(1_025) as never));
    draw.features.update(ids[0], { locked: true });
    draw.selection.set('feature', ids);
    settle(instance);
    const frame = frameOf(instance, selectedOf(instance));
    expect(cursorAt(instance, resizeHandleOf(frame, 'resize-ne'))).not.toBe('ne-resize');
    draw.features.update(ids[0], { locked: false });
    expect(cursorAt(instance, resizeHandleOf(frame, 'resize-ne'))).toBe('ne-resize');
  });

  it('takes a drag of one of them outside a handle as a drag of all of them', () => {
    const instance = instanceOf();
    const { draw } = instance;
    const ids = idsOf(draw.features.createMany(shapes(1_025) as never));
    draw.selection.set('feature', ids);
    settle(instance);
    const start = vi.spyOn(SelectModeDragHandler.prototype, 'startDrag');
    const drag = createSyntheticDrag(instance.engine);
    drag.start([0.1, 0.1]);
    expect(start).toHaveBeenCalledTimes(1);
    expect(start.mock.calls[0][0]).toEqual({ type: 'move' });
    expect(start.mock.calls[0][3]).toEqual(computeSelectionBoundingBox(selectedOf(instance)));
    expect(draw.selection.get().ids.count()).toBe(1_025);
    drag.end([0.1, 0.1]);
  });
});

describe('the handles of a selection of points alone', () => {
  for (const count of [2, FEATURES_KEPT, FEATURES_KEPT + 1]) {
    it(`are not hit with ${count} points, and are with an area among them`, () => {
      const instance = instanceOf();
      const { draw } = instance;
      // The rotate handle is then well above the frame
      instance.engine.map.getZoom = () => 6;
      const ids = idsOf(
        draw.features.createMany(
          gridPoints(count).map((each) => ({ ...each, style: { pointRadius: 2 } })) as never,
        ),
      );
      draw.selection.set('feature', ids);
      settle(instance);
      const frame = frameOf(instance, selectedOf(instance));
      const start = vi.spyOn(SelectModeDragHandler.prototype, 'startDrag');
      const drag = createSyntheticDrag(instance.engine);
      const places = [
        rotateHandleOf(instance, frame),
        ...['resize-nw', 'resize-ne', 'resize-se', 'resize-sw'].map((type) =>
          resizeHandleOf(frame, type),
        ),
      ];
      for (const place of places) {
        expect(['default', 'move', 'pointer']).toContain(cursorAt(instance, place));
        drag.start(place);
        drag.end(place);
      }
      expect(start.mock.calls.filter(([hit]) => hit.type !== 'move')).toEqual([]);
      // Above the points, where the rotate handle would be, nothing is grabbed at all
      start.mockClear();
      drag.start(places[0]);
      drag.end(places[0]);
      expect(start).not.toHaveBeenCalled();

      const area = idsOf(
        draw.features.createMany([
          {
            type: 'Polygon',
            geometry: {
              type: 'Polygon',
              coordinates: [
                [
                  [-0.5, 0],
                  [0.5, 0],
                  [0.5, 0.5],
                  [-0.5, 0],
                ],
              ],
            },
          },
        ] as never),
      );
      draw.selection.set('feature', [...ids, ...area]);
      settle(instance);
      const wider = frameOf(instance, selectedOf(instance));
      expect(cursorAt(instance, rotateHandleOf(instance, wider))).toBe('grab');
      expect(cursorAt(instance, resizeHandleOf(wider, 'resize-ne'))).toBe('ne-resize');
    });
  }
});

describe('the features of the groups and of the layers selected', () => {
  /** The features as they were listed into an array, each time they were asked for */
  function listed(store: SelectionDocument): string[] {
    const selection = store.getSelection();
    const ids = [...selection.ids.iterate()];
    if (selection.type === 'group') {
      return ids.flatMap((id) => store.listGroupFeatureIds(id, 0, store.countGroupFeatures(id)));
    }
    return ids.flatMap((layerId) => {
      if (!store.getLayer(layerId)) return [];
      return [...store.iterateFeatures({ layerId })].map((feature) => feature.id);
    });
  }

  /** A document of two layers, groups, hidden features and a hidden group */
  function documentOf(seed: number, count: number) {
    const random = randomOf(seed);
    const instance = instanceOf();
    const { draw } = instance;
    const layers = [0, 1, 2].map((i) => draw.layers.create({ name: `l${i}` })?.id as string);
    const made = layers.map((layerId) =>
      idsOf(
        draw.features.createMany(
          Array.from({ length: count }, () => shapeOf(random, layerId, EVERY_TYPE)) as never,
        ),
      ),
    );
    const groups = made.flatMap((ids) => [
      draw.groups.create({ featureIds: ids.filter(() => random() < 0.3) })?.id as string,
      draw.groups.create({ featureIds: ids.slice(0, 4) })?.id as string,
    ]);
    return { instance, layers, made, groups, random };
  }

  for (const seed of [11, 12, 13]) {
    it(`are counted, told and listed as before (document ${seed})`, () => {
      const { instance, layers, made, groups, random } = documentOf(seed, 60);
      const { draw } = instance;
      const store = instance.engine.context.store as unknown as SelectionDocument;
      const everyId = [...made.flat(), 'no such feature'];
      const expectSame = (): void => {
        const set = getSelectedFeatureIdSet(store);
        const before = listed(store);
        const has = new Set(before);
        expect(set.count()).toBe(before.length);
        expect([...set.iterate()]).toEqual(before);
        for (const id of everyId) expect(set.has(id)).toBe(has.has(id));
      };
      for (const round of [0, 1]) {
        for (const type of ['group', 'layer'] as const) {
          const of = type === 'group' ? groups : layers;
          for (let i = 0; i < of.length; i++) {
            const chosen = of.filter(() => random() < 0.6);
            draw.selection.set(type, chosen.length > 0 ? chosen : [of[0]]);
            expectSame();
          }
        }
        if (round === 1) break;
        // Some hidden and locked, then the same selections of groups and layers with them (the
        // selection is set while they are shown: what hides them leaves them in their layer)
        draw.selection.set('layer', layers);
        for (const ids of made) {
          draw.features.update(ids[5], { visible: false });
          draw.features.update(ids[6], { locked: true });
          draw.features.delete(ids[8]);
        }
        expectSame();
      }
    });
  }

  it('are counted and told without the features being made', () => {
    for (const type of ['group', 'layer'] as const) {
      const scene = (size: number): number => {
        const instance = instanceOf();
        const { draw } = instance;
        const ids = idsOf(draw.features.createMany(gridPoints(size) as never));
        const layerId = draw.features.get(ids[0])?.layerId as string;
        const groupId = draw.groups.create({ featureIds: ids })?.id as string;
        draw.selection.set(type, [type === 'group' ? groupId : layerId]);
        const store = instance.engine.context.store as unknown as SelectionDocument;
        return workDuring(instance.counts, () => {
          const set = getSelectedFeatureIdSet(store);
          expect(set.count()).toBe(size);
          expect(set.has(ids[0])).toBe(true);
          expect(set.has(ids[size - 1])).toBe(true);
          expect(set.has('no such feature')).toBe(false);
        }).objectsCreated;
      };
      const { large } = expectNotProportional(scene, 'the objects made', { zero: true });
      expect(large).toBeLessThan(20);
    }
  });
});
