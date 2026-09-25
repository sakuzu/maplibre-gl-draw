// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The renderer-specific uniforms of the SDF line program, with a record of the values written
 * last
 *
 * The projection uniforms are handled by ProjectionUniformManager; this covers the line width,
 * the zoom, the viewport, the miter limit, the coordinate texture, the subdivision count, the
 * dash pattern, and the draw-time factors. Writes of the same value are skipped within a frame
 * (see shaders/frame.ts).
 */

import { getDashPattern, RENDERING_DEFAULTS } from '../../../shared/math/index.js';
import { getRenderFrame } from '../../shaders/frame.js';
import type { RetainedDrawFactors } from '../draw-factors.js';
import type { LineBatchShape } from './line-types.js';

/**
 * The uniform locations of one SDF line program and the values written to them last
 *
 * @internal
 */
export class LineUniforms {
  // Uniform locations (renderer-specific)
  // Color and opacity are instance attributes, so they have no uniforms
  private widthLoc: WebGLUniformLocation | null = null;
  private viewportLoc: WebGLUniformLocation | null = null;
  private miterLimitLoc: WebGLUniformLocation | null = null;
  private coordTexLoc: WebGLUniformLocation | null = null;
  private texSizeLoc: WebGLUniformLocation | null = null;
  private dashArrayLoc: WebGLUniformLocation | null = null;
  private dashEnabledLoc: WebGLUniformLocation | null = null;
  private zoomLoc: WebGLUniformLocation | null = null;
  private sizeScaleLoc: WebGLUniformLocation | null = null;
  private opacityLoc: WebGLUniformLocation | null = null;
  private stationsLoc: WebGLUniformLocation | null = null;
  private stationMercatorLoc: WebGLUniformLocation | null = null;

  // A record of the renderer-specific uniforms written last (for memoization within a frame)
  //
  // Retained mode passes through here once per chunk, but the viewport, the miter limit, and
  // the sampler unit are invariant within a frame. Writes of the same value are skipped, and
  // they are rewritten once the frame changes (see shaders/frame.ts).
  private memoViewportFrame = -1;
  private memoViewportWidth = Number.NaN;
  private memoViewportHeight = Number.NaN;
  private memoFrame = -1;
  private memoWidth = Number.NaN;
  private memoZoom = Number.NaN;
  private memoMiterLimit = Number.NaN;
  private memoTexSize = Number.NaN;
  private memoStations = Number.NaN;
  private memoStationMercator = Number.NaN;
  private memoCoordTexUnit = Number.NaN;
  private memoDashFrame = -1;
  private memoDashEnabled = Number.NaN;
  private memoDashLength = Number.NaN;
  private memoDashGap = Number.NaN;
  private memoFactorsFrame = -1;
  private memoSizeScale = Number.NaN;
  private memoOpacity = Number.NaN;

  constructor(private readonly gl: WebGL2RenderingContext) {}

  /**
   * Reads the uniform locations of a (re)created program and discards the record
   *
   * A recreated program also resets its uniforms to their initial values.
   */
  bind(program: WebGLProgram): void {
    this.widthLoc = this.gl.getUniformLocation(program, 'u_width');
    this.viewportLoc = this.gl.getUniformLocation(program, 'u_viewport');
    this.miterLimitLoc = this.gl.getUniformLocation(program, 'u_miter_limit');
    this.coordTexLoc = this.gl.getUniformLocation(program, 'u_coord_tex');
    this.texSizeLoc = this.gl.getUniformLocation(program, 'u_tex_size');
    this.dashArrayLoc = this.gl.getUniformLocation(program, 'u_dashArray');
    this.dashEnabledLoc = this.gl.getUniformLocation(program, 'u_dashEnabled');
    this.zoomLoc = this.gl.getUniformLocation(program, 'u_zoom');
    this.sizeScaleLoc = this.gl.getUniformLocation(program, 'u_size_scale');
    this.opacityLoc = this.gl.getUniformLocation(program, 'u_opacity');
    this.stationsLoc = this.gl.getUniformLocation(program, 'u_stations');
    this.stationMercatorLoc = this.gl.getUniformLocation(program, 'u_station_mercator');
    this.reset();
  }

  /**
   * Discards the record of the values written last
   */
  reset(): void {
    this.memoViewportFrame = -1;
    this.memoViewportWidth = Number.NaN;
    this.memoViewportHeight = Number.NaN;
    this.memoFrame = -1;
    this.memoWidth = Number.NaN;
    this.memoZoom = Number.NaN;
    this.memoMiterLimit = Number.NaN;
    this.memoTexSize = Number.NaN;
    this.memoStations = Number.NaN;
    this.memoStationMercator = Number.NaN;
    this.memoCoordTexUnit = Number.NaN;
    this.memoDashFrame = -1;
    this.memoDashEnabled = Number.NaN;
    this.memoDashLength = Number.NaN;
    this.memoDashGap = Number.NaN;
    this.memoFactorsFrame = -1;
    this.memoSizeScale = Number.NaN;
    this.memoOpacity = Number.NaN;
  }

  /**
   * Writes the viewport (not rewritten when the value is the same)
   */
  setViewport(width: number, height: number): void {
    if (!this.viewportLoc) return;
    const frame = getRenderFrame();
    if (
      this.memoViewportFrame === frame &&
      this.memoViewportWidth === width &&
      this.memoViewportHeight === height
    ) {
      return;
    }
    this.gl.uniform2f(this.viewportLoc, width, height);
    this.memoViewportWidth = width;
    this.memoViewportHeight = height;
    this.memoViewportFrame = frame;
  }

  /**
   * Writes the uniforms for the line width, the zoom, the miter limit, and the coordinate
   * texture (shared between immediate mode and retained mode; not rewritten when the value is
   * the same)
   *
   * @param stations The number of parts a segment is split into (1 = not split)
   * @param mercatorStations Whether the split points move along the Mercator plane (the
   *   globe) rather than along the degrees (the terrain)
   */
  setLineDraw(
    width: number,
    zoomValue: number,
    texSize: number,
    stations: number,
    mercatorStations = false,
  ): void {
    const gl = this.gl;
    const frame = getRenderFrame();
    const staleFrame = this.memoFrame !== frame;

    if (this.widthLoc && (staleFrame || this.memoWidth !== width)) {
      gl.uniform1f(this.widthLoc, width);
      this.memoWidth = width;
    }
    if (this.zoomLoc && (staleFrame || this.memoZoom !== zoomValue)) {
      gl.uniform1f(this.zoomLoc, zoomValue);
      this.memoZoom = zoomValue;
    }
    if (
      this.miterLimitLoc &&
      (staleFrame || this.memoMiterLimit !== RENDERING_DEFAULTS.MITER_LIMIT)
    ) {
      gl.uniform1f(this.miterLimitLoc, RENDERING_DEFAULTS.MITER_LIMIT);
      this.memoMiterLimit = RENDERING_DEFAULTS.MITER_LIMIT;
    }
    if (this.texSizeLoc && (staleFrame || this.memoTexSize !== texSize)) {
      gl.uniform1f(this.texSizeLoc, texSize);
      this.memoTexSize = texSize;
    }
    if (this.stationsLoc && (staleFrame || this.memoStations !== stations)) {
      gl.uniform1f(this.stationsLoc, stations);
      this.memoStations = stations;
    }
    const stationMercator = mercatorStations ? 1 : 0;
    if (this.stationMercatorLoc && (staleFrame || this.memoStationMercator !== stationMercator)) {
      gl.uniform1f(this.stationMercatorLoc, stationMercator);
      this.memoStationMercator = stationMercator;
    }
    // The sampler unit (binding the texture is done by the caller every time)
    if (this.coordTexLoc && (staleFrame || this.memoCoordTexUnit !== 0)) {
      gl.uniform1i(this.coordTexLoc, 0);
      this.memoCoordTexUnit = 0;
    }

    this.memoFrame = frame;
  }

  /**
   * Writes the factors used at draw time
   *
   * Uniforms are per-program residual state, so paths that do not use the factors (immediate
   * mode, the Store's retained rendering) always reset them to 1. If the value already written
   * is the same, it is not rewritten.
   */
  setDrawFactors(factors: RetainedDrawFactors): void {
    const gl = this.gl;
    const frame = getRenderFrame();
    const staleFrame = this.memoFactorsFrame !== frame;

    if (this.sizeScaleLoc && (staleFrame || this.memoSizeScale !== factors.scale)) {
      gl.uniform1f(this.sizeScaleLoc, factors.scale);
      this.memoSizeScale = factors.scale;
    }
    if (this.opacityLoc && (staleFrame || this.memoOpacity !== factors.opacity)) {
      gl.uniform1f(this.opacityLoc, factors.opacity);
      this.memoOpacity = factors.opacity;
    }
    this.memoFactorsFrame = frame;
  }

  /**
   * Sets the dash-related uniforms (shared between immediate mode and retained mode)
   *
   * They are not rewritten when the value is the same (lines in retained mode are always
   * solid, so no matter how many chunks are drawn there is no need to rewrite "not dashed").
   *
   * @param pixelRatio Drawing-buffer px per CSS px (the ratio the cumulative distance of the
   *   instances was written with)
   */
  setDash(shape: LineBatchShape, pixelRatio: number): void {
    const gl = this.gl;
    const frame = getRenderFrame();
    const staleFrame = this.memoDashFrame !== frame;

    const dash = resolveDashUniform(shape, pixelRatio);
    const dashEnabled = dash ? 1.0 : 0.0;

    if (this.dashEnabledLoc && (staleFrame || this.memoDashEnabled !== dashEnabled)) {
      gl.uniform1f(this.dashEnabledLoc, dashEnabled);
      this.memoDashEnabled = dashEnabled;
    }
    if (dash && this.dashArrayLoc) {
      const [dashLength, gapLength] = dash;
      if (staleFrame || this.memoDashLength !== dashLength || this.memoDashGap !== gapLength) {
        gl.uniform4fv(this.dashArrayLoc, dash);
        this.memoDashLength = dashLength;
        this.memoDashGap = gapLength;
      }
    }

    this.memoDashFrame = frame;
  }
}

/**
 * The value of `u_dashArray` for a batch, or null when the line is solid
 *
 * The dash and the gap are given in CSS px and returned in drawing-buffer px
 * (`[dash, gap, dash + gap, 0]`), the unit of the cumulative distance the vertex shader
 * passes on (`v_linesofar`), so a dash keeps its length in CSS px at any zoom and latitude.
 *
 * @param pixelRatio Drawing-buffer px per CSS px
 *
 * @internal
 */
export function resolveDashUniform(
  shape: LineBatchShape,
  pixelRatio: number,
): [number, number, number, number] | null {
  const dashPattern = shape.dashArray ?? getDashPattern(shape.lineStyle);
  if (shape.lineStyle === 'solid' || dashPattern.length < 2) return null;
  const dash = dashPattern[0] * pixelRatio;
  const gap = dashPattern[1] * pixelRatio;
  return [dash, gap, dash + gap, 0];
}
