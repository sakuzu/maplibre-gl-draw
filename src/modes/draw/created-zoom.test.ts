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
import { MemoryStore } from '../../store/memory.js';
import { createModeHarness, keyInput } from '../../test-utils.js';
import { ModeManagerImpl } from '../manager.js';
import { drawCircleMode } from './circle.js';
import { drawLineMode } from './line.js';
import { drawPointMode } from './point.js';
import { drawPolygonMode } from './polygon.js';

const ZOOM = 12.5;

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
    'a line',
    drawLineMode,
    (h) => {
      h.onClick?.(pointer(1, 1));
      h.onClick?.(pointer(2, 2));
      h.onKeyDown?.(keyInput('Enter'));
    },
  ],
  [
    'a polygon',
    drawPolygonMode,
    (h) => {
      h.onClick?.(pointer(1, 1));
      h.onClick?.(pointer(2, 1));
      h.onClick?.(pointer(2, 2));
      h.onKeyDown?.(keyInput('Enter'));
    },
  ],
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
