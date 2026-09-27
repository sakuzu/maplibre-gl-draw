// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * EventBridge tests
 *
 * Verifies the conversion of StateChanges into public events: every change is emitted
 * whatever the source, and features.change comes once per flush.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitterImpl } from '../shared/utils/event-emitter.js';
import { EventBridgeImpl } from './event-bridge.js';
import { MemoryStore } from './memory.js';
import type { Feature } from './types.js';

function makeFeature(id: string): Feature {
  return {
    id,
    type: 'Point',
    geometry: { type: 'Point', coordinates: [139.7, 35.6] },
    layerId: 'default-layer',
    groupId: undefined,
    properties: {},
    locked: false,
    visible: true,
    style: {},
  };
}

describe('EventBridge', () => {
  let store: MemoryStore;
  let emitter: EventEmitterImpl;
  let bridge: EventBridgeImpl;

  beforeEach(() => {
    store = new MemoryStore();
    emitter = new EventEmitterImpl();
    bridge = new EventBridgeImpl(store, emitter);
    bridge.start();
    store.createLayer({
      id: 'default-layer',
      name: 'L',
      visible: true,
      locked: false,
      opacity: 1,
      items: [],
      styleRule: undefined,
      metadata: undefined,
    });
  });

  it('emits feature.create for each feature on a normal (local) creation of several', () => {
    const handler = vi.fn();
    emitter.on('feature.create', handler);

    store.transact(() => {
      store.createFeature(makeFeature('f1'));
      store.createFeature(makeFeature('f2'));
      store.createFeature(makeFeature('f3'));
    });

    expect(handler).toHaveBeenCalledTimes(3);
  });

  it.each(['silent', 'batch'])(
    'emits feature.create for every feature on a %s bulk creation',
    (source) => {
      const handler = vi.fn();
      emitter.on('feature.create', handler);

      store.transact(() => {
        store.createFeature(makeFeature('f1'));
        store.createFeature(makeFeature('f2'));
        store.createFeature(makeFeature('f3'));
      }, source);

      expect(handler.mock.calls.map((c) => c[0].feature.id)).toEqual(['f1', 'f2', 'f3']);
    },
  );

  it.each(['silent', 'batch'])(
    'emits feature.update / delete for every feature on %s',
    (source) => {
      store.createFeature(makeFeature('f1'));
      store.createFeature(makeFeature('f2'));
      const update = vi.fn();
      const remove = vi.fn();
      emitter.on('feature.update', update);
      emitter.on('feature.delete', remove);

      store.transact(() => {
        store.updateFeature('f1', { properties: { a: 1 } });
        store.updateFeature('f2', { properties: { a: 2 } });
      }, source);
      store.transact(() => {
        store.deleteFeature('f1');
        store.deleteFeature('f2');
      }, source);

      expect(update).toHaveBeenCalledTimes(2);
      expect(remove.mock.calls.map((c) => c[0].feature.id)).toEqual(['f1', 'f2']);
    },
  );

  describe('features.change', () => {
    it('is emitted once per flush with every change and the source', () => {
      store.createFeature(makeFeature('old'));
      const handler = vi.fn();
      emitter.on('features.change', handler);

      store.transact(() => {
        store.createFeature(makeFeature('f1'));
        store.createFeature(makeFeature('f2'));
        store.updateFeature('old', { properties: { a: 1 } });
        store.deleteFeature('f2');
      }, 'batch');

      expect(handler).toHaveBeenCalledTimes(1);
      const payload = handler.mock.calls[0][0];
      expect(payload.source).toBe('batch');
      expect(payload.created.map((f: Feature) => f.id)).toEqual(['f1', 'f2']);
      expect(payload.updated).toHaveLength(1);
      expect(payload.updated[0].feature.id).toBe('old');
      expect(payload.updated[0].previous.properties).toEqual({});
      expect(payload.deleted.map((f: Feature) => f.id)).toEqual(['f2']);
    });

    it('comes after the per-feature events of the same flush', () => {
      const calls: string[] = [];
      emitter.on('feature.create', () => calls.push('create'));
      emitter.on('features.change', () => calls.push('change'));

      store.transact(() => {
        store.createFeature(makeFeature('f1'));
        store.createFeature(makeFeature('f2'));
      }, 'silent');

      expect(calls).toEqual(['create', 'create', 'change']);
    });

    it('is emitted once per mutation outside a transaction, with source local', () => {
      const handler = vi.fn();
      emitter.on('features.change', handler);

      store.createFeature(makeFeature('f1'));
      store.createFeature(makeFeature('f2'));

      expect(handler).toHaveBeenCalledTimes(2);
      expect(handler.mock.calls[0][0].source).toBe('local');
    });

    it('is not emitted for a flush without feature changes', () => {
      const handler = vi.fn();
      emitter.on('features.change', handler);

      store.setMetadata({ title: 'x' });
      store.createLayer({
        id: 'layer-2',
        name: 'L2',
        visible: true,
        locked: false,
        opacity: 1,
        items: [],
        styleRule: undefined,
        metadata: undefined,
      });

      expect(handler).not.toHaveBeenCalled();
    });
  });

  it('emits once as before for a single silent creation (the equivalent of a draw mode)', () => {
    const handler = vi.fn();
    emitter.on('feature.create', handler);

    store.transact(() => {
      store.createFeature(makeFeature('only'));
    }, 'silent');

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0].feature.id).toBe('only');
  });

  it('emits every layer and feature on a silent bulk application', () => {
    const featureCreate = vi.fn();
    const layerCreate = vi.fn();
    emitter.on('feature.create', featureCreate);
    emitter.on('layer.create', layerCreate);

    store.transact(() => {
      store.createLayer({
        id: 'layer-2',
        name: 'L2',
        visible: true,
        locked: false,
        opacity: 1,
        items: [],
        styleRule: undefined,
        metadata: undefined,
      });
      store.createLayer({
        id: 'layer-3',
        name: 'L3',
        visible: true,
        locked: false,
        opacity: 1,
        items: [],
        styleRule: undefined,
        metadata: undefined,
      });
      store.createFeature(makeFeature('f1'));
      store.createFeature(makeFeature('f2'));
    }, 'silent');

    expect(layerCreate).toHaveBeenCalledTimes(2);
    expect(featureCreate).toHaveBeenCalledTimes(2);
  });
});
