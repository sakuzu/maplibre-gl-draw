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

import type { PlaneTransform } from '../../shared/math/plane-transform.js';
import { type GpuLedger, textureBytes } from '../gpu-ledger.js';
import { getRenderFrame } from '../shaders/frame.js';
import type { RetainedDrawRun } from './draw-run.js';

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
// The rotation or resize of the moving sets (bit k: set k has one), applied before the
// translation in the plane of Web Mercator around a center (plane-transform.ts)
uniform int u_state_transformed;
// The matrix of each set (a, b, c, d: x' = a x + c y, y' = b x + d y), for the rows resized along
// the axes and for the rows that keep their shape
uniform vec4 u_state_matrix[4];
uniform vec4 u_state_matrix_uniform[4];
// The center the offsets are taken from minus the center of the transform, in degrees
uniform vec2 u_state_center[4];
// The sine, the cosine and the tangent of the latitude of the center of the transform
uniform vec3 u_state_center_lat[4];

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

// atanh and sinh of a small value without cancellation
float rowAtanh(float z) {
    if (abs(z) < 0.1) {
        float z2 = z * z;
        return z * (1.0 + z2 * (1.0 / 3.0 + z2 * (0.2 + z2 * (1.0 / 7.0 + z2 / 9.0))));
    }
    return 0.5 * log((1.0 + z) / (1.0 - z));
}

float rowSinh(float x) {
    if (abs(x) < 0.1) {
        float x2 = x * x;
        return x * (1.0 + x2 * (1.0 / 6.0 + x2 * (1.0 / 120.0 + x2 / 5040.0)));
    }
    return 0.5 * (exp(x) - exp(-x));
}

// The difference of the northing of Mercator, in degrees, of a latitude delta degrees north of
// the center (c: the sine, the cosine and the tangent of its latitude)
float rowMercatorDelta(float delta, vec3 c) {
    float halfAngle = delta * 0.008726646259971648;
    float sinHalf = sin(halfAngle);
    float cosHalf = cos(halfAngle);
    float cosMid = c.y * cosHalf - c.x * sinHalf;
    float sinTo = c.x * (cosHalf * cosHalf - sinHalf * sinHalf) + c.y * 2.0 * sinHalf * cosHalf;
    return rowAtanh(2.0 * cosMid * sinHalf / (1.0 - sinTo * c.x)) * 57.29577951308232;
}

// The difference of latitude of a point y degrees of northing north of the center
float rowLatitudeDelta(float y, vec3 c) {
    float sinhHalf = rowSinh(y * 0.008726646259971648);
    float coshHalf = sqrt(1.0 + sinhHalf * sinhHalf);
    float coshMid = coshHalf / c.y + c.z * sinhHalf;
    float deltaTan = 2.0 * coshMid * sinhHalf;
    return atan(deltaTan / (1.0 + c.z * (c.z + deltaTan))) * 57.29577951308232;
}

// An offset of a row moved by its moving set: rotated or resized around the center of the set,
// then translated (an offset of a row not moving as it is)
vec2 rowStateMove(uint state, vec2 offset) {
    int moveSet = int((state >> 1u) & 3u);
    if (moveSet == 0) return offset;
    vec2 moved = offset;
    if (((u_state_transformed >> moveSet) & 1) != 0) {
        vec2 rel = offset + u_origin_shift + u_state_center[moveSet];
        vec4 m = (state & 16u) != 0u ? u_state_matrix_uniform[moveSet] : u_state_matrix[moveSet];
        vec3 c = u_state_center_lat[moveSet];
        float y = rowMercatorDelta(rel.y, c);
        vec2 q = vec2(m.x * rel.x + m.z * y, m.y * rel.x + m.w * y);
        moved = vec2(q.x, rowLatitudeDelta(q.y, c)) - u_origin_shift - u_state_center[moveSet];
    }
    return moved + u_state_translate[moveSet];
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
  /** The rotation or resize of the sets 0 to 3, applied before the translation (null for none) */
  readonly transforms?: ReadonlyArray<PlaneTransform | null>;
}

/**
 * The uniforms of the state of the rows in one program, with the values written to them last
 *
 * The draws of a run of rows go through here once per range drawn, but the unit of the texture
 * never changes, the width of the texture is the same for every group, and the translations of
 * the moving sets change once per layer at most. Writes of the same values are skipped, and
 * everything is written again once the frame changes (`shaders/frame.ts`). A program made again
 * gets a new instance (its uniforms start from their initial values).
 *
 * @internal
 */
export class RowStateUniforms {
  private readonly state: WebGLUniformLocation | null;
  private readonly width: WebGLUniformLocation | null;
  private readonly translate: WebGLUniformLocation | null;
  private readonly transformed: WebGLUniformLocation | null;
  private readonly matrix: WebGLUniformLocation | null;
  private readonly matrixUniform: WebGLUniformLocation | null;
  private readonly center: WebGLUniformLocation | null;
  private readonly centerLat: WebGLUniformLocation | null;
  /** The frame the values were written in (-1 before the first write) */
  private frame = -1;
  private writtenWidth = Number.NaN;
  private readonly writtenTranslations = new Float32Array(8).fill(Number.NaN);
  /** The values of the transforms, as they are written (and were written last) */
  private readonly transformValues = new TransformUniformValues();
  private readonly writtenTransforms = new TransformUniformValues(Number.NaN);

  constructor(
    private readonly gl: WebGL2RenderingContext,
    program: WebGLProgram,
  ) {
    this.state = gl.getUniformLocation(program, 'u_row_state');
    this.width = gl.getUniformLocation(program, 'u_row_state_width');
    this.translate = gl.getUniformLocation(program, 'u_state_translate');
    this.transformed = gl.getUniformLocation(program, 'u_state_transformed');
    this.matrix = gl.getUniformLocation(program, 'u_state_matrix');
    this.matrixUniform = gl.getUniformLocation(program, 'u_state_matrix_uniform');
    this.center = gl.getUniformLocation(program, 'u_state_center');
    this.centerLat = gl.getUniformLocation(program, 'u_state_center_lat');
  }

  /**
   * Writes the uniforms for a draw (the program in use must be the one of these uniforms)
   *
   * @param center The center the offsets of the draw are taken from (the camera center, or the
   *   origin of the batch), `[lng, lat]` in degrees: the centers of the transforms are given as
   *   their differences from it
   */
  write(binding: RowStateBinding, center: readonly [number, number] = [0, 0]): void {
    const gl = this.gl;
    const frame = getRenderFrame();
    const stale = this.frame !== frame;
    this.frame = frame;
    if (stale && this.state) gl.uniform1i(this.state, ROW_STATE_TEXTURE_UNIT);
    const width = binding.texture.width;
    if (this.width && (stale || this.writtenWidth !== width)) {
      gl.uniform1i(this.width, width);
      this.writtenWidth = width;
    }
    const translations = binding.translations;
    if (this.translate && (stale || !sameValues(this.writtenTranslations, translations))) {
      gl.uniform2fv(this.translate, translations);
      this.writtenTranslations.set(translations.subarray(0, this.writtenTranslations.length));
    }
    const values = this.transformValues;
    values.set(binding.transforms, center);
    const written = this.writtenTransforms;
    if (this.transformed && (stale || written.flags !== values.flags)) {
      gl.uniform1i(this.transformed, values.flags);
    }
    if (values.flags === 0 && !stale && written.flags === 0) return;
    if (this.matrix && (stale || !sameValues(written.matrix, values.matrix))) {
      gl.uniform4fv(this.matrix, values.matrix);
    }
    if (this.matrixUniform && (stale || !sameValues(written.uniform, values.uniform))) {
      gl.uniform4fv(this.matrixUniform, values.uniform);
    }
    if (this.center && (stale || !sameValues(written.center, values.center))) {
      gl.uniform2fv(this.center, values.center);
    }
    if (this.centerLat && (stale || !sameValues(written.centerLat, values.centerLat))) {
      gl.uniform3fv(this.centerLat, values.centerLat);
    }
    written.copy(values);
  }
}

/**
 * The values of the uniforms of the transforms of the moving sets
 *
 * @internal
 */
export class TransformUniformValues {
  /** Bit k: set k has a transform */
  flags = 0;
  readonly matrix = new Float32Array(16);
  readonly uniform = new Float32Array(16);
  readonly center = new Float32Array(8);
  readonly centerLat = new Float32Array(12);

  constructor(fill = 0) {
    for (const array of [this.matrix, this.uniform, this.center, this.centerLat]) array.fill(fill);
    if (Number.isNaN(fill)) this.flags = -1;
  }

  /**
   * The values of the transforms of the sets, the centers given as their differences from the
   * center the offsets are taken from (computed in float64)
   */
  set(
    transforms: ReadonlyArray<PlaneTransform | null> | undefined,
    origin: readonly [number, number],
  ): void {
    this.flags = 0;
    for (let set = 0; set < 4; set++) {
      const transform = transforms?.[set] ?? null;
      if (!transform) continue;
      this.flags |= 1 << set;
      this.matrix.set(transform.matrix, set * 4);
      this.uniform.set(transform.uniformMatrix, set * 4);
      this.center[set * 2] = origin[0] - transform.center[0];
      this.center[set * 2 + 1] = origin[1] - transform.center[1];
      const phi = (transform.center[1] * Math.PI) / 180;
      this.centerLat[set * 3] = Math.sin(phi);
      this.centerLat[set * 3 + 1] = Math.cos(phi);
      this.centerLat[set * 3 + 2] = Math.tan(phi);
    }
  }

  copy(other: TransformUniformValues): void {
    this.flags = other.flags;
    this.matrix.set(other.matrix);
    this.uniform.set(other.uniform);
    this.center.set(other.center);
    this.centerLat.set(other.centerLat);
  }
}

/** Whether the first values of `values` are those written */
function sameValues(written: Float32Array, values: Float32Array): boolean {
  for (let i = 0; i < written.length; i++) {
    if (written[i] !== values[i]) return false;
  }
  return true;
}

/**
 * Binds the state of the rows for a draw (the program in use must be the variant of the rows)
 *
 * The texture is bound through the run of the draws (once per group within a run), and the
 * uniforms are written when their values change.
 *
 * @internal
 */
export function bindRowState(
  run: RetainedDrawRun,
  uniforms: RowStateUniforms,
  binding: RowStateBinding,
  center?: readonly [number, number],
): void {
  run.bindRowState(binding.texture.texture);
  uniforms.write(binding, center);
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
