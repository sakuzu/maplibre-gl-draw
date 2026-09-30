// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the click that selects a line, and the stroke and the fill of a polygon, driven
 * through the input router as the pointer drives it (a press, a release, then the click)
 *
 * A line is hit within the click tolerance of its path, whatever width it is drawn at: a line
 * created at a higher zoom is drawn well under one pixel wide when the map is zoomed out, and it
 * still takes a click on it. This holds for a feature written through the instance and for one
 * a replaced Store held before the instance, and with the extensions a host registers around
 * the select mode: a companion provider, a handle provider, a plugin whose input receivers
 * leave every event to the mode, and an override of `Point` that takes only some points. The
 * map stub projects one degree to one hundred pixels.
 */

import type { Map as MapLibreMap } from 'maplibre-gl';
import { afterEach, describe, expect, it } from 'vitest';
import type { MouseNormalizedEvent } from '../../dispatcher/types.js';
import { DRAW_PROPERTY_KEYS } from '../../shared/properties.js';
import { MemoryContractStore } from '../../store/memory.js';
import { createMapStub } from '../../test-utils.js';
import type { Draw } from '../draw.js';
import type { Store } from '../extension/store.js';
import type { Feature, Layer } from '../model.js';
import { createDrawOnEngine } from './create-draw.js';
import type { Engine } from './engine.js';
import { createEngine } from './engine.js';

/** The zoom of the map stub: lower than the zoom the features were created at */
const MAP_ZOOM = 10;

const MODIFIERS = { shift: false, ctrl: false, alt: false, meta: false };

/** A path of the line, and the ring of the polygon (one degree is one hundred pixels) */
const LINE_PATH: [number, number][] = [
  [-2, -1],
  [0, -1],
  [1, -0.5],
];
const RING: [number, number][] = [
  [1, 1],
  [2, 1],
  [2, 2],
  [1, 2],
  [1, 1],
];

const LAYER = {
  id: 'held',
  name: 'Held',
  visible: true,
  locked: false,
  opacity: 1,
  items: [],
} as unknown as Layer;

let engine: Engine | null = null;
let draw: Draw | null = null;

afterEach(() => {
  draw?.destroy();
  draw = null;
  engine = null;
});

/** A draw instance over the map stub at MAP_ZOOM, over the given Store or the built-in one */
function create(store?: Store): { engine: Engine; draw: Draw } {
  const { map } = createMapStub();
  (map as unknown as { getZoom: () => number }).getZoom = () => MAP_ZOOM;
  const options = store ? { store, initDefaultLayer: false } : {};
  engine = createEngine(map as MapLibreMap, options, { deferDefaultMode: true });
  draw = createDrawOnEngine(engine, options);
  engine.enterDefaultMode();
  return { engine, draw };
}

/** The original event of a synthetic press, release or click */
function original(type: string, point: { x: number; y: number }): MouseEvent {
  return {
    type,
    button: 0,
    buttons: type === 'mousedown' ? 1 : 0,
    clientX: point.x,
    clientY: point.y,
    target: null,
    preventDefault() {},
    stopPropagation() {},
  } as unknown as MouseEvent;
}

/** A move, a press, a release and the click of the pointer at a position */
function pointerClick(target: Engine, lngLat: [number, number]): void {
  const projected = target.map.project(lngLat);
  const point = { x: projected.x, y: projected.y };
  for (const type of ['mousemove', 'mousedown', 'mouseup', 'click'] as const) {
    const event: MouseNormalizedEvent = {
      type,
      point,
      lngLat: { lng: lngLat[0], lat: lngLat[1] },
      originalEvent: original(type, point),
      modifiers: MODIFIERS,
      snap: false,
    };
    target.inputRouter.dispatch(event);
  }
}

/** The line and the polygon, created at `createdZoom` */
function inputs(createdZoom: number, path: [number, number][] = LINE_PATH) {
  const properties = { [DRAW_PROPERTY_KEYS.createdZoom]: createdZoom };
  return {
    line: {
      type: 'LineString' as const,
      geometry: { type: 'LineString' as const, coordinates: path },
      properties,
      style: { strokeWidth: 2 },
    },
    polygon: {
      type: 'Polygon' as const,
      geometry: { type: 'Polygon' as const, coordinates: [RING] },
      properties,
      style: { strokeWidth: 2 },
    },
  };
}

/** The line and the polygon written through the instance */
function throughTheInstance(createdZoom: number, path?: [number, number][]) {
  const created = create();
  const { line, polygon } = inputs(createdZoom, path);
  const l = created.draw.features.create(line);
  const g = created.draw.features.create(polygon);
  if (!l || !g) throw new Error('not created');
  return { ...created, lineId: l.id, polygonId: g.id };
}

/** The line and the polygon a replaced Store held before the instance was created */
function heldByTheStore(createdZoom: number, path?: [number, number][]) {
  const contract = new MemoryContractStore();
  const { line, polygon } = inputs(createdZoom, path);
  const base = { layerId: LAYER.id, groupId: undefined, visible: true, locked: false };
  contract.transact(() => {
    contract.createLayer(LAYER);
    contract.createFeature({ ...line, ...base, id: 'line' } as Feature);
    contract.createFeature({ ...polygon, ...base, id: 'polygon' } as Feature);
  }, 'remote');
  return { ...create(contract), lineId: 'line', polygonId: 'polygon' };
}

/** The extensions a host registers around the select mode */
type Extras = 'companion' | 'handles' | 'input' | 'point override';

function register(target: Draw, extras: readonly Extras[]): void {
  if (extras.includes('companion')) {
    // A companion of every feature that is hit nowhere, as leader lines are for a feature that
    // has none
    target.extensions.companionProviders.add({
      name: 'lead',
      has: () => true,
      draw() {},
      hitTest: () => null,
      onClick: () => true,
    });
  }
  if (extras.includes('handles')) {
    target.extensions.handleProviders.add({
      name: 'grips',
      handles: () => [],
      globalHandles: () => [],
      onDrag: () => null,
    });
  }
  if (extras.includes('input')) {
    // Receivers that consume nothing unless the host holds the pointer
    const held = () => false;
    target.extensions.plugins.add({
      name: 'hold',
      onAdd() {},
      input: {
        onPointerDown: held,
        onPointerMove: held,
        onPointerUp: held,
        onClick: held,
        onDoubleClick: held,
        onDragStart: held,
        onDrag: held,
        onDragEnd: held,
      },
    });
  }
  if (extras.includes('point override')) {
    target.extensions.featureTypes.override({
      type: 'Point',
      geometry: 'Point',
      appliesTo: (feature) => feature.properties.icon !== undefined,
      renderer: { onAdd() {}, draw() {}, onRemove() {} },
      hitPaddingPx: 70,
      hitTest: () => null,
    });
  }
}

const CASES = [
  ['through the instance', throughTheInstance],
  ['held by a replaced Store', heldByTheStore],
] as const;

const EXTRAS: ReadonlyArray<{ extras: readonly Extras[] }> = [
  { extras: [] },
  { extras: ['companion'] },
  { extras: ['handles'] },
  { extras: ['companion', 'handles'] },
  { extras: ['companion', 'handles', 'input', 'point override'] },
];

describe.each(CASES)('a line and a polygon %s', (_name, setup) => {
  describe.each(EXTRAS)('with the extensions $extras', ({ extras }) => {
    // Created four zoom levels above the map (drawn at a sixteenth of its width) and at the
    // zoom of the map
    it.each([14, MAP_ZOOM])('selects them with a click, created at zoom %d', (createdZoom) => {
      const { engine: target, draw: instance, lineId, polygonId } = setup(createdZoom);
      register(instance, extras);
      const clicks: Array<[[number, number], string]> = [
        // On the path of the line, on a vertex, and 4 px beside it
        [[-1, -1], lineId],
        [[0, -1], lineId],
        [[0.5, -0.75], lineId],
        [[-1, -0.96], lineId],
        [[-1, -1.04], lineId],
        // On the stroke of the polygon from outside, on its edge, and inside its fill
        [[1.5, 0.96], polygonId],
        [[2, 1.5], polygonId],
        [[1.5, 1.5], polygonId],
      ];
      for (const [at, expected] of clicks) {
        instance.selection.clear();
        pointerClick(target, at);
        expect({ at, ids: instance.selection.get().ids }).toEqual({ at, ids: [expected] });
      }
      // Beyond the tolerance of the line (6 px), nothing is selected
      pointerClick(target, [-1, -1.08]);
      expect(instance.selection.get().ids).toEqual([]);
    });
  });

  it('selects a line of a few thousand vertices with a click on its path', () => {
    const path: [number, number][] = [];
    for (let i = 0; i <= 2000; i++) path.push([-2 + i * 0.0015, -1 + (i % 2) * 0.001]);
    const { engine: target, draw: instance, lineId } = setup(14, path);
    register(instance, ['companion', 'handles']);
    pointerClick(target, [-0.5, -1]);
    expect(instance.selection.get().ids).toEqual([lineId]);
  });
});
