// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the created zoom that the drawing modes record
 *
 * A feature with a created zoom has line widths that follow the map (twice as wide one zoom
 * level in); one without it keeps its widths on the screen. The drawing modes record it unless
 * the instance turns it off (`Options.scaleWithZoom: false`, carried by the ModeContext), so by
 * default the widths of a drawn feature follow the zoom.
 */

import type { Map as MapLibreMap } from 'maplibre-gl';
import { describe, expect, it } from 'vitest';
import type {
  ModeHandler as ContractModeHandler,
  DrawPointerEvent,
  ModeFactory,
} from '../../api/v2/extension/mode.js';
import type { KeyNormalizedEvent, MouseNormalizedEvent } from '../../dispatcher/types.js';
import { MemoryStore } from '../../store/memory.js';
import { RBushSpatialIndex } from '../../store/spatial/spatial-index.js';
import type { Mode } from '../../store/types.js';
import { createModeHarness } from '../../test-utils.js';
import type { ModeContext, ModeHandler } from '../handler.js';
import { ModeManagerImpl } from '../manager.js';
import { drawCircleMode } from './circle.js';
import { DrawLineMode } from './line.js';
import { drawPointMode } from './point.js';
import { DrawPolygonMode } from './polygon.js';

const ZOOM = 12.5;

function click(lng: number, lat: number): MouseNormalizedEvent {
  return {
    type: 'click',
    point: { x: lng * 1000, y: lat * 1000 },
    lngLat: { lng, lat },
    originalEvent: {} as unknown as MouseEvent,
    modifiers: { shift: false, ctrl: false, alt: false, meta: false },
  } as unknown as MouseNormalizedEvent;
}

const ENTER = {
  type: 'keydown',
  key: 'Enter',
  code: 'Enter',
  modifiers: { shift: false, ctrl: false, alt: false, meta: false },
  originalEvent: { preventDefault() {} } as unknown as KeyboardEvent,
} as unknown as KeyNormalizedEvent;

/** Draws one feature with the mode and returns its properties */
function drawWith(
  handler: ModeHandler,
  scaleWithZoom: boolean,
  input: (handler: ModeHandler) => void,
): Record<string, unknown> {
  const store = new MemoryStore();
  store.createLayer({
    id: 'a',
    name: 'a',
    visible: true,
    locked: false,
    opacity: 1,
    items: [],
    styleRule: undefined,
    metadata: undefined,
  });
  let idCounter = 0;
  const canvas = { style: { cursor: '' } };
  handler.onStart?.({
    map: {
      getCanvas: () => canvas,
      getZoom: () => ZOOM,
      getCenter: () => ({ lng: 0, lat: 0 }),
      project: (c: [number, number]) => ({ x: c[0] * 1000, y: c[1] * 1000 }),
      dragPan: { enable: () => {}, disable: () => {} },
      doubleClickZoom: { enable: () => {}, disable: () => {} },
      triggerRepaint: () => {},
    },
    store,
    spatialIndex: new RBushSpatialIndex(),
    eventEmitter: { emit: () => {} },
    autoNameGenerator: { generateName: () => undefined },
    generateFeatureId: () => `f${++idCounter}`,
    getCurrentLayerId: () => 'a',
    setMode: (mode: Mode) => store.setMode(mode),
    scaleWithZoom,
  } as unknown as ModeContext);
  input(handler);
  const [feature] = store.listFeatures();
  expect(feature).toBeDefined();
  return feature.properties;
}

const MODES: Array<[string, () => ModeHandler, (handler: ModeHandler) => void]> = [
  [
    'a line',
    () => new DrawLineMode(),
    (h) => {
      h.onClick?.(click(1, 1));
      h.onClick?.(click(2, 2));
      h.onKeyDown?.(ENTER);
    },
  ],
  [
    'a polygon',
    () => new DrawPolygonMode(),
    (h) => {
      h.onClick?.(click(1, 1));
      h.onClick?.(click(2, 1));
      h.onClick?.(click(2, 2));
      h.onKeyDown?.(ENTER);
    },
  ],
];

function pointer(lng: number, lat: number): DrawPointerEvent {
  return {
    point: [lng * 1000, lat * 1000],
    lngLat: [lng, lat],
    snapped: { lngLat: [lng, lat] },
    modifiers: { shift: false, ctrl: false, alt: false, meta: false },
    pointerType: 'mouse',
    original: {} as PointerEvent,
  };
}

/** Draws one feature with a mode of the extension contract and returns its properties */
function drawWithContract(
  factory: ModeFactory,
  scaleWithZoom: boolean,
  input: (handler: ContractModeHandler) => void,
): Record<string, unknown> {
  const store = new MemoryStore();
  store.createLayer({
    id: 'a',
    name: 'a',
    visible: true,
    locked: false,
    opacity: 1,
    items: [],
    styleRule: undefined,
    metadata: undefined,
  });
  const canvas = { style: { cursor: '' } };
  const map = { getCanvas: () => canvas, getZoom: () => ZOOM } as unknown as MapLibreMap;
  const modeManager = new ModeManagerImpl(store);
  const harness = createModeHarness({ store, map, modeManager, scaleWithZoom });
  const handler = factory(harness.modeContext());
  handler.onEnter?.();
  input(handler);
  const [feature] = store.listFeatures();
  expect(feature).toBeDefined();
  return feature.properties;
}

const CONTRACT_MODES: Array<[string, ModeFactory, (handler: ContractModeHandler) => void]> = [
  ['a point', drawPointMode, (h) => h.onClick?.(pointer(1, 1))],
  [
    'a circle',
    drawCircleMode,
    (h) => {
      h.onClick?.(pointer(1, 1));
      h.onPointerMove?.(pointer(1.01, 1));
      h.onClick?.(pointer(1.01, 1));
    },
  ],
];

describe('the created zoom of a drawn feature', () => {
  it.each(MODES)('is recorded on %s when the widths follow the zoom', (_name, create, input) => {
    expect(drawWith(create(), true, input)['maplibre-gl-draw:createdZoom']).toBe(ZOOM);
  });

  it.each(MODES)(
    'is not recorded on %s when the widths stay the same on the screen',
    (_name, create, input) => {
      expect(drawWith(create(), false, input)).not.toHaveProperty(['maplibre-gl-draw:createdZoom']);
    },
  );
});

describe('the created zoom of a feature drawn by a mode of the extension contract', () => {
  it.each(CONTRACT_MODES)(
    'is recorded on %s when the widths follow the zoom',
    (_n, factory, input) => {
      expect(drawWithContract(factory, true, input)['maplibre-gl-draw:createdZoom']).toBe(ZOOM);
    },
  );

  it.each(CONTRACT_MODES)(
    'is not recorded on %s when the widths stay the same on the screen',
    (_n, factory, input) => {
      expect(drawWithContract(factory, false, input)).not.toHaveProperty([
        'maplibre-gl-draw:createdZoom',
      ]);
    },
  );
});
