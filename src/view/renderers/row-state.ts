// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The state of the rows as the drawing of the rows reads it
 *
 * Every instance of a chunk of rows carries the number of its row in its row group. The state of
 * the rows of a group is one byte per row in an integer texture (`R8UI`), and the program that
 * draws the rows looks the byte up by the number: a hidden row is moved out of the clip space.
 * Writing the state of the rows of a group is one upload of a few kilobytes, and the chunks are
 * never written for it: a row hidden or shown on this client only, or selected, writes its byte.
 *
 * The byte of a row:
 *
 * - bit 0: the row is not drawn (hidden, by itself, by its group or on this client, deleted, or
 *   read elsewhere)
 * - bits 1 to 3: the set of rows moving together the row is in (0 for none). Nothing writes it
 *   yet: the drawing writes 0
 * - bit 4: the row is selected (the drawing of the rows draws it as it draws any row; the frames
 *   of a selection of many features are drawn for the rows with it, `ui/bulk-frames.ts`)
 */

import type { GpuLedger } from '../gpu-ledger.js';
import { giveStorage, textureBytes } from '../gpu-ledger.js';
import { texelPlaceGlsl, widthShift } from './rows/rows-writes.js';

/**
 * The width of the texture of the state of a row group (rows per texture line; a power of two,
 * read with a shift and a mask fixed in the shader)
 */
export const ROW_STATE_WIDTH = 128;

/** The texture unit the texture of the state of the rows is read on */
export const ROW_STATE_TEXTURE_UNIT = 1;

/** The bit of a row that is not drawn */
export const ROW_STATE_HIDDEN = 1;
/** The first bit of the set of rows moving together a row is in */
export const ROW_STATE_MOVE_SHIFT = 1;
/** The bits of the set of rows moving together a row is in */
export const ROW_STATE_MOVE_MASK = 7 << ROW_STATE_MOVE_SHIFT;
/** The bit of a row selected */
export const ROW_STATE_SELECTED = 1 << 4;

/** The part the textures of the state are recorded under in the ledger (row data) */
export const ROW_STATE_PART = 'rowState';

/**
 * The GLSL that reads the state of a row: `readRowState(row)` gives the byte of a row, and
 * `rowStateHidden(state)` whether it is not drawn
 */
export const ROW_STATE_GLSL = `
uniform highp usampler2D u_row_state;

uint readRowState(int index) {
    return texelFetch(u_row_state, ${texelPlaceGlsl('index', String(ROW_STATE_WIDTH - 1), String(widthShift(ROW_STATE_WIDTH)))}, 0).r;
}

bool rowStateHidden(uint state) {
    return (state & ${ROW_STATE_HIDDEN}u) != 0u;
}
`;

/**
 * The GLSL that reads the mark of a row selected from its byte: `rowStateSelected(state)` (after
 * {@link ROW_STATE_GLSL})
 */
export const ROW_STATE_SELECTED_GLSL = `
bool rowStateSelected(uint state) {
    return (state & ${ROW_STATE_SELECTED}u) != 0u;
}
`;

/** A position outside the clip space: a vertex of a hidden row goes here */
export const ROW_HIDDEN_POSITION_GLSL = 'vec4(2.0, 2.0, 2.0, 1.0)';

/**
 * A texture of the state of rows, one byte per row (an `R8UI` texture `width` rows wide)
 *
 * @internal
 */
export interface RowStateTexture {
  readonly texture: WebGLTexture;
  /** The rows per line of the texture */
  readonly width: number;
  /** The lines of the texture */
  readonly height: number;
  /** The number of rows it holds */
  readonly rows: number;
}

/**
 * Creates a texture of the state of rows, every byte 0, recorded in the ledger
 *
 * @returns The texture (null when the context cannot make one: a lost context)
 * @internal
 */
export function createRowStateTexture(
  gl: WebGL2RenderingContext,
  ledger: GpuLedger,
  rows: number,
): RowStateTexture | null {
  const width = ROW_STATE_WIDTH;
  const height = Math.max(1, Math.ceil(rows / width));
  const texture = gl.createTexture();
  if (!texture) return null;
  ledger.record(texture, ROW_STATE_PART, 'texture');
  gl.bindTexture(gl.TEXTURE_2D, texture);
  giveStorage(gl, ledger, texture, () => gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R8UI, width, height));
  ledger.record(texture, ROW_STATE_PART, 'texture', textureBytes(width, height, 1));
  // An integer texture is read with texelFetch and must not be filtered
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindTexture(gl.TEXTURE_2D, null);
  return { texture, width, height, rows };
}

/**
 * Releases a texture of the state of rows
 *
 * @internal
 */
export function releaseRowStateTexture(
  gl: WebGL2RenderingContext,
  ledger: GpuLedger,
  texture: RowStateTexture,
): void {
  ledger.release(texture.texture);
  gl.deleteTexture(texture.texture);
}

/**
 * Writes the byte of every row of a texture of the state of rows
 *
 * A line of the texture is `width` bytes, but the alignment of the rows of an upload
 * (`UNPACK_ALIGNMENT`) is a state of the context shared with maplibre, so it is set to 1 for the
 * upload and put back after it.
 *
 * @param state One byte per row (at least `texture.rows`)
 * @internal
 */
export function uploadRowState(
  gl: WebGL2RenderingContext,
  texture: RowStateTexture,
  state: Uint8Array,
): void {
  const size = texture.width * texture.height;
  let data = state.subarray(0, size);
  if (data.length < size) {
    data = new Uint8Array(size);
    data.set(state);
  }
  const alignment = gl.getParameter(gl.UNPACK_ALIGNMENT) as number;
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.bindTexture(gl.TEXTURE_2D, texture.texture);
  gl.texSubImage2D(
    gl.TEXTURE_2D,
    0,
    0,
    0,
    texture.width,
    texture.height,
    gl.RED_INTEGER,
    gl.UNSIGNED_BYTE,
    data,
  );
  gl.bindTexture(gl.TEXTURE_2D, null);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, alignment);
}

/**
 * The uniforms of `ROW_STATE_GLSL` in one program
 *
 * @internal
 */
export class RowStateUniforms {
  private readonly state: WebGLUniformLocation | null;

  constructor(
    private readonly gl: WebGL2RenderingContext,
    program: WebGLProgram,
  ) {
    this.state = gl.getUniformLocation(program, 'u_row_state');
  }

  /**
   * Binds a texture of the state of rows on its unit and writes the uniforms (the program in use
   * must be the one given to the constructor); the unit 0 is active again afterwards
   */
  bind(texture: RowStateTexture): void {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + ROW_STATE_TEXTURE_UNIT);
    gl.bindTexture(gl.TEXTURE_2D, texture.texture);
    gl.activeTexture(gl.TEXTURE0);
    if (this.state) gl.uniform1i(this.state, ROW_STATE_TEXTURE_UNIT);
  }
}
