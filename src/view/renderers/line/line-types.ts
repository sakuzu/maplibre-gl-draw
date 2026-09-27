// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The types of the SDF line renderer
 *
 * The public stroke style and options, the line data handed to the batch paths, and the GPU
 * resources of a retained batch. `sdf-line.ts` re-exports them.
 */

import type { Color, LineStyle } from '../../../shared/types/style.js';

export type { Color, LineStyle };

/** The style of a line drawn by the shared line renderer. */
export interface SDFStrokeStyle {
  /** The line width in CSS px (at `createdZoom` when the options give one) */
  width: number;
  /** The color as `[r, g, b, a]`, each 0..1 */
  color: Color;
  /** The opacity, 0..1, multiplied into the color */
  opacity: number;
  /** Solid, dashed or dotted */
  lineStyle: LineStyle;
  /**
   * The dash and gap lengths in CSS px, `[dash, gap]`. When omitted, a preset of `lineStyle`
   * is used
   */
  dashArray?: number[];
}

/**
 * The unit of a line width: screen pixels (CSS px), or meters on the ground converted at the
 * zoom and the latitude.
 */
export type WidthUnit = 'pixels' | 'meters';

/** The options of one `draw` call of the shared line renderer. */
export interface SDFStrokeOptions {
  /** The unit of the width. The renderer draws `width` in CSS px */
  widthUnit: WidthUnit;
  /** Whether the path is closed (the last position joins the first) */
  closed: boolean;
  /** The id of the feature drawn, for diagnostics */
  featureId?: string;
  /**
   * The zoom at which `width` applies; the width then scales as `width * 2^(zoom -
   * createdZoom)`. When omitted, the width is fixed on screen
   */
  createdZoom?: number;
}

/**
 * Line data for batch rendering (the old form, without a color)
 *
 * For `drawBatch`, which receives the color as a per-batch argument.
 *
 * @internal
 */
export interface LineBatchItemBase {
  coords: Array<[number, number]>;
  featureId: string;
  closed: boolean;
  /**
   * The original pixel width (relative to createdZoom)
   *
   * Positive value: scales with zoom as `strokeWidth * 2^(zoom - createdZoom)`.
   * Negative value: a fixed width of `-strokeWidth` pixels (ignoring createdZoom and the zoom
   *   at draw time). This is the convention that lets features without a createdZoom be mixed
   *   into the same batch as variable-width features and drawn together (preserving z-order).
   * 0: use the per-batch `u_width` (the old immediate-mode path).
   */
  strokeWidth: number;
  createdZoom: number; // The zoom level at creation time
}

/**
 * Line data for batch rendering
 *
 * Color and opacity are passed to the shader as instance attributes, so lines can be drawn in
 * the same batch even when they differ from one line to the next.
 *
 * @internal
 */
export interface LineBatchItem extends LineBatchItemBase {
  color: Color;
  opacity: number;
}

/**
 * Shape parameters of a line batch
 *
 * The unit by which draw calls are split. Dashes are handled by a uniform in the fragment
 * shader, so unlike the color they have to be uniform across the batch.
 *
 * @internal
 */
export interface LineBatchShape {
  lineStyle: LineStyle;
  dashArray?: number[];
}

/**
 * A retained-mode line batch (GPU resources)
 *
 * It shares no resources with the shared buffers and shared textures of immediate mode. Each
 * batch owns its own coordinate texture, instance buffer, quad vertex buffer, and VAO, all of
 * which are released together by `disposeRetainedBatch`.
 *
 * @internal
 */
export interface RetainedLineBatch {
  /** The VAO, with the instance attributes already configured */
  readonly vao: WebGLVertexArrayObject;
  /** The quad vertex buffer (dedicated to this batch) */
  readonly quadBuffer: WebGLBuffer;
  /** The instance buffer (dedicated to this batch) */
  readonly instanceBuffer: WebGLBuffer;
  /** The coordinate texture (dedicated to this batch) */
  readonly texture: WebGLTexture;
  /** The side length of the coordinate texture */
  readonly texSize: number;
  /** The number of instances */
  readonly instanceCount: number;
  /** The per-batch shape parameters, such as the dash kind */
  readonly shape: LineBatchShape;
  /** The origin of the relative coordinates (already rounded to Float32) */
  readonly origin: [number, number];
  /**
   * The fixed zoom used for the line-width computation
   *
   * When null, the zoom at draw time is passed to u_zoom (the previous behavior of scaling
   * relative to createdZoom). When it holds a value, that value is always passed, so the line
   * width on screen stays constant regardless of zoom.
   */
  readonly widthZoom: number | null;
  /**
   * The length of the longest segment in the batch (meters, approximate)
   *
   * The value used to decide the number of subdivisions on terrain at draw time. It depends on
   * neither the camera nor the zoom, so the batch does not have to be rebuilt.
   */
  readonly maxSegmentMeters: number;
  /**
   * The length of the longest segment in the batch on the Mercator plane (world units)
   *
   * The value used to decide the number of subdivisions on the globe at draw time (the cell
   * changes with the zoom, the length does not).
   */
  readonly maxSegmentMercator: number;
}

/**
 * Options for building a retained-mode line batch
 *
 * @internal
 */
export interface RetainedLineBuildOptions {
  /** The origin of the relative coordinates (defaults to the first coordinate of the first
   * item) */
  origin?: [number, number];
  /** The fixed zoom used for the line-width computation (defaults to the zoom at draw time) */
  widthZoom?: number;
  /**
   * The zoom used to compute the cumulative distance (affects nothing but dashes; default 0)
   *
   * The distance is in px at this zoom, so a dash on a retained batch keeps its length only
   * at that zoom. Retained batches are solid; dashed lines are split on the CPU instead.
   */
  distanceZoom?: number;
}
