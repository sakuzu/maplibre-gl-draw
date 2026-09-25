// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the Snapping API (draw.snapping)
 *
 * Verifies that the SnapService can be driven from the public API (registering and
 * unregistering a provider, enabling and disabling it, getting the most recent result,
 * and an explicit resolve).
 */

import type { Map as MapLibreMap } from 'maplibre-gl';
import { beforeEach, describe, expect, it } from 'vitest';
import { createSnapService } from '../snapping/service.js';
import type { SnapProvider, SnapService } from '../snapping/types.js';
import { createSnappingApi } from './snapping-api.js';

const ZOOM = 14;
const DEG_PER_PIXEL_LNG = 360 / (512 * 2 ** ZOOM);
const TARGET: [number, number] = [139.7, 35.68];

let snapService: SnapService;
let projected: Array<[number, number]>;
let map: MapLibreMap;

/** A provider that returns a fixed vertex candidate */
const vertexProvider: SnapProvider = {
  name: 'test',
  candidates: () => [{ kind: 'vertex', coordinate: TARGET, featureId: 'f1' }],
};

beforeEach(() => {
  snapService = createSnapService();
  projected = [];
  map = {
    getZoom: () => ZOOM,
    project: (coord: [number, number]) => {
      projected.push(coord);
      return { x: 1, y: 2 };
    },
  } as unknown as MapLibreMap;
});

describe('draw.snapping', () => {
  it('adds a provider with register and removes it with the returned value', () => {
    const { snapping } = createSnappingApi({ snapService, map });
    const unregister = snapping.register(vertexProvider);

    const cursor = { lng: TARGET[0] + 3 * DEG_PER_PIXEL_LNG, lat: TARGET[1] };
    expect(snapping.resolve(cursor).target).toEqual({ kind: 'vertex', featureId: 'f1' });

    unregister();
    expect(snapping.resolve(cursor).target).toBeUndefined();
  });

  it('makes setEnabled / isEnabled reach the SnapService', () => {
    const { snapping } = createSnappingApi({ snapService, map });
    expect(snapping.isEnabled()).toBe(true);

    snapping.setEnabled(false);

    expect(snapping.isEnabled()).toBe(false);
    expect(snapService.isEnabled()).toBe(false);
  });

  it('computes the screen coordinate with map.project when resolve omits it', () => {
    const { snapping } = createSnappingApi({ snapService, map });
    snapping.register(vertexProvider);

    const result = snapping.resolve({ lng: TARGET[0], lat: TARGET[1] });

    expect(projected).toEqual([[TARGET[0], TARGET[1]]]);
    expect(result.lngLat).toEqual({ lng: TARGET[0], lat: TARGET[1] });
  });

  it('allows the context of resolve to be overridden (exclusions, modifier keys)', () => {
    const { snapping } = createSnappingApi({ snapService, map });
    snapping.register(vertexProvider);
    const cursor = { lng: TARGET[0] + 3 * DEG_PER_PIXEL_LNG, lat: TARGET[1] };

    const disabled = snapping.resolve(
      cursor,
      { x: 0, y: 0 },
      {
        modifiers: { shift: false, ctrl: false, alt: true, meta: false },
      },
    );

    expect(disabled.target).toBeUndefined();
  });

  it('returns the most recent result from getResult', () => {
    const { snapping } = createSnappingApi({ snapService, map });
    expect(snapping.getResult()).toBeNull();

    snapping.register(vertexProvider);
    const result = snapping.resolve({ lng: TARGET[0], lat: TARGET[1] });

    expect(snapping.getResult()).toEqual(result);
  });

  it('makes setGuideStep reach the SnapService, falling back to 45 for an invalid step', () => {
    const { snapping } = createSnappingApi({ snapService, map });
    expect(snapping.getOptions().guideStepDegrees).toBe(45);

    snapping.setGuideStep(15);
    expect(snapService.getOptions().guideStepDegrees).toBe(15);

    snapping.setGuideStep(-1);
    expect(snapping.getOptions().guideStepDegrees).toBe(45);
  });
});
