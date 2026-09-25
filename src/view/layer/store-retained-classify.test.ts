// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the origin fallback of a chunk (the classification itself is pinned down in
 * store-retained.test.ts together with the run boundaries)
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FEATURE_STYLE_CONFIG,
  type FeatureStyleConfig,
} from '../../shared/config/feature-style.js';
import type { Feature, FeatureStyle } from '../../store/types.js';
import { createFeatureCompanionRegistry } from '../feature-companion.js';
import { FeatureDrawer } from '../renderers/drawer.js';
import type { ImageRenderer } from '../renderers/image.js';
import type { SDFLineRenderer } from '../renderers/line/sdf-line.js';
import type { PointShapeRenderer } from '../renderers/point/point-shape.js';
import { classifyFeature, featureOrigin } from './store-retained-classify.js';

function makeFeature(type: Feature['type'], coordinates: unknown): Feature {
  return { id: 'f', type, coordinates, layerId: 'layer-1', properties: {} } as Feature;
}

describe('featureOrigin', () => {
  it('takes the first coordinate whatever the nesting', () => {
    expect(featureOrigin(makeFeature('Point', [1, 2]))).toEqual([1, 2]);
    expect(featureOrigin(makeFeature('Circle', [3, 4]))).toEqual([3, 4]);
    expect(featureOrigin(makeFeature('MultiPoint', [[5, 6]]))).toEqual([5, 6]);
    expect(featureOrigin(makeFeature('LineString', [[7, 8]]))).toEqual([7, 8]);
    expect(featureOrigin(makeFeature('MultiLineString', [[[9, 10]]]))).toEqual([9, 10]);
    expect(featureOrigin(makeFeature('Polygon', [[[11, 12]]]))).toEqual([11, 12]);
    expect(featureOrigin(makeFeature('MultiPolygon', [[[[13, 14]]]]))).toEqual([13, 14]);
  });

  it('falls back to the origin of the world without a coordinate', () => {
    expect(featureOrigin(undefined)).toEqual([0, 0]);
    expect(featureOrigin(makeFeature('LineString', []))).toEqual([0, 0]);
    expect(featureOrigin(makeFeature('Point', 'bad'))).toEqual([0, 0]);
  });
});

describe('classifyFeature with the style resolution of the renderer', () => {
  /** A drawer built from stubs: the style resolution touches neither GL nor the map */
  function createDrawer(featureStyle: FeatureStyleConfig): FeatureDrawer {
    const gl = {
      createBuffer: (): object => ({}),
      createVertexArray: (): object => ({}),
      bindBuffer: (): void => {},
      bindVertexArray: (): void => {},
      enableVertexAttribArray: (): void => {},
      vertexAttribPointer: (): void => {},
    } as unknown as WebGL2RenderingContext;
    return new FeatureDrawer({
      gl,
      map: {} as never,
      sdfLineRenderer: {} as SDFLineRenderer,
      pointShapeRenderer: {} as PointShapeRenderer,
      imageRenderer: {} as ImageRenderer,
      featureStyle,
    });
  }

  function pointWith(style?: FeatureStyle): Feature {
    return { ...makeFeature('Point', [0, 0]), style };
  }

  const customTypes = new Map<string, unknown>();
  const companions = createFeatureCompanionRegistry();

  it('puts a point in the run of the shape its own style names', () => {
    const drawer = createDrawer(DEFAULT_FEATURE_STYLE_CONFIG);
    const classify = (style?: FeatureStyle): string =>
      classifyFeature(pointWith(style), drawer, customTypes, companions);

    expect(classify({ pointShape: 'square' })).toBe('point-square');
    expect(classify({ pointShape: 'triangle' })).toBe('point-triangle');
    expect(classify({ pointShape: 'star' })).toBe('point-star');
    expect(classify({ pointShape: 'circle' })).toBe('point-circle');
  });

  it('puts a point without a shape in the run of the default of the instance', () => {
    const base = DEFAULT_FEATURE_STYLE_CONFIG;
    const drawer = createDrawer({
      ...base,
      point: { ...base.point, point: { ...base.point.point, shape: 'star' } },
    });

    expect(classifyFeature(pointWith(), drawer, customTypes, companions)).toBe('point-star');
    expect(
      classifyFeature(pointWith({ pointColor: '#00ff00' }), drawer, customTypes, companions),
    ).toBe('point-star');
    expect(
      classifyFeature(pointWith({ pointShape: 'square' }), drawer, customTypes, companions),
    ).toBe('point-square');
  });
});
