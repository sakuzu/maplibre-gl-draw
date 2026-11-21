// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for a Store of the application that refuses some writes (a write that returns false
 * changes nothing): the instance tells nothing of a write refused, keeps nothing of it, and the
 * public API returns what it returns when read-only refuses the write
 *
 * The Store of the application is the built-in Store spread into an object of its own, whose
 * writes the test refuses by a rule it switches on once the document is written.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStore } from '../../store/built-in/create-store.js';
import type { Store } from '../../store/built-in/types.js';
import { createMapStub, readRowFeature } from '../../test-utils.js';
import type { Draw } from '../draw.js';
import type { DrawEvents } from '../events.js';
import type { Feature } from '../model.js';
import { createDrawOnEngine } from './create-draw.js';
import { createEngine } from './engine.js';

/** A 1 x 1 PNG, as a data URL */
const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

/** The writes of a Store the test can refuse */
type Write =
  | 'writeRows'
  | 'createRows'
  | 'createLayer'
  | 'updateLayer'
  | 'deleteLayer'
  | 'setLayerOrder'
  | 'createGroup'
  | 'updateGroup'
  | 'deleteGroup'
  | 'createFile'
  | 'deleteFile'
  | 'setMetadata';

const WRITES: readonly Write[] = [
  'writeRows',
  'createRows',
  'createLayer',
  'updateLayer',
  'deleteLayer',
  'setLayerOrder',
  'createGroup',
  'updateGroup',
  'deleteGroup',
  'createFile',
  'deleteFile',
  'setMetadata',
];

/** The events of the document */
const EVENTS: readonly (keyof DrawEvents)[] = [
  'feature.created',
  'feature.updated',
  'feature.deleted',
  'feature.moved',
  'layer.created',
  'layer.updated',
  'layer.deleted',
  'layer.reordered',
  'group.created',
  'group.updated',
  'group.moved',
  'group.deleted',
  'metadata.updated',
  'selection.changed',
  'document.changed',
];

/** Whether a write with these arguments is refused */
type Rule = (...args: unknown[]) => boolean;

/** A Store of the application whose writes are refused by the rules set */
function refusingStore() {
  const base = createStore();
  const rules = new Map<Write, Rule>();
  const store = { ...base } as Store;
  for (const name of WRITES) {
    const write = base[name] as (...args: unknown[]) => boolean;
    (store as unknown as Record<string, unknown>)[name] = (...args: unknown[]) =>
      rules.get(name)?.(...args) ? false : write(...args);
  }
  return { base, store, rules };
}

const draws: Draw[] = [];

afterEach(() => {
  for (const draw of draws.splice(0)) draw.destroy();
  vi.useRealTimers();
});

/** An instance over a refusing Store, with what it told */
function instance() {
  vi.useFakeTimers();
  const host = refusingStore();
  const engine = createEngine(
    createMapStub().map,
    { store: host.store },
    { deferDefaultMode: true },
  );
  const draw = createDrawOnEngine(engine, { store: host.store });
  engine.enterDefaultMode();
  draws.push(draw);
  const told: string[] = [];
  for (const name of EVENTS) draw.on(name, () => told.push(name));
  draw.document.subscribe(() => told.push('subscribe'));
  return { ...host, draw, told };
}

/** A point at a position */
function point(x: number, y: number) {
  return { type: 'Point', geometry: { type: 'Point' as const, coordinates: [x, y] } };
}

/**
 * An instance whose document holds the layers `a` and `b`, the points `p` and `q` in `a`, the
 * point `r` in `b`, the group `g` of `q`, the empty group `e` (written to the Store) and the
 * metadata
 */
function written() {
  const host = instance();
  const { draw, base } = host;
  draw.layers.create({ id: 'a', name: 'A' });
  draw.layers.create({ id: 'b', name: 'B' });
  draw.features.create({ ...point(0, 0), id: 'p', layerId: 'a', properties: { name: 'p' } });
  draw.features.create({ ...point(1, 1), id: 'q', layerId: 'a' });
  draw.features.create({ ...point(2, 2), id: 'r', layerId: 'b' });
  draw.groups.create({ id: 'g', featureIds: ['q'] });
  base.createGroup({
    id: 'e',
    layerId: 'b',
    orderKey: 'zz',
    name: 'Empty',
    visible: true,
    locked: false,
  } as Parameters<Store['createGroup']>[0]);
  draw.metadata.update({ title: 'T' });
  host.told.length = 0;
  return host;
}

/** Whether what the instance reads is what the Store the application wrapped holds */
function expectSameAsStore(draw: Draw, base: Store): void {
  for (const id of ['p', 'q', 'r', 'refused']) {
    expect(draw.features.get(id)).toEqual(readRowFeature(base, id));
  }
  for (const id of ['a', 'b', 'nope']) {
    const layer = draw.layers.get(id);
    const held = base.getLayer(id);
    expect(layer === undefined ? undefined : { ...layer }).toEqual(
      held === undefined ? undefined : { ...held },
    );
  }
  for (const id of ['g', 'e', 'h']) {
    const group = draw.groups.get(id);
    const held = base.getGroup(id);
    expect(group?.name).toBe(held?.name);
    expect(group?.layerId).toBe(held?.layerId);
  }
  expect(draw.metadata.get()).toEqual({ ...base.getMetadata() });
  expect(draw.layers.getOrder()).toEqual([...base.getLayerOrder()]);
}

describe('a write the Store refuses', () => {
  it.each([
    {
      what: 'the attributes written (writeRows)',
      write: 'writeRows' as const,
      rule: (values: { fields: Map<string, unknown> }) => values.fields.has('properties:block'),
      run: (draw: Draw) => draw.features.update('p', { properties: { block: 1 } }),
      refused: null,
    },
    {
      what: 'the shape written (writeRows)',
      write: 'writeRows' as const,
      rule: (values: { geometry?: unknown }) => values.geometry !== undefined,
      run: (draw: Draw) =>
        draw.features.update('p', { geometry: { type: 'Point', coordinates: [5, 5] } }),
      refused: null,
    },
    {
      what: 'a deletion (writeRows)',
      write: 'writeRows' as const,
      rule: (values: { deleted?: unknown }) => values.deleted !== undefined,
      run: (draw: Draw) => draw.features.delete('p'),
      refused: false,
    },
    {
      what: 'a feature created (createRows, refused by its ID)',
      write: 'createRows' as const,
      rule: (rows: { ids: readonly string[] }) => rows.ids.includes('refused'),
      run: (draw: Draw) => draw.features.create({ ...point(3, 3), id: 'refused', layerId: 'a' }),
      refused: null,
    },
    {
      what: 'a layer created (createLayer)',
      write: 'createLayer' as const,
      rule: (layer: { id: string }) => layer.id === 'nope',
      run: (draw: Draw) => draw.layers.create({ id: 'nope', name: 'Nope' }),
      refused: null,
    },
    {
      what: 'a group created (createGroup)',
      write: 'createGroup' as const,
      rule: () => true,
      run: (draw: Draw) => draw.groups.create({ id: 'h', featureIds: ['p'] }),
      refused: null,
    },
    {
      what: 'a layer updated (updateLayer)',
      write: 'updateLayer' as const,
      rule: () => true,
      run: (draw: Draw) => draw.layers.update('a', { name: 'Renamed' }),
      refused: null,
    },
    {
      what: 'a layer deleted (deleteLayer)',
      write: 'deleteLayer' as const,
      rule: () => true,
      run: (draw: Draw) => draw.layers.delete('b'),
      refused: null,
    },
    {
      what: 'a group updated (updateGroup)',
      write: 'updateGroup' as const,
      rule: () => true,
      run: (draw: Draw) => draw.groups.update('g', { name: 'Renamed' }),
      refused: null,
    },
    {
      what: 'a group deleted (deleteGroup)',
      write: 'deleteGroup' as const,
      rule: () => true,
      run: (draw: Draw) => draw.groups.delete('e'),
      refused: false,
    },
    {
      what: 'the stacking order written (setLayerOrder)',
      write: 'setLayerOrder' as const,
      rule: () => true,
      run: (draw: Draw) => {
        const order = [...draw.layers.getOrder()];
        return draw.layers.reorder([order[order.length - 1], ...order.slice(0, -1)]);
      },
      refused: false,
    },
    {
      what: 'the metadata written (setMetadata)',
      write: 'setMetadata' as const,
      rule: () => true,
      run: (draw: Draw) => draw.metadata.update({ title: 'Refused' }),
      refused: null,
    },
  ])(
    '$what: returns what read-only returns, tells nothing and keeps nothing',
    async ({ write, rule, run, refused }) => {
      const { draw, base, rules, told } = written();
      draw.selection.set('feature', ['p']);
      told.length = 0;
      rules.set(write, rule as Rule);
      let result: unknown;
      expect(() => {
        result = run(draw);
      }).not.toThrow();
      // An edit written in parts gives its result once its last part is written
      if (result instanceof Promise) {
        const pending = result;
        await vi.runAllTimersAsync();
        result = await pending;
      }
      expect(result).toBe(refused);
      expect(told).toEqual([]);
      expect(draw.selection.get()).toEqual({ type: 'feature', ids: ['p'] });
      expectSameAsStore(draw, base);
      // Read-only refuses the same write with the same value
      rules.clear();
      draw.setReadOnly(true);
      let again: unknown = run(draw);
      if (again instanceof Promise) again = await again;
      expect(again).toBe(refused);
      draw.setReadOnly(false);
    },
  );

  it.each([
    {
      what: 'a file created (createFile)',
      write: 'createFile' as const,
      // No layer: the file is the first thing the load writes
      document: (draw: Draw) => ({
        ...draw.document.toJSON(),
        layers: [],
        files: { f1: { id: 'f1', mimeType: 'image/png', dataURL: PNG } },
      }),
    },
    {
      what: 'a file deleted (deleteFile)',
      write: 'deleteFile' as const,
      document: (draw: Draw) => draw.document.toJSON(),
      before: (base: Store) => base.createFile({ id: 'f0', mimeType: 'image/png', dataURL: PNG }),
    },
  ])(
    '$what by a load: returns what read-only returns, tells nothing and keeps nothing',
    async ({ write, document, before }) => {
      const { draw, base, rules, told } = instance();
      before?.(base);
      const files = base.listFiles();
      const data = document(draw);
      const { created: _created, modified: _modified, ...json } = draw.document.toJSON();
      told.length = 0;
      rules.set(write, () => true);
      await expect(draw.document.load(data)).resolves.toBeNull();
      expect(told).toEqual([]);
      expect(base.listFiles()).toEqual(files);
      expect(draw.document.toJSON()).toEqual({
        ...json,
        created: expect.any(String),
        modified: expect.any(String),
      });
      rules.clear();
      draw.setReadOnly(true);
      await expect(draw.document.load(data)).resolves.toBeNull();
    },
  );

  it('is not read back once the features made are let go of', () => {
    const { draw, base, rules } = written();
    const before = draw.features.get('p');
    rules.set('writeRows', (values) =>
      (values as { fields: Map<string, unknown> }).fields.has('properties:block'),
    );
    expect(draw.features.update('p', { properties: { block: 1 } })).toBeNull();
    expect(draw.features.get('p')).toEqual(before);
    const made = draw.features.createMany(
      Array.from({ length: 1_100 }, (_, i) => point(i * 1e-4, 0)),
    ) as Feature[];
    for (const feature of made) draw.features.get(feature.id);
    expect(draw.features.get('p')).toEqual(readRowFeature(base, 'p'));
    expect(draw.features.get('p')?.properties).toEqual({ name: 'p' });
  });

  it('stops a write of many layers at the layer refused: the rows before it are told', () => {
    const { draw, base, rules, told } = written();
    const created: string[] = [];
    draw.on('feature.created', ({ feature }) => created.push(feature.id));
    const changed: string[][] = [];
    draw.on('document.changed', (change) => changed.push([...change.features.created.iterate()]));
    rules.set(
      'createRows',
      (rows) =>
        (rows as { fields: Map<string, unknown[]> }).fields.get('parent')?.includes('b') === true,
    );
    const result = draw.features.createMany([
      { ...point(4, 4), id: 'in-a', layerId: 'a' },
      { ...point(5, 5), id: 'in-b', layerId: 'b' },
      { ...point(6, 6), id: 'in-a-too', layerId: 'a' },
    ]);
    expect(result).toBeNull();
    expect(readRowFeature(base, 'in-a')).toBeDefined();
    expect(readRowFeature(base, 'in-a-too')).toBeDefined();
    expect(readRowFeature(base, 'in-b')).toBeUndefined();
    expect(draw.features.get('in-b')).toBeUndefined();
    expect(created).toEqual(['in-a', 'in-a-too']);
    expect(changed).toEqual([['in-a', 'in-a-too']]);
    expect(told.filter((name) => name === 'document.changed')).toHaveLength(1);
  });

  it('stops a group created at the places of its features: the group alone is told', () => {
    const { draw, base, rules, told } = written();
    rules.set('writeRows', (values) =>
      (values as { fields: Map<string, unknown> }).fields.has('parent'),
    );
    expect(draw.groups.create({ id: 'h', featureIds: ['p'] })).toBeNull();
    expect(base.getGroup('h')).toBeDefined();
    expect(told).toEqual(['group.created', 'document.changed', 'subscribe']);
    expect(draw.features.get('p')?.groupId).toBeUndefined();
    expectSameAsStore(draw, base);
  });

  it('stops a write of many features at the one refused: the ones before it are told', () => {
    const { draw, base, rules } = written();
    const updated: string[] = [];
    draw.on('feature.updated', ({ feature }) => updated.push(feature.id));
    const refs = new Set([base.tables.getRowRef('r')]);
    rules.set('writeRows', (values) =>
      [...(values as { rows: Int32Array }).rows].some((ref) => refs.has(ref)),
    );
    const result = draw.features.updateMany([
      { id: 'p', patch: { properties: { n: 1 } } },
      { id: 'r', patch: { properties: { n: 2 } } },
      { id: 'q', patch: { properties: { n: 3 } } },
    ]);
    expect(result).toBeNull();
    expect(updated).toEqual(['p']);
    expect(readRowFeature(base, 'p')?.properties).toEqual({ name: 'p', n: 1 });
    expect(readRowFeature(base, 'r')?.properties).toEqual({});
    expect(readRowFeature(base, 'q')?.properties).toEqual({});
    expectSameAsStore(draw, base);
  });
});
