// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the suppression of the operation cursor in updateCursorForSelection
 *
 * For a selection whose editing operations are suppressed (effective lock / read-only /
 * interaction lock), no operation cursor such as move or resize is shown and it falls through to
 * the feature hit test (pointer / default). Because it uses the same predicate,
 * isInteractionBlocked, as the drag start (startDrag), the cursor agrees with what is actually
 * possible.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { MouseNormalizedEvent } from '../../dispatcher/types.js';
import { DEFAULT_SELECTION_CONFIG } from '../../shared/config/selection.js';
import { MemoryStore } from '../../store/memory.js';
import type { Feature } from '../../store/types.js';
import { createSelectionScope } from '../../view/ui/selection-scope.js';
import type { ModeContext } from '../handler.js';
import { updateCursorForSelection } from './cursor-handler.js';

function polygon(id: string, layerId: string): Feature {
  return {
    id,
    type: 'Polygon',
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [0, 0],
          [10, 0],
          [10, 10],
          [0, 10],
          [0, 0],
        ],
      ],
    },
    layerId,
    properties: {},
    locked: false,
    visible: true,
    style: {},
  };
}

// A mock that maps longitude and latitude naively and linearly (1 degree = 10px). It has
// project / unproject as a pair so that the real coordinate computation of the hit test runs
// through unchanged.
function makeMap(canvas: { style: { cursor: string } }) {
  return {
    getCanvas: () => canvas,
    getZoom: () => 10,
    project: (lngLat: [number, number] | { lng: number; lat: number }) => {
      const lng = Array.isArray(lngLat) ? lngLat[0] : lngLat.lng;
      const lat = Array.isArray(lngLat) ? lngLat[1] : lngLat.lat;
      return { x: lng * 10, y: -lat * 10 };
    },
    unproject: (p: [number, number] | { x: number; y: number }) => {
      const x = Array.isArray(p) ? p[0] : p.x;
      const y = Array.isArray(p) ? p[1] : p.y;
      return { lng: x / 10, lat: -y / 10 };
    },
  };
}

let store: MemoryStore;
let canvas: { style: { cursor: string } };
let context: ModeContext;
let hit: Feature | null;

// The screen coordinate of the polygon center (5,5). Being inside the bbox, it normally becomes
// the move cursor.
const centerEvent = { point: { x: 50, y: -50 } } as unknown as MouseNormalizedEvent;

beforeEach(() => {
  store = new MemoryStore();
  store.createLayer({ id: 'l1', name: 'l1', visible: true, locked: false, opacity: 1, items: [] });
  store.createFeature(polygon('f1', 'l1'));
  store.setSelection('feature', ['f1']);
  canvas = { style: { cursor: '' } };
  hit = null;
  context = {
    store,
    map: makeMap(canvas),
    hitTestService: { hitTest: () => hit },
    // A stub for the unified z traversal (it returns only Store features)
    hitTestTopmost: () => (hit ? { kind: 'store', feature: hit } : null),
    selectionScope: createSelectionScope(),
  } as unknown as ModeContext;
});

describe('updateCursorForSelection', () => {
  it('a normal selection shows the move cursor inside the bbox (control)', () => {
    updateCursorForSelection(centerEvent, context, DEFAULT_SELECTION_CONFIG);
    expect(canvas.style.cursor).toBe('move');
  });

  it('while locked no operation cursor is shown in the bbox; over a feature it is pointer', () => {
    store.setInteractionLock(true);
    hit = store.getFeature('f1') ?? null;
    updateCursorForSelection(centerEvent, context, DEFAULT_SELECTION_CONFIG);
    expect(canvas.style.cursor).toBe('pointer');
  });

  it('while read-only no operation cursor is shown; outside a feature it is default', () => {
    store.setReadOnly(true);
    hit = null;
    updateCursorForSelection(centerEvent, context, DEFAULT_SELECTION_CONFIG);
    expect(canvas.style.cursor).toBe('default');
  });

  it('no operation cursor is shown for a selection of a locked feature either', () => {
    store.updateFeature('f1', { locked: true });
    hit = store.getFeature('f1') ?? null;
    updateCursorForSelection(centerEvent, context, DEFAULT_SELECTION_CONFIG);
    expect(canvas.style.cursor).toBe('pointer');
  });
});
