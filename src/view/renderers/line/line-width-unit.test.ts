// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The unit of the width of a line the shared line renderer draws (`widthUnit`)
 *
 * - `pixels`: the width is CSS pixels on the screen; with `createdZoom` (the `referenceZoom` of
 *   the contract) it follows the zoom from there, on the GPU
 * - `meters`: the width is a length on the ground, turned into pixels at the zoom and at the
 *   latitude of the middle of the line, so it follows the map; `createdZoom` does not apply
 */

import type { Map as MapLibreMap, ProjectionData } from 'maplibre-gl';
import { describe, expect, it } from 'vitest';
import { metersPerPixelAtZoom } from '../../../shared/math/ground-scale.js';
import type { ShaderData } from '../../shaders/helpers.js';
import type { SDFStrokeOptions } from './line-types.js';
import { SDFLineRenderer } from './sdf-line.js';

const SHADER_DATA: ShaderData = {
  vertexShaderPrelude: 'vec4 projectTile(vec2 p) { return vec4(p, 0.0, 1.0); }',
  define: '',
  variantName: 'mercator',
};

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const PROJECTION = {
  mainMatrix: IDENTITY,
  tileMercatorCoords: [0, 0, 1, 1],
  clippingPlane: [0, 0, 0, 0],
  projectionTransition: 0,
  fallbackMatrix: IDENTITY,
} as unknown as ProjectionData;

/** A GL that does nothing but record the writes of `u_width` */
function recordingGL(): { gl: WebGL2RenderingContext; widths: number[] } {
  const widths: number[] = [];
  const gl = new Proxy(
    {
      canvas: { width: 800, height: 600 },
      drawingBufferWidth: 800,
      drawingBufferHeight: 600,
      getUniformLocation: (_program: unknown, name: string) => ({ name }),
      uniform1f: (location: { name: string } | null, value: number) => {
        if (location?.name === 'u_width') widths.push(value);
      },
      getShaderParameter: () => true,
      getProgramParameter: () => true,
      getParameter: () => 4096,
    } as Record<string, unknown>,
    {
      get(target, prop) {
        if (prop in target) return target[prop as string];
        if (typeof prop === 'string' && /^[A-Z_0-9]+$/.test(prop)) return 1;
        return () => ({});
      },
    },
  ) as unknown as WebGL2RenderingContext;
  return { gl, widths };
}

/** The `u_width` a draw of a line at latitude 35 sets, in physical pixels at a ratio of 1 */
function widthOf(width: number, options: SDFStrokeOptions, zoom: number): number | undefined {
  const { gl, widths } = recordingGL();
  const renderer = new SDFLineRenderer({} as MapLibreMap, gl, 1);
  renderer.ensureShader(SHADER_DATA);
  renderer.draw(
    [
      [139, 34],
      [140, 36],
    ],
    { width, color: [1, 0, 0, 1], opacity: 1, lineStyle: 'solid' },
    options,
    zoom,
    PROJECTION,
  );
  return widths[widths.length - 1];
}

describe('the unit of the width of a line', () => {
  it('draws a width in pixels as it is, without a zoom of reference', () => {
    expect(widthOf(4, { widthUnit: 'pixels', closed: false }, 12)).toBeCloseTo(4, 6);
  });

  it('draws a width in meters as the pixels it spans on the ground at the zoom drawn', () => {
    const at12 = widthOf(100, { widthUnit: 'meters', closed: false }, 12) ?? 0;
    expect(at12).toBeCloseTo(100 / metersPerPixelAtZoom(35, 12), 4);
    // It follows the map: twice as wide a zoom level in
    const at13 = widthOf(100, { widthUnit: 'meters', closed: false }, 13) ?? 0;
    expect(at13 / at12).toBeCloseTo(2, 6);
  });

  it('takes no zoom of reference for a width in meters', () => {
    const plain = widthOf(100, { widthUnit: 'meters', closed: false }, 12);
    const withZoom = widthOf(100, { widthUnit: 'meters', closed: false, createdZoom: 5 }, 12);
    expect(withZoom).toBeCloseTo(plain ?? Number.NaN, 6);
  });
});
