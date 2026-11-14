// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The keys of the style of a feature put over the parts of the configuration of the look: the
 * stroke keys over a line, the point keys over a point marker, the fill keys over a fill, and all
 * of them over the look of the geometry being drawn
 *
 * The options of the instance give the defaults so (`style`, `previewStyle`), and a sketch gives
 * the look of the shapes it draws over them (`Sketch.previewStyle`).
 */

import { toColor } from '../color.js';
import type { FeatureStyle } from '../types/model.js';
import type { Color, PointStyle, StrokeStyle } from '../types/style.js';
import type { FillStyle, TentativeStyle } from './feature-style.js';

/**
 * The alpha of a CSS color, 1 when there is none
 *
 * @internal
 */
export function alphaOf(css: string | undefined): number {
  return css === undefined ? 1 : toColor(css)[3];
}

/**
 * A color with another alpha
 *
 * @internal
 */
export function withAlpha(color: Color, alpha: number): Color {
  return [color[0], color[1], color[2], alpha];
}

/**
 * A stroke with the stroke keys of a style: the opacity is folded into the alpha of the color,
 * as the style of a feature does
 *
 * @internal
 */
export function applyStroke(
  stroke: StrokeStyle,
  style: Readonly<FeatureStyle>,
  lineStyle = true,
): void {
  if (style.strokeColor !== undefined || style.strokeOpacity !== undefined) {
    const base = style.strokeColor !== undefined ? toColor(style.strokeColor) : stroke.color;
    const alpha =
      style.strokeOpacity !== undefined
        ? alphaOf(style.strokeColor) * style.strokeOpacity
        : base[3];
    stroke.color = withAlpha(base, alpha);
  }
  if (style.strokeWidth !== undefined) stroke.width = style.strokeWidth;
  if (lineStyle && style.lineStyle !== undefined) stroke.lineStyle = style.lineStyle;
}

/**
 * A point marker with the point keys of a style: `pointStrokeColor` and `pointStrokeWidth` give
 * its outline, and `pointOpacity` is multiplied into its fill and its outline
 *
 * @internal
 */
export function applyPoint(point: PointStyle, style: Readonly<FeatureStyle>): void {
  if (style.pointShape !== undefined) point.shape = style.pointShape;
  if (style.pointRadius !== undefined) point.size = style.pointRadius * 2;
  if (style.pointColor !== undefined) point.fillColor = withAlpha(toColor(style.pointColor), 1);
  if (style.pointColor !== undefined || style.pointOpacity !== undefined) {
    point.fillOpacity = alphaOf(style.pointColor) * (style.pointOpacity ?? 1);
  }
  if (style.pointStrokeColor !== undefined) {
    point.strokeColor = withAlpha(toColor(style.pointStrokeColor), 1);
  }
  if (style.pointStrokeColor !== undefined || style.pointOpacity !== undefined) {
    point.strokeOpacity = alphaOf(style.pointStrokeColor) * (style.pointOpacity ?? 1);
  }
  if (style.pointStrokeWidth !== undefined) point.strokeWidth = style.pointStrokeWidth;
}

/**
 * A fill with the fill keys of a style; a color without an opacity keeps the alpha before
 *
 * @internal
 */
export function applyFill(fill: FillStyle, style: Readonly<FeatureStyle>): void {
  if (style.fillColor === undefined && style.fillOpacity === undefined) return;
  const base = style.fillColor !== undefined ? toColor(style.fillColor) : fill.color;
  const alpha = alphaOf(style.fillColor) * (style.fillOpacity ?? fill.color[3]);
  fill.color = withAlpha(base, alpha);
}

/**
 * The look of the geometry being drawn with the keys of a style put over it: the stroke keys give
 * its lines (the line to the pointer and the line that closes the shape keep their dashes), the
 * point keys its vertices (`pointStrokeColor` the outline of the marks of a circle too), and the
 * fill keys its fill
 *
 * @internal
 */
export function applyPreviewStyle(
  tentative: TentativeStyle,
  preview: Readonly<FeatureStyle>,
): void {
  applyStroke(tentative.stroke, preview);
  // The line to the pointer keeps its dashes
  applyStroke(tentative.tentativeStroke, preview, false);
  for (const vertex of [tentative.vertex, tentative.highlightedVertex]) {
    applyPoint(vertex, preview);
  }
  // The highlighted vertex stays larger than the others
  if (preview.pointRadius !== undefined) {
    tentative.highlightedVertex.size = preview.pointRadius * 2 + 4;
  }
  for (const marker of [tentative.circleCenterMarker, tentative.circleRadiusHandle]) {
    if (preview.pointStrokeColor !== undefined) {
      marker.strokeColor = withAlpha(toColor(preview.pointStrokeColor), 1);
    }
  }
  applyFill(tentative.fill, preview);
}
