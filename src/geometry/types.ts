// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Type definitions of the geometry module
 *
 * GeoJSON-compatible array representations. They match the shape of the coordinates of
 * a core Feature structurally, so they can be passed through as they are with no
 * conversion. The geometry module does not depend on external type definitions; the
 * coordinate types are self-contained in this file alone.
 */

/**
 * A position as `[longitude, latitude]` in degrees (WGS84, the GeoJSON order).
 *
 * Longitude comes first. No altitude is carried; the functions of this module read only the
 * first two elements.
 */
export type Coordinate = [number, number];

/**
 * The outline of a polygon: a closed coordinate sequence whose first and last positions are
 * equal.
 *
 * The functions of this module accept a ring in either orientation. A ring with fewer than
 * 3 positions, or with a position that is not finite, cannot bound an area and is dropped
 * by every function that takes polygons.
 */
export type Ring = Coordinate[];

/**
 * The coordinates of a Polygon: index 0 is the outer ring and the rest are holes (inner
 * rings).
 */
export type PolygonCoordinates = Ring[];

/** The coordinates of a MultiPolygon: an array of Polygon coordinates, one per part. */
export type MultiPolygonCoordinates = PolygonCoordinates[];

/**
 * Either Polygon coordinates or MultiPolygon coordinates.
 *
 * The functions that take polygons accept both shapes (Ring[] and Ring[][]) and tell them
 * apart with {@link isMultiPolygonCoordinates}, so the caller does not need to normalize
 * them. The functions that return polygons always return MultiPolygon coordinates.
 */
export type AreaCoordinates = PolygonCoordinates | MultiPolygonCoordinates;

/**
 * A bounding box as `[minLng, minLat, maxLng, maxLat]` in degrees.
 *
 * A box never crosses the ±180 degree meridian: `minLng <= maxLng` always holds.
 */
export type BBox = [number, number, number, number];

/** A GeoJSON Point geometry without `bbox`. */
export interface PointGeometry {
  /** The geometry type */
  type: 'Point';
  /** The position `[lng, lat]` */
  coordinates: Coordinate;
}

/** A GeoJSON MultiPoint geometry without `bbox`. */
export interface MultiPointGeometry {
  /** The geometry type */
  type: 'MultiPoint';
  /** The positions `[lng, lat]` */
  coordinates: Coordinate[];
}

/** A GeoJSON LineString geometry without `bbox`. */
export interface LineStringGeometry {
  /** The geometry type */
  type: 'LineString';
  /** The vertices `[lng, lat]` in drawing order */
  coordinates: Coordinate[];
}

/** A GeoJSON MultiLineString geometry without `bbox`. */
export interface MultiLineStringGeometry {
  /** The geometry type */
  type: 'MultiLineString';
  /** The lines, each a vertex sequence `[lng, lat][]` */
  coordinates: Coordinate[][];
}

/** A GeoJSON Polygon geometry without `bbox`. */
export interface PolygonGeometry {
  /** The geometry type */
  type: 'Polygon';
  /** The outer ring followed by the holes */
  coordinates: PolygonCoordinates;
}

/** A GeoJSON MultiPolygon geometry without `bbox`. */
export interface MultiPolygonGeometry {
  /** The geometry type */
  type: 'MultiPolygon';
  /** The parts, each an outer ring followed by its holes */
  coordinates: MultiPolygonCoordinates;
}

/**
 * A whole geometry, as taken by {@link buffer}.
 *
 * The GeoJSON Geometry types without `bbox` and without GeometryCollection. The
 * coordinates of a Point, LineString or Polygon feature have the same shape, so they can
 * be passed with no conversion.
 */
export type GeometryInput =
  | PointGeometry
  | MultiPointGeometry
  | LineStringGeometry
  | MultiLineStringGeometry
  | PolygonGeometry
  | MultiPolygonGeometry;
