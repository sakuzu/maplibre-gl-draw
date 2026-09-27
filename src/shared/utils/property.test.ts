// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests of the property helpers
 *
 * Verifies the getter/setter round trip of the internal meta (zoom) and the defaults of
 * rotation and scale.
 */

import { describe, expect, it } from 'vitest';
import type { Feature } from '../../store/types.js';
import { drawPropertyKey } from '../properties.js';
import { getCreatedZoom, getRotation, getScale, setCreatedZoom } from './property.js';

function featureWith(properties: Record<string, unknown>): Feature {
  return {
    id: 'f',
    type: 'Point',
    geometry: { type: 'Point', coordinates: [0, 0] },
    layerId: 'l1',
    groupId: undefined,
    properties,
    locked: false,
    visible: true,
    style: {},
  };
}

describe('getter/setter round trip of the internal meta', () => {
  it('createdZoom', () => {
    const props: Record<string, unknown> = {};
    setCreatedZoom(props, 12);
    expect(props[drawPropertyKey('createdZoom')]).toBe(12);
    expect(getCreatedZoom(featureWith(props))).toBe(12);
  });

  it('rotation defaults to 0', () => {
    expect(getRotation(featureWith({}))).toBe(0);
    expect(getRotation(featureWith({ [drawPropertyKey('rotation')]: 1.5 }))).toBe(1.5);
  });

  it('scale defaults to 1', () => {
    expect(getScale(featureWith({}))).toBe(1);
    expect(getScale(featureWith({ [drawPropertyKey('scale')]: 2 }))).toBe(2);
  });
});
