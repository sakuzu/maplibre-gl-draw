// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for DrawCircleMode
 *
 * The radius handle is placed on the rendered circle with the direct problem on the sphere
 * (destinationPoint), so the bearing recorded while the pointer moves must be the great-circle
 * bearing for the handle to land on the pointer.
 */

import { describe, expect, it } from 'vitest';
import type { MouseNormalizedEvent } from '../../dispatcher/types.js';
import { destinationPoint, haversineDistanceMeters } from '../../geometry/distance.js';
import { MemoryStore } from '../../store/memory.js';
import type { Coordinate } from '../../store/types.js';
import type { ModeContext } from '../handler.js';
import { DrawCircleMode } from './circle.js';

function mouse(type: 'click' | 'mousemove', coord: Coordinate): MouseNormalizedEvent {
  return {
    type,
    point: { x: coord[0] * 1000, y: coord[1] * 1000 },
    lngLat: { lng: coord[0], lat: coord[1] },
    originalEvent: {} as unknown as MouseEvent,
    modifiers: { shift: false, ctrl: false, alt: false, meta: false },
  } as unknown as MouseNormalizedEvent;
}

function start(store: MemoryStore): DrawCircleMode {
  const mode = new DrawCircleMode();
  const canvas = { style: { cursor: '' } };
  mode.onStart({
    map: { getCanvas: () => canvas, getZoom: () => 10 },
    store,
    autoNameGenerator: { generateName: () => undefined },
    generateFeatureId: () => 'c1',
    getCurrentLayerId: () => 'l1',
    setMode: () => {},
  } as unknown as ModeContext);
  return mode;
}

describe('DrawCircleMode radius handle', () => {
  it('the handle lands on the pointer at a high latitude (60 deg, 100 km, 45 deg)', () => {
    const store = new MemoryStore();
    const mode = start(store);
    const center: Coordinate = [10, 60];
    const pointer = destinationPoint(center, 100_000, 45);

    mode.onClick(mouse('click', center));
    mode.onMouseMove(mouse('mousemove', pointer));

    const tentative = store.getTentative();
    expect(tentative?.type).toBe('Circle');
    if (tentative?.type !== 'Circle') return;
    const handle = destinationPoint(
      center,
      tentative.radiusMeters ?? 0,
      tentative.radiusHandleAngle ?? 0,
    );
    expect(haversineDistanceMeters(handle, pointer)).toBeLessThan(1);
  });
});
