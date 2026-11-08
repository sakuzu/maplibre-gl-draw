// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the events of the draw instance and the observables of its values: `change` once per
 * commit with the IDs of what it changed, in the same shape over a Store of objects and a Store of
 * rows, and the feature before it; the observables of the selection, the vertex selection, the
 * mode, what is hidden here and the options; on, off and once; and the signals of the engine under
 * their names
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DragNormalizedEvent } from '../../dispatcher/types.js';
import type { EngineModeContext } from '../../modes/handler.js';
import { SelectModeDragHandler } from '../../modes/select/drag-handler.js';
import { MemoryStore } from '../../store/memory.js';
import type { Store } from '../../store/store.js';
import { createTableStore } from '../../store/table-memory.js';
import { createMapStub, createSyntheticInput } from '../../test-utils.js';
import type { HandleHitResult } from '../../view/ui/handle-test.js';
import { computeSelectionBoundingBox, getSelectedFeatureIds } from '../../view/ui/helper.js';
import type { Draw } from '../draw.js';
import { createDraw } from '../draw.js';
import { DrawError } from '../errors.js';
import type { Change, DrawEvents, Observable } from '../events.js';
import type { Feature, Group } from '../model.js';
import type { Sketch } from '../sketches.js';
import { createDrawOnEngine } from './create-draw.js';
import type { Engine } from './engine.js';
import { createEngine } from './engine.js';
import { createEventHub, observe } from './events.js';

/** The selected features, read from the Store */
const selectedOf = (store: Store) =>
  getSelectedFeatureIds(store).flatMap((id) => store.getFeature(id) ?? []);

type Recorded = { [K in keyof DrawEvents]: [K, DrawEvents[K]] }[keyof DrawEvents];

const ALL_EVENTS: ReadonlyArray<keyof DrawEvents> = [
  'change',
  'document.loaded',
  'drag.started',
  'drag.ended',
  'readOnly.changed',
  'interactionLock.changed',
  'snap.changed',
  'map.clicked',
  'dataset.clicked',
  'image.requested',
  'layerStack.changed',
  'error',
];

/** Records every event of an instance, in the order they arrive */
function record(target: Pick<Draw, 'on'>): Recorded[] {
  const events: Recorded[] = [];
  for (const name of ALL_EVENTS) {
    target.on(name, (payload) => events.push([name, payload] as Recorded));
  }
  return events;
}

const names = (events: Recorded[]) => events.map(([name]) => name);
const payloadsOf = <K extends keyof DrawEvents>(events: Recorded[], name: K): DrawEvents[K][] =>
  events.filter(([n]) => n === name).map(([, payload]) => payload as DrawEvents[K]);
const changesOf = (events: Recorded[]): Change[] => payloadsOf(events, 'change');

/** The values an observable told, the one it holds when subscribed first */
function told<T>(observable: Observable<T>): T[] {
  const values: T[] = [];
  observable.subscribe((value) => values.push(value));
  return values;
}

const NONE = { created: [], updated: [], deleted: [], placed: [] };

const pointInput = (lng = 0, lat = 0) => ({
  type: 'Point' as const,
  geometry: { type: 'Point' as const, coordinates: [lng, lat] },
});

const lineInput = () => ({
  type: 'LineString' as const,
  geometry: {
    type: 'LineString' as const,
    coordinates: [
      [0, 0],
      [1, 1],
    ],
  },
});

let store: MemoryStore;
let draw: Draw;
let events: Recorded[];

beforeEach(() => {
  vi.useFakeTimers();
  store = new MemoryStore();
  draw = createDraw(createMapStub().map, { store });
  events = record(draw);
});

afterEach(() => {
  draw.destroy();
  vi.useRealTimers();
});

describe('change', () => {
  it('tells the IDs of the features a commit created, updated and deleted, once per commit, with its source', () => {
    const created = draw.features.create(pointInput()) as Feature;
    draw.features.update(created.id, { properties: { name: 'A' } });
    draw.features.delete(created.id);

    const changes = changesOf(events);
    expect(changes).toHaveLength(3);
    expect(changes.map((change) => change.features)).toEqual([
      { ...NONE, created: [created.id] },
      { ...NONE, updated: [created.id] },
      { ...NONE, deleted: [created.id] },
    ]);
    for (const change of changes) {
      expect(change.source).toBe('local');
      expect(change.layers).toEqual(NONE);
      expect(change.groups).toEqual(NONE);
      expect(change.document).toBe(false);
    }
  });

  it('arrives once per transaction, last, with its source, whatever it changed', () => {
    draw.transact(
      () => {
        draw.features.create(pointInput());
        draw.features.create(pointInput(1, 1));
        draw.layers.create({ name: 'Second' });
        draw.metadata.update({ title: 'Map' });
      },
      { source: 'script' },
    );
    const changes = changesOf(events);
    expect(changes).toHaveLength(1);
    expect(names(events)[events.length - 1]).toBe('change');
    expect(changes[0].source).toBe('script');
    expect(changes[0].features.created).toHaveLength(2);
    expect(changes[0].layers.created).toHaveLength(1);
    expect(changes[0].document).toBe(true);
  });

  it('gives the feature before the commit for one updated or deleted, and none for one created', () => {
    const created = draw.features.create(pointInput()) as Feature;
    const before: Array<Feature | undefined> = [];
    draw.on('change', (change) => {
      for (const id of [...change.features.created, ...change.features.updated]) {
        before.push(change.previous(id));
      }
      for (const id of change.features.deleted) before.push(change.previous(id));
    });
    const updated = draw.features.update(created.id, { properties: { name: 'A' } }) as Feature;
    draw.features.delete(created.id);
    draw.features.create(pointInput(1, 1));
    expect(before).toEqual([created, updated, undefined]);
  });

  it('tells a feature put in another place of its layer as placed, and one put into another layer or group as updated too', () => {
    const first = draw.layers.getActive()?.id as string;
    const second = draw.layers.create({ name: 'Second' })?.id as string;
    const a = draw.features.create(pointInput()) as Feature;
    const b = draw.features.create(pointInput(1, 1)) as Feature;
    const c = draw.features.create(pointInput(2, 2)) as Feature;
    events.length = 0;

    draw.features.move(c.id, { layerId: first, index: 0 });
    draw.features.move(a.id, { layerId: second });
    const group = draw.groups.create({ featureIds: [b.id] }) as Group;

    const [inLayer, intoLayer, intoGroup] = changesOf(events);
    // A move within a layer changes no field of the feature
    expect(inLayer.features).toEqual({ ...NONE, placed: [c.id] });
    expect(intoLayer.features).toEqual({ ...NONE, updated: [a.id], placed: [a.id] });
    expect(intoGroup.features.updated).toEqual([b.id]);
    expect(intoGroup.features.placed).toEqual([b.id]);
    expect(intoGroup.groups.created).toEqual([group.id]);
    // The group created is not also placed
    expect(intoGroup.groups.placed).toEqual([]);
  });

  it('tells the layers created, updated, deleted, and those whose place in the order changed', () => {
    const first = draw.layers.getActive()?.id as string;
    const second = draw.layers.create({ name: 'Roads' })?.id as string;
    const third = draw.layers.create({ name: 'Rivers' })?.id as string;
    draw.layers.update(second, { name: 'Streets' });
    events.length = 0;
    // The third layer goes to the back: the two others keep their order
    draw.layers.reorder([third, first, second]);
    draw.layers.delete(second);

    const [reorder, deletion] = changesOf(events);
    expect(reorder.layers).toEqual({ ...NONE, placed: [third] });
    expect(deletion.layers.deleted).toEqual([second]);
    // The layers after the one deleted are not placed: their order among them is the same
    expect(deletion.layers.placed).toEqual([]);
  });

  it('tells the layers and the groups updated for a field of their own, not for their items alone', () => {
    const first = draw.layers.getActive()?.id as string;
    const second = draw.layers.create({ name: 'Second' })?.id as string;
    draw.features.create(pointInput());
    const b = draw.features.create(pointInput(1, 1)) as Feature;
    const c = draw.features.create(pointInput(2, 2)) as Feature;
    const group = draw.groups.create({ featureIds: [c.id], name: 'G' }) as Group;
    events.length = 0;
    draw.features.move(b.id, { groupId: group.id });
    draw.groups.move(group.id, { layerId: first, index: 0 });
    expect(changesOf(events)).toHaveLength(2);
    for (const change of changesOf(events)) {
      expect(change.layers.updated).toEqual([]);
      expect(change.groups.updated).toEqual([]);
    }
    expect(changesOf(events)[1].groups.placed).toEqual([group.id]);

    events.length = 0;
    draw.layers.update(second, { name: 'Renamed' });
    draw.groups.move(group.id, { layerId: second });
    const [renamed, moved] = changesOf(events);
    expect(renamed.layers.updated).toEqual([second]);
    expect(moved.groups.updated).toEqual([group.id]);
    expect(moved.groups.placed).toEqual([group.id]);
  });

  it('tells the groups created, updated and deleted', () => {
    const a = draw.features.create(pointInput()) as Feature;
    const group = draw.groups.create({ featureIds: [a.id], name: 'G' }) as Group;
    draw.groups.update(group.id, { name: 'H' });
    draw.groups.delete(group.id);
    const [created, updated, deleted] = changesOf(events).slice(-3);
    expect(created.groups.created).toEqual([group.id]);
    expect(updated.groups.updated).toEqual([group.id]);
    expect(deleted.groups.deleted).toEqual([group.id]);
  });

  it('tells a change of the metadata or of the files as a change of the document itself', () => {
    draw.metadata.update({ title: 'Map' });
    store.createFile({ id: 'f1', mimeType: 'image/png', dataURL: 'data:image/png;base64,' });
    store.deleteFile('f1');
    const changes = changesOf(events);
    expect(changes).toHaveLength(3);
    for (const change of changes) {
      expect(change.document).toBe(true);
      expect(change.features).toEqual(NONE);
    }
  });

  it('does not fire for a change of the selection, the mode or the drawing state alone', () => {
    const a = draw.features.create(pointInput()) as Feature;
    const received: Change[] = [];
    draw.on('change', (change) => received.push(change));
    draw.selection.set('feature', [a.id]);
    draw.selection.clear();
    draw.setMode('draw_line');
    draw.drawing.addVertex([0, 0]);
    draw.drawing.moveTo([1, 1]);
    draw.setMode('select');
    draw.hidden.add(a.id);
    draw.hidden.remove(a.id);
    draw.setReadOnly(true);
    draw.setReadOnly(false);
    draw.setInteractionLocked(true);
    draw.setInteractionLocked(false);
    expect(received).toEqual([]);
  });

  it('document.loaded carries the result, and the features of the load arrive in one change', async () => {
    const result = await draw.document.load({
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [1, 2] } },
      ],
    });
    expect(payloadsOf(events, 'document.loaded')).toEqual([{ result, source: 'load' }]);
    const changes = changesOf(events);
    expect(changes[changes.length - 1]?.source).toBe('load');
    expect(changes[changes.length - 1]?.features.created).toEqual(result?.featureIds);
  });

  it('has the same shape over a Store of rows: the rows written by the IDs of their features', () => {
    const rows = createTableStore().store;
    rows.createLayer({
      id: 'rows',
      name: 'rows',
      visible: true,
      locked: false,
      opacity: 1,
      kind: 'table',
      styleRule: undefined,
      metadata: undefined,
    });
    const other = createDraw(createMapStub().map, { store: rows, initDefaultLayer: false });
    const seen = record(other);
    const before: Array<Feature | undefined> = [];
    other.on('change', (change) => {
      for (const id of [...change.features.updated, ...change.features.deleted]) {
        before.push(change.previous(id));
      }
    });
    const a = other.features.create({ ...pointInput(), layerId: 'rows' }) as Feature;
    const b = other.features.create({ ...pointInput(1, 1), layerId: 'rows' }) as Feature;
    const named = other.features.update(a.id, { properties: { name: 'A' } }) as Feature;
    other.features.move(b.id, { layerId: 'rows', below: null, above: a.id });
    other.features.delete(a.id);

    const changes = changesOf(seen);
    expect(changes.map((change) => change.features)).toEqual([
      { ...NONE, created: [a.id] },
      { ...NONE, created: [b.id] },
      { ...NONE, updated: [a.id] },
      { ...NONE, placed: [b.id] },
      { ...NONE, deleted: [a.id] },
    ]);
    expect(changes[2].rows?.layers.get('rows')?.updated).toHaveLength(1);
    // The feature before a write of this client, and the one deleted as it was
    expect(before[0]).toMatchObject({ id: a.id, properties: {} });
    expect(before[0]?.properties).not.toHaveProperty('name');
    expect(before[1]).toMatchObject({ id: named.id, properties: { name: 'A' } });
    other.destroy();
  });

  it('is refused for a name that is not an event of draw.on', () => {
    for (const name of ['document.changed', 'feature.created', 'selection.changed', 42]) {
      expect(() => draw.on(name as never, () => {})).toThrow(DrawError);
      expect(() => draw.once(name as never, () => {})).toThrow(DrawError);
    }
  });
});

describe('the observables of the state of this client', () => {
  it('the selection holds its value and tells each change of it', () => {
    const a = draw.features.create(pointInput()) as Feature;
    const values = told(draw.selection);
    draw.selection.set('feature', [a.id]);
    draw.selection.clear();
    const none = { type: 'feature', count: 0, ids: [], layerIds: [], bbox: null };
    const one = {
      type: 'feature',
      count: 1,
      ids: [a.id],
      layerIds: [a.layerId],
      bbox: [0, 0, 0, 0],
    };
    expect(values).toEqual([none, one, none]);
    expect(draw.selection.value).toEqual(none);
  });

  it('the vertex selection tells the vertices selected', () => {
    const line = draw.features.create(lineInput()) as Feature;
    draw.selection.set('feature', [line.id]);
    const values = told(draw.vertexSelection);
    draw.vertexSelection.set(line.id, [{ ring: 0, index: 1 }]);
    draw.vertexSelection.set(line.id, [{ ring: 0, index: 1 }]);
    draw.vertexSelection.clear();
    expect(values).toHaveLength(3);
    expect(values[0]).toBeNull();
    expect(values[1]).toMatchObject({ featureId: line.id, vertices: [{ ring: 0, index: 1 }] });
    expect(values[2]).toBeNull();
  });

  it('the IDs hidden here are told as the whole set after each change', () => {
    const a = draw.features.create(pointInput()) as Feature;
    const b = draw.features.create(pointInput(1, 1)) as Feature;
    const values = told(draw.hidden.hiddenIds);
    draw.hidden.add(a.id);
    draw.hidden.add(b.id);
    draw.hidden.add(b.id);
    draw.features.delete(a.id);
    draw.hidden.clear();
    expect(values.map((ids) => [...ids])).toEqual([[], [a.id], [a.id, b.id], [b.id], []]);
    expect(draw.hidden.hiddenIds.value.size).toBe(0);
  });

  it('readOnly.changed and interactionLock.changed fire when the value changes', () => {
    draw.setReadOnly(true);
    draw.setReadOnly(true);
    draw.setReadOnly(false);
    draw.setInteractionLocked(true);
    draw.setInteractionLocked(true);
    draw.setInteractionLocked(false);
    expect(payloadsOf(events, 'readOnly.changed')).toEqual([
      { readOnly: true },
      { readOnly: false },
    ]);
    expect(payloadsOf(events, 'interactionLock.changed')).toEqual([
      { locked: true },
      { locked: false },
    ]);
  });

  it('the options are told after an update that changed them, and not for one that changes nothing', () => {
    const before = draw.options.get();
    expect(draw.options.value).toEqual(before);
    const formatter = (typeName: string, n: number) => `${typeName} ${n}`;
    const values = told(draw.options);
    draw.options.update({ snapping: { tolerancePx: 25 }, scaleWithZoom: false });
    draw.options.update({ autoName: { formatter } });
    const { snapping, clickTolerance } = draw.options.get();
    draw.options.update({});
    draw.options.update({ snapping: { enabled: snapping?.enabled }, clickTolerance });
    draw.options.update({ autoName: { formatter } });
    expect(() => draw.options.update({ clickTolerance: 'far' as never })).toThrow(DrawError);
    expect(values).toHaveLength(3);
    expect(values[1].snapping?.tolerancePx).toBe(25);
    expect(values[1].scaleWithZoom).toBe(false);
    // A client state: no change of the document
    expect(events).toEqual([]);
  });

  it('the mode is told at each change, and a subscriber stops once the function it was given is called', () => {
    const values = told(draw.mode);
    const heard: string[] = [];
    const stop = draw.mode.subscribe((mode) => heard.push(mode));
    draw.setMode('draw_polygon');
    stop();
    draw.setMode('select');
    expect(values).toEqual(['select', 'draw_polygon', 'select']);
    expect(heard).toEqual(['select', 'draw_polygon']);
    expect(draw.mode.value).toBe('select');
  });

  it('keeps calling the other subscribers when one throws, refuses a subscriber that is not a function, and does not depend on this', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const hub = createEventHub();
    let value = 1;
    const observable = observe(hub, ['mode.changed'], () => value);
    const heard: number[] = [];
    observable.subscribe(() => {
      throw new Error('boom');
    });
    const { subscribe } = observable;
    subscribe((next) => heard.push(next));
    value = 2;
    hub.emit('mode.changed', { mode: 'select', previous: 'select' });
    expect(heard).toEqual([1, 2]);
    expect(error).toHaveBeenCalled();
    expect(() => observable.subscribe('nope' as never)).toThrow(DrawError);
    error.mockRestore();
  });
});

describe('on, off and once', () => {
  it('once hears the next occurrence only, and its function unsubscribes before it', () => {
    const heard: boolean[] = [];
    draw.once('readOnly.changed', ({ readOnly }) => heard.push(readOnly));
    const cancel = draw.once('readOnly.changed', () => heard.push(false));
    cancel();
    draw.setReadOnly(true);
    draw.setReadOnly(false);
    expect(heard).toEqual([true]);
  });

  it('off removes a listener given to on or to once, and on returns the function that does it', () => {
    const heard: boolean[] = [];
    const listener = ({ readOnly }: DrawEvents['readOnly.changed']) => heard.push(readOnly);
    draw.on('readOnly.changed', listener);
    draw.off('readOnly.changed', listener);
    draw.once('readOnly.changed', listener);
    draw.off('readOnly.changed', listener);
    const stop = draw.on('readOnly.changed', listener);
    draw.setReadOnly(true);
    stop();
    draw.setReadOnly(false);
    expect(heard).toEqual([true]);
  });

  it('keeps calling the other listeners when one throws, and refuses a listener that is not a function', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const hub = createEventHub();
    const heard: number[] = [];
    hub.on('mode.changed', () => {
      throw new Error('boom');
    });
    hub.on('mode.changed', () => heard.push(1));
    hub.emit('mode.changed', { mode: 'select', previous: 'select' });
    expect(heard).toEqual([1]);
    expect(error).toHaveBeenCalled();
    expect(() => hub.on('mode.changed', 'nope' as never)).toThrow(DrawError);
    error.mockRestore();
  });
});

describe('the signals of the engine', () => {
  let engine: Engine;
  let signals: Recorded[];

  beforeEach(() => {
    engine = createEngine(createMapStub().map);
    signals = record(engine.events);
  });

  afterEach(() => engine.destroy());

  it('passes snapping, clicks, image requests, the stacking order and failed loads on', () => {
    const emitter = engine.context.eventEmitter;
    emitter.emit('snap.change', {
      lngLat: { lng: 1, lat: 2 },
      target: {
        kind: 'edge',
        featureId: 'f',
        segment: { start: [0, 0], end: [1, 1], startRef: { ring: 0, index: 0 } },
      },
    });
    emitter.emit('snap.change', { lngLat: { lng: 1, lat: 2 } });
    emitter.emit('map.click', { lngLat: [3, 4], point: { x: 5, y: 6 } });
    emitter.emit('image.request', { coordinate: [7, 8], zoom: 9, layerId: 'l' });
    emitter.emit('layerStack.change', { slots: [{ layerId: 'slot', from: 0, to: 2 }] });
    const cause = new Error('bad image');
    emitter.emit('load.error', { source: 'image', featureId: 'img', error: cause });

    expect(payloadsOf(signals, 'snap.changed')).toEqual([
      {
        result: {
          lngLat: [1, 2],
          target: { kind: 'edge', featureId: 'f', segment: { start: [0, 0], end: [1, 1] } },
        },
      },
      { result: null },
    ]);
    expect(payloadsOf(signals, 'map.clicked')).toEqual([
      { lngLat: [3, 4], point: [5, 6], hit: null },
    ]);
    expect(payloadsOf(signals, 'image.requested')).toEqual([
      { lngLat: [7, 8], zoom: 9, layerId: 'l' },
    ]);
    expect(payloadsOf(signals, 'layerStack.changed')).toEqual([
      { entries: [{ layerId: 'slot', from: 0, to: 2 }] },
    ]);
    const [failure] = payloadsOf(signals, 'error');
    expect(failure.source).toBe('image');
    expect(failure.featureId).toBe('img');
    expect(failure.error).toBeInstanceOf(DrawError);
    expect(failure.error.code).toBe('unsupported-format');
    expect(failure.error.details).toEqual({ cause });
  });

  it('map.clicked fires for every click of the select mode, with what it hit or null', () => {
    const draw = createDrawOnEngine(engine);
    engine.enterDefaultMode();
    const point = draw.features.create(pointInput(1, 1)) as Feature;
    const input = createSyntheticInput(engine);
    input.click([1, 1]);
    input.click([-0.5, -0.5]);
    const clicks = payloadsOf(signals, 'map.clicked');
    expect(clicks).toHaveLength(2);
    expect(clicks[0]).toMatchObject({
      lngLat: [1, 1],
      point: [500, 200],
      hit: { kind: 'feature', id: point.id },
    });
    // A feature is named by `id` alone
    expect(clicks[0].hit).not.toHaveProperty('featureId');
    expect(clicks[1]).toEqual({ lngLat: [-0.5, -0.5], point: [350, 350], hit: null });

    // Not in a drawing mode
    draw.setMode('draw_point');
    input.click([0.5, 0.5]);
    expect(payloadsOf(signals, 'map.clicked')).toHaveLength(2);
  });

  it('drag.started and drag.ended come from the drags of the select mode', () => {
    const { store: engineStore, eventEmitter } = engine.context;
    const a = engine.context.generateFeatureId();
    const layerId = engineStore.listLayers()[0].id;
    engineStore.createFeature({
      id: a,
      type: 'LineString',
      geometry: {
        type: 'LineString',
        coordinates: [
          [0, 0],
          [1, 1],
        ],
      },
      layerId,
      groupId: undefined,
      properties: {},
      style: {},
      locked: false,
      visible: true,
    });
    engineStore.setSelection('feature', [a]);
    const dragPan = { enable: vi.fn(), disable: vi.fn(), isEnabled: () => true };
    const context = {
      store: engineStore,
      spatialIndex: engine.context.spatialIndex,
      map: { dragPan, getCanvas: () => ({ style: {} }), getZoom: () => 10 },
      eventEmitter,
      sketches: engine.sketches,
      selectionScope: engine.context.selectionScope,
    } as unknown as EngineModeContext;
    const drag = (lng: number, lat: number): DragNormalizedEvent => ({
      type: 'dragstart',
      point: { x: lng * 10, y: -lat * 10 },
      lngLat: { lng, lat },
      originalEvent: {} as MouseEvent,
      modifiers: { shift: false, ctrl: false, alt: false, meta: false },
      dragStartPoint: { x: 0, y: 0 },
      dragStartLngLat: { lng: 0, lat: 0 },
    });
    const bbox = computeSelectionBoundingBox(selectedOf(engineStore));
    const handler = new SelectModeDragHandler();

    handler.startDrag({ type: 'move' } as HandleHitResult, drag(0, 0), context, bbox);
    handler.updateDrag(drag(1, 1), context);
    handler.endDrag(context);

    handler.startDrag(
      { type: 'vertex', featureId: a, vertexRef: { ring: 0, index: 0 } },
      drag(0, 0),
      context,
      bbox,
    );
    handler.reset(engineStore);

    expect(payloadsOf(signals, 'drag.started')).toEqual([
      { kind: 'feature', featureIds: [a] },
      { kind: 'vertex', featureIds: [a] },
    ]);
    expect(payloadsOf(signals, 'drag.ended')).toEqual([
      { kind: 'feature', featureIds: [a], cancelled: false },
      { kind: 'vertex', featureIds: [a], cancelled: true },
    ]);
  });

  it('drops every listener and subscriber when the instance is destroyed', () => {
    const heard = vi.fn();
    const other = createDrawOnEngine(engine);
    engine.events.on('mode.changed', heard);
    const subscriber = vi.fn();
    other.mode.subscribe(subscriber);
    subscriber.mockClear();
    engine.destroy();
    engine.events.emit('mode.changed', { mode: 'select', previous: 'select' });
    expect(heard).not.toHaveBeenCalled();
    expect(subscriber).not.toHaveBeenCalled();
  });
});

describe('the shape being drawn, shown by a sketch of this client', () => {
  let engine: Engine;
  let local: Draw;
  let told: Array<[string, Sketch, string | undefined]>;

  beforeEach(() => {
    engine = createEngine(createMapStub().map, {}, { deferDefaultMode: true });
    local = createDrawOnEngine(engine);
    engine.enterDefaultMode();
    told = [];
    engine.events.on('sketch.added', ({ sketch }) => told.push(['added', sketch, undefined]));
    engine.events.on('sketch.updated', ({ sketch }) => told.push(['updated', sketch, undefined]));
    engine.events.on('sketch.removed', ({ sketch, reason }) =>
      told.push(['removed', sketch, reason]),
    );
  });

  afterEach(() => local.destroy());

  /** The edit create of a sketch */
  const createOf = (sketch: Sketch) =>
    sketch.edits[0] as Extract<Sketch['edits'][number], { kind: 'create' }>;
  const shapes = () =>
    told.map(([what, sketch]) =>
      what === 'removed'
        ? null
        : (createOf(sketch).feature.geometry as { coordinates: unknown }).coordinates,
    );

  it('is told at each change, and ends committed with the feature it creates', () => {
    local.setMode('draw_line');
    const input = createSyntheticInput(engine);
    const signals = record(local);
    input.click([0, 0]);
    input.move([0.5, 0.5]);
    input.click([1, 1]);
    const [first] = told;
    expect(first?.[0]).toBe('added');
    expect(first?.[1].owner).toBeNull();
    expect(createOf(first?.[1] as Sketch).feature).toMatchObject({
      type: 'LineString',
      layerId: expect.any(String),
    });
    expect(typeof createOf(first?.[1] as Sketch).feature.id).toBe('string');
    expect(told.length).toBeGreaterThanOrEqual(3);
    const all = shapes();
    const last = all[all.length - 1] as number[][];
    expect(last[0]).toEqual([0, 0]);
    expect(last[1][0]).toBeCloseTo(1);
    expect(last[1][1]).toBeCloseTo(1);
    // Nothing is written while it is drawn
    expect(changesOf(signals)).toEqual([]);

    input.key('Enter');
    expect(told[told.length - 1]?.[0]).toBe('removed');
    expect(told[told.length - 1]?.[2]).toBe('committed');
    const changes = changesOf(signals);
    expect(changes).toHaveLength(1);
    expect(changes[0].features.created).toEqual([createOf(first?.[1] as Sketch).feature.id]);
    expect(local.sketches.count()).toBe(0);
  });

  it('ends cancelled once when the drawing is cancelled, and nothing when there was none', () => {
    local.setMode('draw_line');
    const input = createSyntheticInput(engine);
    const signals = record(local);
    input.click([0, 0]);
    input.move([0.5, 0.5]);
    const before = told.length;
    input.key('Escape');
    expect(told.slice(before).map(([what, , reason]) => [what, reason])).toEqual([
      ['removed', 'cancelled'],
    ]);

    local.setMode('select');
    expect(told).toHaveLength(before + 1);
    expect(changesOf(signals)).toEqual([]);
  });

  it('holds the vertices placed and the one to close on that the shape was shown with', () => {
    local.extensions.modes.add('custom', (ctx) => ({
      onClick(event) {
        ctx.preview.set(
          {
            type: 'LineString',
            geometry: { type: 'LineString', coordinates: [[0, 0], event.lngLat] },
          },
          { confirmedVertices: 1, highlightVertex: 0 },
        );
        return true;
      },
      onPointerMove(event) {
        ctx.preview.set({
          type: 'LineString',
          geometry: { type: 'LineString', coordinates: [[0, 0], event.lngLat] },
        });
        return true;
      },
      onKeyDown() {
        ctx.preview.clear();
        return true;
      },
    }));
    local.setMode('custom');
    const input = createSyntheticInput(engine);
    input.click([1, 1]);
    input.move([2, 2]);
    input.key('x');
    // The click moves the pointer first
    const changes = told.slice(-3);
    expect(createOf(changes[0]?.[1] as Sketch)).toMatchObject({
      placedVertexCount: 1,
      highlightedVertexIndex: 0,
    });
    expect(createOf(changes[0]?.[1] as Sketch).feature.type).toBe('LineString');
    // Shown without options: every vertex placed, none to close on
    expect(createOf(changes[1]?.[1] as Sketch).placedVertexCount).toBe(2);
    expect(createOf(changes[1]?.[1] as Sketch).highlightedVertexIndex).toBeUndefined();
    expect(changes[2]?.[0]).toBe('removed');
  });

  it('holds the placed vertices of a built-in line', () => {
    local.setMode('draw_line');
    const input = createSyntheticInput(engine);
    input.click([0, 0]);
    input.move([0.5, 0.5]);
    expect(createOf(told[told.length - 1]?.[1] as Sketch).placedVertexCount).toBe(1);
    // The shape being drawn has no ID of the document, and is read by the shapes
    expect(engine.context.shapes.drawing()?.confirmedCount).toBe(1);
  });

  it('holds the radius of a circle', () => {
    local.setMode('draw_circle');
    const input = createSyntheticInput(engine);
    input.click([0, 0]);
    input.move([0.01, 0]);
    const last = createOf(told[told.length - 1]?.[1] as Sketch).feature;
    expect(last.type).toBe('Circle');
    expect(last.properties?.['maplibre-gl-draw:radiusMeters']).toBeGreaterThan(0);
  });
});
