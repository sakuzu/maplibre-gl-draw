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
 *
 * A renderer of an extension that draws something with each row (a mark of a point) reads the
 * same GLSL and the same uniforms from the second entry, with a texture of its own holding the
 * byte of the row of each of its instances (`rowStateOf`), so what it draws moves as the rows do.
 */

import { type DraggedRows, draggedRowMotionsOf } from '../../feature-table/dragged-rows.js';
import { MOVE_SETS } from '../../feature-table/row-state.js';
import type { RowHandle } from '../../feature-table/types.js';
import {
  type EnuEdit,
  enuEditTurn,
  inverseEnuEdit,
  moveEnuPosition,
} from '../../geometry/enu-transforms.js';
import type { BoundingBox } from '../../store/types.js';
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

/**
 * The texture unit `RowStateUniforms` points `u_row_state` of `ROW_STATE_GLSL` to: bind the
 * texture of the state of the rows (`RowStateTexture.texture`) there before drawing.
 */
export const ROW_STATE_TEXTURE_UNIT = 1;

/**
 * The GLSL that reads the state of the rows and moves a position of a row as the library draws it
 * while it is dragged; include it in a vertex shader after `OFFSET_MODE_GLSL`.
 *
 * Each instance (or vertex) carries the number of its row, which picks one byte of the texture of
 * the state of the rows (`createRowStateTexture`, `uploadRowState`; `rowStateOf` gives the byte of
 * a row being dragged). The functions:
 *
 * - `uint readRowState(float row)`: the byte of a row
 * - `bool rowStateHidden(uint state)`: whether the row is hidden (bit 1 of the byte)
 * - `vec2 rowStateMove(uint state, vec2 offset)`: an offset in degrees from the origin of what is
 *   drawn, moved as the rows of the library are moved by the drag of their moving set: moved,
 *   turned or scaled as the drag is written once it is let go, then translated. Give what it
 *   returns to `project_position_to_clipspace_from_offset`. A row moved so gives its offsets from
 *   the center the projection takes them from, so every position a vertex projects after it must be
 *   of the same row
 * - `float rowStateRotation(uint state)`: the degrees the drag of the moving set of the row adds to
 *   an angle of the row (0 for a row not moving), as it is written once the drag is let go
 * - `float rowStateScale(uint state)`: the factor the drag multiplies a size of the row by (1 for a
 *   row not moving), as it is written once the drag is let go
 *
 * The uniforms, which `RowStateUniforms` writes: `u_row_state` (the texture, read on the unit
 * `ROW_STATE_TEXTURE_UNIT`), `u_row_state_width`, `u_state_translate`, `u_state_transformed`,
 * `u_state_rotate_scale` and those of the motions.
 */
export const ROW_STATE_GLSL = `
uniform highp usampler2D u_row_state;
uniform int u_row_state_width;
// The translation of each moving set in degrees of longitude and latitude (set 0 is none)
uniform vec2 u_state_translate[4];
// The sets moved by the motion of an edit (bit k: set k has one), before their translation
// (row-motion.ts)
uniform int u_state_transformed;
// What the edit of each moving set does to a row besides its position: the degrees added to an
// angle and the factor of a size (set 0 is none)
uniform vec2 u_state_rotate_scale[4];

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

float rowStateRotation(uint state) {
    return u_state_rotate_scale[int((state >> 1u) & 3u)].x;
}

float rowStateScale(uint state) {
    return u_state_rotate_scale[int((state >> 1u) & 3u)].y;
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
`;

/**
 * The GLSL of the variant of the programs of the library that draws the rows (`#define
 * TABLE_ROWS`): `ROW_STATE_GLSL` when it is defined, nothing otherwise. The attribute of the number
 * of the row is declared by each program at its own location.
 *
 * @internal
 */
export const TABLE_ROWS_GLSL = `
#ifdef TABLE_ROWS
${ROW_STATE_GLSL}
#endif
`;

/** A position outside the clip space: a vertex of a hidden row goes here */
export const ROW_HIDDEN_POSITION_GLSL = 'vec4(2.0, 2.0, 2.0, 1.0)';

/**
 * A texture of the state of rows, one byte per row (an `R8UI` texture `width` rows wide), which
 * `ROW_STATE_GLSL` reads by the number of a row.
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
 * What a draw of rows reads: the texture of the state of its rows, and how each moving set moves
 * (`rowStateBindingOf`). It keeps the moves it was made with: drawing with the same binding draws
 * the rows where they were drawn when it was made.
 */
export interface RowStateBinding {
  readonly texture: RowStateTexture;
  /** `[dLng, dLat]` of the moving sets 0 to 3, in degrees (set 0 is always 0) */
  readonly translations: Float32Array;
  /**
   * The edit that moves, rotates or scales each of the sets 0 to 3, applied before the
   * translation (null for none)
   *
   * @internal
   */
  readonly transforms?: ReadonlyArray<EnuEdit | null>;
}

/**
 * Looks up and writes the uniforms of `ROW_STATE_GLSL` in one program.
 *
 * A value the same as the one written last is not written again; everything is written again
 * once per draw of the map. Make a new one for a program made again.
 *
 * The draws of a run of rows of the library go through here once per range drawn, but the unit of
 * the texture never changes, the width of the texture is the same for every group, and the
 * translations of the moving sets change once per layer at most (`shaders/frame.ts`).
 */
export class RowStateUniforms {
  private readonly state: WebGLUniformLocation | null;
  private readonly width: WebGLUniformLocation | null;
  private readonly translate: WebGLUniformLocation | null;
  private readonly transformed: WebGLUniformLocation | null;
  private readonly rotateScale: WebGLUniformLocation | null;
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

  /**
   * @param gl - The WebGL context of the map
   * @param program - The program that includes `ROW_STATE_GLSL`
   */
  constructor(
    private readonly gl: WebGL2RenderingContext,
    program: WebGLProgram,
  ) {
    this.state = gl.getUniformLocation(program, 'u_row_state');
    this.width = gl.getUniformLocation(program, 'u_row_state_width');
    this.translate = gl.getUniformLocation(program, 'u_state_translate');
    this.transformed = gl.getUniformLocation(program, 'u_state_transformed');
    this.rotateScale = gl.getUniformLocation(program, 'u_state_rotate_scale');
    this.motionRows = gl.getUniformLocation(program, 'u_motion_rows');
    this.motionOffsets = gl.getUniformLocation(program, 'u_motion_offsets');
    this.motionFrom = gl.getUniformLocation(program, 'u_motion_from');
    this.motionTo = gl.getUniformLocation(program, 'u_motion_to');
  }

  /**
   * Writes the uniforms for a draw; the program in use must be the one given to the constructor.
   *
   * @param binding - The state of the rows drawn
   * @param origin - The position the offsets drawn are taken from, `[lng, lat]` in degrees
   * @param center - The center the projection takes the offsets from (`centerLngLat` of the
   *   `OffsetUniforms` given to `ProjectionUniformManager.setUniforms`); the origin when omitted
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
    if (this.rotateScale && (stale || !sameValues(written.rotateScale, values.rotateScale))) {
      gl.uniform2fv(this.rotateScale, values.rotateScale);
    }
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
  /** The degrees added to an angle and the factor of a size, of the sets 0 to 3 */
  readonly rotateScale = new Float32Array(8);

  constructor(fill = 0) {
    this.motion = new MotionUniformValues(fill);
    if (Number.isNaN(fill)) {
      this.flags = -1;
      this.rotateScale.fill(fill);
    }
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
    const rotateScale = this.rotateScale;
    for (let set = 0; set < 4; set++) {
      const edit = transforms?.[set] ?? null;
      const turn = edit ? enuEditTurn(edit) : null;
      rotateScale[set * 2] = turn?.angleDegrees ?? 0;
      rotateScale[set * 2 + 1] = turn?.sizeFactor ?? 1;
    }
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
    this.rotateScale.set(other.rotateScale);
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
 * Creates a texture of the state of rows, every byte 0 (shown, not moving).
 *
 * @param gl - The WebGL context of the map
 * @param rows - The number of rows
 * @returns The texture, or null when it cannot be created
 */
export function createRowStateTexture(
  gl: WebGL2RenderingContext,
  rows: number,
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
  return { texture, width, height, rows };
}

/**
 * Records a texture of the state of rows in the ledger of an instance (the textures of the
 * extensions are their own)
 *
 * @internal
 */
export function recordRowStateTexture(ledger: GpuLedger | undefined, state: RowStateTexture): void {
  const { texture, width, height } = state;
  ledger?.record(texture, 'row-state', 'texture', textureBytes(width, height, 1));
}

/**
 * Writes the byte of every row of a texture of the state of rows. It binds the texture to the
 * active texture unit.
 *
 * A line of the texture is `width` bytes, but the alignment of the rows of an upload
 * (`UNPACK_ALIGNMENT`) is a state of the context shared with maplibre, so it is set to 1 for the
 * upload and put back after it: the upload is right whatever the alignment was.
 *
 * @param gl - The WebGL context of the map
 * @param texture - The texture
 * @param state - One byte per row (at least `texture.rows`; `rowStateOf` gives the byte of a row
 *   being dragged)
 * @param scratch - An array of `width * height` bytes the upload is laid out in (made when
 *   omitted)
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
 * Deletes a texture of the state of rows.
 *
 * @param gl - The WebGL context of the map
 * @param texture - The texture
 */
export function deleteRowStateTexture(gl: WebGL2RenderingContext, texture: RowStateTexture): void {
  gl.deleteTexture(texture.texture);
}

/**
 * The byte of the state of the row of a handle that tells how it moves while it is dragged (its
 * moving set, and whether it keeps its shape), to write in a texture of the state of rows at the
 * number an instance drawn with the row carries.
 *
 * @param dragged - The rows being dragged (`draw.rendered.getDraggedRows()`)
 * @param handle - The handle of the row
 * @returns The byte; 0 for a row not dragged, or when no row is (`dragged` is null). Its lowest
 *   bit is 0: set it (`| 1`) to hide the row (`rowStateHidden`)
 */
export function rowStateOf(dragged: DraggedRows | null, handle: RowHandle): number {
  if (!dragged) return 0;
  return draggedRowMotionsOf(dragged)?.gpuStateOf(handle) ?? 0;
}

/**
 * What a draw of rows reads: a texture of the state of its rows, and how each moving set of the
 * rows being dragged moves now. The moves are copied: keep the binding to draw the rows where they
 * are now after the drag ends.
 *
 * @param dragged - The rows being dragged (`draw.rendered.getDraggedRows()`); null when no row is
 * @param texture - The texture of the state of the rows drawn
 */
export function rowStateBindingOf(
  dragged: DraggedRows | null,
  texture: RowStateTexture,
): RowStateBinding {
  const translations = new Float32Array((MOVE_SETS + 1) * 2);
  const transforms: Array<EnuEdit | null> = new Array(MOVE_SETS + 1).fill(null);
  const moves = dragged ? draggedRowMotionsOf(dragged) : undefined;
  if (moves) {
    for (let set = 1; set <= MOVE_SETS; set++) {
      const [dLng, dLat] = moves.translation(set);
      translations[set * 2] = dLng;
      translations[set * 2 + 1] = dLat;
      transforms[set] = moves.transform(set);
    }
  }
  return { texture, translations, transforms };
}

/**
 * The regions a view sees the rows moved on the GPU by a binding from: the view moved back by the
 * move of each moving set. A batch of such rows takes its origin near them while they are moved
 * (`rebasedRetainedOrigin`).
 *
 * @param binding - The moves the rows are drawn with
 * @param view - The view, longitude and latitude
 * @returns The regions, none when no set moves by more than a translation
 */
export function rowStateMovedViews(binding: RowStateBinding, view: BoundingBox): BoundingBox[] {
  const views: BoundingBox[] = [];
  if (binding.transforms) movedViewsOf(binding.transforms, view, views);
  return views;
}

/**
 * The regions the view sees the rows of the moving sets from: the view moved back by the edit of
 * each set (for a scaling, by its factors and by its size), as the extents of its corners, the
 * middles of its sides and its center (appended to `out`)
 *
 * @internal
 */
export function movedViewsOf(
  transforms: ReadonlyArray<EnuEdit | null>,
  view: BoundingBox,
  out: BoundingBox[],
): void {
  for (const edit of transforms) {
    if (edit) movedBackViews(edit, view, out);
  }
}

/**
 * The regions a view is seen from before an edit (appended to `out`), as `movedViewsOf`
 *
 * @internal
 */
export function movedBackViews(edit: EnuEdit, view: BoundingBox, out: BoundingBox[]): void {
  const back = inverseEnuEdit(edit);
  for (const uniform of edit.kind === 'scale' ? [false, true] : [false]) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const fx of [0, 0.5, 1]) {
      for (const fy of [0, 0.5, 1]) {
        const x = view.minX + (view.maxX - view.minX) * fx;
        const y = Math.max(-90, Math.min(90, view.minY + (view.maxY - view.minY) * fy));
        const p = moveEnuPosition(back, [x, y], uniform);
        minX = Math.min(minX, p[0] as number);
        minY = Math.min(minY, p[1] as number);
        maxX = Math.max(maxX, p[0] as number);
        maxY = Math.max(maxY, p[1] as number);
      }
    }
    if (minX <= maxX && minY <= maxY) out.push({ minX, minY, maxX, maxY });
  }
}
