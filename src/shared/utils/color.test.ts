// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests of the color interpolation utilities
 *
 * interpolateHexColor is the OKLab interpolation used for continuous color ramps.
 * The expected values were derived from the coefficients of Björn Ottosson's original article
 * (https://bottosson.github.io/posts/oklab/), not copied from the output of the
 * implementation.
 */

import { describe, expect, it } from 'vitest';
import { interpolateHexColor } from './color.js';

describe('the endpoints of interpolateHexColor', () => {
  it('t=0 matches the start point and t=1 matches the end point exactly', () => {
    expect(interpolateHexColor('#ff0000', '#0000ff', 0)).toBe('#ff0000');
    expect(interpolateHexColor('#ff0000', '#0000ff', 1)).toBe('#0000ff');
    expect(interpolateHexColor('#123456', '#fedcba', 0)).toBe('#123456');
    expect(interpolateHexColor('#123456', '#fedcba', 1)).toBe('#fedcba');
  });

  it('the colors of the endpoints are not broken by the round-trip conversion', () => {
    // Confirm with representative colors that going through OKLab does not shift the color
    // through rounding error
    const colors = [
      '#000000',
      '#ffffff',
      '#ff0000',
      '#00ff00',
      '#0000ff',
      '#010203',
      '#7f7f80',
      '#fedcba',
      '#123456',
      '#888888',
    ];
    for (const color of colors) {
      expect(interpolateHexColor(color, '#00ff88', 0)).toBe(color);
      expect(interpolateHexColor('#00ff88', color, 1)).toBe(color);
    }
  });

  it('t is clamped to 0-1', () => {
    expect(interpolateHexColor('#ff0000', '#0000ff', -0.5)).toBe('#ff0000');
    expect(interpolateHexColor('#ff0000', '#0000ff', -100)).toBe('#ff0000');
    expect(interpolateHexColor('#ff0000', '#0000ff', 1.5)).toBe('#0000ff');
    expect(interpolateHexColor('#ff0000', '#0000ff', 42)).toBe('#0000ff');
  });

  it('two identical colors return the original color at any t', () => {
    for (const t of [0, 0.13, 0.25, 0.5, 0.5001, 0.75, 0.99, 1]) {
      expect(interpolateHexColor('#123456', '#123456', t)).toBe('#123456');
      expect(interpolateHexColor('#ff8800', '#ff8800', t)).toBe('#ff8800');
      expect(interpolateHexColor('#000000', '#000000', t)).toBe('#000000');
    }
  });
});

describe('the midpoint of interpolateHexColor', () => {
  it('the midpoint of black to white is the perceptually middle gray', () => {
    // The midpoint of black OKLab(0,0,0) and white OKLab(1,0,0) is L=0.5.
    // The coefficients of each row of the inverse matrix sum to 1, so l=m=s=0.5^3=0.125,
    // linear sRGB is also 0.125, and the transfer function 1.055*0.125^(1/2.4)-0.055
    // = 0.38858 → 0.38858*255 = 99.09 → 99 = 0x63。
    expect(interpolateHexColor('#000000', '#ffffff', 0.5)).toBe('#636363');
  });

  it('the midpoint of black to white is darker than the RGB midpoint #808080', () => {
    // The perceptually middle gray has a linear luminance of 0.125, darker than the RGB
    // midpoint (linear 0.2159)
    const mid = interpolateHexColor('#000000', '#ffffff', 0.5);
    expect(Number.parseInt(mid.slice(1, 3), 16)).toBeLessThan(0x80);
  });

  it('t=0.25 from black to white is the gray with L=0.25', () => {
    // l=m=s=0.25^3=0.015625 → 1.055*0.015625^(1/2.4)-0.055 = 0.13150
    // → 0.13150*255 = 33.53 → 34 = 0x22
    expect(interpolateHexColor('#000000', '#ffffff', 0.25)).toBe('#222222');
  });

  it('the midpoint of red to blue is a lighter purple than the RGB interpolation', () => {
    // Taking the midpoint (0.53998, 0.09620, -0.09284) of red OKLab(0.62796, 0.22486,
    // 0.12585) and blue OKLab(0.45201, -0.03246, -0.31153) back through the inverse
    // conversion of the original article gives
    // (140.36, 83.03, 162.31) → #8c53a2
    expect(interpolateHexColor('#ff0000', '#0000ff', 0.5)).toBe('#8c53a2');
    // It differs from #800080, the component-wise RGB interpolation
    expect(interpolateHexColor('#ff0000', '#0000ff', 0.5)).not.toBe('#800080');
  });
});

describe('the input forms of interpolateHexColor', () => {
  it('treats the shorthand #RGB the same as #RRGGBB', () => {
    expect(interpolateHexColor('#f00', '#00f', 0.5)).toBe(
      interpolateHexColor('#ff0000', '#0000ff', 0.5),
    );
    expect(interpolateHexColor('#000', '#fff', 0.5)).toBe('#636363');
    expect(interpolateHexColor('#abc', '#abc', 0.3)).toBe('#aabbcc');
  });

  it('the output is always lowercase #rrggbb', () => {
    expect(interpolateHexColor('#FF0000', '#0000FF', 0.5)).toBe('#8c53a2');
    expect(interpolateHexColor('#ABCDEF', '#ABCDEF', 0.5)).toBe('#abcdef');
  });
});
