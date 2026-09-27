// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests of the property helpers
 *
 * Verifies the internal property test, the extraction of user properties, and the
 * getter/setter round trip of the internal meta (zoom/rotation/scale) and of
 * name/description.
 */

import { describe, expect, it } from 'vitest';
import type { Feature } from '../../store/types.js';
import { drawPropertyKey } from '../properties.js';
import {
  getCreatedZoom,
  getFeatureDescription,
  getFeatureName,
  getRotation,
  getScale,
  setCreatedZoom,
  setFeatureDescription,
  setFeatureName,
  setRotation,
  setScale,
} from './property.js';

function featureWith(properties: Record<string, unknown>): Feature {
  return {
    id: 'f',
    type: 'Point',
    coordinates: [0, 0],
    layerId: 'l1',
    properties,
    locked: false,
    visible: true,
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
    const props: Record<string, unknown> = {};
    setRotation(props, 1.5);
    expect(getRotation(featureWith(props))).toBe(1.5);
  });

  it('scale defaults to 1', () => {
    expect(getScale(featureWith({}))).toBe(1);
    const props: Record<string, unknown> = {};
    setScale(props, 2);
    expect(getScale(featureWith(props))).toBe(2);
  });
});

describe('name / description', () => {
  it('get/set of name', () => {
    expect(getFeatureName(featureWith({}))).toBeUndefined();
    const props: Record<string, unknown> = {};
    setFeatureName(props, '名前');
    expect(getFeatureName(featureWith(props))).toBe('名前');
  });

  it('get/set of description', () => {
    const props: Record<string, unknown> = {};
    setFeatureDescription(props, '説明');
    expect(getFeatureDescription(featureWith(props))).toBe('説明');
  });
});
