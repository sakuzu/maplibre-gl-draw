// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `features.scan`: many features read without making them
 *
 * - Every feature comes, in stacking order from the back, as a row whose fields are those of its
 *   feature; `toFeature` makes the feature, the same as `features.get` gives
 * - A query keeps the features that match it
 * - The rows of a Store of rows are read where they are: 100,000 of them make no feature
 * - While a commit made over several tasks is under way, the document before it is read
 * - A transaction scans its document with its writes over it
 * - A wrong input, a signal aborted and what `visit` throws reject the promise
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { DrawStore } from '../../store/draw-store.js';
import { MemoryStore } from '../../store/memory.js';
import type { Store } from '../../store/store.js';
import { createTableStore, TableContractStore } from '../../store/table-memory.js';
import { writesOf } from '../../test-support/writes.js';
import { createMapStub, internalsOf } from '../../test-utils.js';
import { createDraw, type Draw } from '../draw.js';
import { DrawError } from '../errors.js';
import type { FeatureRow } from '../model.js';
import type { FeatureTables } from '../tables.js';

const draws: Draw[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const draw of draws.splice(0)) draw.destroy();
});

function layer(id: string, rows: boolean) {
  return {
    id,
    name: id,
    visible: true,
    locked: false,
    opacity: 1,
    ...(rows ? { kind: 'table' as const } : { items: [] }),
    styleRule: undefined,
    metadata: undefined,
  };
}

/** An instance on a Store with the layers `l` and `m` */
function open(store: Store, rows: boolean): Draw {
  store.createLayer(layer('l', rows) as never);
  store.createLayer(layer('m', rows) as never);
  const draw = createDraw(createMapStub().map, { store: store as never, initDefaultLayer: false });
  draws.push(draw);
  return draw;
}

/** What a row reads, as plain values */
function read(row: FeatureRow) {
  return {
    id: row.id,
    featureType: row.featureType,
    layerId: row.layerId,
    groupId: row.groupId,
    visible: row.visible,
    locked: row.locked,
    bbox: row.bbox,
    name: row.property('name'),
  };
}

async function scanned(draw: Draw, query?: object): Promise<ReturnType<typeof read>[]> {
  const out: ReturnType<typeof read>[] = [];
  await draw.features.scan((row) => out.push(read(row)), query ? { query } : undefined);
  return out;
}

describe('features.scan', () => {
  for (const rows of [false, true]) {
    const kind = rows ? 'a Store of rows' : 'a Store of objects';

    it(`reads every feature in stacking order, as its fields are (${kind})`, async () => {
      const draw = open(rows ? createTableStore().store : new MemoryStore(), rows);
      const writes = writesOf(draw);
      writes.features.create({
        id: 'a',
        type: 'Point',
        geometry: { type: 'Point', coordinates: [1, 2] },
        layerId: 'l',
        properties: { name: 'first' },
      });
      writes.features.create({
        id: 'b',
        type: 'LineString',
        geometry: {
          type: 'LineString',
          coordinates: [
            [0, 0],
            [2, 1],
          ],
        },
        layerId: 'm',
        locked: true,
        visible: false,
      });
      const group = writes.groups.create({ name: 'g', layerId: 'l', members: ['a'] });
      expect(await scanned(draw)).toEqual([
        {
          id: 'a',
          featureType: 'Point',
          layerId: 'l',
          groupId: group?.id ?? null,
          visible: true,
          locked: false,
          bbox: [1, 2, 1, 2],
          name: 'first',
        },
        {
          id: 'b',
          featureType: 'LineString',
          layerId: 'm',
          groupId: null,
          visible: false,
          locked: true,
          bbox: [0, 0, 2, 1],
          name: undefined,
        },
      ]);
      const made: unknown[] = [];
      await draw.features.scan((row) => made.push(row.toFeature()));
      expect(made).toEqual([draw.features.get('a'), draw.features.get('b')]);
      // A query keeps what matches it
      expect((await scanned(draw, { layerId: 'm' })).map((row) => row.id)).toEqual(['b']);
      expect((await scanned(draw, { locked: false })).map((row) => row.id)).toEqual(['a']);
    });
  }

  for (const rows of [false, true]) {
    const kind = rows ? 'a Store of rows' : 'a Store of objects';

    it(`reads a key of the library as the feature holds it, making no feature (${kind})`, async () => {
      const { store, tables } = rows
        ? (() => {
            const made = createTableStore();
            return { store: made.store as Store, tables: made.store.tables };
          })()
        : { store: new MemoryStore() as Store, tables: undefined };
      const draw = open(store, rows);
      const writes = writesOf(draw);
      writes.features.create({
        id: 'a',
        type: 'Point',
        geometry: { type: 'Point', coordinates: [1, 2] },
        layerId: 'l',
        style: { pointColor: '#ff0000' },
        locked: true,
        properties: { name: 'first', 'maplibre-gl-draw:rotation': 30 },
      });
      writes.features.create({
        id: 'b',
        type: 'LineString',
        geometry: {
          type: 'LineString',
          coordinates: [
            [0, 0],
            [2, 1],
          ],
        },
        layerId: 'm',
        visible: false,
      });
      writes.features.create({
        id: 'c',
        type: 'Circle',
        geometry: { type: 'Point', coordinates: [3, 3] },
        layerId: 'l',
        properties: { 'maplibre-gl-draw:radiusMeters': 500 },
      });
      writes.groups.create({ name: 'g', layerId: 'l', members: ['c'] });
      const keys = [
        'maplibre-gl-draw:layerId',
        'maplibre-gl-draw:groupId',
        'maplibre-gl-draw:featureType',
        'maplibre-gl-draw:style',
        'maplibre-gl-draw:visible',
        'maplibre-gl-draw:locked',
        'maplibre-gl-draw:rotation',
        'maplibre-gl-draw:radiusMeters',
        'name',
      ] as const;
      const readKeys = (row: FeatureRow) =>
        Object.fromEntries(keys.map((key) => [key, row.property(key as never)]));
      const made = tables
        ? vi.spyOn(internalsOf(tables as FeatureTables).featureCache, 'featureOf')
        : undefined;
      const getFeature = vi.spyOn(store, 'getFeature');
      const read: Record<string, Record<string, unknown>> = {};
      await draw.features.scan((row) => {
        read[row.id] = readKeys(row);
      });
      // A Store of rows reads them where they are
      if (rows) {
        expect(made).not.toHaveBeenCalled();
        expect(getFeature).not.toHaveBeenCalled();
      }
      const asFeatures = Object.fromEntries(
        ['a', 'b', 'c'].map((id) => {
          const properties = (draw.features.get(id)?.properties ?? {}) as Record<string, unknown>;
          return [id, Object.fromEntries(keys.map((key) => [key, properties[key]]))];
        }),
      );
      expect(read).toEqual(asFeatures);
      expect(read.a).toMatchObject({
        'maplibre-gl-draw:layerId': 'l',
        'maplibre-gl-draw:style': { pointColor: '#ff0000' },
        'maplibre-gl-draw:locked': true,
        'maplibre-gl-draw:rotation': 30,
      });
      expect(read.b).toMatchObject({ 'maplibre-gl-draw:visible': false });
      expect(read.c).toMatchObject({
        'maplibre-gl-draw:featureType': 'Circle',
        'maplibre-gl-draw:radiusMeters': 500,
      });
      expect(read.c?.['maplibre-gl-draw:groupId']).toEqual(expect.any(String));
    });
  }

  it('reads 100,000 rows where they are, making no feature', async () => {
    const { store } = createTableStore();
    const draw = open(store, true);
    writesOf(draw).features.createMany(
      Array.from({ length: 100_000 }, (_, i) => ({
        id: `r${i}`,
        type: 'Point',
        geometry: {
          type: 'Point',
          coordinates: [(i % 1000) * 0.001, Math.floor(i / 1000) * 0.001],
        },
        layerId: 'l',
        properties: { n: i },
      })),
    );
    const cache = internalsOf(store.tables as FeatureTables).featureCache;
    const made = vi.spyOn(cache, 'featureOf');
    const getFeature = vi.spyOn(store, 'getFeature');
    let count = 0;
    let sum = 0;
    let last = '';
    await draw.features.scan((row) => {
      count++;
      sum += row.property('n') as number;
      last = row.id;
    });
    expect(count).toBe(100_000);
    expect(sum).toBe((99_999 * 100_000) / 2);
    expect(last).toBe('r99999');
    expect(made).not.toHaveBeenCalled();
    expect(getFeature).not.toHaveBeenCalled();
  });

  it('reads the document before a commit made over several tasks, until its last step', async () => {
    const store = new DrawStore(new TableContractStore({}), { selectionIdsLimit: 2 });
    const draw = open(store as never, true);
    writesOf(draw).features.createMany(
      Array.from({ length: 1000 }, (_, i) => ({
        id: `r${i}`,
        type: 'Point',
        geometry: { type: 'Point', coordinates: [i * 0.001, 1] },
        layerId: 'l',
        properties: {},
      })),
    );
    draw.selection.setAll();
    // Every part of the write spends the time of a step
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => {
      now += 30;
      return now;
    });
    let firstStep = (): void => {};
    const stepped = new Promise<void>((resolve) => {
      firstStep = resolve;
    });
    const target = draw.selection.target;
    const write = draw.write((tx) => tx.features.update(target, { properties: { name: 'red' } }), {
      onProgress: () => firstStep(),
    });
    await stepped;
    expect(store.slicedWritePending).toBe(true);
    const names = new Set<unknown>();
    let count = 0;
    await draw.features.scan((row) => {
      names.add(row.property('name'));
      count++;
    });
    expect(count).toBe(1000);
    expect([...names]).toEqual([undefined]);
    // Read without finishing it
    expect(store.slicedWritePending).toBe(true);
    await write;
    names.clear();
    await draw.features.scan((row) => void names.add(row.property('name')));
    expect([...names]).toEqual(['red']);
  });

  it('reads in a transaction its document with its writes over it', async () => {
    const draw = open(createTableStore().store, true);
    writesOf(draw).features.create({
      id: 'a',
      type: 'Point',
      geometry: { type: 'Point', coordinates: [0, 0] },
      layerId: 'l',
    });
    const ids = await draw.write(async (tx) => {
      await tx.features.create({
        type: 'Feature',
        id: 'b',
        geometry: { type: 'Point', coordinates: [1, 1] },
        properties: { 'maplibre-gl-draw:layerId': 'l' },
      });
      await tx.features.update('a', { properties: { name: 'changed' } });
      const read: string[] = [];
      await tx.features.scan((row) => read.push(`${row.id}:${String(row.property('name'))}`));
      return read;
    });
    expect(ids).toEqual(['a:changed', 'b:undefined']);
  });

  it('rejects a wrong input, a signal aborted and what visit throws', async () => {
    const draw = open(new MemoryStore(), false);
    writesOf(draw).features.create({
      id: 'a',
      type: 'Point',
      geometry: { type: 'Point', coordinates: [0, 0] },
      layerId: 'l',
    });
    const codeOf = (promise: Promise<unknown>) =>
      promise.then(
        () => null,
        (error) => (error instanceof DrawError ? error.code : String(error)),
      );
    expect(await codeOf(draw.features.scan(null as never))).toBe('invalidInput');
    expect(await codeOf(draw.features.scan(() => {}, { limit: 1 } as never))).toBe('invalidInput');
    expect(await codeOf(draw.features.scan(() => {}, { query: { color: 1 } as never }))).toBe(
      'invalidInput',
    );
    const stopped = new AbortController();
    stopped.abort();
    expect(await codeOf(draw.features.scan(() => {}, { signal: stopped.signal }))).toBe('aborted');
    const midway = new AbortController();
    expect(await codeOf(draw.features.scan(() => midway.abort(), { signal: midway.signal }))).toBe(
      'aborted',
    );
    expect(
      await codeOf(
        draw.features.scan(() => {
          throw new Error('visit');
        }),
      ),
    ).toBe('Error: visit');
    const progress: unknown[] = [];
    await draw.features.scan(() => {}, { onProgress: (p) => progress.push(p) });
    expect(progress).toEqual([{ phase: 'read', done: 1, total: 1 }]);
  });
});
