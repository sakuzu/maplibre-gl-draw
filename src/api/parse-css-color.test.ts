// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `parseCssColor`: the reader of the CSS colors the library takes, for an extension
 *
 * - It reads the notations of the colors of the API as `[red, green, blue, alpha]` from 0 to 1,
 *   in a new array each time
 * - It answers `null` for a value that is not a color the library reads, whatever its type
 * - It takes exactly the colors the check of a style takes: a color it reads is accepted in the
 *   style of a feature, and a value it does not read is refused with `invalidInput`
 */

import { afterEach, describe, expect, it } from 'vitest';
import { writesOf } from '../test-support/writes.js';
import { createMapStub } from '../test-utils.js';
import type { Draw } from './draw.js';
import { createDraw } from './draw.js';
import { DrawError } from './errors.js';
import { parseCssColor } from './model.js';

describe('parseCssColor', () => {
  it.each([
    ['#f00', [1, 0, 0, 1]],
    ['#ff000080', [1, 0, 0, 128 / 255]],
    ['rgb(0 255 0 / 50%)', [0, 1, 0, 0.5]],
    ['rgba(0, 0, 255, 0.25)', [0, 0, 1, 0.25]],
    ['hsl(120 100% 50%)', [0, 1, 0, 1]],
    ['rebeccapurple', [0x66 / 255, 0x33 / 255, 0x99 / 255, 1]],
    ['transparent', [0, 0, 0, 0]],
  ])('reads %s', (value, expected) => {
    const color = parseCssColor(value);
    expect(color).toHaveLength(4);
    color?.forEach((channel, index) => {
      expect(channel).toBeCloseTo(expected[index], 6);
    });
  });

  it('gives a new array each time', () => {
    const first = parseCssColor('#336699');
    const second = parseCssColor('#336699');
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    if (first) first[0] = 0;
    expect(parseCssColor('#336699')?.[0]).toBeCloseTo(0x33 / 255, 6);
  });

  it.each([
    ['a word that is not a color', 'tomatoes'],
    ['a notation the library does not read', 'oklch(0.6 0.1 200)'],
    ['an empty string', ''],
    ['a number', 0xff0000],
    ['an array of channels', [1, 0, 0, 1]],
    ['undefined', undefined],
  ])('answers null for %s', (_, value) => {
    expect(parseCssColor(value)).toBeNull();
  });
});

describe('parseCssColor and the check of a style', () => {
  let draw: Draw;

  afterEach(() => draw.destroy());

  const createWithColor = (fillColor: string) =>
    writesOf(draw).features.create({
      type: 'Polygon',
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [0, 0],
            [1, 0],
            [1, 1],
            [0, 0],
          ],
        ],
      },
      style: { fillColor },
    });

  it('takes the colors the style of a feature takes, and no other', () => {
    draw = createDraw(createMapStub().map);
    for (const value of ['#ff000080', 'hsl(120 100% 50%)', 'rebeccapurple']) {
      expect(parseCssColor(value)).not.toBeNull();
      expect(() => createWithColor(value)).not.toThrow();
    }
    for (const value of ['tomatoes', 'oklch(0.6 0.1 200)']) {
      expect(parseCssColor(value)).toBeNull();
      let thrown: unknown;
      try {
        createWithColor(value);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(DrawError);
      expect((thrown as DrawError).code).toBe('invalidInput');
    }
  });
});
