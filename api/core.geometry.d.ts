// @sakuzu/maplibre-gl-draw/geometry 3.0 の案 (第 3 稿)。main (2.2.0) の宣言に、error の code を camelCase に
// する決め (main/DECISIONS.md の 5 章) と、禁止の語を外す直し (TSDoc の 1 か所) だけを当てた。元の説明は次の通り。
// @sakuzu/maplibre-gl-draw/geometry 2.2.0 (main) の公開 API の宣言を 1 つにまとめた物。
// 元は tsc --emitDeclarationOnly の出力 (stripInternal)。再 export は元の宣言を写した。
// @internal のメンバーと private のメンバーは落としてある。
// 「export されない宣言」の領域は、export された宣言が参照するので、このファイルだけで
// 読めるように写した物で、入口からは export されていない。

import type { Geometry, LineString, MultiLineString, MultiPolygon, Point, Polygon, Position } from 'geojson';

// 入口の説明 (入口の index の先頭の TSDoc)
/**
 * Geometry calculations that need no map.
 *
 * Measure lengths and areas, build circles and buffers, combine polygons, test whether a
 * point lies in a polygon, and tidy shapes. They also work in code that does not use the
 * drawing engine (workers, tests, programs without a map).
 *
 * ```ts
 * import { area, buffer, union } from '@sakuzu/maplibre-gl-draw/geometry';
 *
 * const a = draw.features.get('park');
 * const b = draw.features.get('lake');
 * const merged = union([a, b]);            // Polygon | MultiPolygon | null
 * const zone = buffer(merged, 300);        // the area within 300 m
 * console.log(area(zone) / 1e6, 'km²');
 * ```
 *
 * The functions take GeoJSON geometries, or anything with a `geometry` field whose geometry
 * they use (GeoJSON features and the features of the drawing), and return GeoJSON geometries. Lengths, distances, radii and tolerances are in meters, areas in
 * square meters, and bearings and coordinates in degrees. An input whose shape a function
 * cannot take throws a {@link GeometryError}; a computation whose result is empty returns null.
 * Crossing the ±180 degree meridian and the vicinity of the poles are out of scope.
 *
 * Read next: the guide
 * [snapping and geometry](https://sakuzu.github.io/maplibre-gl-draw/guides/snapping-geometry),
 * which also shows the operations that change the drawing (`draw.features.union` and the
 * rest). The functions used most are {@link area}, {@link length}, {@link buffer} and
 * {@link union}.
 *
 * @module geometry
 */

// =============================================================================
// 領域: Measure
// =============================================================================

/**
 * Returns the point at a distance in meters along a line, measured from its start.
 *
 * @param line The LineString, or a feature whose geometry is one; coordinates in degrees
 * @param distanceMeters The distance from the start in meters. 0 or less gives the start,
 *   and a distance longer than the line gives its end
 * @returns The position `[lng, lat]` in degrees
 * @throws {@link GeometryError} (`invalidInput`) when the line is not a LineString or has no
 *   position, and when the distance is not a finite number
 */
export declare function along(line: LineString | {
    readonly geometry: Geometry;
}, distanceMeters: number): Position;

/**
 * Returns the area in square meters of a polygon on the sphere.
 *
 * @param polygon The Polygon or MultiPolygon, or a feature whose geometry is one; coordinates
 *   in degrees. Self-intersections are resolved and ring orientation does not matter
 * @returns The area in square meters, holes subtracted. 0 when nothing with an area remains
 * @throws {@link GeometryError} (`invalidInput`) when the input is not a Polygon or a
 *   MultiPolygon, and (`engineFailure`) when resolving its self-intersections fails
 *
 * @example
 * ```ts
 * import { area } from '@sakuzu/maplibre-gl-draw/geometry';
 *
 * // A 1 x 1 degree square on the equator
 * area({ type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] });
 * // about 1.236e10 m²
 * ```
 */
export declare function area(polygon: Polygon | MultiPolygon | {
    readonly geometry: Geometry;
}): number;

/**
 * Returns the initial bearing in degrees of the great circle from one point to another.
 *
 * @param from The start, a position `[lng, lat]` in degrees or a Point
 * @param to The end, a position `[lng, lat]` in degrees or a Point
 * @returns The bearing at the start in degrees, clockwise from north, in [0, 360). 0 when the
 *   points are identical
 * @throws {@link GeometryError} (`invalidInput`) when an argument is not a position or a
 *   Point
 */
export declare function bearing(from: Position | Point, to: Position | Point): number;

/**
 * Returns the centroid of a polygon, weighted by area.
 *
 * @param polygon The Polygon or MultiPolygon, or a feature whose geometry is one; coordinates
 *   in degrees. Holes are subtracted and the parts are weighted by their areas on the lng/lat
 *   plane
 * @returns The centroid as a Point, in degrees; it can fall outside a concave polygon (see
 *   {@link pointOnSurface}). The mean of the positions when the area is 0. null when there is
 *   no position
 * @throws {@link GeometryError} (`invalidInput`) when the input is not a Polygon or a
 *   MultiPolygon
 */
export declare function centroid(polygon: Polygon | MultiPolygon | {
    readonly geometry: Geometry;
}): Point | null;

/**
 * Returns the point reached from an origin after a distance in meters along a great circle
 * that starts at a bearing in degrees.
 *
 * @param origin The start, a position `[lng, lat]` in degrees or a Point
 * @param distanceMeters The distance in meters; a negative value goes the opposite way
 * @param bearingDegrees The initial bearing in degrees, clockwise from north
 * @returns The position `[lng, lat]` in degrees. The longitude continues from the origin
 *   and is not wrapped into [-180, 180]
 * @throws {@link GeometryError} (`invalidInput`) when the origin is not a position or a
 *   Point
 */
export declare function destination(origin: Position | Point, distanceMeters: number, bearingDegrees: number): Position;

/**
 * Returns the great-circle distance in meters between two points.
 *
 * @param from The first point, a position `[lng, lat]` in degrees or a Point
 * @param to The second point, a position `[lng, lat]` in degrees or a Point
 * @returns The distance in meters on the sphere of {@link EARTH_RADIUS_METERS}. NaN when a
 *   coordinate is not finite
 * @throws {@link GeometryError} (`invalidInput`) when an argument is not a position or a
 *   Point
 *
 * @example
 * ```ts
 * import { distance } from '@sakuzu/maplibre-gl-draw/geometry';
 *
 * distance([139.767, 35.681], [135.495, 34.702]); // about 403,139 m
 * ```
 */
export declare function distance(from: Position | Point, to: Position | Point): number;

/**
 * Returns the length in meters of a line.
 *
 * @param line The LineString or MultiLineString, or a feature whose geometry is one;
 *   coordinates in degrees
 * @returns The sum of the great-circle distances of the segments, in meters. 0 for a line
 *   with fewer than 2 positions
 * @throws {@link GeometryError} (`invalidInput`) when the input is not a LineString or a
 *   MultiLineString
 */
export declare function length(line: LineString | MultiLineString | {
    readonly geometry: Geometry;
}): number;

/**
 * Returns the point halfway between two points along the great circle that joins them.
 *
 * @param from The first point, a position `[lng, lat]` in degrees or a Point
 * @param to The second point, a position `[lng, lat]` in degrees or a Point
 * @returns The position `[lng, lat]` in degrees, at the same distance in meters from both
 *   points. The longitude continues from `from`
 * @throws {@link GeometryError} (`invalidInput`) when an argument is not a position or a
 *   Point
 */
export declare function midpoint(from: Position | Point, to: Position | Point): Position;

/**
 * Returns the point of a line nearest to a given point, with its distance in meters and the
 * index of the segment it lies on.
 *
 * @param line The LineString or MultiLineString, or a feature whose geometry is one;
 *   coordinates in degrees. Each segment is taken as a great-circle arc
 * @param point The point, a position `[lng, lat]` in degrees or a Point
 * @returns `position`, the nearest point `[lng, lat]` in degrees; `distanceMeters`, its
 *   distance from `point` in meters; and `segmentIndex`, the segment it lies on, counted from
 *   0 across the lines of a MultiLineString in order (segment `i` of a LineString joins its
 *   positions `i` and `i + 1`)
 * @throws {@link GeometryError} (`invalidInput`) when the line is not a LineString or a
 *   MultiLineString or has no position, and when the point is not a position or a Point
 */
export declare function nearestPointOnLine(line: LineString | MultiLineString | {
    readonly geometry: Geometry;
}, point: Position | Point): {
    position: Position;
    distanceMeters: number;
    segmentIndex: number;
};

/**
 * Returns the length in meters of the boundary of a polygon, the rings of its holes included.
 *
 * @param polygon The Polygon or MultiPolygon, or a feature whose geometry is one; coordinates
 *   in degrees. An open ring is measured as if closed; a ring with fewer than 3 positions or a
 *   position that is not finite is left out
 * @returns The sum of the great-circle lengths of every ring, in meters
 * @throws {@link GeometryError} (`invalidInput`) when the input is not a Polygon or a
 *   MultiPolygon
 */
export declare function perimeter(polygon: Polygon | MultiPolygon | {
    readonly geometry: Geometry;
}): number;

/**
 * Returns a point that always lies inside a polygon, such as the anchor of a label.
 *
 * @param polygon The Polygon or MultiPolygon, or a feature whose geometry is one; coordinates
 *   in degrees
 * @returns The {@link centroid} when it lies inside, otherwise the middle of the widest
 *   section of the polygon along the parallel of the centroid, as a Point in degrees. null
 *   when there is no position
 * @throws {@link GeometryError} (`invalidInput`) when the input is not a Polygon or a
 *   MultiPolygon
 */
export declare function pointOnSurface(polygon: Polygon | MultiPolygon | {
    readonly geometry: Geometry;
}): Point | null;

// =============================================================================
// 領域: Create
// =============================================================================

/**
 * Returns the area within a distance in meters of a geometry, or a polygon shrunk by it when
 * the distance is negative.
 *
 * @param geometry The geometry, or a feature whose geometry it is; coordinates in degrees. The
 *   members of a GeometryCollection are buffered one by one and the results merged
 * @param distanceMeters The distance in meters. A negative distance shrinks a polygon and
 *   leaves nothing of a point or a line
 * @param options `segments`, the number of segments of each circle (64 by default, rounded
 *   down and clamped to 3-1024)
 * @returns A Polygon, or a MultiPolygon when the area falls apart. null when nothing remains,
 *   and when a vertex is so close to a pole or an edge so long in longitude (over 180 degrees)
 *   that the area cannot be drawn in longitude and latitude
 * @throws {@link GeometryError} (`invalidInput`) when the input is not a geometry or a
 *   feature with one and when the distance is not a finite number, and (`engineFailure`)
 *   when merging the parts fails
 *
 * @example
 * ```ts
 * import { buffer } from '@sakuzu/maplibre-gl-draw/geometry';
 *
 * // The area within 100 m of a road
 * const corridor = buffer(
 *   { type: 'LineString', coordinates: [[139.76, 35.68], [139.77, 35.69]] },
 *   100,
 * );
 * ```
 */
export declare function buffer(geometry: Geometry | {
    readonly geometry: Geometry;
}, distanceMeters: number, options?: {
    segments?: number;
}): Polygon | MultiPolygon | null;

/**
 * Returns a polygon that approximates the geodesic circle of a radius in meters around a
 * center.
 *
 * @param center The center, a position `[lng, lat]` in degrees or a Point
 * @param radiusMeters The radius in meters, 0 or more. Every vertex lies at this great-circle
 *   distance from the center
 * @param options `segments`, the number of vertices (64 by default, rounded down and clamped
 *   to 3-1024)
 * @returns The Polygon, its ring starting due north of the center and running
 *   counter-clockwise, with the first position repeated at the end
 * @throws {@link GeometryError} (`invalidInput`) when the center is not a position or a
 *   Point or is not finite, and when the radius is negative or not finite
 */
export declare function circle(center: Position | Point, radiusMeters: number, options?: {
    segments?: number;
}): Polygon;

// =============================================================================
// 領域: Combine
// =============================================================================

/**
 * Returns a polygon with other polygons removed from it.
 *
 * @param subject The Polygon or MultiPolygon to remove from, or a feature whose geometry is
 *   one; coordinates in degrees
 * @param others The Polygons and MultiPolygons to remove, or features whose geometry is one;
 *   coordinates in degrees
 * @returns A Polygon or a MultiPolygon in the form {@link union} returns; a removed area inside
 *   the subject becomes a hole. null when nothing remains
 * @throws {@link GeometryError} (`invalidInput`) when an argument is not a Polygon or a
 *   MultiPolygon, and (`engineFailure`) when the boolean operation fails
 */
export declare function difference(subject: Polygon | MultiPolygon | {
    readonly geometry: Geometry;
}, others: readonly (Polygon | MultiPolygon | {
    readonly geometry: Geometry;
})[]): Polygon | MultiPolygon | null;

/**
 * Returns the part that polygons have in common.
 *
 * @param polygons The Polygons and MultiPolygons, or features whose geometry is one;
 *   coordinates in degrees
 * @returns A Polygon or a MultiPolygon in the form {@link union} returns. null when the
 *   polygons share no area (touching boundaries included), when one has no area, and for an
 *   empty array
 * @throws {@link GeometryError} (`invalidInput`) when an element is not a Polygon or a
 *   MultiPolygon, and (`engineFailure`) when the boolean operation fails
 */
export declare function intersection(polygons: readonly (Polygon | MultiPolygon | {
    readonly geometry: Geometry;
})[]): Polygon | MultiPolygon | null;

/**
 * Cuts a polygon with a line and returns the pieces.
 *
 * @param polygon The Polygon or MultiPolygon, or a feature whose geometry is one; coordinates
 *   in degrees
 * @param line The cutting LineString, or a feature whose geometry is one; coordinates in
 *   degrees. A stretch that runs along the boundary does not cut, and positions closer than
 *   1e-9 degrees count as one
 * @returns One Polygon per piece, holes kept. When the line does not cut across, the polygon
 *   itself (one Polygon per part of a MultiPolygon). An empty array when it has no area
 * @throws {@link GeometryError} (`invalidInput`) when an argument is not of the expected
 *   type, and (`engineFailure`) when the boolean operation fails
 */
export declare function split(polygon: Polygon | MultiPolygon | {
    readonly geometry: Geometry;
}, line: LineString | {
    readonly geometry: Geometry;
}): Polygon[];

/**
 * Returns the union of polygons.
 *
 * @param polygons The Polygons and MultiPolygons, or features whose geometry is one;
 *   coordinates in degrees. Rings with fewer than 3 positions or a position that is not finite
 *   are left out
 * @returns A Polygon, or a MultiPolygon when the union falls apart, with self-intersections
 *   resolved and the rings oriented as RFC 7946 recommends. null when nothing has an area
 * @throws {@link GeometryError} (`invalidInput`) when an element is not a Polygon or a
 *   MultiPolygon, and (`engineFailure`) when the boolean operation fails
 *
 * @example
 * ```ts
 * import { union } from '@sakuzu/maplibre-gl-draw/geometry';
 *
 * union([
 *   { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] },
 *   { type: 'Polygon', coordinates: [[[0.5, 0], [1.5, 0], [1.5, 1], [0.5, 1], [0.5, 0]]] },
 * ]);
 * // { type: 'Polygon', coordinates: [[[0, 0], [1.5, 0], [1.5, 1], [0, 1], [0, 0]]] }
 * ```
 */
export declare function union(polygons: readonly (Polygon | MultiPolygon | {
    readonly geometry: Geometry;
})[]): Polygon | MultiPolygon | null;

// =============================================================================
// 領域: Test
// =============================================================================

/**
 * Determines whether one bounding box contains another, coincident boundaries included.
 *
 * @param outer The containing box `[minLng, minLat, maxLng, maxLat]` in degrees
 * @param inner The contained box `[minLng, minLat, maxLng, maxLat]` in degrees
 * @returns `true` when every point of `inner` lies in `outer`. A box contains itself
 */
export declare function bboxContains(outer: BBox, inner: BBox): boolean;

/**
 * Determines whether two bounding boxes overlap, touching included.
 *
 * @param a A box `[minLng, minLat, maxLng, maxLat]` in degrees
 * @param b A box `[minLng, minLat, maxLng, maxLat]` in degrees
 * @returns `true` when the boxes share at least one point, an edge or a corner included
 */
export declare function bboxIntersects(a: BBox, b: BBox): boolean;

/**
 * Determines whether a polygon completely contains a geometry.
 *
 * @param outer The containing Polygon or MultiPolygon, or a feature whose geometry is one;
 *   coordinates in degrees
 * @param inner The contained geometry, or a feature whose geometry it is; coordinates in
 *   degrees. It may share the boundary of `outer`
 * @returns `true` when no part of `inner` lies outside `outer`. `false` for a polygon without
 *   an area and for an empty geometry
 * @throws {@link GeometryError} (`invalidInput`) when an argument is not of the expected
 *   type, and (`engineFailure`) when the boolean operation fails
 */
export declare function contains(outer: Polygon | MultiPolygon | {
    readonly geometry: Geometry;
}, inner: Geometry | {
    readonly geometry: Geometry;
}): boolean;

/**
 * Determines whether two polygons share an area.
 *
 * @param a The Polygon or MultiPolygon, or a feature whose geometry is one; coordinates in
 *   degrees
 * @param b The Polygon or MultiPolygon, or a feature whose geometry is one; coordinates in
 *   degrees
 * @returns `true` when the common part has an area. `false` when they only touch along an edge
 *   or at a vertex
 * @throws {@link GeometryError} (`invalidInput`) when an argument is not a Polygon or a
 *   MultiPolygon, and (`engineFailure`) when the boolean operation fails
 */
export declare function overlaps(a: Polygon | MultiPolygon | {
    readonly geometry: Geometry;
}, b: Polygon | MultiPolygon | {
    readonly geometry: Geometry;
}): boolean;

/**
 * Determines whether a point lies inside a polygon, holes taken into account.
 *
 * @param point The point, a position `[lng, lat]` in degrees or a Point
 * @param polygon The Polygon or MultiPolygon, or a feature whose geometry is one; coordinates
 *   in degrees
 * @returns `true` when the point lies inside an outer ring and inside none of its holes. The
 *   result for a point exactly on the boundary is not defined
 * @throws {@link GeometryError} (`invalidInput`) when an argument is not of the expected type
 */
export declare function pointInPolygon(point: Position | Point, polygon: Polygon | MultiPolygon | {
    readonly geometry: Geometry;
}): boolean;

// =============================================================================
// 領域: Repair
// =============================================================================

/**
 * Returns a polygon with its self-intersections resolved, its rings oriented and its rings
 * without an area removed.
 *
 * @param polygon The Polygon or MultiPolygon, or a feature whose geometry is one; coordinates
 *   in degrees. A ring with fewer than 3 positions or a position that is not finite is dropped
 * @returns A Polygon, or a MultiPolygon when the result falls apart (a figure eight becomes two
 *   parts), with outer rings counter-clockwise and holes clockwise. null when nothing with an
 *   area remains
 * @throws {@link GeometryError} (`invalidInput`) when the input is not a Polygon or a
 *   MultiPolygon, and (`engineFailure`) when the boolean operation fails
 */
export declare function makeValid(polygon: Polygon | MultiPolygon | {
    readonly geometry: Geometry;
}): Polygon | MultiPolygon | null;

/**
 * Returns a polygon with its rings oriented as RFC 7946 recommends: outer rings
 * counter-clockwise and holes clockwise.
 *
 * @param polygon The Polygon or MultiPolygon, or a feature whose geometry is one; coordinates
 *   in degrees. Only the orientation changes; self-intersections are left as they are (see
 *   {@link makeValid})
 * @returns A geometry of the same type as the input
 * @throws {@link GeometryError} (`invalidInput`) when the input is not a Polygon or a
 *   MultiPolygon
 */
export declare function rewind(polygon: Polygon | {
    readonly geometry: Polygon;
}): Polygon;
export declare function rewind(polygon: MultiPolygon | {
    readonly geometry: MultiPolygon;
}): MultiPolygon;
export declare function rewind(polygon: Polygon | MultiPolygon | {
    readonly geometry: Geometry;
}): Polygon | MultiPolygon;

/**
 * Reduces the vertices of a line or a polygon with the Douglas-Peucker algorithm and a
 * tolerance in meters.
 *
 * @param geometry The LineString, Polygon or MultiPolygon, or a feature whose geometry is one;
 *   coordinates in degrees
 * @param toleranceMeters The largest distance in meters a removed vertex may lie from the
 *   simplified line, measured on a plane at the latitude of the center of the bounding box. 0
 *   or less removes nothing
 * @returns A geometry of the same type. The ends of a line always remain, and a ring that
 *   would keep fewer than 4 positions is kept as it is. The result may intersect itself (see
 *   {@link makeValid})
 * @throws {@link GeometryError} (`invalidInput`) when the input is not a LineString, a
 *   Polygon or a MultiPolygon, and when the tolerance is not a finite number
 *
 * @example
 * ```ts
 * import { simplify } from '@sakuzu/maplibre-gl-draw/geometry';
 *
 * // The middle vertex lies about 1 m off the line, within the 5 m tolerance
 * simplify({ type: 'LineString', coordinates: [[0, 0], [0.001, 0.00001], [0.002, 0]] }, 5);
 * // { type: 'LineString', coordinates: [[0, 0], [0.002, 0]] }
 * ```
 */
export declare function simplify(geometry: LineString | {
    readonly geometry: LineString;
}, toleranceMeters: number): LineString;
export declare function simplify(geometry: Polygon | {
    readonly geometry: Polygon;
}, toleranceMeters: number): Polygon;
export declare function simplify(geometry: MultiPolygon | {
    readonly geometry: MultiPolygon;
}, toleranceMeters: number): MultiPolygon;
export declare function simplify(geometry: LineString | Polygon | MultiPolygon | {
    readonly geometry: Geometry;
}, toleranceMeters: number): LineString | Polygon | MultiPolygon;

// =============================================================================
// 領域: Bounds and units
// =============================================================================

/**
 * Returns the bounding box `[minLng, minLat, maxLng, maxLat]` in degrees of a geometry.
 *
 * @param geometry The geometry, or a feature whose geometry it is; coordinates in degrees.
 *   Every position counts, the holes and the members of a collection included; a position
 *   that is not finite is skipped. Crossing the ±180 degree meridian is not handled
 * @returns The box in degrees
 * @throws {@link GeometryError} (`invalidInput`) when the input is not a geometry or a feature
 *   with one, and when it has no finite position
 *
 * @example
 * ```ts
 * import { bbox } from '@sakuzu/maplibre-gl-draw/geometry';
 *
 * bbox({ type: 'LineString', coordinates: [[139.7, 35.6], [139.8, 35.7]] });
 * // [139.7, 35.6, 139.8, 35.7]
 * ```
 */
export declare function bbox(geometry: Geometry | {
    readonly geometry: Geometry;
}): BBox;

/**
 * Converts a distance at a latitude into degrees of longitude and latitude.
 *
 * On the sphere of {@link EARTH_RADIUS_METERS}: a degree of latitude is always the same
 * length, and a degree of longitude shrinks with the cosine of the latitude. Use it to turn a
 * tolerance in meters into one in degrees. Near the poles the longitude grows without bound.
 *
 * @param meters The distance in meters
 * @param latitude The latitude in degrees at which the distance is taken
 * @returns The distance in degrees of longitude (`lng`) and of latitude (`lat`)
 */
export declare function metersToDegrees(meters: number, latitude: number): {
    lng: number;
    lat: number;
};

// =============================================================================
// 領域: Types and errors
// =============================================================================

/**
 * Why a geometry function failed: `invalidInput` for an input whose shape the function cannot
 * take, `engineFailure` for a boolean operation that could not compute a result.
 */
export type GeometryErrorCode = 'invalidInput' | 'engineFailure';

/**
 * The error a geometry function throws for an input it cannot take or when its boolean
 * operation cannot compute a result.
 *
 * A failure of a boolean operation is first retried once with the coordinates rounded to a
 * 1e-9 degree grid (about 0.1 mm); the error is thrown only when the retry fails too. Branch
 * on `code`; the message is `<operation>: <reason>` in English and is meant for logs.
 *
 * @example
 * ```ts
 * import type { Polygon } from 'geojson';
 * import { GeometryError, union } from '@sakuzu/maplibre-gl-draw/geometry';
 *
 * function tryMerge(a: Polygon, b: Polygon) {
 *   try {
 *     return union([a, b]);
 *   } catch (error) {
 *     if (error instanceof GeometryError && error.code === 'engineFailure') {
 *       // Keep the inputs as they are and tell the user the merge failed
 *       return null;
 *     }
 *     throw error;
 *   }
 * }
 * ```
 */
export declare class GeometryError extends Error {
    /** Why the function failed */
    readonly code: GeometryErrorCode;
    /** The name of the function that failed, such as `union` or `buffer` */
    readonly operation: string;
    /** The error that caused this one, kept for diagnosis */
    readonly cause: unknown;
    /**
     * Creates the error. The library creates it; a caller only needs to catch it.
     *
     * @param code Why the function failed
     * @param operation The name of the function that failed
     * @param message The message, `<operation>: <reason>`
     * @param options The original error as `cause`
     */
    constructor(code: GeometryErrorCode, operation: string, message: string, options?: {
        cause?: unknown;
    });
}

/**
 * A bounding box as `[minLng, minLat, maxLng, maxLat]` in degrees.
 *
 * A box never crosses the ±180 degree meridian: `minLng <= maxLng` always holds.
 */
export type BBox = [number, number, number, number];

/**
 * The radius in meters of the sphere on which every function of this entry measures.
 *
 * The value is the mean Earth radius of the IUGG, 6,371,008.8 m. Distances, bearings, areas,
 * circles and buffers all assume this sphere rather than an ellipsoid, so a result differs from
 * an ellipsoidal computation by up to about 0.5%.
 */
export declare const EARTH_RADIUS_METERS = 6371008.8;
