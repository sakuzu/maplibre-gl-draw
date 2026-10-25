// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The roles of the fields of a feature the edits that move, rotate and scale features change
 *
 * - An Image has its rotation and its scale, and keeps its shape; a Circle has its radius, and
 *   keeps its shape; any feature that has a rotation or a scale has them
 * - The features that have a rotation are the ones the rotate drag turns by their rotation, and
 *   the ones that have a scale (other than a Circle) the ones the resize drag scales by their
 *   scale
 * - The values given the computation: the fields there, null for the ones not there yet
 */

import { describe, expect, it } from 'vitest';
import { startResize } from '../operations/resize.js';
import { startRotation } from '../operations/rotate.js';
import { DRAW_PROPERTY_KEYS } from '../shared/properties.js';
import { transformRolesOf, transformValuesOf } from './transform-roles.js';
import type { Feature } from './types.js';

const ROTATION = DRAW_PROPERTY_KEYS.rotation;
const SCALE = DRAW_PROPERTY_KEYS.scale;
const RADIUS = DRAW_PROPERTY_KEYS.radiusMeters;

/** A feature of a type with properties */
function feature(type: string, properties: Record<string, unknown>): Feature {
  return {
    id: `${type}-${Object.keys(properties).join('-')}`,
    type,
    geometry: { type: 'Point', coordinates: [139.7, 35.6] },
    properties,
    layerId: 'layer',
    style: {},
    visible: true,
    locked: false,
  } as Feature;
}

/** The roles of a feature */
function rolesOf(f: Feature) {
  return transformRolesOf(f.type, (key) => key in f.properties);
}

/** Features of every kind the roles tell apart */
function features(): Feature[] {
  const out: Feature[] = [];
  const kinds: Array<Record<string, unknown>> = [
    {},
    { [ROTATION]: 30 },
    { [SCALE]: 2 },
    { [ROTATION]: 30, [SCALE]: 2 },
    { [ROTATION]: 'thirty' },
    { [RADIUS]: 100 },
    { name: 'other' },
  ];
  for (const type of [
    'Point',
    'LineString',
    'Polygon',
    'MultiPoint',
    'MultiLineString',
    'MultiPolygon',
    'Freehand',
    'Image',
    'Circle',
    'Custom',
  ]) {
    for (const properties of kinds) out.push(feature(type, properties));
  }
  return out;
}

describe('the roles of the fields of a feature', () => {
  it('gives an Image its rotation and its scale, a Circle its radius, and others what they have', () => {
    expect(rolesOf(feature('Image', {}))).toEqual({
      angleDegrees: ROTATION,
      size: SCALE,
      uniformScale: true,
    });
    expect(rolesOf(feature('Circle', { [RADIUS]: 10 }))).toEqual({
      size: RADIUS,
      uniformScale: true,
    });
    expect(rolesOf(feature('Polygon', { [ROTATION]: 1 }))).toEqual({
      angleDegrees: ROTATION,
      uniformScale: false,
    });
    expect(rolesOf(feature('Point', { [SCALE]: 1 }))).toEqual({ size: SCALE, uniformScale: true });
    expect(rolesOf(feature('LineString', { [RADIUS]: 1 }))).toEqual({ uniformScale: false });
  });

  it('has a rotation for the features the rotate drag turns by their rotation', () => {
    for (const f of features()) {
      const state = startRotation({ lng: 139.7, lat: 35.6 }, BOX, [f]);
      expect(rolesOf(f).angleDegrees !== undefined, f.id).toBe(state.initialRotations.has(f.id));
    }
  });

  it('has a scale for the features the resize drag scales by their scale, but a Circle', () => {
    for (const f of features()) {
      const state = startResize('resize-se', { lng: 139.7, lat: 35.6 }, BOX, [f]);
      const roles = rolesOf(f);
      if (f.type === 'Circle') {
        // A Circle scales its radius (the resize drag scales a scale it has instead)
        expect(roles.size, f.id).toBe(RADIUS);
        expect(roles.uniformScale, f.id).toBe(true);
        continue;
      }
      expect(roles.size === SCALE, f.id).toBe(state.initialScales.has(f.id));
      expect(roles.uniformScale, f.id).toBe(state.initialScales.has(f.id));
    }
  });

  it('gives the computation the fields there, and null for the ones not there yet', () => {
    const image = feature('Image', { [ROTATION]: 30 });
    const read = (key: string) => image.properties[key];
    expect(transformValuesOf(image.geometry, rolesOf(image), read)).toEqual({
      geometry: image.geometry,
      angleDegrees: 30,
      size: null,
      uniformScale: true,
    });
    const line = feature('LineString', {});
    expect(transformValuesOf(line.geometry, rolesOf(line), () => undefined)).toEqual({
      geometry: line.geometry,
    });
    const named = feature('Point', { [ROTATION]: 'thirty' });
    expect(
      transformValuesOf(named.geometry, rolesOf(named), (key) => named.properties[key]),
    ).toEqual({ geometry: named.geometry, angleDegrees: null });
  });
});

const BOX = {
  topLeft: [139.6, 35.7] as [number, number],
  topRight: [139.8, 35.7] as [number, number],
  bottomLeft: [139.6, 35.5] as [number, number],
  bottomRight: [139.8, 35.5] as [number, number],
  center: [139.7, 35.6] as [number, number],
};
