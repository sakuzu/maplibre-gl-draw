// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the conversion of features into the data of a retained batch
 */

import { describe, expect, it } from 'vitest';
import { drawPropertyKey } from '../../shared/properties.js';
import type { FeatureCoordinates } from '../../shared/types/model.js';
import { geometryFromCoordinates } from '../../shared/utils/coordinates.js';
import type { Feature } from '../../store/types.js';
import type { RetainedStyleResolver } from '../renderers/retained.js';
import { collectLineItems, collectPoints, collectPolygons } from './store-retained-collect.js';

function makeFeature(
  id: string,
  type: Feature['type'],
  coordinates: FeatureCoordinates,
  properties: Record<string, unknown> = {},
): Feature {
  return {
    id,
    type,
    geometry: geometryFromCoordinates(type, coordinates),
    layerId: 'layer-1',
    properties,
    locked: false,
    visible: true,
    style: {},
  } as Feature;
}

function makeStyles(fillAlpha = 0.5, strokeOpacity = 1): RetainedStyleResolver {
  const stroke = { width: 3, color: [0, 0, 0, 1], opacity: strokeOpacity, lineStyle: 'solid' };
  return {
    getPointStyle: () => ({
      shape: 'circle',
      size: 10,
      fillColor: [1, 0, 0, 1],
      fillOpacity: 1,
      strokeColor: [0, 0, 0, 1],
      strokeWidth: 1,
      strokeOpacity: 1,
    }),
    getLineStringStrokeStyle: () => stroke,
    getPolygonStyles: () => ({ fillColor: [0, 0, 1, fillAlpha], strokeStyle: stroke }),
  } as unknown as RetainedStyleResolver;
}

const ZOOMED = { [drawPropertyKey('createdZoom')]: 12 };

describe('collectLineItems', () => {
  it('marks a feature without createdZoom as fixed width with a negative width', () => {
    const items = collectLineItems(
      [
        makeFeature('fixed', 'LineString', [
          [0, 0],
          [1, 1],
        ]),
        makeFeature(
          'scaled',
          'LineString',
          [
            [0, 0],
            [1, 1],
          ],
          ZOOMED,
        ),
      ],
      makeStyles(),
      undefined,
    );
    expect(items.map((item) => [item.featureId, item.strokeWidth, item.createdZoom])).toEqual([
      ['fixed', -3, 0],
      ['scaled', 3, 12],
    ]);
  });

  it('pushes each part of a MultiLineString and skips parts under 2 vertices', () => {
    const items = collectLineItems(
      [
        makeFeature('m', 'MultiLineString', [
          [
            [0, 0],
            [1, 1],
          ],
          [[2, 2]],
          [
            [3, 3],
            [4, 4],
          ],
        ]),
      ],
      makeStyles(),
      undefined,
    );
    expect(items).toHaveLength(2);
  });
});

describe('collectPolygons', () => {
  const ring = [
    [0, 0],
    [1, 0],
    [1, 1],
  ];

  it('skips a polygon with neither a fill nor an outline', () => {
    expect(
      collectPolygons([makeFeature('p', 'Polygon', [ring])], makeStyles(0, 0), undefined),
    ).toHaveLength(0);
  });

  it('pushes a fill-only polygon without an outline', () => {
    const [polygon] = collectPolygons(
      [makeFeature('p', 'Polygon', [ring])],
      makeStyles(0.5, 0),
      undefined,
    );
    expect(polygon.style.strokeOpacity).toBe(0);
    expect(polygon.style.strokeWidth).toBe(0);
  });

  it('numbers the parts of a MultiPolygon and turns a Circle into a ring', () => {
    const polygons = collectPolygons(
      [
        makeFeature('m', 'MultiPolygon', [[ring], [ring]]),
        makeFeature('c', 'Circle', [0, 0], { 'maplibre-gl-draw:radiusMeters': 1000 }),
        makeFeature('z', 'Circle', [0, 0]),
      ],
      makeStyles(),
      undefined,
    );
    expect(polygons.map((p) => [p.featureId, p.partIndex])).toEqual([
      ['m', 0],
      ['m', 1],
      ['c', 0],
    ]);
    expect(polygons[2].coordinates[0].length).toBeGreaterThan(3);
  });
});

describe('collectPoints', () => {
  it('pushes one instance per point of a MultiPoint', () => {
    const points = collectPoints(
      [
        makeFeature('p', 'Point', [0, 0]),
        makeFeature('m', 'MultiPoint', [
          [1, 1],
          [2, 2],
        ]),
      ],
      makeStyles(),
      undefined,
    );
    expect(points).toHaveLength(3);
  });
});
