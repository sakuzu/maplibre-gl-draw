// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The state of the rows as the retained batches of the rows held as columns read it
 *
 * Every vertex (or instance) of such a batch carries the number of its row in its row group.
 * The state of the rows of a group is one byte per row in an integer texture (`R8UI`), and the
 * variant of the programs that draws the rows (`#define TABLE_ROWS`) looks the byte up by the
 * number: a hidden row is moved out of the clip space, and a row in a moving set is translated
 * by the uniform of its set. Writing the state of every row of a group is one upload of a few
 * kilobytes, and the vertices are never written for it.
 *
 * The other paths (the features of the Store, the datasets, immediate mode) draw with the
 * programs without the define, which neither have the attribute nor read the texture.
 */

import { type GpuLedger, textureBytes } from '../gpu-ledger.js';

/** The width of the texture of the state of a row group (rows per texture line) */
export const ROW_STATE_WIDTH = 128;

/** The texture unit the state of the rows is bound to */
export const ROW_STATE_TEXTURE_UNIT = 1;

/**
 * The GLSL of the variant that reads the state of the rows (`TABLE_ROWS`)
 *
 * It declares the texture, its width and the translation of each moving set, and the functions
 * that read the state of the row of the vertex. The attribute of the number of the row is
 * declared by each program at its own location.
 */
export const ROW_STATE_GLSL = `
#ifdef TABLE_ROWS
uniform highp usampler2D u_row_state;
uniform int u_row_state_width;
// The translation of each moving set in degrees of longitude and latitude (set 0 is none)
uniform vec2 u_state_translate[4];

uint readRowState(float row) {
    int index = int(row + 0.5);
    return texelFetch(u_row_state, ivec2(index % u_row_state_width, index / u_row_state_width), 0).r;
}

bool rowStateHidden(uint state) {
    return (state & 1u) != 0u;
}

vec2 rowStateTranslation(uint state) {
    return u_state_translate[int((state >> 1u) & 3u)];
}
#endif
`;

/** A position outside the clip space: a vertex of a hidden row goes here */
export const ROW_HIDDEN_POSITION_GLSL = 'vec4(2.0, 2.0, 2.0, 1.0)';

/**
 * The texture of the state of the rows of a group
 *
 * @internal
 */
export interface RowStateTexture {
  readonly texture: WebGLTexture;
  readonly width: number;
  readonly height: number;
  /** The number of rows it holds */
  readonly rows: number;
}

/**
 * What a draw of rows binds: the texture of the group and the translations of the moving sets
 *
 * @internal
 */
export interface RowStateBinding {
  readonly texture: RowStateTexture;
  /** `[dLng, dLat]` of the sets 0 to 3 (set 0 is always 0) */
  readonly translations: Float32Array;
}

/**
 * The uniform locations of the state of the rows in one program
 *
 * @internal
 */
export interface RowStateLocations {
  readonly state: WebGLUniformLocation | null;
  readonly width: WebGLUniformLocation | null;
  readonly translate: WebGLUniformLocation | null;
}

/**
 * Reads the uniform locations of the state of the rows of a program
 *
 * @internal
 */
export function rowStateLocations(
  gl: WebGL2RenderingContext,
  program: WebGLProgram,
): RowStateLocations {
  return {
    state: gl.getUniformLocation(program, 'u_row_state'),
    width: gl.getUniformLocation(program, 'u_row_state_width'),
    translate: gl.getUniformLocation(program, 'u_state_translate'),
  };
}

/**
 * Binds the state of the rows for a draw (the program in use must be the variant of the rows)
 *
 * @internal
 */
export function bindRowState(
  gl: WebGL2RenderingContext,
  locations: RowStateLocations,
  binding: RowStateBinding,
): void {
  gl.activeTexture(gl.TEXTURE0 + ROW_STATE_TEXTURE_UNIT);
  gl.bindTexture(gl.TEXTURE_2D, binding.texture.texture);
  gl.activeTexture(gl.TEXTURE0);
  if (locations.state) gl.uniform1i(locations.state, ROW_STATE_TEXTURE_UNIT);
  if (locations.width) gl.uniform1i(locations.width, binding.texture.width);
  if (locations.translate) gl.uniform2fv(locations.translate, binding.translations);
}

/**
 * Creates the texture of the state of `rows` rows (all 0: shown, not moving)
 *
 * @returns null when the texture cannot be created
 * @internal
 */
export function createRowStateTexture(
  gl: WebGL2RenderingContext,
  rows: number,
  ledger?: GpuLedger,
): RowStateTexture | null {
  const width = ROW_STATE_WIDTH;
  const height = Math.max(1, Math.ceil(rows / width));
  const texture = gl.createTexture();
  if (!texture) return null;
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R8UI, width, height);
  // An integer texture is read with texelFetch and must not be filtered
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  ledger?.record(texture, 'row-state', 'texture', textureBytes(width, height, 1));
  return { texture, width, height, rows };
}

/**
 * Uploads the state of every row
 *
 * A line of the texture is `ROW_STATE_WIDTH` bytes, but the alignment of the rows of an upload
 * (`UNPACK_ALIGNMENT`) is a state of the context shared with maplibre, so it is set to 1 for the
 * upload and put back after it: the upload is right whatever the alignment was.
 *
 * @param state One byte per row (at least `texture.rows`)
 * @param scratch An array of `width * height` bytes the upload is laid out in (made when omitted)
 * @internal
 */
export function uploadRowState(
  gl: WebGL2RenderingContext,
  texture: RowStateTexture,
  state: Uint8Array,
  scratch?: Uint8Array,
): void {
  const size = texture.width * texture.height;
  const data = scratch && scratch.length >= size ? scratch.subarray(0, size) : new Uint8Array(size);
  data.set(state.subarray(0, Math.min(texture.rows, size)));
  if (texture.rows < size) data.fill(0, texture.rows);
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
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, alignment);
}

/**
 * Deletes the texture of the state of a group
 *
 * @internal
 */
export function deleteRowStateTexture(
  gl: WebGL2RenderingContext,
  texture: RowStateTexture,
  ledger?: GpuLedger,
): void {
  ledger?.release(texture.texture);
  gl.deleteTexture(texture.texture);
}
