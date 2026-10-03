// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * ShaderInitializer
 *
 * Manages the shader initialization and the projection data setup of every
 * renderer in one place.
 */

import type { ProjectionData } from 'maplibre-gl';
import type { AnchoredOutlineRenderer } from '../renderers/anchored-outline.js';
import type { FeatureDrawer } from '../renderers/drawer.js';
import type { SDFLineRenderer } from '../renderers/line/sdf-line.js';
import type { PointInstanceRenderer } from '../renderers/point/point-instance.js';
import type { PointShapeRenderer } from '../renderers/point/point-shape.js';
import type { PolygonBatchRenderer } from '../renderers/polygon/batch.js';
import type { FillShaderManager } from '../renderers/polygon/fill.js';
import type { SDFPolygonRenderer } from '../renderers/polygon/sdf-polygon.js';
import type { StrokeRenderer } from '../renderers/stroke.js';
import type { TentativeRenderer } from '../ui/tentative.js';
import { calculateOffsetUniforms, type OffsetUniforms, type ShaderData } from './helpers.js';
import type { QuadShader } from './quad.js';

/**
 * The renderers managed by ShaderInitializer
 */
export interface ShaderInitializerRenderers {
  featureDrawer: FeatureDrawer | null;
  tentativeRenderer: TentativeRenderer | null;
  quadShader: QuadShader | null;
  strokeRenderer: StrokeRenderer | null;
  /** The outlines laid on the screen around an anchor (the frames of points) */
  outlineRenderer: AnchoredOutlineRenderer | null;
  pointShapeRenderer: PointShapeRenderer | null;
  pointInstanceRenderer: PointInstanceRenderer | null;
  sdfLineRenderer: SDFLineRenderer | null;
  polygonBatchRenderer: PolygonBatchRenderer | null;
  sdfPolygonRenderer: SDFPolygonRenderer | null;
  /** The fill shared with the render context of custom feature renderers */
  fillShaderManager: FillShaderManager | null;
}

/**
 * ShaderInitializer
 *
 * Manages the shader initialization and the projection data setup of every
 * renderer
 *
 * @internal
 */
export class ShaderInitializer {
  private renderers: ShaderInitializerRenderers;

  constructor(renderers: ShaderInitializerRenderers) {
    this.renderers = renderers;
  }

  /**
   * Makes every renderer ensure its shader
   */
  ensureShaders(shaderData: ShaderData): void {
    const {
      featureDrawer,
      tentativeRenderer,
      quadShader,
      strokeRenderer,
      outlineRenderer,
      pointShapeRenderer,
      pointInstanceRenderer,
      sdfLineRenderer,
      polygonBatchRenderer,
      sdfPolygonRenderer,
      fillShaderManager,
    } = this.renderers;

    if (featureDrawer) {
      featureDrawer.ensureShader(shaderData);
    }
    if (tentativeRenderer) {
      tentativeRenderer.ensureShader(shaderData);
    }
    if (quadShader) {
      quadShader.ensureShader(shaderData);
    }
    if (strokeRenderer) {
      strokeRenderer.ensureShader(shaderData);
    }
    if (outlineRenderer) {
      outlineRenderer.ensureShader(shaderData);
    }
    if (pointShapeRenderer) {
      pointShapeRenderer.ensureShader(shaderData);
    }
    if (pointInstanceRenderer) {
      pointInstanceRenderer.ensureShader(shaderData);
    }
    if (sdfLineRenderer) {
      sdfLineRenderer.ensureShader(shaderData);
    }
    if (polygonBatchRenderer) {
      polygonBatchRenderer.ensureShader(shaderData);
    }
    if (sdfPolygonRenderer) {
      sdfPolygonRenderer.ensureShader(shaderData);
    }
    fillShaderManager?.ensureShader(shaderData);
  }

  /**
   * Sets the projection data on the renderers that need it
   */
  setProjectionData(projectionData: ProjectionData): void {
    const { pointShapeRenderer, pointInstanceRenderer } = this.renderers;

    if (pointShapeRenderer) {
      pointShapeRenderer.setProjectionData(projectionData);
    }
    if (pointInstanceRenderer) {
      pointInstanceRenderer.setProjectionData(projectionData);
    }
  }

  /**
   * Sets the uniforms for offset mode on every renderer
   * Computes projectionCenter at 64-bit precision on the CPU side and passes it to each renderer
   * The uniforms for globe mode are set directly from ProjectionData
   */
  setOffsetUniforms(centerLngLat: [number, number], mainMatrix: Float32Array | number[]): void {
    this.applyOffsetUniforms(calculateOffsetUniforms(centerLngLat, mainMatrix));
  }

  /**
   * Sets uniforms for offset mode that are already computed on every renderer
   *
   * The rendering of one copy of the world (the view across the antimeridian) computes its
   * uniforms once per frame and applies them for each slot.
   */
  applyOffsetUniforms(uniforms: OffsetUniforms): void {
    const {
      featureDrawer,
      tentativeRenderer,
      quadShader,
      strokeRenderer,
      outlineRenderer,
      pointShapeRenderer,
      pointInstanceRenderer,
      sdfLineRenderer,
      polygonBatchRenderer,
      sdfPolygonRenderer,
      fillShaderManager,
    } = this.renderers;

    if (featureDrawer) {
      featureDrawer.setOffsetUniforms(uniforms);
    }
    if (tentativeRenderer) {
      tentativeRenderer.setOffsetUniforms(uniforms);
    }
    if (quadShader) {
      quadShader.setOffsetUniforms(uniforms);
    }
    if (strokeRenderer) {
      strokeRenderer.setOffsetUniforms(uniforms);
    }
    if (outlineRenderer) {
      outlineRenderer.setOffsetUniforms(uniforms);
    }
    if (pointShapeRenderer) {
      pointShapeRenderer.setOffsetUniforms(uniforms);
    }
    if (pointInstanceRenderer) {
      pointInstanceRenderer.setOffsetUniforms(uniforms);
    }
    if (sdfLineRenderer) {
      sdfLineRenderer.setOffsetUniforms(uniforms);
    }
    if (polygonBatchRenderer) {
      polygonBatchRenderer.setOffsetUniforms(uniforms);
    }
    if (sdfPolygonRenderer) {
      sdfPolygonRenderer.setOffsetUniforms(uniforms);
    }
    fillShaderManager?.setOffsetUniforms(uniforms);
  }

  /**
   * Increments the frame count of SDFLineRenderer
   */
  incrementSdfLineFrame(): void {
    if (this.renderers.sdfLineRenderer) {
      this.renderers.sdfLineRenderer.incrementFrame();
    }
  }
}

/**
 * Creates a ShaderInitializer
 */
export function createShaderInitializer(renderers: ShaderInitializerRenderers): ShaderInitializer {
  return new ShaderInitializer(renderers);
}
