// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The features are made when they are asked for, and the layer over the Store keeps no more of them
 * than the number it keeps one by one: no list of every feature is kept, whatever was read before
 *
 * The readers that relied on such a list answer as they did with one: the stacking order of what is
 * moved and of what is selected, the automatic names, and the boxes made again when an extension
 * asks for everything. None of them makes a feature it does not hand out.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { FEATURES_KEPT, type InstanceDocument } from '../../store/document-access.js';
import type { Feature as StoredFeature } from '../../store/types.js';
import {
  createCountedInstance,
  expectNotProportional,
  gridPoints,
  workDuring,
} from '../../test-utils.js';

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

/** More objects than making a feature counts (it is made from the arrays of its values) */
const OBJECTS_PER_FEATURE = 20;

describe('the features the layer keeps made', () => {
  for (const before of ['nothing read', 'every feature listed'] as const) {
    it(`are ${FEATURES_KEPT.toLocaleString('en')} at most, the last ones read (${before})`, () => {
      const instance = instanceOf();
      const ids = idsOf(instance.draw.features.createMany(gridPoints(2_000) as never));
      const { store } = instance.engine.context;
      if (before === 'every feature listed') {
        store.listFeatures();
        store.listFeaturesInOrder();
      }
      for (const id of ids) store.getFeature(id);
      const last = ids.slice(-FEATURES_KEPT).reverse();
      const others = ids.slice(0, -FEATURES_KEPT).reverse();
      const made = (read: readonly string[]) =>
        workDuring(instance.counts, () => {
          for (const id of read) store.getFeature(id);
        }).objectsCreated;
      expect(made(last)).toBe(0);
      expect(made(others)).toBeGreaterThanOrEqual(others.length);
    });
  }

  it('are not those of a list of every feature: it is made each time', () => {
    const instance = instanceOf();
    instance.draw.features.createMany(gridPoints(2_000) as never);
    const { store } = instance.engine.context;
    const made = () =>
      workDuring(instance.counts, () => {
        expect(store.listFeatures()).toHaveLength(2_000);
      }).objectsCreated;
    made();
    expect(made()).toBeGreaterThanOrEqual(2_000 - FEATURES_KEPT);
  });
});

describe('the stacking order of what is moved and of what is selected', () => {
  /** Every feature in stacking order, those of the layers off the order at the end, as it was listed */
  function listed(store: InstanceDocument): StoredFeature[] {
    const ordered = store.listFeaturesInOrder();
    const on = new Set(ordered.map((feature) => feature.id));
    return [...ordered, ...store.listFeatures().filter((feature) => !on.has(feature.id))];
  }

  /** The IDs given as they were sorted: picked from the list of every feature */
  function sorted(store: InstanceDocument, ids: readonly string[]): string[] {
    const wanted = new Set(ids);
    return listed(store)
      .filter((feature) => wanted.has(feature.id))
      .map((feature) => feature.id);
  }

  /** Some of the IDs, in an order of their own */
  function someOf(random: () => number, ids: readonly string[], share: number): string[] {
    const some = ids.filter(() => random() < share);
    for (let i = some.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [some[i], some[j]] = [some[j], some[i]];
    }
    return some.length > 0 ? some : [ids[0]];
  }

  /**
   * A document of four layers, one of them off the stacking order, with groups, and with rows of
   * the same key (written to the Store directly)
   */
  function documentOf(seed: number) {
    const random = randomOf(seed);
    const instance = instanceOf();
    const { draw, store: rows, engine } = instance;
    const layers = [0, 1, 2, 3].map((i) => draw.layers.create({ name: `l${i}` })?.id as string);
    const made = layers.map((layerId) =>
      idsOf(
        draw.features.createMany(gridPoints(60).map((each) => ({ ...each, layerId })) as never),
      ),
    );
    const groups = made.flatMap((ids) => [
      draw.groups.create({ featureIds: ids.filter((_, i) => i % 7 === 0) })?.id as string,
      draw.groups.create({ featureIds: ids.filter((_, i) => i % 7 === 3) })?.id as string,
    ]);
    // Rows of one key, in a layer and in a group
    for (const ids of made) {
      const alone = ids.filter((_, i) => i % 7 === 1).slice(0, 5);
      const members = ids.filter((_, i) => i % 7 === 0).slice(0, 5);
      for (const same of [alone, members]) {
        const key = rows.tables
          .readValues(Int32Array.of(rows.tables.getRowRef(same[0]) as number), ['orderKey'])
          .fields.get('orderKey')?.[0] as string;
        for (const id of same) {
          rows.transact(() => {
            rows.writeRows({
              rows: Int32Array.of(rows.tables.getRowRef(id) as number),
              fields: new Map([['orderKey', [key]]]),
            });
          }, 'remote');
        }
      }
    }
    const { store } = engine.context;
    const keysOf = (read: readonly string[]) =>
      read.map(
        (id) =>
          rows.tables
            .readValues(Int32Array.of(rows.tables.getRowRef(id) as number), ['orderKey'])
            .fields.get('orderKey')?.[0],
      );
    const alike = new Set(keysOf(made[0].filter((_, i) => i % 7 === 1).slice(0, 5)));
    expect(alike.size).toBe(1);
    // The last layer is off the stacking order
    rows.transact(() => rows.setLayerOrder([layers[2], layers[0], layers[1]]), 'remote');
    return { instance, draw, store, layers, groups, ids: made.flat(), random };
  }

  for (const seed of [1, 2, 3]) {
    it(`is that of the list of every feature (document ${seed})`, () => {
      const { draw, store, layers, groups, ids, random } = documentOf(seed);
      expect(store.sortInStackingOrder(ids)).toEqual(sorted(store, ids));
      // What is selected
      for (const [type, of] of [
        ['group', groups],
        ['layer', layers],
      ] as const) {
        for (let i = 0; i < 4; i++) {
          const chosen = someOf(random, of, 0.6);
          draw.selection.set(type, chosen);
          const inside = new Set(chosen);
          const expected = listed(store).filter((feature) =>
            inside.has((type === 'group' ? feature.groupId : feature.layerId) as string),
          );
          expect(draw.selection.features()).toEqual(expected);
        }
      }
      // What is moved: into a layer and into a group, kept in the order it had
      for (const to of [{ layerId: layers[0] }, { groupId: groups[1] }]) {
        const some = someOf(random, ids, 0.1);
        const expected = sorted(store, some);
        expect(draw.features.moveMany(some, to as never)).toBe(true);
        expect(sorted(store, some)).toEqual(expected);
        const containers = new Set(
          some.map((id) =>
            JSON.stringify([store.getFeature(id)?.layerId, store.getFeature(id)?.groupId]),
          ),
        );
        expect(containers.size).toBe(1);
      }
      // The groups moved, in the order of their frontmost place
      const alive = groups.filter((id) => store.getGroup(id) && store.countGroupFeatures(id) > 0);
      const some = someOf(random, alive, 0.6);
      const first = new Map<string, number>();
      listed(store).forEach((feature, i) => {
        if (feature.groupId !== undefined && !first.has(feature.groupId)) {
          first.set(feature.groupId, i);
        }
      });
      const onOrder = some.filter((id) => store.getGroup(id)?.layerId !== layers[3]);
      const expected = [...onOrder].sort((a, b) => (first.get(a) ?? 0) - (first.get(b) ?? 0));
      expect(draw.groups.moveMany(onOrder, { layerId: layers[1] } as never)).toBe(
        onOrder.length > 0,
      );
      const items = store.listItemIds(layers[1], 0, store.countItems(layers[1]));
      expect(items.filter((id) => onOrder.includes(id))).toEqual(expected);
    });
  }
});

describe('an extension that asks for everything to be drawn again', () => {
  /** An instance with a plugin, whose context it returns */
  function withPlugin(types: readonly string[]) {
    const instance = instanceOf();
    const { draw } = instance;
    const asked: string[] = [];
    draw.extensions.featureTypes.add({
      type: 'Sign',
      geometry: 'Point',
      bbox(feature: { id: string; geometry: unknown }) {
        asked.push(feature.id);
        const [x, y] = (feature.geometry as { coordinates: [number, number] }).coordinates;
        return [x - extent.half, y - extent.half, x + extent.half, y + extent.half];
      },
      renderer: { onAdd() {}, draw() {}, onRemove() {} },
    } as never);
    const ids = idsOf(
      draw.features.createMany(
        gridPoints(300).map((each, i) => ({ ...each, type: types[i % types.length] })) as never,
      ),
    );
    let context: { invalidate(): void } | null = null;
    draw.extensions.plugins.add({
      name: 'asks',
      onAdd(given: { invalidate(): void }) {
        context = given;
      },
      onRemove() {},
    } as never);
    const far = { minX: 5, minY: -1, maxX: 6, maxY: 1 };
    const find = () => instance.engine.context.spatialIndex.findInBounds(far);
    settle(instance);
    find();
    asked.length = 0;
    return { instance, ids, asked, find, invalidate: () => context?.invalidate() };
  }
  const extent = { half: 0.1 };

  it('makes no feature when no type gives its box, and asks for a frame', () => {
    const { instance, invalidate, find } = withPlugin(['Point']);
    const repaint = vi.spyOn(instance.map.map, 'triggerRepaint');
    const { objectsCreated } = workDuring(instance.counts, () => {
      invalidate();
      find();
    });
    expect(objectsCreated).toBe(0);
    expect(repaint).toHaveBeenCalled();
  });

  it('makes the boxes of the types that give theirs again, and no other feature', () => {
    const { instance, ids, asked, find, invalidate } = withPlugin(['Point', 'Sign', 'Point']);
    expect(find()).toEqual([]);
    const repaint = vi.spyOn(instance.map.map, 'triggerRepaint');
    extent.half = 5.5;
    let found: string[] = [];
    const { objectsCreated } = workDuring(instance.counts, () => {
      invalidate();
      found = find();
    });
    extent.half = 0.1;
    const signs = new Set(ids.filter((_, i) => i % 3 === 1));
    expect(found.length).toBeGreaterThan(0);
    for (const id of found) expect(signs.has(id)).toBe(true);
    expect(asked.length).toBeGreaterThanOrEqual(signs.size);
    for (const id of asked) expect(signs.has(id)).toBe(true);
    // A feature is a few objects: those of the signs, and not of the 300
    expect(objectsCreated).toBeLessThan(asked.length * OBJECTS_PER_FEATURE);
    expect(repaint).toHaveBeenCalled();
  });
});

describe('the automatic names', () => {
  it('go on from the numbers of the names in the document, type by type, also once it is replaced', async () => {
    const instance = instanceOf();
    const { draw } = instance;
    const named = (type: string, name: string) => ({
      type,
      geometry:
        type === 'LineString'
          ? {
              type,
              coordinates: [
                [0, 0],
                [1, 1],
              ],
            }
          : { type: 'Point', coordinates: [0, 0] },
      properties: { name },
    });
    const second = draw.layers.create({ name: 'second' })?.id as string;
    draw.features.createMany([
      named('Point', 'Point 7'),
      named('Point', 'LineString 90'),
      named('LineString', 'LineString 12'),
      { ...named('Point', 'Point 31'), layerId: second },
      { ...named('Point', 'Point'), layerId: second },
      ...gridPoints(500).map(() => named('Point', 'a place')),
    ] as never);
    const { autoNameGenerator, store } = instance.engine.context;
    const list = vi.spyOn(store, 'listFeatures');
    const names = vi.spyOn(store, 'listFeatureNames');
    const { objectsCreated } = workDuring(instance.counts, () => {
      expect(autoNameGenerator.generateName('Point')).toBe('Point 32');
      expect(autoNameGenerator.generateName('LineString')).toBe('LineString 13');
    });
    // The columns of the layers are read, and none of the 500 features is made
    expect(objectsCreated).toBeLessThan(OBJECTS_PER_FEATURE);
    expect(list).not.toHaveBeenCalled();
    // Read once per type
    expect(autoNameGenerator.generateName('Point')).toBe('Point 33');
    expect(names).toHaveBeenCalledTimes(2);

    // The document replaced: the names of the new one, and no number used again
    const other = createCountedInstance();
    instances.push(other);
    other.draw.features.createMany([
      named('Point', 'Point 50'),
      named('Point', 'Point 2'),
    ] as never);
    const data = other.draw.document.toJSON();
    await draw.document.load(data as never);
    expect(autoNameGenerator.generateName('Point')).toBe('Point 51');
    expect(autoNameGenerator.generateName('LineString')).toBe('LineString 14');
    expect(autoNameGenerator.generateName('Circle')).toBe('Circle 1');
  });
});

describe('a provider of companions', () => {
  it('has no feature made but the ones that have companions when a row is written', () => {
    const instance = instanceOf();
    const { draw, engine } = instance;
    const ids = idsOf(
      draw.features.createMany(
        gridPoints(2_500).map((each, i) => ({
          ...each,
          properties: i % 500 === 0 ? { lead: true } : {},
        })) as never,
      ),
    );
    settle(instance);
    draw.extensions.companionProviders.add({
      name: 'lead',
      has: (feature: { properties: Record<string, unknown> }) => feature.properties.lead === true,
      draw() {},
      hitTest: () => null,
    } as never);
    settle(instance);
    const renderer = engine.customLayer.getTableRenderer();
    if (!renderer) throw new Error('the instance draws no rows');
    const drawn: string[] = [];
    renderer.forEachDrawnAtOnce((feature) => drawn.push(feature.id));
    const holders = ids.filter((_, i) => i % 500 === 0);
    expect([...new Set(drawn)].sort()).toEqual([...holders].sort());
    // A row that has none is written, then the chunks are cut again
    const made = renderer.stats.featuresMade;
    const { objectsCreated } = workDuring(instance.counts, () => {
      draw.features.update(ids[1], { geometry: { type: 'Point', coordinates: [0.2, 0.3] } });
      settle(instance);
      renderer.reclassify();
      settle(instance);
    });
    expect(renderer.stats.featuresMade - made).toBeLessThanOrEqual(holders.length);
    expect(objectsCreated).toBeLessThan(60);
    // A row that takes one is drawn at once from then on
    draw.features.update(ids[7], { properties: { lead: true } });
    settle(instance);
    const then = new Set<string>();
    renderer.forEachDrawnAtOnce((feature) => then.add(feature.id));
    expect([...then].sort()).toEqual([...holders, ids[7]].sort());
  });
});

describe('the work after a write of the document', () => {
  /** An instance over `size` features in two layers, drawn, with one feature written */
  function written(size: number) {
    const instance = instanceOf();
    const { draw } = instance;
    const other = draw.layers.create({ name: 'other' })?.id as string;
    const ids = idsOf(
      draw.features.createMany([
        ...gridPoints(size),
        ...gridPoints(20).map((each) => ({ ...each, layerId: other })),
      ] as never),
    );
    settle(instance);
    instance.input.move([0.5, 0.5], { snap: false });
    draw.features.update(ids[3], { geometry: { type: 'Point', coordinates: [0.31, 0.31] } });
    return { instance, draw, ids, other };
  }

  const scenes: Array<[string, (made: ReturnType<typeof written>) => void]> = [
    ['a pointer event', ({ instance }) => instance.input.move([5, 5], { snap: false })],
    ['a frame', ({ instance }) => instance.map.render()],
    ['a read of the feature written', ({ draw, ids }) => void draw.features.get(ids[3])],
  ];
  for (const [name, run] of scenes) {
    it(`makes as many objects whatever the features are (${name})`, () => {
      expectNotProportional(
        (size) => {
          const made = written(size);
          return workDuring(made.instance.counts, () => run(made)).objectsCreated;
        },
        'the objects made',
        { zero: true },
      );
    });
  }

  it('makes one feature to read one that is not kept', () => {
    const { instance, draw, ids } = written(10_000);
    const { objectsCreated } = workDuring(instance.counts, () => draw.features.get(ids[10]));
    expect(objectsCreated).toBeGreaterThan(0);
    expect(objectsCreated).toBeLessThan(OBJECTS_PER_FEATURE);
  });

  it('reads as many rows to move ten features', () => {
    expectNotProportional((size) => {
      const { instance, draw, ids, other } = written(size);
      const moved = ids.slice(20, 30);
      return workDuring(instance.counts, () => {
        expect(draw.features.moveMany(moved, { layerId: other } as never)).toBe(true);
      }).rowsTouched;
    }, 'the rows read');
  });
});
