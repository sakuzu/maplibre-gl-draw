// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * BoxSelectionRenderer
 *
 * A renderer that draws the UI of the box selection made by shift-dragging.
 * It draws the frame of the rectangle (a dotted line) and a translucent fill.
 */

import type { Map as MapLibreMap, ProjectionData } from 'maplibre-gl';

import type { BoxSelectionStyleConfig } from '../../shared/config/rendering.js';
import { DEFAULT_BOX_SELECTION_STYLE_CONFIG } from '../../shared/config/rendering.js';
import type { PixelRatioInput } from '../../shared/utils/pixel-ratio.js';
import type { BoxSelection, Coordinate } from '../../store/types.js';
import { FillShaderManager } from '../renderers/polygon/fill.js';
import type { Color, StrokeStyle } from '../renderers/stroke.js';
import { StrokeRenderer } from '../renderers/stroke.js';
import type { OffsetUniforms, ShaderData } from '../shaders/helpers.js';

/**
 * BoxSelectionRenderer
 *
 * @internal
 */
export class BoxSelectionRenderer {
  private strokeRenderer: StrokeRenderer;
  private fillShaderManager: FillShaderManager;
  private styleConfig: BoxSelectionStyleConfig;

  constructor(
    map: MapLibreMap,
    gl: WebGL2RenderingContext,
    styleConfig?: BoxSelectionStyleConfig,
    pixelRatio?: PixelRatioInput,
  ) {
    // The rubber band is a rectangle on the screen, so it is never given elevation: its
    // renderers are built without the draw instance's terrain (they draw flat)
    this.strokeRenderer = new StrokeRenderer(map, gl, pixelRatio);
    this.fillShaderManager = new FillShaderManager(gl);
    this.styleConfig = styleConfig ?? DEFAULT_BOX_SELECTION_STYLE_CONFIG;
  }

  /**
   * Make sure the shader exists
   */
  ensureShader(shaderData: ShaderData): void {
    this.strokeRenderer.ensureShader(shaderData);
    this.fillShaderManager.ensureShader(shaderData);
  }

  /**
   * Set the offset uniforms
   */
  setOffsetUniforms(uniforms: OffsetUniforms): void {
    this.strokeRenderer.setOffsetUniforms(uniforms);
    this.fillShaderManager.setOffsetUniforms(uniforms);
  }

  /**
   * Draw the box selection UI
   */
  draw(boxSelection: BoxSelection, projectionData: ProjectionData, zoom: number): void {
    const { startPoint, endPoint } = boxSelection;

    // Compute the 4 vertices of the rectangle (a closed ring)
    const ring: Coordinate[] = [
      [startPoint[0], startPoint[1]],
      [endPoint[0], startPoint[1]],
      [endPoint[0], endPoint[1]],
      [startPoint[0], endPoint[1]],
      [startPoint[0], startPoint[1]], // closing it
    ];

    // Draw the fill
    this.fillShaderManager.drawPolygon(
      ring,
      this.styleConfig.fillColor as [number, number, number, number],
      projectionData,
      zoom,
    );

    // Draw the frame (a dotted line)
    const strokeStyle: StrokeStyle = {
      width: this.styleConfig.strokeWidth,
      color: this.styleConfig.strokeColor as Color,
      opacity: this.styleConfig.strokeOpacity,
      lineStyle: 'dashed',
      dashArray: this.styleConfig.dashArray,
    };

    this.strokeRenderer.draw(
      ring,
      strokeStyle,
      { widthUnit: 'pixels', closed: true },
      zoom,
      projectionData,
    );
  }

  /**
   * Dispose of the resources
   */
  dispose(): void {
    this.strokeRenderer.dispose();
    this.fillShaderManager.dispose();
  }
}
