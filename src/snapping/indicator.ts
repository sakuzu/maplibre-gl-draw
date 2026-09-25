// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Snapping indicator
 *
 * A built-in overlay renderer that draws the current snapping result (what was
 * snapped to and how) with a symbol. It is put in front of the selection UI
 * (order: 'overlay').
 *
 * The symbols are drawn with the existing PointShapeRenderer (no shader is added).
 *
 *   Vertex       A circle (outline only)
 *   Edge         A square (outline only)
 *   Intersection A small filled circle (to tell it apart from the circle of a vertex)
 *   Guide        A small circle (outline only) and the dashed guide line of the
 *                snapping target
 *
 * The guide line uses SDFLineRenderer in the same manner as TentativeRenderer, with a
 * step ([4, 4]) that can be told apart from the dashes of Tentative ([8, 6]).
 */

import type { Map as MapLibreMap, ProjectionData } from 'maplibre-gl';
import type { CustomOverlayRenderer, CustomRendererDrawContext } from '../extension/index.js';
import type { PointStyle } from '../shared/types/style.js';
import type { SDFStrokeStyle } from '../view/renderers/line/sdf-line.js';
import type { SnapService, SnapTargetKind } from './types.js';

/**
 * The symbol drawn at the snapped point, per kind of snap target.
 */
export type SnapIndicatorStyles = Record<SnapTargetKind, PointStyle>;

/** The snapping color (#00C7BE) */
const SNAP_COLOR: [number, number, number, number] = [0.0, 0.78, 0.745, 1.0];

const VERTEX_STYLE: PointStyle = {
  shape: 'circle',
  size: 14,
  fillColor: SNAP_COLOR,
  fillOpacity: 0,
  strokeColor: SNAP_COLOR,
  strokeWidth: 2,
  strokeOpacity: 1.0,
};

const EDGE_STYLE: PointStyle = {
  shape: 'square',
  size: 12,
  fillColor: SNAP_COLOR,
  fillOpacity: 0,
  strokeColor: SNAP_COLOR,
  strokeWidth: 2,
  strokeOpacity: 1.0,
};

/**
 * The symbol of an intersection
 *
 * To tell it apart from a vertex (a circle with an outline only), it is a slightly
 * smaller filled circle. The shapes PointShapeRenderer can actually draw are the
 * circle and the square, so a diamond cannot be used.
 */
const INTERSECTION_STYLE: PointStyle = {
  shape: 'circle',
  size: 8,
  fillColor: SNAP_COLOR,
  fillOpacity: 1.0,
  strokeColor: SNAP_COLOR,
  strokeWidth: 0,
  strokeOpacity: 0,
};

/**
 * The symbol of a guide
 *
 * It appears together with the guide line (dashed), so the point is a smallish circle
 * with an outline.
 */
const GUIDE_STYLE: PointStyle = {
  shape: 'circle',
  size: 10,
  fillColor: SNAP_COLOR,
  fillOpacity: 0,
  strokeColor: SNAP_COLOR,
  strokeWidth: 2,
  strokeOpacity: 1.0,
};

/**
 * The dash pattern of a guide line (told apart from the [8, 6] of Tentative)
 */
const GUIDE_DASH_ARRAY: [number, number] = [4, 4];

/**
 * The style of the guide line drawn under the symbol while a guide is snapped to: 1 px, the
 * snap color `#00C7BE`, dashed `[4, 4]` (distinct from the `[8, 6]` of the drawing in
 * progress).
 */
export const DEFAULT_SNAP_GUIDE_LINE_STYLE: SDFStrokeStyle = {
  width: 1,
  color: SNAP_COLOR,
  opacity: 1.0,
  lineStyle: 'dashed',
  dashArray: GUIDE_DASH_ARRAY,
};

/**
 * The symbols drawn at the snapped point, all in the snap color `#00C7BE`: `vertex` an
 * outlined circle of 14 px, `edge` an outlined square of 12 px, `intersection` a filled
 * circle of 8 px and `guide` an outlined circle of 10 px.
 */
export const DEFAULT_SNAP_INDICATOR_STYLES: SnapIndicatorStyles = {
  vertex: VERTEX_STYLE,
  edge: EDGE_STYLE,
  intersection: INTERSECTION_STYLE,
  guide: GUIDE_STYLE,
};

/**
 * The dependencies of the snapping indicator
 *
 * @internal
 */
export interface SnapIndicatorRendererDeps {
  /** Where the snapping result to draw is obtained from */
  snapService: SnapService;
  /** A replacement of the styles (per kind) */
  styles?: Partial<SnapIndicatorStyles>;
  /** A replacement of the style of the guide line (dashed) */
  guideLineStyle?: SDFStrokeStyle;
}

/**
 * The renderer of the snapping indicator
 *
 * @internal
 */
export class SnapIndicatorRenderer implements CustomOverlayRenderer {
  readonly name = 'snap-indicator';
  readonly order = 'overlay' as const;

  private snapService: SnapService;
  private styles: SnapIndicatorStyles;
  private guideLineStyle: SDFStrokeStyle;

  constructor(deps: SnapIndicatorRendererDeps) {
    this.snapService = deps.snapService;
    this.styles = { ...DEFAULT_SNAP_INDICATOR_STYLES, ...deps.styles };
    this.guideLineStyle = deps.guideLineStyle ?? DEFAULT_SNAP_GUIDE_LINE_STYLE;
  }

  onAdd(_gl: WebGL2RenderingContext, _map: MapLibreMap): void {
    // It uses the existing drawing primitives, so it holds no GPU resources of its own
  }

  draw(projectionData: ProjectionData, zoom: number, context: CustomRendererDrawContext): void {
    const result = this.snapService.getResult();
    if (!result?.target) return;

    const target = result.target;

    // For a guide, the guide line of the snapping target itself is shown dashed (laid
    // under the symbol)
    if (target.kind === 'guide' && target.segment) {
      const line: Array<[number, number]> = [
        [target.segment.start[0], target.segment.start[1]],
        [target.segment.end[0], target.segment.end[1]],
      ];
      context.sdfLineRenderer.draw(
        line,
        this.guideLineStyle,
        { widthUnit: 'pixels', closed: false },
        zoom,
        projectionData,
      );
    }

    const style = this.styles[target.kind];
    context.pointShapeRenderer.draw([result.lngLat.lng, result.lngLat.lat], style, zoom);
  }

  onRemove(): void {
    // There are no resources to release
  }
}
