// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * CSS colors: the one parser of the color strings the library takes
 *
 * Every color of the API is a CSS color string: `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`,
 * `rgb()` and `rgba()`, `hsl()` and `hsla()` (with commas, or with spaces and a `/` before
 * the alpha), the named colors and `transparent`. The validation of the inputs and the
 * renderers read them here, so a color that passes the one is drawn by the other.
 */

import type { Color } from './types/style.js';

/** The named colors of CSS, as `name` and `rrggbb` in turn */
const NAMED =
  'aliceblue f0f8ff antiquewhite faebd7 aqua 00ffff aquamarine 7fffd4 azure f0ffff beige f5f5dc ' +
  'bisque ffe4c4 black 000000 blanchedalmond ffebcd blue 0000ff blueviolet 8a2be2 brown a52a2a ' +
  'burlywood deb887 cadetblue 5f9ea0 chartreuse 7fff00 chocolate d2691e coral ff7f50 ' +
  'cornflowerblue 6495ed cornsilk fff8dc crimson dc143c cyan 00ffff darkblue 00008b ' +
  'darkcyan 008b8b darkgoldenrod b8860b darkgray a9a9a9 darkgreen 006400 darkgrey a9a9a9 ' +
  'darkkhaki bdb76b darkmagenta 8b008b darkolivegreen 556b2f darkorange ff8c00 ' +
  'darkorchid 9932cc darkred 8b0000 darksalmon e9967a darkseagreen 8fbc8f darkslateblue 483d8b ' +
  'darkslategray 2f4f4f darkslategrey 2f4f4f darkturquoise 00ced1 darkviolet 9400d3 ' +
  'deeppink ff1493 deepskyblue 00bfff dimgray 696969 dimgrey 696969 dodgerblue 1e90ff ' +
  'firebrick b22222 floralwhite fffaf0 forestgreen 228b22 fuchsia ff00ff gainsboro dcdcdc ' +
  'ghostwhite f8f8ff gold ffd700 goldenrod daa520 gray 808080 green 008000 greenyellow adff2f ' +
  'grey 808080 honeydew f0fff0 hotpink ff69b4 indianred cd5c5c indigo 4b0082 ivory fffff0 ' +
  'khaki f0e68c lavender e6e6fa lavenderblush fff0f5 lawngreen 7cfc00 lemonchiffon fffacd ' +
  'lightblue add8e6 lightcoral f08080 lightcyan e0ffff lightgoldenrodyellow fafad2 ' +
  'lightgray d3d3d3 lightgreen 90ee90 lightgrey d3d3d3 lightpink ffb6c1 lightsalmon ffa07a ' +
  'lightseagreen 20b2aa lightskyblue 87cefa lightslategray 778899 lightslategrey 778899 ' +
  'lightsteelblue b0c4de lightyellow ffffe0 lime 00ff00 limegreen 32cd32 linen faf0e6 ' +
  'magenta ff00ff maroon 800000 mediumaquamarine 66cdaa mediumblue 0000cd mediumorchid ba55d3 ' +
  'mediumpurple 9370db mediumseagreen 3cb371 mediumslateblue 7b68ee mediumspringgreen 00fa9a ' +
  'mediumturquoise 48d1cc mediumvioletred c71585 midnightblue 191970 mintcream f5fffa ' +
  'mistyrose ffe4e1 moccasin ffe4b5 navajowhite ffdead navy 000080 oldlace fdf5e6 ' +
  'olive 808000 olivedrab 6b8e23 orange ffa500 orangered ff4500 orchid da70d6 ' +
  'palegoldenrod eee8aa palegreen 98fb98 paleturquoise afeeee palevioletred db7093 ' +
  'papayawhip ffefd5 peachpuff ffdab9 peru cd853f pink ffc0cb plum dda0dd powderblue b0e0e6 ' +
  'purple 800080 rebeccapurple 663399 red ff0000 rosybrown bc8f8f royalblue 4169e1 ' +
  'saddlebrown 8b4513 salmon fa8072 sandybrown f4a460 seagreen 2e8b57 seashell fff5ee ' +
  'sienna a0522d silver c0c0c0 skyblue 87ceeb slateblue 6a5acd slategray 708090 ' +
  'slategrey 708090 snow fffafa springgreen 00ff7f steelblue 4682b4 tan d2b48c teal 008080 ' +
  'thistle d8bfd8 tomato ff6347 turquoise 40e0d0 violet ee82ee wheat f5deb3 white ffffff ' +
  'whitesmoke f5f5f5 yellow ffff00 yellowgreen 9acd32';

let namedColors: Map<string, string> | null = null;

/** The table of the named colors, built on the first use */
function named(): Map<string, string> {
  if (namedColors) return namedColors;
  const words = NAMED.split(' ');
  namedColors = new Map();
  for (let i = 0; i < words.length; i += 2) namedColors.set(words[i], words[i + 1]);
  return namedColors;
}

/** The colors parsed so far; the renderers read the same few colors on every frame */
const cache = new Map<string, Color | null>();
const CACHE_LIMIT = 1024;

/**
 * Parses a CSS color.
 *
 * @param value - The color: `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, `rgb()`, `rgba()`,
 *   `hsl()`, `hsla()`, a named color or `transparent`
 * @returns The color as `[r, g, b, a]`, each from 0 to 1, or `null` when the value is not a
 *   color
 * @internal
 */
export function parseColor(value: string): Color | null {
  if (typeof value !== 'string') return null;
  let parsed = cache.get(value);
  if (parsed === undefined) {
    parsed = parse(value.trim().toLowerCase());
    if (cache.size >= CACHE_LIMIT) cache.clear();
    cache.set(value, parsed);
  }
  return parsed ? [parsed[0], parsed[1], parsed[2], parsed[3]] : null;
}

/**
 * Whether the value is a CSS color the library can read.
 *
 * @internal
 */
export function isColor(value: unknown): value is string {
  return typeof value === 'string' && parseColor(value) !== null;
}

/**
 * A CSS color as `[r, g, b, a]` with its alpha multiplied by an opacity; a value that is not
 * a color gives transparent black.
 *
 * @param value - The CSS color
 * @param opacity - The opacity the alpha of the color is multiplied by, from 0 to 1
 * @internal
 */
export function toColor(value: string, opacity = 1): Color {
  const color = parseColor(value);
  if (!color) return [0, 0, 0, 0];
  color[3] *= opacity;
  return color;
}

/**
 * A color `[r, g, b, a]`, each from 0 to 1, as a CSS color: `#rrggbb`, or `rgba()` when it is
 * not opaque.
 *
 * @internal
 */
export function formatColor(color: Color): string {
  const channel = (value: number): number => Math.round(clamp(value, 0, 1) * 255);
  const [r, g, b] = [channel(color[0]), channel(color[1]), channel(color[2])];
  const alpha = clamp(color[3], 0, 1);
  if (alpha === 1) {
    return `#${[r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('')}`;
  }
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function parse(text: string): Color | null {
  if (text.startsWith('#')) return parseHex(text.slice(1));
  if (text === 'transparent') return [0, 0, 0, 0];
  const open = text.indexOf('(');
  if (open > 0 && text.endsWith(')')) {
    const name = text.slice(0, open).trim();
    const args = splitArguments(text.slice(open + 1, -1));
    if (!args) return null;
    if (name === 'rgb' || name === 'rgba') return parseRgb(args);
    if (name === 'hsl' || name === 'hsla') return parseHsl(args);
    return null;
  }
  const hex = named().get(text);
  return hex ? parseHex(hex) : null;
}

/** `rgb`, `rgba`, `rrggbb` or `rrggbbaa` */
function parseHex(hex: string): Color | null {
  if (!/^[0-9a-f]+$/.test(hex)) return null;
  const channel = (i: number, width: number): number => {
    const digits = hex.slice(i * width, i * width + width);
    return Number.parseInt(width === 1 ? digits + digits : digits, 16) / 255;
  };
  if (hex.length === 3 || hex.length === 4) {
    return [channel(0, 1), channel(1, 1), channel(2, 1), hex.length === 4 ? channel(3, 1) : 1];
  }
  if (hex.length === 6 || hex.length === 8) {
    return [channel(0, 2), channel(1, 2), channel(2, 2), hex.length === 8 ? channel(3, 2) : 1];
  }
  return null;
}

/**
 * The arguments of a color function: three values and an optional alpha, separated by commas
 * (`1, 2, 3, 0.5`) or by spaces with a slash before the alpha (`1 2 3 / 0.5`)
 */
function splitArguments(body: string): string[] | null {
  const text = body.trim();
  if (text.includes(',')) {
    const args = text.split(',').map((arg) => arg.trim());
    return args.length === 3 || args.length === 4 ? args : null;
  }
  const [channels, alpha, ...rest] = text.split('/');
  if (rest.length > 0) return null;
  const args = channels.trim().split(/\s+/);
  if (args.length !== 3) return null;
  if (alpha === undefined) return args;
  const alphaText = alpha.trim();
  return alphaText === '' ? null : [...args, alphaText];
}

/** A number, or null when the text is not one */
function toNumber(text: string): number | null {
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/.test(text)) return null;
  return Number(text);
}

/** A number or a percentage, as a fraction of `scale` for a percentage */
function numberOrPercent(text: string, scale: number): number | null {
  if (text.endsWith('%')) {
    const value = toNumber(text.slice(0, -1));
    return value === null ? null : (value / 100) * scale;
  }
  return toNumber(text);
}

/** The alpha, from 0 to 1 (a number or a percentage); 1 when it is absent */
function parseAlpha(text: string | undefined): number | null {
  if (text === undefined) return 1;
  const value = numberOrPercent(text, 1);
  return value === null ? null : clamp(value, 0, 1);
}

function parseRgb(args: string[]): Color | null {
  const channels = args.slice(0, 3).map((arg) => numberOrPercent(arg, 255));
  const alpha = parseAlpha(args[3]);
  if (alpha === null || channels.some((channel) => channel === null)) return null;
  const [r, g, b] = channels as number[];
  return [clamp(r, 0, 255) / 255, clamp(g, 0, 255) / 255, clamp(b, 0, 255) / 255, alpha];
}

function parseHsl(args: string[]): Color | null {
  const hue = parseHue(args[0]);
  const saturation = args[1].endsWith('%') ? toNumber(args[1].slice(0, -1)) : null;
  const lightness = args[2].endsWith('%') ? toNumber(args[2].slice(0, -1)) : null;
  const alpha = parseAlpha(args[3]);
  if (hue === null || saturation === null || lightness === null || alpha === null) return null;
  const [r, g, b] = hslToRgb(hue, clamp(saturation, 0, 100) / 100, clamp(lightness, 0, 100) / 100);
  return [r, g, b, alpha];
}

/** The hue in degrees, from a number or an angle in `deg`, `rad`, `grad` or `turn` */
function parseHue(text: string): number | null {
  const units: Record<string, number> = { deg: 1, grad: 0.9, rad: 180 / Math.PI, turn: 360 };
  for (const [unit, factor] of Object.entries(units)) {
    if (text.endsWith(unit)) {
      const value = toNumber(text.slice(0, -unit.length));
      return value === null ? null : value * factor;
    }
  }
  return toNumber(text);
}

/** HSL (hue in degrees, saturation and lightness from 0 to 1) to RGB from 0 to 1 */
function hslToRgb(hue: number, saturation: number, lightness: number): [number, number, number] {
  const h = (((hue % 360) + 360) % 360) / 30;
  const a = saturation * Math.min(lightness, 1 - lightness);
  const channel = (n: number): number => {
    const k = (n + h) % 12;
    return lightness - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [channel(0), channel(8), channel(4)];
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
