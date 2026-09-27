// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Feature rendering style configuration
 *
 * Configuration related to rendering features.
 * The selected state is expressed with a bounding box, so the style of the feature itself is
 * not changed.
 */

import type { Color, PointStyle, StrokeStyle } from '../types/style.js';

/**
 * The fill of a polygon (part of {@link PolygonFeatureStyle})
 */
export interface FillStyle {
  /**
   * The fill color; its alpha is the opacity of the fill
   *
   * @defaultValue `#FF0077` at an alpha of 0.25
   */
  color: Color;
}

/**
 * How a point is drawn by default (part of {@link FeatureStyleConfig})
 */
export interface PointFeatureStyle {
  /**
   * The marker
   *
   * @defaultValue a 12 px `#FF6633` circle with a 2 px white outline
   */
  point: PointStyle;
}

/**
 * How a line is drawn by default (part of {@link FeatureStyleConfig})
 */
export interface LineStringFeatureStyle {
  /**
   * The line
   *
   * @defaultValue `#FF0077`, 2 px, solid
   */
  stroke: StrokeStyle;
}

/**
 * How a polygon is drawn by default (part of {@link FeatureStyleConfig})
 */
export interface PolygonFeatureStyle {
  /**
   * The outline
   *
   * @defaultValue `#FF0077`, 2 px, solid
   */
  stroke: StrokeStyle;
  /**
   * The fill
   *
   * @defaultValue `#FF0077` at an alpha of 0.25
   */
  fill: FillStyle;
}

/**
 * How the geometry being drawn looks, before it is committed as a feature (part of
 * {@link FeatureStyleConfig})
 */
export interface TentativeStyle {
  /**
   * The line through the vertices placed so far
   *
   * @defaultValue `#FF0077`, 2 px, solid
   */
  stroke: StrokeStyle;
  /**
   * The line from the last vertex to the cursor, not yet committed
   *
   * @defaultValue `#FF0077`, 2 px, dashed
   */
  tentativeStroke: StrokeStyle;
  /**
   * The vertices placed so far
   *
   * @defaultValue a 10 px white circle with a 2 px `#FF0077` outline
   */
  vertex: PointStyle;
  /**
   * A vertex the cursor is close to (clicking the first vertex closes a polygon)
   *
   * @defaultValue a 14 px `#FFCC00` circle with a 3 px `#FF0077` outline
   */
  highlightedVertex: PointStyle;
  /**
   * For a Circle: the marker at the center
   *
   * @defaultValue a 6 px white circle with a 1 px `#FF2D55` outline
   */
  circleCenterMarker: PointStyle;
  /**
   * For a Circle: the handle on the edge that sets the radius
   *
   * @defaultValue a 10 px white circle with a 1 px `#FF2D55` outline
   */
  circleRadiusHandle: PointStyle;
}

/**
 * The default look of the features, and of the geometry being drawn
 *
 * A key the style of a feature ({@link FeatureStyle}) leaves unset takes its value from here,
 * unless the style rule of the layer gives the color. Give the parts to change through the
 * `style` option of `createMapLibreGLDraw`; the parts left out keep their defaults.
 *
 * The selection does not change how a feature is drawn; it is shown by the box and the
 * handles of {@link SelectionUIConfig}.
 *
 * @example
 * ```ts
 * const draw = createMapLibreGLDraw(map, {
 *   style: {
 *     lineString: {
 *       stroke: { width: 3, color: [0, 0.33, 1, 1], opacity: 1, lineStyle: 'solid' },
 *     },
 *   },
 * });
 * ```
 */
export interface FeatureStyleConfig {
  /**
   * Point and MultiPoint
   *
   * @defaultValue a 12 px `#FF6633` circle with a 2 px white outline
   */
  point: PointFeatureStyle;
  /**
   * LineString, MultiLineString and Freehand
   *
   * @defaultValue `#FF0077`, 2 px, solid
   */
  lineString: LineStringFeatureStyle;
  /**
   * Polygon, MultiPolygon and Circle
   *
   * @defaultValue a `#FF0077` 2 px outline and a `#FF0077` fill at an alpha of 0.25
   */
  polygon: PolygonFeatureStyle;
  /**
   * Circle, when it looks different from the polygons
   *
   * @defaultValue the look of the polygons
   */
  circle?: PolygonFeatureStyle;
  /**
   * The opacity of an Image that has none of its own
   *
   * @defaultValue 1
   */
  image?: { opacity: number };
  /**
   * The geometry being drawn
   *
   * @defaultValue `#FF0077` 2 px lines (dashed to the cursor) and 10 px white vertices
   */
  tentative: TentativeStyle;
}

/**
 * Default feature rendering style configuration
 */
export const DEFAULT_FEATURE_STYLE_CONFIG: FeatureStyleConfig = {
  point: {
    point: {
      shape: 'circle',
      size: 12,
      fillColor: [1.0, 0.4, 0.2, 1.0],
      fillOpacity: 1.0,
      strokeColor: [1.0, 1.0, 1.0, 1.0],
      strokeWidth: 2,
      strokeOpacity: 1.0,
    },
  },
  lineString: {
    stroke: {
      width: 2,
      color: [1.0, 0.0, 0.467, 1.0], // #FF0077
      opacity: 1.0,
      lineStyle: 'solid',
    },
  },
  polygon: {
    stroke: {
      width: 2,
      color: [1.0, 0.0, 0.467, 1.0], // #FF0077
      opacity: 1.0,
      lineStyle: 'solid',
    },
    fill: {
      color: [1.0, 0.0, 0.467, 0.25], // #FF0077, 25% opacity
    },
  },
  tentative: {
    stroke: {
      width: 2,
      color: [1.0, 0.0, 0.467, 1.0], // #FF0077
      opacity: 1.0,
      lineStyle: 'solid',
    },
    tentativeStroke: {
      width: 2,
      color: [1.0, 0.0, 0.467, 1.0], // #FF0077
      opacity: 1.0,
      lineStyle: 'dashed',
    },
    vertex: {
      shape: 'circle',
      size: 10,
      fillColor: [1.0, 1.0, 1.0, 1.0],
      fillOpacity: 1.0,
      strokeColor: [1.0, 0.0, 0.467, 1.0], // #FF0077
      strokeWidth: 2,
      strokeOpacity: 1.0,
    },
    highlightedVertex: {
      shape: 'circle',
      size: 14,
      fillColor: [1.0, 0.8, 0.0, 1.0], // yellow
      fillOpacity: 1.0,
      strokeColor: [1.0, 0.0, 0.467, 1.0], // #FF0077
      strokeWidth: 3,
      strokeOpacity: 1.0,
    },
    // For Circle: center marker
    // Specification: a 6px diameter circle, white fill, pink border (#FF2D55), 1px wide
    circleCenterMarker: {
      shape: 'circle',
      size: 6,
      fillColor: [1.0, 1.0, 1.0, 1.0], // white
      fillOpacity: 1.0,
      strokeColor: [1.0, 0.176, 0.333, 1.0], // #FF2D55
      strokeWidth: 1,
      strokeOpacity: 1.0,
    },
    // For Circle: radius handle
    // Specification: a 10px diameter circle, white fill, pink border (#FF2D55), 1px wide
    circleRadiusHandle: {
      shape: 'circle',
      size: 10,
      fillColor: [1.0, 1.0, 1.0, 1.0], // white
      fillOpacity: 1.0,
      strokeColor: [1.0, 0.176, 0.333, 1.0], // #FF2D55
      strokeWidth: 1,
      strokeOpacity: 1.0,
    },
  },
};

/**
 * Helper function that merges configurations
 */
export function mergeFeatureStyleConfig(
  base: FeatureStyleConfig,
  override: Partial<FeatureStyleConfig>,
): FeatureStyleConfig {
  return {
    point: {
      ...base.point,
      ...override.point,
      point: {
        ...base.point.point,
        ...override.point?.point,
      },
    },
    lineString: {
      ...base.lineString,
      ...override.lineString,
      stroke: {
        ...base.lineString.stroke,
        ...override.lineString?.stroke,
      },
    },
    polygon: {
      ...base.polygon,
      ...override.polygon,
      stroke: {
        ...base.polygon.stroke,
        ...override.polygon?.stroke,
      },
      fill: {
        ...base.polygon.fill,
        ...override.polygon?.fill,
      },
    },
    tentative: {
      ...base.tentative,
      ...override.tentative,
      stroke: {
        ...base.tentative.stroke,
        ...override.tentative?.stroke,
      },
      tentativeStroke: {
        ...base.tentative.tentativeStroke,
        ...override.tentative?.tentativeStroke,
      },
      vertex: {
        ...base.tentative.vertex,
        ...override.tentative?.vertex,
      },
      highlightedVertex: {
        ...base.tentative.highlightedVertex,
        ...override.tentative?.highlightedVertex,
      },
      circleCenterMarker: {
        ...base.tentative.circleCenterMarker,
        ...override.tentative?.circleCenterMarker,
      },
      circleRadiusHandle: {
        ...base.tentative.circleRadiusHandle,
        ...override.tentative?.circleRadiusHandle,
      },
    },
    ...mergeOptionalPart('circle', base, override),
    ...mergeOptionalPart('image', base, override),
  };
}

/** An optional part of the configuration: the override over the base, when either has it */
function mergeOptionalPart<K extends 'circle' | 'image'>(
  key: K,
  base: FeatureStyleConfig,
  override: Partial<FeatureStyleConfig>,
): Partial<Pick<FeatureStyleConfig, K>> {
  const value = override[key] ?? base[key];
  return value === undefined
    ? {}
    : ({ [key]: structuredClone(value) } as Pick<FeatureStyleConfig, K>);
}
