// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The kind and the row of an instance of the rows drawn in one draw, as the vertex shader takes
 * them out of what the CPU wrote
 *
 * The shader reads the kind of an instance and the number of its row from the bytes
 * `writeRowsInstance` writes, and every look of the row (its style, whether it is hidden) is read
 * through that number. GLSL ES 3.00 bounds the error of a division by 2.5 ULP only (and of
 * `floor`, `int` and the integer operations by none), so a number taken out of a float by a
 * division can come out as the one next to it on a GPU that uses that freedom, while SwiftShader
 * divides exactly: the end-to-end tests do not see it. This copy of the shader on the CPU takes
 * the kind and the row out of the bytes of each instance as the shader does, operation by
 * operation, with every error the specification allows a division, and the shader is read to
 * know which operations it uses.
 */

import { describe, expect, it } from 'vitest';
import {
  ROWS_INSTANCE_FLOATS,
  ROWS_KIND,
  type RowsKind,
  readRowsInstance,
  writeRowsInstance,
} from './rows-format.js';
import { buildRowsVertexSource } from './rows-shader.js';

/** The source of the vertex shader, without the preludes of maplibre */
const SOURCE = buildRowsVertexSource('', '');

/** The ULP of a float32 */
function ulpOf(value: number): number {
  const magnitude = Math.abs(value);
  if (magnitude < 2 ** -126) return 2 ** -149;
  return 2 ** (Math.floor(Math.log2(magnitude)) - 23);
}

/** The errors a division of GLSL ES 3.00 may make, in ULP of the exact quotient */
const DIVISION_ERRORS = [-2.5, -2, -1.5, -1, -0.5, 0, 0.5, 1, 1.5, 2, 2.5];

/** The ways a shader of the rows has taken the kind and the row out of an instance */
type Decode = { form: 'float'; factor: number } | { form: 'integer'; shift: number; mask: number };

/** How the shader takes the kind and the row out of an instance, read from its source */
function decodeOfShader(source: string): Decode {
  const float = source.match(
    /int kind = int\(floor\(a_head\.x \/ ([0-9.]+)\)\);\s*float row = a_head\.x - float\(kind\) \* ([0-9.]+);/,
  );
  if (float && float[1] === float[2]) return { form: 'float', factor: Number(float[1]) };
  const integer = source.match(
    /in uint a_tag;[\s\S]*int kind = int\(a_tag >> (\d+)u\);\s*int row = int\(a_tag & (\d+)u\);/,
  );
  if (integer) return { form: 'integer', shift: Number(integer[1]), mask: Number(integer[2]) };
  throw new Error('the shader takes the kind and the row out of an instance in a way not copied');
}

/**
 * The kind and the row the shader takes out of the bytes of an instance, its division off by
 * `error` ULP
 */
function decodeLikeShader(
  decode: Decode,
  bytes: ArrayBuffer,
  at: number,
  error: number,
): { kind: number; row: number } {
  const offset = at * ROWS_INSTANCE_FLOATS * 4;
  if (decode.form === 'integer') {
    // `in uint a_tag`: the first word of the instance as an unsigned integer; shifts and masks
    // are exact
    const tag = new Uint32Array(bytes, offset, 1)[0] as number;
    return { kind: tag >>> decode.shift, row: tag & decode.mask };
  }
  // `in vec4 a_head`: the first word as a float
  const head = new Float32Array(bytes, offset, 1)[0] as number;
  const exact = head / decode.factor;
  const quotient = Math.fround(exact + error * ulpOf(exact));
  const kind = Math.floor(quotient);
  const row = Math.fround(head - Math.fround(kind * decode.factor));
  return { kind, row: Math.trunc(Math.fround(row + 0.5)) };
}

/** The rows of a group held up to the largest number an instance holds */
const ROWS = [0, 1, 2, 3, 255, 256, 4095, 65_535, 1_000_000, 2_097_150, 2_097_151];

describe('the kind and the row of an instance, as the shader takes them out', () => {
  const decode = decodeOfShader(SOURCE);
  const kinds = Object.values(ROWS_KIND) as RowsKind[];

  it.each(kinds)('takes kind %i and its row out whatever error a division makes', (kind) => {
    const instances = new Float32Array(ROWS.length * ROWS_INSTANCE_FLOATS);
    ROWS.forEach((row, i) => {
      writeRowsInstance(instances, i, kind, row, 1, 2, 3, 4, 5);
    });
    const missed: string[] = [];
    ROWS.forEach((row, i) => {
      for (const error of DIVISION_ERRORS) {
        const read = decodeLikeShader(decode, instances.buffer, i, error);
        if (read.kind !== kind || read.row !== row) {
          missed.push(`row ${row} (${error} ULP): kind ${read.kind} row ${read.row}`);
        }
      }
    });
    expect(missed).toEqual([]);
  });

  it('reads back on the CPU what the shader takes out', () => {
    const instances = new Float32Array(2 * ROWS_INSTANCE_FLOATS);
    writeRowsInstance(instances, 0, ROWS_KIND.dashedOutline, 2_097_151, 7, -1, 9, 10, 11.5);
    writeRowsInstance(instances, 1, ROWS_KIND.point, 0, 3, -1, -1, -1);
    expect(readRowsInstance(instances, 0)).toEqual({
      kind: ROWS_KIND.dashedOutline,
      row: 2_097_151,
      indices: [7, -1, 9, 10],
      t0: 0,
      t1: 1,
      extra: 11.5,
    });
    expect(readRowsInstance(instances, 1)).toMatchObject({ kind: ROWS_KIND.point, row: 0 });
  });
});
