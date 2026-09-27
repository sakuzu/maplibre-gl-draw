// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * BoxSelectionStrategies
 *
 * The basic BoxSelectionStrategy implementations of the core edition.
 * They provide the intersection test logic for box selection of each feature type.
 */

import {
  createOBB,
  DEFAULT_TILE_SIZE,
  getMetersPerPixel,
  getOBBCorners,
  metersToDegreesLat,
  metersToDegreesLng,
  pointInRectangle,
  rectangleIntersectsCircle,
  rectangleIntersectsLineString,
  rectangleIntersectsOBB,
  rectangleIntersectsPolygon,
} from '../../shared/math/index.js';
import { coordinatesOf } from '../../shared/utils/coordinates.js';
import { getCircleRadius, getImageProperties } from '../../shared/utils/property.js';
import type { BoundingBox, Coordinate, Feature } from '../../store/types.js';
import type { BoxSelectionStrategy } from './box-strategy.js';

/**
 * Box selection test for Point
 *
 * It tests whether the center coordinate is contained in the box.
 *
 * @internal
 */
export class PointBoxSelectionStrategy implements BoxSelectionStrategy {
  readonly featureType = 'Point' as const;

  intersects(feature: Feature, rect: BoundingBox): boolean {
    if (feature.type !== 'Point') return false;

    const coord = coordinatesOf(feature) as Coordinate;
    return pointInRectangle(coord, rect);
  }
}

/**
 * Box selection test for LineString
 *
 * It tests the intersection between the geometry and the selection box.
 * true when any vertex is inside the box, or any edge intersects the box.
 *
 * @internal
 */
export class LineStringBoxSelectionStrategy implements BoxSelectionStrategy {
  readonly featureType = 'LineString' as const;

  intersects(feature: Feature, rect: BoundingBox): boolean {
    if (feature.type !== 'LineString') return false;

    const coords = coordinatesOf(feature) as Coordinate[];
    return rectangleIntersectsLineString(rect, coords);
  }
}

/**
 * Box selection test for Polygon
 *
 * It tests the intersection between the geometry and the selection box.
 * true when any vertex of the polygon is inside the box,
 * or any vertex of the box is inside the polygon,
 * or any edge of the polygon intersects the box.
 *
 * @internal
 */
export class PolygonBoxSelectionStrategy implements BoxSelectionStrategy {
  readonly featureType = 'Polygon' as const;

  intersects(feature: Feature, rect: BoundingBox): boolean {
    if (feature.type !== 'Polygon') return false;

    const rings = coordinatesOf(feature) as Coordinate[][];
    return rectangleIntersectsPolygon(rect, rings);
  }
}

/**
 * Box selection test for MultiPoint
 *
 * true when any part (a point) is inside the box.
 *
 * @internal
 */
export class MultiPointBoxSelectionStrategy implements BoxSelectionStrategy {
  readonly featureType = 'MultiPoint' as const;

  intersects(feature: Feature, rect: BoundingBox): boolean {
    if (feature.type !== 'MultiPoint') return false;

    const parts = coordinatesOf(feature) as Coordinate[];
    return parts.some((coord) => pointInRectangle(coord, rect));
  }
}

/**
 * Box selection test for MultiLineString
 *
 * true when any part (a polyline) intersects the box.
 *
 * @internal
 */
export class MultiLineStringBoxSelectionStrategy implements BoxSelectionStrategy {
  readonly featureType = 'MultiLineString' as const;

  intersects(feature: Feature, rect: BoundingBox): boolean {
    if (feature.type !== 'MultiLineString') return false;

    const parts = coordinatesOf(feature) as Coordinate[][];
    return parts.some((coords) => rectangleIntersectsLineString(rect, coords));
  }
}

/**
 * Box selection test for MultiPolygon
 *
 * true when any part (an array of rings) intersects the box.
 *
 * @internal
 */
export class MultiPolygonBoxSelectionStrategy implements BoxSelectionStrategy {
  readonly featureType = 'MultiPolygon' as const;

  intersects(feature: Feature, rect: BoundingBox): boolean {
    if (feature.type !== 'MultiPolygon') return false;

    const parts = coordinatesOf(feature) as Coordinate[][][];
    return parts.some((rings) => rings.length > 0 && rectangleIntersectsPolygon(rect, rings));
  }
}

/**
 * Box selection test for Image
 *
 * It tests the intersection between the OBB (a bounding box that accounts for the
 * rotation) and the selection box.
 *
 * @internal
 */
export class ImageBoxSelectionStrategy implements BoxSelectionStrategy {
  readonly featureType = 'Image' as const;

  private tileSize: number;

  constructor(tileSize = DEFAULT_TILE_SIZE) {
    this.tileSize = tileSize;
  }

  intersects(feature: Feature, rect: BoundingBox): boolean {
    if (feature.type !== 'Image') return false;

    const obb = this.createOBBForImage(feature);
    if (!obb) {
      // When the OBB cannot be created, test with the coordinate alone
      const coord = coordinatesOf(feature) as Coordinate;
      return pointInRectangle(coord, rect);
    }

    const corners = getOBBCorners(obb);
    return rectangleIntersectsOBB(rect, { corners });
  }

  private createOBBForImage(feature: Feature): ReturnType<typeof createOBB> | null {
    const properties = getImageProperties(feature);
    if (!properties.imageFileId) return null;

    const coord = coordinatesOf(feature) as Coordinate;
    const latitude = coord[1];

    const imageWidth = properties.imageWidth || 100;
    const imageHeight = properties.imageHeight || 100;

    const displayWidth = imageWidth;
    const displayHeight = imageHeight;

    const createdZoom = properties.createdZoom || 14;
    const scale = properties.scale || 1;

    const widthMeters =
      getMetersPerPixel(latitude, createdZoom, this.tileSize) * displayWidth * scale;
    const heightMeters =
      getMetersPerPixel(latitude, createdZoom, this.tileSize) * displayHeight * scale;

    const widthDeg = metersToDegreesLng(widthMeters, latitude);
    const heightDeg = metersToDegreesLat(heightMeters);

    const rotation = properties.rotation || 0;

    return createOBB(coord[0], coord[1], widthDeg, heightDeg, rotation);
  }
}

/**
 * Box selection test for Circle
 *
 * It tests the intersection between the selection box and the ring of the circle, which is
 * expressed as a center plus a radius (in meters). Testing with the center point alone
 * would fail to select a circle whose ring overlaps the box widely while its center is
 * outside the box.
 *
 * In geographic coordinate (lng/lat) space a circle becomes an ellipse stretched by a
 * factor of 1/cos(lat) along the longitude axis, so the latitude axis is normalized by a
 * factor of rLng/rLat to turn it back into a true circle, and the box is put through the
 * same transformation before the test.
 */
export class CircleBoxSelectionStrategy implements BoxSelectionStrategy {
  readonly featureType = 'Circle' as const;

  intersects(feature: Feature, rect: BoundingBox): boolean {
    if (feature.type !== 'Circle') return false;

    const center = coordinatesOf(feature) as Coordinate;
    const radiusMeters = getCircleRadius(feature);
    if (!radiusMeters || radiusMeters <= 0) {
      return pointInRectangle(center, rect);
    }

    const rLng = metersToDegreesLng(radiusMeters, center[1]);
    const rLat = metersToDegreesLat(radiusMeters);
    if (rLng <= 0 || rLat <= 0) {
      return pointInRectangle(center, rect);
    }

    // Normalize the latitude axis by k = rLng/rLat -> the ellipse becomes a true circle of
    // radius rLng. The box is axis-aligned, so multiplying each y coordinate by k is an
    // equivalent transformation.
    const k = rLng / rLat;
    const normRect: BoundingBox = {
      minX: rect.minX,
      maxX: rect.maxX,
      minY: rect.minY * k,
      maxY: rect.maxY * k,
    };
    const normCenter: Coordinate = [center[0], center[1] * k];

    return rectangleIntersectsCircle(normRect, normCenter, rLng);
  }
}

/**
 * Creates every BoxSelectionStrategy of the core edition
 *
 * @internal
 */
export function createCoreBoxSelectionStrategies(
  tileSize = DEFAULT_TILE_SIZE,
): BoxSelectionStrategy[] {
  return [
    new PointBoxSelectionStrategy(),
    new LineStringBoxSelectionStrategy(),
    new PolygonBoxSelectionStrategy(),
    new MultiPointBoxSelectionStrategy(),
    new MultiLineStringBoxSelectionStrategy(),
    new MultiPolygonBoxSelectionStrategy(),
    new CircleBoxSelectionStrategy(),
    new ImageBoxSelectionStrategy(tileSize),
  ];
}
