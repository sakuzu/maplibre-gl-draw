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

import { describe, expect, it } from 'vitest';
import type { KeyNormalizedEvent, MouseNormalizedEvent } from '../../dispatcher/types.js';
import { MemoryStore } from '../../store/memory.js';
import { RBushSpatialIndex } from '../../store/spatial/spatial-index.js';
import type { Mode } from '../../store/types.js';
import type { ModeContext, ModeHandler } from '../handler.js';
import { DrawCircleMode } from './circle.js';
import { DrawLineMode } from './line.js';
import { DrawPointMode } from './point.js';
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
  const [feature] = store.getAllFeatures();
  expect(feature).toBeDefined();
  return feature.properties;
}

const MODES: Array<[string, () => ModeHandler, (handler: ModeHandler) => void]> = [
  ['a point', () => new DrawPointMode(), (h) => h.onClick?.(click(1, 1))],
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
  [
    'a circle',
    () => new DrawCircleMode(),
    (h) => {
      h.onClick?.(click(1, 1));
      h.onMouseMove?.({ ...click(1.01, 1), type: 'mousemove' });
      h.onClick?.(click(1.01, 1));
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
