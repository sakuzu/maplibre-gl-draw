// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the alpha blending of our own rendering
 *
 * Pins down "RGB as before, `ONE` for the alpha component alone". The meaning of the equations
 * is in the description in blend.ts. Here the actual composition result is computed from the
 * factors that were set, to confirm that a translucent fill does not thin the destination alpha.
 */

import { describe, expect, it } from 'vitest';
import { applyDrawBlendState, type BlendCapableGL } from './blend.js';

const GL = {
  BLEND: 1,
  ONE: 2,
  SRC_ALPHA: 3,
  ONE_MINUS_SRC_ALPHA: 4,
} as const;

function createGL(): { gl: BlendCapableGL; enabled: number[]; blend: number[][] } {
  const enabled: number[] = [];
  const blend: number[][] = [];
  const gl: BlendCapableGL = {
    ...GL,
    enable: (cap) => enabled.push(cap),
    blendFuncSeparate: (srcRGB, dstRGB, srcAlpha, dstAlpha) =>
      blend.push([srcRGB, dstRGB, srcAlpha, dstAlpha]),
  };
  return { gl, enabled, blend };
}

/** Composites one pixel with the factors that were set */
function composite(
  factors: number[],
  src: { rgb: number; a: number },
  dst: { rgb: number; a: number },
): { rgb: number; a: number } {
  const [srcRGB, dstRGB, srcAlpha, dstAlpha] = factors;
  const f = (factor: number, alpha: number): number => {
    if (factor === GL.ONE) return 1;
    if (factor === GL.SRC_ALPHA) return alpha;
    if (factor === GL.ONE_MINUS_SRC_ALPHA) return 1 - alpha;
    throw new Error(`Unknown factor: ${factor}`);
  };
  return {
    rgb: f(srcRGB, src.a) * src.rgb + f(dstRGB, src.a) * dst.rgb,
    a: f(srcAlpha, src.a) * src.a + f(dstAlpha, src.a) * dst.a,
  };
}

describe('applyDrawBlendState', () => {
  it('enables BLEND and sets the factors separately', () => {
    const { gl, enabled, blend } = createGL();
    applyDrawBlendState(gl);

    expect(enabled).toEqual([GL.BLEND]);
    expect(blend).toEqual([[GL.SRC_ALPHA, GL.ONE_MINUS_SRC_ALPHA, GL.ONE, GL.ONE_MINUS_SRC_ALPHA]]);
  });

  it('keeps the fill alpha as is even on a transparent destination (no squaring)', () => {
    const { gl, blend } = createGL();
    applyDrawBlendState(gl);

    // Put a 25% fill onto a transparent canvas
    const out = composite(blend[0], { rgb: 1, a: 0.25 }, { rgb: 0, a: 0 });
    expect(out.a).toBeCloseTo(0.25, 10);
    // The RGB is premultiplied (color × alpha)
    expect(out.rgb).toBeCloseTo(0.25, 10);
  });

  it('the appearance on an opaque destination (RGB and resulting opacity) is unchanged', () => {
    const { gl, blend } = createGL();
    applyDrawBlendState(gl);

    const out = composite(blend[0], { rgb: 1, a: 0.25 }, { rgb: 0, a: 1 });
    expect(out.rgb).toBeCloseTo(0.25, 10);
    expect(out.a).toBeCloseTo(1, 10);
  });

  it('stacking translucent fills still gives over composition', () => {
    const { gl, blend } = createGL();
    applyDrawBlendState(gl);

    // Stack 50% on top of 25% → the opacity is 0.5 + 0.5 × 0.25 = 0.625
    const first = composite(blend[0], { rgb: 1, a: 0.25 }, { rgb: 0, a: 0 });
    const second = composite(blend[0], { rgb: 1, a: 0.5 }, first);
    expect(second.a).toBeCloseTo(0.625, 10);
  });
});
