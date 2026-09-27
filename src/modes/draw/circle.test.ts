// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the circle drawing mode
 *
 * The radius handle is placed on the rendered circle with the direct problem on the sphere
 * (destinationPoint), so the bearing recorded while the pointer moves must be the great-circle
 * bearing for the handle to land on the pointer.
 */

import type { Map as MapLibreMap } from 'maplibre-gl';
import { describe, expect, it } from 'vitest';
import type { DrawPointerEvent } from '../../api/v2/extension/mode.js';
import { destinationPoint, haversineDistanceMeters } from '../../geometry/distance.js';
import { MemoryStore } from '../../store/memory.js';
import type { Coordinate } from '../../store/types.js';
import { createModeHarness } from '../../test-utils.js';
import { ModeManagerImpl } from '../manager.js';
import { drawCircleMode } from './circle.js';

function pointer(coord: Coordinate): DrawPointerEvent {
  return {
    point: [coord[0] * 1000, coord[1] * 1000],
    lngLat: coord,
    snapped: { lngLat: coord },
    modifiers: { shift: false, ctrl: false, alt: false, meta: false },
    pointerType: 'mouse',
    original: {} as PointerEvent,
  };
}

function start(store: MemoryStore) {
  const canvas = { style: { cursor: '' } };
  const map = {
    getCanvas: () => canvas,
    getZoom: () => 10,
  } as unknown as MapLibreMap;
  const modeManager = new ModeManagerImpl(store);
  const harness = createModeHarness({ store, map, modeManager, getWritableLayerId: () => 'l1' });
  const mode = drawCircleMode(harness.modeContext());
  mode.onEnter?.();
  return mode;
}

describe('the radius handle of the circle drawing mode', () => {
  it('the handle lands on the pointer at a high latitude (60 deg, 100 km, 45 deg)', () => {
    const store = new MemoryStore();
    const mode = start(store);
    const center: Coordinate = [10, 60];
    const target = destinationPoint(center, 100_000, 45);

    mode.onClick?.(pointer(center));
    mode.onPointerMove?.(pointer(target));

    const tentative = store.getTentative();
    expect(tentative?.type).toBe('Circle');
    if (tentative?.type !== 'Circle') return;
    const handle = destinationPoint(
      center,
      tentative.radiusMeters ?? 0,
      tentative.radiusHandleAngle ?? 0,
    );
    expect(haversineDistanceMeters(handle, target)).toBeLessThan(1);
  });
});
