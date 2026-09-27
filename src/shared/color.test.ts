// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the CSS color parser
 */

import { describe, expect, it } from 'vitest';
import { isColor, parseColor, toColor } from './color.js';

/** A color from 0-255 channels and an alpha */
const rgba = (r: number, g: number, b: number, a = 1) => [r / 255, g / 255, b / 255, a];

describe('parseColor', () => {
  const cases: Array<[string, number[]]> = [
    ['#f00', rgba(255, 0, 0)],
    ['#F00', rgba(255, 0, 0)],
    ['#f008', rgba(255, 0, 0, 0x88 / 255)],
    ['#ff8000', rgba(255, 128, 0)],
    ['#FF800080', rgba(255, 128, 0, 0x80 / 255)],
    ['  #abc  ', rgba(0xaa, 0xbb, 0xcc)],
    ['rgb(255, 128, 0)', rgba(255, 128, 0)],
    ['rgb(255,128,0)', rgba(255, 128, 0)],
    ['rgba(255, 128, 0, 0.5)', rgba(255, 128, 0, 0.5)],
    ['rgba(255, 128, 0, 50%)', rgba(255, 128, 0, 0.5)],
    ['rgb(100%, 50%, 0%)', rgba(255, 127.5, 0)],
    ['rgb(255 128 0)', rgba(255, 128, 0)],
    ['rgb(255 128 0 / 0.25)', rgba(255, 128, 0, 0.25)],
    ['rgba(255 128 0 / 25%)', rgba(255, 128, 0, 0.25)],
    ['RGB(300, -5, 0)', rgba(255, 0, 0)],
    ['rgba(0, 0, 0, 2)', rgba(0, 0, 0, 1)],
    ['hsl(0, 100%, 50%)', rgba(255, 0, 0)],
    ['hsl(120, 100%, 50%)', rgba(0, 255, 0)],
    ['hsl(240deg, 100%, 50%)', rgba(0, 0, 255)],
    ['hsl(0.5turn 100% 50%)', rgba(0, 255, 255)],
    ['hsla(0, 0%, 100%, 0.5)', rgba(255, 255, 255, 0.5)],
    ['hsl(-120, 100%, 50%)', rgba(0, 0, 255)],
    ['hsl(0 0% 0% / 30%)', rgba(0, 0, 0, 0.3)],
    ['red', rgba(255, 0, 0)],
    ['RebeccaPurple', rgba(0x66, 0x33, 0x99)],
    ['lightgoldenrodyellow', rgba(0xfa, 0xfa, 0xd2)],
    ['grey', rgba(128, 128, 128)],
    ['transparent', [0, 0, 0, 0]],
  ];

  it.each(cases)('reads %s', (text, expected) => {
    const color = parseColor(text);
    expect(color).not.toBeNull();
    expect(color).toHaveLength(4);
    (color as number[]).forEach((channel, i) => {
      expect(channel).toBeCloseTo(expected[i], 5);
    });
  });

  const invalid = [
    '',
    '#',
    '#ff',
    '#fffff',
    '#ggg',
    'rgb(1, 2)',
    'rgb(1, 2, 3, 4, 5)',
    'rgb(1 2 3 4)',
    'rgb(1, 2, x)',
    'rgb(1 2 3 /)',
    'hsl(0, 100, 50%)',
    'hsl(red, 100%, 50%)',
    'cmyk(0, 0, 0, 0)',
    'reddish',
    'currentColor',
  ];

  it.each(invalid)('refuses %j', (text) => {
    expect(parseColor(text)).toBeNull();
    expect(isColor(text)).toBe(false);
  });

  it('refuses what is not a string', () => {
    for (const value of [null, undefined, 3, {}, ['#fff']]) {
      expect(isColor(value)).toBe(false);
    }
  });

  it('gives a new array each time', () => {
    const first = parseColor('red') as number[];
    first[0] = 0;
    expect(parseColor('red')?.[0]).toBe(1);
  });
});

describe('toColor', () => {
  it('multiplies the alpha of the color by the opacity', () => {
    expect(toColor('#ff0000', 0.5)).toEqual([1, 0, 0, 0.5]);
    expect(toColor('rgba(255, 0, 0, 0.5)', 0.5)).toEqual([1, 0, 0, 0.25]);
  });

  it('gives transparent black for what is not a color', () => {
    expect(toColor('nope')).toEqual([0, 0, 0, 0]);
  });
});
