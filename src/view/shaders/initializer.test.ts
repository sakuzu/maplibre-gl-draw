// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The renderers ShaderInitializer prepares each frame
 *
 * The fill shared with the render context of custom feature renderers has no draw path of its
 * own in core, so it gets its program and its offset uniforms only from here. A fill that is
 * left out draws nothing, without an error.
 */

import { describe, expect, it, vi } from 'vitest';
import type { FillShaderManager } from '../renderers/polygon/fill.js';
import type { OffsetUniforms, ShaderData } from './helpers.js';
import { ShaderInitializer, type ShaderInitializerRenderers } from './initializer.js';

function emptyRenderers(): ShaderInitializerRenderers {
  return {
    featureDrawer: null,
    tentativeRenderer: null,
    quadShader: null,
    strokeRenderer: null,
    outlineRenderer: null,
    pointShapeRenderer: null,
    pointInstanceRenderer: null,
    sdfLineRenderer: null,
    polygonBatchRenderer: null,
    sdfPolygonRenderer: null,
    fillShaderManager: null,
  };
}

function fakeFill() {
  const ensureShader = vi.fn();
  const setOffsetUniforms = vi.fn();
  const fill = { ensureShader, setOffsetUniforms } as unknown as FillShaderManager;
  return { fill, ensureShader, setOffsetUniforms };
}

describe('ShaderInitializer', () => {
  it('ensures the shader of the shared fill', () => {
    const { fill, ensureShader } = fakeFill();
    const initializer = new ShaderInitializer({ ...emptyRenderers(), fillShaderManager: fill });
    const shaderData = { variantName: 'mercator' } as unknown as ShaderData;

    initializer.ensureShaders(shaderData);

    expect(ensureShader).toHaveBeenCalledTimes(1);
    expect(ensureShader).toHaveBeenCalledWith(shaderData);
  });

  it('sets the offset uniforms of the shared fill', () => {
    const { fill, setOffsetUniforms } = fakeFill();
    const initializer = new ShaderInitializer({ ...emptyRenderers(), fillShaderManager: fill });
    const uniforms = { projectionCenter: [0, 0, 0, 1] } as unknown as OffsetUniforms;

    initializer.applyOffsetUniforms(uniforms);

    expect(setOffsetUniforms).toHaveBeenCalledTimes(1);
    expect(setOffsetUniforms).toHaveBeenCalledWith(uniforms);
  });

  it('skips a missing fill', () => {
    const initializer = new ShaderInitializer(emptyRenderers());
    expect(() => initializer.ensureShaders({} as ShaderData)).not.toThrow();
    expect(() => initializer.applyOffsetUniforms({} as OffsetUniforms)).not.toThrow();
  });
});
