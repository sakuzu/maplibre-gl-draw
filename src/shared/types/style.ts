// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The style types shared by the configuration (shared/config) and the renderers (view/)
 */

/**
 * An RGBA color as four numbers from 0 to 1: `[red, green, blue, alpha]`
 *
 * The configuration of the renderers uses it; the style of a feature ({@link FeatureStyle})
 * uses `#rrggbb` strings instead. `#FF2D55` is `[1.0, 0.176, 0.333, 1.0]`.
 */
export type Color = [number, number, number, number];

/**
 * The shape of a point marker or a handle
 *
 * The built-in renderers draw `'circle'`, `'square'`, `'triangle'` (equilateral, a vertex
 * pointing up) and `'star'` (a five-pointed star, a tip pointing up). The triangle and the star
 * are inscribed in the circle the `'circle'` shape of the same style draws (the size plus the
 * stroke), and their stroke is drawn inside that outline. `'icon'` is a name for an extension
 * renderer to draw (with `iconId` of {@link PointStyle}); the built-in renderers draw it as a
 * circle.
 *
 * Hit testing does not look at the shape: a triangle or a star is hit like the circle that
 * encloses it.
 */
export type PointShape = 'circle' | 'square' | 'triangle' | 'star' | 'icon';

/**
 * How a point marker or a handle is drawn: its shape, size, fill and outline
 */
export interface PointStyle {
  /** The shape */
  shape: PointShape;
  /**
   * The size in CSS pixels (the diameter of a circle, the side of a square; a triangle and a star
   * are inscribed in the circle of this size plus the stroke)
   */
  size: number;
  /** The fill color */
  fillColor: Color;
  /** The opacity of the fill, from 0 to 1 (multiplied into the alpha of `fillColor`) */
  fillOpacity: number;
  /** The color of the outline */
  strokeColor: Color;
  /** The width of the outline in CSS pixels (0 for no outline) */
  strokeWidth: number;
  /** The opacity of the outline, from 0 to 1 */
  strokeOpacity: number;
  /** The identifier of the icon, for the `'icon'` shape */
  iconId?: string;
}

/** The dash pattern of a line: solid, dashed or dotted. */
export type LineStyle = 'solid' | 'dashed' | 'dotted';

/**
 * How a line or an outline is drawn: its width, color, opacity and dash pattern
 */
export interface StrokeStyle {
  /** The width in CSS pixels */
  width: number;
  /** The color */
  color: Color;
  /** The opacity from 0 to 1 (multiplied into the alpha of `color`) */
  opacity: number;
  /** The dash pattern */
  lineStyle: LineStyle;
  /**
   * A custom dash pattern in CSS pixels, `[dash, gap]`, used instead of the pattern of
   * `lineStyle` when `lineStyle` is not `'solid'`
   */
  dashArray?: number[];
}
