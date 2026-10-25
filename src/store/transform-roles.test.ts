// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The roles of the fields of a feature the edits that move, rotate and scale features change
 *
 * - An Image has its rotation and its scale, and keeps its shape; a Circle has its radius, and
 *   keeps its shape; any feature that has a rotation or a scale has them
 * - The rotate drag writes the rotation of the features that have one, and the resize drag the
 *   scale of the ones that have one and the radius of a Circle
 * - The values given the computation: the fields there, null for the ones not there yet
 */

import { describe, expect, it } from 'vitest';
import { transformedUpdates, transformStartOf } from '../operations/transform-features.js';
import { DRAW_PROPERTY_KEYS } from '../shared/properties.js';
import { DEFAULT_TRANSFORMS } from './feature-edits.js';
import type { TransformEdit } from './store.js';
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

  it('has the rotate drag write the rotation of the features with one, and the resize drag their size', () => {
    const rotate: TransformEdit = { kind: 'rotate', center: [139.6, 35.5], angleDegrees: 30 };
    const scale: TransformEdit = {
      kind: 'scale',
      center: [139.6, 35.5],
      eastFactor: 2,
      northFactor: 0.5,
      sizeFactor: 1.5,
    };
    for (const f of features()) {
      const roles = rolesOf(f);
      const start = transformStartOf(f);
      const rotated = transformedUpdates(DEFAULT_TRANSFORMS, rotate, start, f)?.properties ?? {};
      expect(typeof rotated[ROTATION] === 'number', f.id).toBe(roles.angleDegrees !== undefined);
      const scaled = transformedUpdates(DEFAULT_TRANSFORMS, scale, start, f)?.properties ?? {};
      const sizeKey = f.type === 'Circle' ? RADIUS : SCALE;
      expect(
        typeof scaled[sizeKey] === 'number' && scaled[sizeKey] !== f.properties[sizeKey],
        f.id,
      ).toBe(roles.size === sizeKey);
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
