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

import type { EnuEdit } from '../../geometry/enu-transforms.js';
import { type GpuLedger, textureBytes } from '../gpu-ledger.js';
import { getRenderFrame } from '../shaders/frame.js';
import type { RetainedDrawRun } from './draw-run.js';
import {
  MOTION_SLOTS,
  type MotionFrame,
  MotionUniformValues,
  motionFrameOf,
  ROW_MOTION_GLSL,
  stillMotionFrame,
} from './row-motion.js';

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
// The sets moved by the motion of an edit (bit k: set k has one), before their translation
// (row-motion.ts)
uniform int u_state_transformed;

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

// The sine and the cosine of an angle, by their series for a small one: the built-in functions of
// a GPU may be off by an error of the order of a float32 step of 1, a large share of the sine of
// the half angles here (a few hundred-thousandths of a radian)
vec2 rowSinCos(float x) {
    if (abs(x) < 0.1) {
        float x2 = x * x;
        return vec2(
            x * (1.0 - x2 / 6.0 * (1.0 - x2 / 20.0 * (1.0 - x2 / 42.0))),
            1.0 - x2 / 2.0 * (1.0 - x2 / 12.0 * (1.0 - x2 / 30.0))
        );
    }
    return vec2(sin(x), cos(x));
}

// The arctangent of a value, by its series for a small one (as rowSinCos)
float rowAtan(float x) {
    if (abs(x) < 0.1) {
        float x2 = x * x;
        return x * (1.0 - x2 * (1.0 / 3.0 - x2 * (0.2 - x2 * (1.0 / 7.0 - x2 / 9.0))));
    }
    return atan(x);
}
${ROW_MOTION_GLSL}
// An offset of a row moved by its moving set: by the motion of the set, then translated (an
// offset of a row not moving as it is). A row moved by a motion gives its offset from the center
// of the camera, which the projection then takes as it is (g_offset_from_center): every
// position the vertex reads is of the same row, so all of them are taken so
vec2 rowStateMove(uint state, vec2 offset) {
    int moveSet = int((state >> 1u) & 3u);
    if (moveSet == 0) return offset;
    if (((u_state_transformed >> moveSet) & 1) != 0) {
        int slot = 2 * (moveSet - 1) + ((state & 16u) != 0u ? 1 : 0);
        g_offset_from_center = 1.0;
        return rowMotionMove(slot, offset) + u_state_translate[moveSet];
    }
    return offset + u_state_translate[moveSet];
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
  /**
   * The edit that moves, rotates or scales each of the sets 0 to 3, applied before the
   * translation (null for none)
   */
  readonly transforms?: ReadonlyArray<EnuEdit | null>;
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
  private readonly motionRows: WebGLUniformLocation | null;
  private readonly motionOffsets: WebGLUniformLocation | null;
  private readonly motionFrom: WebGLUniformLocation | null;
  private readonly motionTo: WebGLUniformLocation | null;
  /** The frame the values were written in (-1 before the first write) */
  private frame = -1;
  private writtenWidth = Number.NaN;
  private readonly writtenTranslations = new Float32Array(8).fill(Number.NaN);
  /** The values of the motions, as they are written (and were written last) */
  private readonly motionValues = new MotionStateValues();
  private readonly writtenMotions = new MotionStateValues(Number.NaN);

  constructor(
    private readonly gl: WebGL2RenderingContext,
    program: WebGLProgram,
  ) {
    this.state = gl.getUniformLocation(program, 'u_row_state');
    this.width = gl.getUniformLocation(program, 'u_row_state_width');
    this.translate = gl.getUniformLocation(program, 'u_state_translate');
    this.transformed = gl.getUniformLocation(program, 'u_state_transformed');
    this.motionRows = gl.getUniformLocation(program, 'u_motion_rows');
    this.motionOffsets = gl.getUniformLocation(program, 'u_motion_offsets');
    this.motionFrom = gl.getUniformLocation(program, 'u_motion_from');
    this.motionTo = gl.getUniformLocation(program, 'u_motion_to');
  }

  /**
   * Writes the uniforms for a draw (the program in use must be the one of these uniforms)
   *
   * @param origin The origin the offsets of the batch drawn are taken from, `[lng, lat]` in
   *   degrees
   * @param center The center the projection takes the offsets from (`u_center_lnglat`: the camera
   *   center, or the origin of the batch)
   */
  write(
    binding: RowStateBinding,
    origin: readonly [number, number] = [0, 0],
    center: readonly [number, number] = origin,
  ): void {
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
    const values = this.motionValues;
    values.set(binding.transforms, origin, center);
    const written = this.writtenMotions;
    if (this.transformed && (stale || written.flags !== values.flags)) {
      gl.uniform1i(this.transformed, values.flags);
    }
    if (values.flags === 0 && !stale && written.flags === 0) return;
    const motion = values.motion;
    const before = written.motion;
    if (this.motionRows && (stale || !sameValues(before.rows, motion.rows))) {
      gl.uniform4fv(this.motionRows, motion.rows);
    }
    if (this.motionOffsets && (stale || !sameValues(before.offsets, motion.offsets))) {
      gl.uniform4fv(this.motionOffsets, motion.offsets);
    }
    if (this.motionFrom && (stale || !sameValues(before.from, motion.from))) {
      gl.uniform4fv(this.motionFrom, motion.from);
    }
    if (this.motionTo && (stale || !sameValues(before.to, motion.to))) {
      gl.uniform4fv(this.motionTo, motion.to);
    }
    written.copy(values);
  }
}

/** The motions of the centers of the camera computed last (the draws of a frame share them) */
const FRAME_CACHE_SIZE = 8;
const frameCache: Array<{
  edit: EnuEdit;
  uniformScale: boolean;
  lon: number;
  lat: number;
  frame: MotionFrame | null;
} | null> = new Array(FRAME_CACHE_SIZE).fill(null);
let frameCacheNext = 0;

/** The motion of an edit for a center of the camera, computed once for the draws that share it */
function cachedMotionFrame(
  edit: EnuEdit,
  uniformScale: boolean,
  center: readonly [number, number],
): MotionFrame | null {
  const lon = center[0];
  const lat = center[1];
  for (const entry of frameCache) {
    if (
      entry &&
      entry.edit === edit &&
      entry.uniformScale === uniformScale &&
      entry.lon === lon &&
      entry.lat === lat
    ) {
      return entry.frame;
    }
  }
  const frame = motionFrameOf(edit, uniformScale, [lon, lat]);
  frameCache[frameCacheNext] = { edit, uniformScale, lon, lat, frame };
  frameCacheNext = (frameCacheNext + 1) % FRAME_CACHE_SIZE;
  return frame;
}

/**
 * The values of the uniforms of the motions of the moving sets
 *
 * @internal
 */
export class MotionStateValues {
  /** Bit k: set k has a motion */
  flags = 0;
  readonly motion: MotionUniformValues;

  constructor(fill = 0) {
    this.motion = new MotionUniformValues(fill);
    if (Number.isNaN(fill)) this.flags = -1;
  }

  /**
   * The values of the motions of the sets, for a batch whose offsets are taken from `origin`, drawn
   * with the projection centered on `center` (computed in float64)
   */
  set(
    transforms: ReadonlyArray<EnuEdit | null> | undefined,
    origin: readonly [number, number],
    center: readonly [number, number],
  ): void {
    this.flags = 0;
    // The projection takes the offsets from the center as a float32 (u_center_lnglat)
    const k: [number, number] = [Math.fround(center[0]), Math.fround(center[1])];
    for (let set = 1; set < 4 && 2 * (set - 1) + 1 < MOTION_SLOTS; set++) {
      const edit = transforms?.[set] ?? null;
      if (!edit) continue;
      const frame = cachedMotionFrame(edit, false, k);
      // A row that keeps its shape is scaled by sizeFactor, the others by their factors: either
      // may move while the other does not
      const uniform = edit.kind === 'scale' ? cachedMotionFrame(edit, true, k) : frame;
      if (!frame && !uniform) continue;
      this.flags |= 1 << set;
      const slot = 2 * (set - 1);
      this.motion.write(slot, frame ?? stillMotionFrame(k), origin);
      if (uniform === frame) this.motion.copySlot(slot, slot + 1);
      else this.motion.write(slot + 1, uniform ?? stillMotionFrame(k), origin);
    }
  }

  copy(other: MotionStateValues): void {
    this.flags = other.flags;
    this.motion.copy(other.motion);
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
 * @param origin The origin the offsets of the batch are taken from
 * @param center The center the projection takes the offsets from (the origin when omitted)
 * @internal
 */
export function bindRowState(
  run: RetainedDrawRun,
  uniforms: RowStateUniforms,
  binding: RowStateBinding,
  origin?: readonly [number, number],
  center?: readonly [number, number],
): void {
  run.bindRowState(binding.texture.texture);
  uniforms.write(binding, origin, center);
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
