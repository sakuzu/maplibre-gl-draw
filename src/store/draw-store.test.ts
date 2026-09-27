// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests of the Store contracts: the split between the document and the local state
 * (DrawStore over a DocumentStore), the read-only gate, the notifications and the objects
 * the in-memory store returns
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { coordinatesOf } from '../shared/utils/coordinates.js';
import { toStore } from './draw-store.js';
import { MemoryDocumentStore, MemoryStore } from './memory.js';
import type { Feature, Layer, StateChanges } from './types.js';

function layer(id: string): Layer {
  return {
    id,
    name: id,
    visible: true,
    locked: false,
    opacity: 1,
    items: [],
    styleRule: undefined,
    metadata: undefined,
  };
}

function point(id: string, coordinates: [number, number] = [0, 0]): Feature {
  return {
    id,
    type: 'Point',
    geometry: { type: 'Point', coordinates: coordinates },
    layerId: 'l1',
    groupId: undefined,
    properties: {},
    locked: false,
    visible: true,
    style: {},
  };
}

function polygon(id: string): Feature {
  return {
    id,
    type: 'Polygon',
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 0],
        ],
      ],
    },
    layerId: 'l1',
    groupId: undefined,
    properties: { name: 'a' },
    locked: false,
    visible: true,
    style: {},
  };
}

function ringStart(feature: Feature | undefined): number[] | undefined {
  return (coordinatesOf(feature) as number[][][] | undefined)?.[0]?.[0];
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the objects the in-memory store returns', () => {
  it('rejects a write into a returned feature and keeps the stored coordinates', () => {
    const store = new MemoryStore();
    store.createLayer(layer('l1'));
    store.createFeature(polygon('f1'));

    const feature = store.getFeature('f1') as Feature;
    const ring = (coordinatesOf(feature) as [number, number][][])[0];
    expect(() => {
      ring[0] = [50, 50];
    }).toThrow(TypeError);
    expect(() => {
      feature.properties.name = 'b';
    }).toThrow(TypeError);
    expect(ringStart(store.getFeature('f1'))).toEqual([0, 0]);
    expect(store.getFeature('f1')?.properties.name).toBe('a');
  });

  it('does not share the arrays of the feature it was given', () => {
    const store = new MemoryStore();
    store.createLayer(layer('l1'));
    const input = polygon('f1');
    store.createFeature(input);

    (coordinatesOf(input) as number[][][])[0][0][0] = 50;

    expect(ringStart(store.getFeature('f1'))).toEqual([0, 0]);
  });

  it('never changes a layer it has returned or notified', () => {
    const store = new MemoryStore();
    store.createLayer(layer('l1'));
    store.createFeature(point('a'));
    store.createFeature(point('b'));
    const updated: Layer[] = [];
    store.subscribe((changes) => {
      for (const entry of changes.layers?.updated ?? []) updated.push(entry.layer);
    });
    const before = store.getLayer('l1') as Layer;

    store.reorderInLayer('a', 'l1', 1);
    store.createFeature(point('c'));

    expect(before.items).toEqual(['a', 'b']);
    expect(store.getLayer('l1')?.items).toEqual(['b', 'a', 'c']);
    expect(updated[updated.length - 1]?.items).toEqual(['b', 'a', 'c']);
    const notified = updated[0];
    store.createFeature(point('d'));
    expect(notified.items).toEqual(['b', 'a', 'c']);
    expect(() => (store.getLayer('l1') as Layer).items.push('x')).toThrow(TypeError);
  });

  it('keeps a bulk load inside one transaction linear (one copy of the order per notification)', () => {
    const store = new MemoryStore();
    store.createLayer(layer('l1'));
    const count = 20000;

    const started = performance.now();
    store.transact(() => {
      for (let i = 0; i < count; i++) store.createFeature(point(`f${i}`));
    });
    const elapsed = performance.now() - started;

    expect(store.getLayer('l1')?.items).toHaveLength(count);
    expect(elapsed).toBeLessThan(5000);
  });
});

describe('the read-only gate', () => {
  it('refuses every document write with false and no exception', () => {
    const store = new MemoryStore();
    store.createLayer(layer('l1'));
    store.createFeature(point('f1'));
    store.setReadOnly(true);

    expect(store.createFeature(point('f2'))).toBe(false);
    expect(store.updateFeature('f1', { geometry: { type: 'Point', coordinates: [1, 1] } })).toBe(
      false,
    );
    expect(store.deleteFeature('f1')).toBe(false);
    expect(store.deleteFeature('missing')).toBe(false);
    expect(store.createLayer(layer('l2'))).toBe(false);
    expect(store.setLayerOrder([])).toBe(false);
    expect(store.setMetadata({ title: 'x' })).toBe(false);
    expect(store.listFeatures().map((f) => f.id)).toEqual(['f1']);
    expect(store.getLayerOrder()).toEqual(['l1']);

    store.setReadOnly(false);
    expect(store.updateFeature('f1', { geometry: { type: 'Point', coordinates: [1, 1] } })).toBe(
      true,
    );
  });

  it('throws for an argument that cannot apply once writable', () => {
    const store = new MemoryStore();
    store.createLayer(layer('l1'));

    expect(() => store.deleteFeature('missing')).toThrow(/not found/);
    expect(() => store.createFeature({ ...point('f1'), layerId: 'nope' })).toThrow(/not found/);
  });
});

describe('a DocumentStore of the host', () => {
  it('gets the local state and the read-only gate of core around it', () => {
    const document = new MemoryDocumentStore();
    const store = toStore(document);
    store.createLayer(layer('l1'));
    store.createFeature(point('f1'));

    store.setSelection('feature', ['f1']);
    store.setMode('draw_line');
    store.setReadOnly(true);

    expect(store.getSelection()).toEqual({ type: 'feature', ids: ['f1'] });
    expect(store.getMode()).toBe('draw_line');
    expect(store.createFeature(point('f2'))).toBe(false);
    expect(document.getFeature('f2')).toBeUndefined();
  });

  it('applies a change made on the document itself (from elsewhere) even while read-only', () => {
    const document = new MemoryDocumentStore();
    const store = toStore(document);
    store.createLayer(layer('l1'));
    store.setReadOnly(true);
    const notified: StateChanges[] = [];
    store.subscribe((changes) => notified.push(changes));

    document.transact(() => document.createFeature(point('r1')), 'remote');

    expect(store.getFeature('r1')).toBeDefined();
    expect(notified).toHaveLength(1);
    expect(notified[0].source).toBe('remote');
    expect(notified[0].features?.created?.map((f) => f.id)).toEqual(['r1']);
  });

  it('drops a feature deleted on the document from the selection, editing and hiding', () => {
    const document = new MemoryDocumentStore();
    const store = toStore(document);
    store.createLayer(layer('l1'));
    store.createFeature(point('f1'));
    store.createFeature(point('f2'));
    store.setSelection('feature', ['f1', 'f2']);
    store.startEditing(['f1']);
    store.setLocallyHidden('f2', false);
    store.setLocallyHidden('f1', true);
    store.setSelection('feature', ['f1', 'f2']);
    const notified: StateChanges[] = [];
    store.subscribe((changes) => notified.push(changes));

    document.transact(() => document.deleteFeature('f1'), 'remote');

    expect(store.getSelection()).toEqual({ type: 'feature', ids: ['f2'] });
    expect(store.getEditingIds()).toEqual([]);
    expect(store.isHidden('f1')).toBe(false);
    // The deletion and what it changed in the local state arrive together
    expect(notified).toHaveLength(1);
    expect(notified[0].features?.deleted?.map((f) => f.id)).toEqual(['f1']);
    expect(notified[0].selection?.ids).toEqual(['f2']);
    expect(notified[0].editing?.ended).toEqual(['f1']);
  });

  it('keeps a feature deleted and created again in one transaction selected', () => {
    const store = new MemoryStore();
    store.createLayer(layer('l1'));
    store.createFeature(point('f1'));
    store.setSelection('feature', ['f1']);

    store.transact(() => {
      store.deleteFeature('f1');
      store.createFeature(point('f1', [2, 2]));
      store.setSelection('feature', ['f1']);
    });

    expect(store.getSelection().ids).toEqual(['f1']);
  });

  it('uses a Store it is given as it is', () => {
    const store = new MemoryStore();
    expect(toStore(store)).toBe(store);
  });

  it('notifies the document and the local state of one transaction together', () => {
    const store = new MemoryStore();
    store.createLayer(layer('l1'));
    const notified: StateChanges[] = [];
    store.subscribe((changes) => notified.push(changes));

    store.transact(() => {
      store.createFeature(point('f1'));
      store.setSelection('feature', ['f1']);
    }, 'batch');

    expect(notified).toHaveLength(1);
    expect(notified[0].source).toBe('batch');
    expect(notified[0].features?.created?.map((f) => f.id)).toEqual(['f1']);
    expect(notified[0].selection?.ids).toEqual(['f1']);
  });
});

describe('the notifications', () => {
  it('reaches every listener when one of them throws', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const store = new MemoryStore();
    const reached: string[] = [];
    store.subscribe(() => {
      reached.push('first');
      throw new Error('listener bug');
    });
    store.subscribe(() => reached.push('second'));

    expect(() => store.createLayer(layer('l1'))).not.toThrow();

    expect(reached).toEqual(['first', 'second']);
    expect(error).toHaveBeenCalledTimes(1);
  });

  it('keeps and notifies what a failing transaction wrote before the throw', () => {
    const store = new MemoryStore();
    store.createLayer(layer('l1'));
    const notified: StateChanges[] = [];
    store.subscribe((changes) => notified.push(changes));

    expect(() =>
      store.transact(() => {
        store.createFeature(point('f1'));
        throw new Error('stop');
      }),
    ).toThrow('stop');

    expect(store.getFeature('f1')).toBeDefined();
    expect(notified).toHaveLength(1);
    expect(notified[0].features?.created?.map((f) => f.id)).toEqual(['f1']);
  });
});

describe('the invariants of the selection', () => {
  function setup() {
    const store = new MemoryStore();
    store.createLayer(layer('l1'));
    store.createFeature(point('f1'));
    store.createFeature(point('f2'));
    return store;
  }

  it('drops a feature whose shared visible flag is turned off', () => {
    const store = setup();
    store.setSelection('feature', ['f1', 'f2']);

    store.updateFeature('f1', { visible: false });

    expect(store.getSelection()).toEqual({ type: 'feature', ids: ['f2'] });
  });

  it('drops the features of a layer that is hidden, shared or locally', () => {
    const store = setup();
    store.setSelection('feature', ['f1', 'f2']);
    store.updateLayer('l1', { visible: false });
    expect(store.getSelection()).toEqual({ type: null, ids: [] });

    store.updateLayer('l1', { visible: true });
    store.setSelection('feature', ['f1']);
    store.setLocallyHidden('l1', true);
    expect(store.getSelection()).toEqual({ type: null, ids: [] });
  });

  it('drops the features of a group that is hidden, and a hidden group itself', () => {
    const store = setup();
    store.createGroup({
      id: 'g1',
      layerId: 'l1',
      name: 'g',
      featureIds: [],
      locked: false,
      visible: true,
    });
    store.updateFeature('f1', { groupId: 'g1' });
    store.setSelection('feature', ['f1', 'f2']);
    store.updateGroup('g1', { visible: false });
    expect(store.getSelection()).toEqual({ type: 'feature', ids: ['f2'] });

    store.updateGroup('g1', { visible: true });
    store.setSelection('group', ['g1']);
    store.updateLayer('l1', { visible: false });
    expect(store.getSelection()).toEqual({ type: null, ids: [] });
  });

  it('drops a feature hidden by a change of the document from elsewhere', () => {
    const document = new MemoryDocumentStore();
    const store = toStore(document);
    store.createLayer(layer('l1'));
    store.createFeature(point('f1'));
    store.setSelection('feature', ['f1']);

    document.transact(() => document.updateFeature('f1', { visible: false }), 'remote');

    expect(store.getSelection().ids).toEqual([]);
  });

  it('ends the vertex selection when its feature is deleted', () => {
    const store = setup();
    store.setSelectedVertices({ featureId: 'f1', vertices: [{ ring: 0, index: 0 }] });

    store.deleteFeature('f1');

    expect(store.getVertexSelection()).toBeNull();
  });

  it('ends the vertex selection when the coordinates change other than by a drag', () => {
    const store = setup();
    const vertices = { featureId: 'f1', vertices: [{ ring: 0, index: 0 }] };
    store.setSelectedVertices(vertices);

    // A property change keeps it
    store.updateFeature('f1', { properties: { name: 'x' } });
    expect(store.getVertexSelection()).not.toBeNull();

    // A drag (its frames and its commit) keeps it
    store.setDragState({ operation: 'vertex' });
    store.updateFeature(
      'f1',
      { geometry: { type: 'Point', coordinates: [1, 1] } },
      { isIntermediate: true },
    );
    store.updateFeature('f1', { geometry: { type: 'Point', coordinates: [1, 1] } });
    store.setDragState(null);
    expect(store.getVertexSelection()).not.toBeNull();

    // An edit that is not a drag ends it
    store.updateFeature('f1', { geometry: { type: 'Point', coordinates: [2, 2] } });
    expect(store.getVertexSelection()).toBeNull();
  });

  it('ends the vertex selection on a change of the coordinates from elsewhere during a drag', () => {
    const document = new MemoryDocumentStore();
    const store = toStore(document);
    store.createLayer(layer('l1'));
    store.createFeature(point('f1'));
    store.setSelectedVertices({ featureId: 'f1', vertices: [{ ring: 0, index: 0 }] });
    store.setDragState({ operation: 'move' });

    document.transact(
      () => document.updateFeature('f1', { geometry: { type: 'Point', coordinates: [3, 3] } }),
      'remote',
    );

    expect(store.getVertexSelection()).toBeNull();
  });
});
