// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Color conversion utilities
 *
 * Functions that convert between HEX color strings and RGBA arrays.
 */

import type { Color } from '../types/style.js';

/**
 * Extracts the RGB values from a HEX color string
 *
 * @param hex - A color string in #RRGGBB or #RGB form
 * @returns { r, g, b }, each value in 0-255
 */
function parseHexToRgb(hex: string): { r: number; g: number; b: number } {
  const cleanHex = hex.replace('#', '');

  let r: number;
  let g: number;
  let b: number;

  if (cleanHex.length === 3) {
    // #RGB form
    r = Number.parseInt(cleanHex[0] + cleanHex[0], 16);
    g = Number.parseInt(cleanHex[1] + cleanHex[1], 16);
    b = Number.parseInt(cleanHex[2] + cleanHex[2], 16);
  } else {
    // #RRGGBB form
    r = Number.parseInt(cleanHex.substring(0, 2), 16);
    g = Number.parseInt(cleanHex.substring(2, 4), 16);
    b = Number.parseInt(cleanHex.substring(4, 6), 16);
  }

  return { r, g, b };
}

/**
 * Converts a HEX color string into an RGBA array
 *
 * @param hex - A color string in #RRGGBB or #RGB form
 * @param opacity - Opacity (0-1)
 * @returns An array in the form [r, g, b, a] (each value in 0-1)
 */
export function hexToColor(hex: string, opacity = 1): Color {
  const { r, g, b } = parseHexToRgb(hex);
  return [r / 255, g / 255, b / 255, opacity];
}

/**
 * Converts RGB values into a HEX color string
 *
 * @param r - Red (0-255)
 * @param g - Green (0-255)
 * @param b - Blue (0-255)
 * @returns A color string in #RRGGBB form
 */
function rgbToHex(r: number, g: number, b: number): string {
  const toHex = (c: number): string =>
    Math.max(0, Math.min(255, Math.round(c)))
      .toString(16)
      .padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

/**
 * Converts sRGB (0-255) into linear sRGB (0-1)
 *
 * Uses the piecewise formula of IEC 61966-2-1 (threshold 0.04045).
 *
 * @param c - sRGB component (0-255)
 * @returns Linear sRGB component (0-1)
 */
function srgbToLinear(c: number): number {
  const srgb = c / 255;
  return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
}

/**
 * Converts linear sRGB (0-1) into sRGB (0-255)
 *
 * Components that fall outside 0-1 in the inverse conversion are clamped here.
 *
 * @param c - Linear sRGB component
 * @returns sRGB component (0-255)
 */
function linearToSrgb(c: number): number {
  const linear = Math.min(1, Math.max(0, c));
  const srgb = linear <= 0.0031308 ? linear * 12.92 : 1.055 * linear ** (1 / 2.4) - 0.055;
  return srgb * 255;
}

/**
 * Converts a HEX color string into OKLab
 *
 * Uses the coefficients from Björn Ottosson's original article
 * (https://bottosson.github.io/posts/oklab/). It maps in the order sRGB -> linear sRGB -> LMS
 * -> cube root -> OKLab.
 *
 * @param hex - A color string in #RRGGBB or #RGB form
 * @returns { L, a, b } OKLab coordinates
 */
function hexToOklab(hex: string): { L: number; a: number; b: number } {
  const rgb = parseHexToRgb(hex);
  const r = srgbToLinear(rgb.r);
  const g = srgbToLinear(rgb.g);
  const b = srgbToLinear(rgb.b);

  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
  const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
  const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;

  const l_ = Math.cbrt(l);
  const m_ = Math.cbrt(m);
  const s_ = Math.cbrt(s);

  return {
    L: 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_,
    a: 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_,
    b: 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_,
  };
}

/**
 * Converts OKLab into a HEX color string
 *
 * The inverse of hexToOklab. Out-of-gamut components are clamped at the linear sRGB stage.
 *
 * @param L - Lightness
 * @param a - The green-to-red axis
 * @param b - The blue-to-yellow axis
 * @returns A color string in #rrggbb form
 */
function oklabToHex(L: number, a: number, b: number): string {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;

  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;

  return rgbToHex(
    linearToSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    linearToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    linearToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  );
}

/**
 * Linearly interpolates two colors in the OKLab space
 *
 * Used for continuous color ramps (continuous in the style rules).
 * Interpolation in the RGB space skews the brightness unevenly and, depending on the hue,
 * muddies the middle, so the perceptually uniform L, a and b of OKLab are interpolated
 * component by component.
 * The interpolation position is clamped to 0-1.
 *
 * @param from - Color of the start point (#RRGGBB or #RGB)
 * @param to - Color of the end point (#RRGGBB or #RGB)
 * @param t - Interpolation position (0-1)
 * @returns A color string in #RRGGBB form
 */
export function interpolateHexColor(from: string, to: string, t: number): string {
  const ratio = Math.min(1, Math.max(0, t));
  const a = hexToOklab(from);
  const b = hexToOklab(to);
  return oklabToHex(
    a.L + (b.L - a.L) * ratio,
    a.a + (b.a - a.a) * ratio,
    a.b + (b.b - a.b) * ratio,
  );
}

/**
 * Computes the relative luminance
 *
 * Based on the relative luminance formula of WCAG 2.0.
 * https://www.w3.org/TR/WCAG20/#relativeluminancedef
 *
 * @param hex - A color string in #RRGGBB or #RGB form
 * @returns Relative luminance (0-1)
 */
export function getLuminance(hex: string): number {
  const { r, g, b } = parseHexToRgb(hex);

  // Convert from sRGB into a linear value
  const toLinear = (c: number): number => {
    const srgb = c / 255;
    return srgb <= 0.03928 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  };

  const rLinear = toLinear(r);
  const gLinear = toLinear(g);
  const bLinear = toLinear(b);

  // Computation of the relative luminance
  return 0.2126 * rLinear + 0.7152 * gLinear + 0.0722 * bLinear;
}

/**
 * Gets a contrasting color
 *
 * Returns a highly visible contrasting color based on the luminance of the given color.
 * Returns black for a light color and white for a dark color.
 *
 * @param hex - A color string in #RRGGBB or #RGB form
 * @returns The contrasting color (#000000 or #FFFFFF)
 */
export function getContrastColor(hex: string): string {
  const luminance = getLuminance(hex);
  // A luminance above 0.5 means a light color -> a black outline
  // A luminance at or below 0.5 means a dark color -> a white outline
  return luminance > 0.5 ? '#000000' : '#FFFFFF';
}
