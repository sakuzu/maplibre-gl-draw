// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Where the drawing of the rows puts the texels of its textures and where its shaders read them:
 * the widths of the textures of a chunk (the smallest power of two that holds what they hold, up
 * to the widest), the place of a texel the CPU writes and the place the shaders read (the same
 * shift and mask), the widths fixed in the shaders (powers of two), and no division or remainder
 * where a shader finds a texel
 */

import { describe, expect, it } from 'vitest';
import { buildBulkFramesVertexSource } from '../../ui/bulk-frames.js';
import { ROW_STATE_GLSL, ROW_STATE_WIDTH } from '../row-state.js';
import {
  ROWS_COORD_WIDTH,
  ROWS_ROW_STYLE_WIDTH,
  ROWS_STYLE_FLOATS,
  ROWS_STYLE_TEXELS,
  ROWS_STYLE_WIDTH,
  RowsPalette,
} from './rows-format.js';
import { textureSizeOf } from './rows-renderer.js';
import { buildRowsFragmentSource, buildRowsVertexSource } from './rows-shader.js';
import { TexelWrites, texelColumn, texelLine, texelPlaceGlsl, widthShift } from './rows-writes.js';

/** A generator of numbers from a seed (the same numbers on every run) */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 2 ** 32;
  };
}

/** Counts from 1 to 200,000: random ones, and those around every power of two */
function countsToTry(): number[] {
  const random = seeded(7);
  const counts = new Set<number>([1, 2, 3, 200_000]);
  for (let p = 1; p <= 200_000; p *= 2) {
    for (const c of [p - 1, p, p + 1]) if (c >= 1 && c <= 200_000) counts.add(c);
  }
  for (let i = 0; i < 2_000; i++) counts.add(1 + Math.floor(random() * 200_000));
  return [...counts];
}

const isPowerOfTwo = (n: number) => Number.isInteger(n) && n >= 1 && (n & (n - 1)) === 0;

/** The place a texel is read at, by the formula of the shaders (its mask and its shift) */
function placeInShader(texel: number, width: number): [number, number] {
  const shift = Math.log2(width);
  return [texel & (width - 1), texel >> shift];
}

describe('the textures of a chunk', () => {
  for (const [name, widest] of [
    ['coordinates', ROWS_COORD_WIDTH],
    ['styles of the rows', ROWS_ROW_STYLE_WIDTH],
  ] as const) {
    it(`of its ${name} are the smallest power of two wide that holds them, ${widest} at most`, () => {
      for (const count of countsToTry()) {
        const { width, height } = textureSizeOf(count, widest);
        expect(isPowerOfTwo(width), `${count}`).toBe(true);
        expect(width, `${count}`).toBeLessThanOrEqual(widest);
        expect(width >= count || width === widest, `${count}`).toBe(true);
        // The smallest: half of it holds less than the count
        if (width > 1) expect(width / 2 < count, `${count}`).toBe(true);
        expect(height, `${count}`).toBe(Math.ceil(count / width));
        const texels = width * height;
        expect(texels, `${count}`).toBeGreaterThanOrEqual(count);
        expect(texels < 2 * count || texels < widest, `${count}`).toBe(true);
      }
    });
  }

  it('hold every texel where the shaders read it, written in place or uploaded whole', () => {
    const random = seeded(11);
    for (const width of [1, 2, 4, 8, 64, ROWS_ROW_STYLE_WIDTH, ROWS_COORD_WIDTH]) {
      const shift = widthShift(width);
      for (let k = 0; k < 500; k++) {
        const texel = Math.floor(random() * 200_000);
        // A write in place
        const writes = new TexelWrites(2);
        writes.write(texel, [texel, -texel]);
        const runs: Array<[number, number]> = [];
        writes.drain(shift, (line, first) => runs.push([first, line]));
        expect(runs, `${width} ${texel}`).toEqual([placeInShader(texel, width)]);
        expect([texelColumn(texel, shift), texelLine(texel, shift)]).toEqual(
          placeInShader(texel, width),
        );
        // An upload of the whole texture writes the texels a line after the other
        const [column, line] = placeInShader(texel, width);
        expect(line * width + column).toBe(texel);
      }
    }
  });

  it('cut the runs of the writes in place at the ends of the lines of their widths', () => {
    const writes = new TexelWrites(1);
    for (let t = 6; t < 19; t++) writes.write(t, [t]);
    const runs: number[][] = [];
    writes.drain(widthShift(8), (line, first, values) => runs.push([line, first, values.length]));
    expect(runs).toEqual([
      [0, 6, 2],
      [1, 0, 8],
      [2, 0, 3],
    ]);
  });
});

describe('the widths fixed in the shaders', () => {
  it('are powers of two', () => {
    for (const width of [
      ROWS_STYLE_WIDTH,
      ROW_STATE_WIDTH,
      ROWS_COORD_WIDTH,
      ROWS_ROW_STYLE_WIDTH,
    ]) {
      expect(isPowerOfTwo(width), `${width}`).toBe(true);
    }
    expect(() => widthShift(1_000)).toThrow();
  });

  it('give the lines of the values of the styles a palette writes by the formula of the shaders', () => {
    const palette = new RowsPalette();
    const values = new Float32Array(ROWS_STYLE_FLOATS);
    for (let i = 0; i < 700; i++) palette.add(values);
    const lines = new Set<number>();
    for (let i = 0; i < 700; i++)
      lines.add(placeInShader(i * ROWS_STYLE_TEXELS, ROWS_STYLE_WIDTH)[1]);
    expect([...palette.dirty].sort((a, b) => a - b)).toEqual([...lines].sort((a, b) => a - b));
  });
});

/** The arguments of every `texelFetch` of a source */
function texelFetchArguments(source: string): string[] {
  const out: string[] = [];
  let at = source.indexOf('texelFetch(');
  while (at >= 0) {
    let depth = 0;
    let end = at + 'texelFetch'.length;
    for (; end < source.length; end++) {
      if (source[end] === '(') depth++;
      else if (source[end] === ')' && --depth === 0) break;
    }
    out.push(source.slice(at, end + 1));
    at = source.indexOf('texelFetch(', end);
  }
  return out;
}

describe('the shaders that read the textures of the rows', () => {
  const sources = {
    'the rows, with the dashes': buildRowsVertexSource('', ''),
    'the rows, without the dashes': buildRowsVertexSource('', '', false),
    'the frames of a large selection': buildBulkFramesVertexSource('', ''),
    'the state of the rows': ROW_STATE_GLSL,
  };

  for (const [name, source] of Object.entries(sources)) {
    it(`find a texel with no division and no remainder: ${name}`, () => {
      const fetches = texelFetchArguments(source);
      expect(fetches.length).toBeGreaterThan(0);
      for (const fetch of fetches) {
        expect(fetch, name).not.toMatch(/[%/]/);
      }
      // The frames of a large selection take a remainder for the corners of their boxes
      if (source !== sources['the frames of a large selection']) {
        expect(source).not.toContain('%');
      }
      expect(source).not.toMatch(/u_(coord|row_style|style|row_state)_width/);
    });
  }

  it('read the state of the rows at the place of the formula of the CPU', () => {
    expect(ROW_STATE_GLSL).toContain(
      texelPlaceGlsl('index', String(ROW_STATE_WIDTH - 1), String(widthShift(ROW_STATE_WIDTH))),
    );
  });

  it('come in two variants of one text, told apart by one define', () => {
    const vertex = buildRowsVertexSource('', '');
    const fragment = buildRowsFragmentSource();
    // Called as before, they give the variant with the dashes
    expect(buildRowsVertexSource('', '', true)).toBe(vertex);
    expect(buildRowsFragmentSource(true)).toBe(fragment);
    for (const [withDashes, without] of [
      [vertex, buildRowsVertexSource('', '', false)],
      [fragment, buildRowsFragmentSource(false)],
    ]) {
      expect(withDashes).toContain('#define ROWS_DASHED\n');
      expect(without).not.toContain('#define ROWS_DASHED');
      expect(withDashes.replace('#define ROWS_DASHED\n', '')).toBe(without);
    }
  });
});
