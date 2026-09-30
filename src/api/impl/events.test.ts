// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the events of the draw instance: each event from the write that causes it, with
 * the declared payload; document.changed once per transaction and after the events of the
 * resources; on, off and once; and the signals of the engine under their names
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DragNormalizedEvent } from '../../dispatcher/types.js';
import type { EngineModeContext } from '../../modes/handler.js';
import { SelectModeDragHandler } from '../../modes/select/drag-handler.js';
import { MemoryStore } from '../../store/memory.js';
import { createMapStub, createSyntheticInput } from '../../test-utils.js';
import type { HandleHitResult } from '../../view/ui/handle-test.js';
import { computeSelectionBoundingBox, getSelectedFeatures } from '../../view/ui/helper.js';
import type { Draw } from '../draw.js';
import { createDraw } from '../draw.js';
import { DrawError } from '../errors.js';
import type { DrawEvents } from '../events.js';
import type { Feature } from '../model.js';
import { createDrawOnEngine } from './create-draw.js';
import type { Engine } from './engine.js';
import { createEngine } from './engine.js';
import { createEventHub } from './events.js';

type Recorded = { [K in keyof DrawEvents]: [K, DrawEvents[K]] }[keyof DrawEvents];

const ALL_EVENTS: ReadonlyArray<keyof DrawEvents> = [
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
  'group.deleted',
  'metadata.updated',
  'document.changed',
  'document.loaded',
  'selection.changed',
  'vertexSelection.changed',
  'drag.started',
  'drag.ended',
  'mode.changed',
  'hidden.changed',
  'readOnly.changed',
  'interactionLock.changed',
  'snap.changed',
  'preview.changed',
  'map.clicked',
  'dataset.clicked',
  'dataset.added',
  'dataset.removed',
  'dataset.reordered',
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

describe('the events of the features', () => {
  it('feature.created, feature.updated and feature.deleted carry the feature and the source', () => {
    const created = draw.features.create(pointInput()) as Feature;
    const updated = draw.features.update(created.id, { properties: { name: 'A' } }) as Feature;
    draw.features.delete(created.id);

    expect(payloadsOf(events, 'feature.created')).toEqual([{ feature: created, source: 'local' }]);
    expect(payloadsOf(events, 'feature.updated')).toEqual([
      { feature: updated, previous: created, source: 'local', intermediate: false },
    ]);
    expect(payloadsOf(events, 'feature.deleted')).toEqual([{ feature: updated, source: 'local' }]);
  });

  it('feature.updated tells an update in the middle of a drag', () => {
    const created = draw.features.create(pointInput()) as Feature;
    store.updateFeature(
      created.id,
      { geometry: { type: 'Point', coordinates: [1, 1] } },
      { isIntermediate: true },
    );
    expect(payloadsOf(events, 'feature.updated')[0].intermediate).toBe(true);
  });

  it('feature.moved tells the layer or the group a feature left and entered', () => {
    const first = draw.layers.getActive()?.id as string;
    const second = draw.layers.create({ name: 'Second' })?.id as string;
    const a = draw.features.create(pointInput()) as Feature;
    const b = draw.features.create(pointInput(1, 1)) as Feature;

    draw.features.move(a.id, { layerId: second });
    const group = draw.groups.create({ featureIds: [b.id] });
    draw.features.move(b.id, { groupId: null });

    const moved = payloadsOf(events, 'feature.moved');
    expect(moved).toHaveLength(3);
    expect(moved[0]).toMatchObject({
      feature: { id: a.id, layerId: second },
      from: { layerId: first },
      to: { layerId: second, index: 0 },
      source: 'local',
    });
    expect(moved[1]).toMatchObject({
      feature: { id: b.id, groupId: group?.id },
      from: { layerId: first },
      to: { groupId: group?.id, index: 0 },
    });
    expect(moved[2]).toMatchObject({ from: { groupId: group?.id }, to: { groupId: null } });
  });
});

describe('the events of the layers, the groups and the metadata', () => {
  it('layer.created, layer.updated, layer.reordered and layer.deleted', () => {
    const first = draw.layers.getActive()?.id as string;
    const layer = draw.layers.create({ name: 'Roads' });
    const renamed = draw.layers.update(layer?.id as string, { name: 'Streets' });
    draw.layers.reorder([layer?.id as string, first]);
    draw.layers.delete(layer?.id as string);

    expect(payloadsOf(events, 'layer.created')).toEqual([{ layer, source: 'local' }]);
    expect(payloadsOf(events, 'layer.updated')).toContainEqual({
      layer: renamed,
      previous: layer,
      source: 'local',
    });
    expect(payloadsOf(events, 'layer.reordered')).toContainEqual({
      order: [layer?.id, first],
      previous: [first, layer?.id],
      source: 'local',
    });
    expect(payloadsOf(events, 'layer.deleted')).toEqual([
      { layer: expect.objectContaining({ id: layer?.id }), source: 'local' },
    ]);
  });

  it('group.created, group.updated and group.deleted', () => {
    const a = draw.features.create(pointInput()) as Feature;
    const group = draw.groups.create({ featureIds: [a.id], name: 'G' });
    const renamed = draw.groups.update(group?.id as string, { name: 'H' });
    draw.groups.delete(group?.id as string);

    expect(payloadsOf(events, 'group.created')).toEqual([{ group, source: 'local' }]);
    expect(payloadsOf(events, 'group.updated')).toContainEqual({
      group: renamed,
      previous: group,
      source: 'local',
    });
    expect(payloadsOf(events, 'group.deleted')).toEqual([
      { group: expect.objectContaining({ id: group?.id }), source: 'local' },
    ]);
  });

  it('metadata.updated', () => {
    draw.metadata.update({ title: 'Map' });
    expect(payloadsOf(events, 'metadata.updated')).toEqual([
      { metadata: { title: 'Map' }, previous: {}, source: 'local' },
    ]);
  });
});

describe('document.changed', () => {
  it('arrives once per transaction, after the events of the resources, with its source', () => {
    draw.transact(
      () => {
        draw.features.create(pointInput());
        draw.layers.create({ name: 'Second' });
        draw.metadata.update({ title: 'Map' });
      },
      { source: 'script' },
    );
    const changes = payloadsOf(events, 'document.changed');
    expect(changes).toHaveLength(1);
    expect(names(events)[events.length - 1]).toBe('document.changed');
    expect(changes[0].source).toBe('script');
    expect(changes[0].features?.created).toHaveLength(1);
    expect(changes[0].layers?.created).toHaveLength(1);
    expect(changes[0].metadata?.metadata).toEqual({ title: 'Map' });
    for (const [name, payload] of events) {
      if (name !== 'document.changed' && 'source' in payload) {
        expect(payload.source).toBe('script');
      }
    }
  });

  it('does not fire for a change of the selection, the mode or the drawing state alone', () => {
    const a = draw.features.create(pointInput()) as Feature;
    const received: DrawEvents['document.changed'][] = [];
    draw.on('document.changed', (change) => received.push(change));
    draw.selection.set('feature', [a.id]);
    draw.selection.clear();
    draw.setMode('draw_line');
    store.setTentative({ type: 'LineString', coordinates: [[0, 0]], layerId: 'x' });
    draw.setMode('select');
    draw.hidden.add(a.id);
    draw.hidden.remove(a.id);
    draw.setReadOnly(true);
    draw.setReadOnly(false);
    draw.setInteractionLocked(true);
    draw.setInteractionLocked(false);
    expect(received).toEqual([]);
  });

  it('carries the selection of a transaction that also changed the document', () => {
    const received: DrawEvents['document.changed'][] = [];
    draw.on('document.changed', (change) => received.push(change));
    draw.transact(() => {
      const a = draw.features.create(pointInput()) as Feature;
      draw.selection.set('feature', [a.id]);
    });
    expect(received).toHaveLength(1);
    expect(received[0].features?.created).toHaveLength(1);
    expect(received[0].selection?.ids).toHaveLength(1);
    expect(received[0]).not.toHaveProperty('tentative');
    expect(received[0]).not.toHaveProperty('uiStateChanged');
  });

  it('fires for a transaction that changed the files alone', () => {
    const received: DrawEvents['document.changed'][] = [];
    draw.on('document.changed', (change) => received.push(change));
    store.createFile({ id: 'f1', mimeType: 'image/png', dataURL: 'data:image/png;base64,' });
    store.deleteFile('f1');
    expect(received.map((change) => change.files)).toEqual([
      { created: [expect.objectContaining({ id: 'f1' })] },
      { deleted: [expect.objectContaining({ id: 'f1' })] },
    ]);
  });

  it('document.loaded carries the result and the source of the writes', async () => {
    const result = await draw.document.load({
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [1, 2] } },
      ],
    });
    expect(payloadsOf(events, 'document.loaded')).toEqual([{ result, source: 'load' }]);
    // The features of the load arrive in one document.changed with the same source
    const changes = payloadsOf(events, 'document.changed');
    expect(changes[changes.length - 1]?.source).toBe('load');
  });
});

describe('the events of the state of this client', () => {
  it('selection.changed carries the selection and the one before it', () => {
    const a = draw.features.create(pointInput()) as Feature;
    draw.selection.set('feature', [a.id]);
    draw.selection.clear();
    expect(payloadsOf(events, 'selection.changed')).toEqual([
      { selection: { type: 'feature', ids: [a.id] }, previous: { type: null, ids: [] } },
      { selection: { type: null, ids: [] }, previous: { type: 'feature', ids: [a.id] } },
    ]);
  });

  it('vertexSelection.changed carries the vertices and the ones before them', () => {
    const line = draw.features.create(lineInput()) as Feature;
    draw.selection.set('feature', [line.id]);
    draw.vertexSelection.set(line.id, [{ ring: 0, index: 1 }]);
    draw.vertexSelection.set(line.id, [{ ring: 0, index: 1 }]);
    draw.vertexSelection.clear();
    const changes = payloadsOf(events, 'vertexSelection.changed');
    expect(changes).toHaveLength(2);
    expect(changes[0]).toMatchObject({
      selection: { featureId: line.id, vertices: [{ ring: 0, index: 1 }] },
      previous: null,
    });
    expect(changes[1]).toMatchObject({ selection: null, previous: { featureId: line.id } });
  });

  it('hidden.changed carries the whole hidden set after the change', () => {
    const a = draw.features.create(pointInput()) as Feature;
    const b = draw.features.create(pointInput(1, 1)) as Feature;
    draw.hidden.add(a.id);
    draw.hidden.add(b.id);
    draw.hidden.add(b.id);
    draw.features.delete(a.id);
    draw.hidden.clear();
    expect(payloadsOf(events, 'hidden.changed')).toEqual([
      { ids: [a.id] },
      { ids: [a.id, b.id] },
      { ids: [b.id] },
      { ids: [] },
    ]);
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

  it('mode.changed carries the mode and the one before it', () => {
    draw.setMode('draw_polygon');
    expect(payloadsOf(events, 'mode.changed')).toEqual([
      { mode: 'draw_polygon', previous: 'select' },
    ]);
  });
});

describe('on, off and once', () => {
  it('once hears the next occurrence only, and its function unsubscribes before it', () => {
    const heard: string[] = [];
    draw.once('mode.changed', ({ mode }) => heard.push(mode));
    const cancel = draw.once('mode.changed', ({ mode }) => heard.push(`cancelled ${mode}`));
    cancel();
    draw.setMode('draw_line');
    draw.setMode('draw_point');
    expect(heard).toEqual(['draw_line']);
  });

  it('off removes a listener given to on or to once, and on returns the function that does it', () => {
    const heard: string[] = [];
    const listener = ({ mode }: DrawEvents['mode.changed']) => heard.push(mode);
    draw.on('mode.changed', listener);
    draw.off('mode.changed', listener);
    draw.once('mode.changed', listener);
    draw.off('mode.changed', listener);
    const stop = draw.on('mode.changed', listener);
    draw.setMode('draw_line');
    stop();
    draw.setMode('draw_point');
    expect(heard).toEqual(['draw_line']);
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
      hit: { kind: 'feature', id: point.id, featureId: point.id },
    });
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
    const bbox = computeSelectionBoundingBox(getSelectedFeatures(engineStore));
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

  it('drops every listener when the instance is destroyed', () => {
    const heard = vi.fn();
    engine.events.on('mode.changed', heard);
    engine.destroy();
    engine.events.emit('mode.changed', { mode: 'select', previous: 'select' });
    expect(heard).not.toHaveBeenCalled();
  });
});

describe('preview.changed', () => {
  let engine: Engine;
  let signals: Recorded[];
  let local: Draw;

  beforeEach(() => {
    engine = createEngine(createMapStub().map, {}, { deferDefaultMode: true });
    local = createDrawOnEngine(engine);
    engine.enterDefaultMode();
    signals = record(local);
  });

  afterEach(() => local.destroy());

  const shapes = () =>
    payloadsOf(signals, 'preview.changed').map(({ feature }) =>
      feature ? (feature.geometry as { coordinates: unknown }).coordinates : null,
    );

  it('fires at each change of the shape being drawn, and null when it is created', () => {
    local.setMode('draw_line');
    const input = createSyntheticInput(engine);
    input.click([0, 0]);
    input.move([0.5, 0.5]);
    input.click([1, 1]);
    const [first] = payloadsOf(signals, 'preview.changed');
    expect(first.feature).toMatchObject({ type: 'LineString', layerId: expect.any(String) });
    expect(typeof first.feature?.id).toBe('string');
    const count = shapes().length;
    expect(count).toBeGreaterThanOrEqual(3);
    const all = shapes();
    const last = all[all.length - 1] as number[][];
    expect(last[0]).toEqual([0, 0]);
    expect(last[1][0]).toBeCloseTo(1);
    expect(last[1][1]).toBeCloseTo(1);

    input.key('Enter');
    expect(shapes()[shapes().length - 1]).toBeNull();
    const created = payloadsOf(signals, 'feature.created');
    expect(created).toHaveLength(1);
    expect(created[0].feature.id).toBe(first.feature?.id);
  });

  it('fires null once when the drawing is cancelled, and nothing when there was none', () => {
    local.setMode('draw_line');
    const input = createSyntheticInput(engine);
    input.click([0, 0]);
    input.move([0.5, 0.5]);
    const before = shapes().length;
    input.key('Escape');
    expect(shapes().slice(before)).toEqual([null]);

    local.setMode('select');
    expect(shapes()).toHaveLength(before + 1);
  });

  it('carries the options the shape was shown with, and none when it is cleared', () => {
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
    const changes = payloadsOf(signals, 'preview.changed').slice(-3);
    expect(changes[0]).toMatchObject({ confirmedVertices: 1, highlightVertex: 0 });
    expect(changes[0].feature?.type).toBe('LineString');
    expect(Object.keys(changes[1]).sort()).toEqual(['feature']);
    expect(changes[2]).toEqual({ feature: null });
  });

  it('carries the placed vertices of a built-in line', () => {
    local.setMode('draw_line');
    const input = createSyntheticInput(engine);
    input.click([0, 0]);
    input.move([0.5, 0.5]);
    const changes = payloadsOf(signals, 'preview.changed');
    expect(changes[changes.length - 1]?.confirmedVertices).toBe(1);
  });

  it('carries the radius of a circle', () => {
    local.setMode('draw_circle');
    const input = createSyntheticInput(engine);
    input.click([0, 0]);
    input.move([0.01, 0]);
    const changes = payloadsOf(signals, 'preview.changed');
    const last = changes[changes.length - 1]?.feature;
    expect(last?.type).toBe('Circle');
    expect(last?.properties?.['maplibre-gl-draw:radiusMeters']).toBeGreaterThan(0);
  });
});
