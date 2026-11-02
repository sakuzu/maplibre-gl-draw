// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The Store the drawing reads: another document shown in place
 * of the document gives the reads of the document, and the state of this client is left out while
 * it is shown and while a frame is taken as an image
 */

import { describe, expect, it } from 'vitest';
import { MemoryStore } from '../../store/memory.js';
import { createTableStore } from '../../store/table-memory.js';
import type { Feature, Layer } from '../../store/types.js';
import { createShownStore } from './shown-store.js';

const layer = (id: string, table: boolean): Layer =>
  ({
    id,
    name: id,
    visible: true,
    locked: false,
    opacity: 1,
    styleRule: undefined,
    metadata: undefined,
    ...(table ? { kind: 'table' } : { items: [] }),
  }) as Layer;

const point = (id: string, layerId: string): Feature => ({
  id,
  type: 'Point',
  geometry: { type: 'Point', coordinates: [0, 0] },
  layerId,
  groupId: undefined,
  properties: {},
  style: {},
  visible: true,
  locked: false,
});

function setup() {
  const own = new MemoryStore();
  own.createLayer(layer('live', false));
  own.createFeature(point('a', 'live'));
  own.setSelection('feature', ['a']);
  const { store: other } = createTableStore();
  other.createLayer(layer('version', true));
  other.createFeature(point('b', 'version'));
  return { own, other, shown: createShownStore(own) };
}

describe('the Store the drawing reads', () => {
  it('reads the Store of the instance while no other document is shown', () => {
    const { own, shown } = setup();
    expect(shown.store.getLayerOrder()).toEqual(['live']);
    expect(shown.store.getFeature('a')).toBe(own.getFeature('a'));
    expect(shown.store.getSelection().ids).toEqual(['a']);
    expect(shown.store.tables).toBeUndefined();
  });

  it('reads the document shown in place of the document, without the state of this client', () => {
    const { own, other, shown } = setup();
    shown.setShown(other);
    expect(shown.getShown()).toBe(other);
    expect(shown.store.getLayerOrder()).toEqual(['version']);
    expect(shown.store.getLayer('live')).toBeUndefined();
    expect(shown.store.getLayer('version')?.kind).toBe('table');
    expect(shown.store.tables).toBe(other.tables);
    expect(shown.store.getFeature('a')).toBeUndefined();
    // The selection of the document is not drawn on the other one
    expect(shown.store.getSelection()).toEqual({ type: null, ids: [] });
    expect(shown.store.getTentative()).toBeNull();
    expect(shown.store.getDragState()).toBeNull();
    // Writes and the rest go to the Store of the instance
    expect(shown.store.holdLimit).toBe(own.holdLimit);
    expect(own.getSelection().ids).toEqual(['a']);
    shown.setShown(null);
    expect(shown.store.getLayerOrder()).toEqual(['live']);
    expect(shown.store.getSelection().ids).toEqual(['a']);
  });

  it('leaves the state of this client out while asked, the document read as it is', () => {
    const { shown } = setup();
    shown.setEditingHidden(true);
    expect(shown.store.getSelection()).toEqual({ type: null, ids: [] });
    expect(shown.store.getFeature('a')?.id).toBe('a');
    expect(shown.store.getEditingIds()).toEqual([]);
    expect(shown.store.getVertexSelection()).toBeNull();
    shown.setEditingHidden(false);
    expect(shown.store.getSelection().ids).toEqual(['a']);
  });

  it('subscribes to the Store of the instance', () => {
    const { own, other, shown } = setup();
    shown.setShown(other);
    let notified = 0;
    const stop = shown.store.subscribe(() => notified++);
    own.createFeature(point('c', 'live'));
    expect(notified).toBe(1);
    stop();
  });
});
