// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The layout of the rows drawn in one draw (`RowsRenderer`)
 *
 * Every point, segment of a line, edge of the outline of a polygon and pair of triangles of its
 * fill is one instance of 32 bytes, drawn as a strip of 4 vertices by one program. An instance
 * holds no style and no position: it holds its kind and the number of its row in its row group
 * (one unsigned integer, its tag, read by the shader as an integer attribute) and the numbers of
 * its coordinates, and the vertex shader reads the rest from textures:
 *
 * - the coordinates of the chunk (`RG32F`, offsets from the origin of the chunk), by number
 * - the style of each row of the chunk (`RGBA32F`, one texel per row): the number of its
 *   resolved style, its created zoom and whether it has one
 * - the values of the resolved styles of the layer (`RGBA32F`, four texels per style)
 * - the state of the rows of the group (`R8UI`, `row-state.ts`)
 *
 * The instances of a row are contiguous and in the order the rows are drawn in, so one draw
 * draws the rows in their order (the primitives of one draw are blended in the order they are
 * issued), and a range of rows is one range of instances.
 */

import type { FeatureStyle as PublicFeatureStyle } from '../../../api/model.js';

/** The floats of an instance */
export const ROWS_INSTANCE_FLOATS = 8;
/** The bytes of an instance */
export const ROWS_INSTANCE_BYTES = ROWS_INSTANCE_FLOATS * 4;

/** The kinds of instances (what the shaders branch on) */
export const ROWS_KIND = {
  /** A point (one coordinate) */
  point: 0,
  /** A segment of a line (the coordinates before, at the start, at the end and after it) */
  segment: 1,
  /** An edge of the outline of a polygon (the same four coordinates) */
  outline: 2,
  /** One or two triangles of the fill of a polygon (four coordinates, the last two the same for one) */
  fill: 3,
  /** A point drawn as a picture of a texture an extension gives */
  sprite: 4,
  /** An edge of a dashed outline of a polygon, drawn as a segment of a line */
  dashedOutline: 5,
} as const;

/** The kind of an instance */
export type RowsKind = (typeof ROWS_KIND)[keyof typeof ROWS_KIND];

/**
 * The bits of the number of the row in the tag of an instance (`kind << ROWS_KIND_SHIFT | row`):
 * a row group of up to 2^21 rows, whatever number of rows a host builds its groups with, and the
 * kind above them
 *
 * The tag is the first word of an instance, an unsigned integer the shader reads as an integer
 * attribute and takes apart with a shift and a mask, which are exact on every GPU. A kind and a
 * row taken out of a float by a division move to the next integer on a GPU that uses the 2.5 ULP
 * GLSL ES 3.00 allows a division (the instance then reads the style and the state of the next
 * row).
 */
export const ROWS_KIND_SHIFT = 21;
/** The mask of the number of the row in the tag of an instance */
export const ROWS_ROW_MASK = (1 << ROWS_KIND_SHIFT) - 1;

/**
 * The tag as the float whose bits it is, and back: the instances are written into float arrays,
 * and the tag is the bits of their first word. A tag is below 2^24, so its float is a subnormal
 * or a small normal number (never a NaN), which a copy through a number keeps bit for bit
 */
const TAG_BITS = new Uint32Array(1);
const TAG_FLOAT = new Float32Array(TAG_BITS.buffer);

/** The float whose bits are the tag of a kind and a row */
function tagAsFloat(kind: RowsKind, row: number): number {
  TAG_BITS[0] = (kind << ROWS_KIND_SHIFT) | row;
  return TAG_FLOAT[0] as number;
}

/** The tag whose bits a float is */
function tagOfFloat(value: number): number {
  TAG_FLOAT[0] = value;
  return TAG_BITS[0] as number;
}

/**
 * The number of the row of the instance at a float of an array of instances (its first word)
 *
 * @internal
 */
export function rowOfInstanceWord(value: number): number {
  return tagOfFloat(value) & ROWS_ROW_MASK;
}

/** The texels of the values of one resolved style */
export const ROWS_STYLE_TEXELS = 4;
/** The floats of the values of one resolved style */
export const ROWS_STYLE_FLOATS = ROWS_STYLE_TEXELS * 4;

/** The floats of the style of a row (one texel) */
export const ROWS_ROW_STYLE_FLOATS = 4;

/** The code of the pattern of a line: solid, dashed, dotted */
export const ROWS_DASH = { solid: 0, dashed: 1, dotted: 2 } as const;

/** The widest texture of the coordinates of a chunk (texels per line) */
export const ROWS_COORD_WIDTH = 2_048;
/** The widest texture of the styles of the rows of a chunk (texels per line) */
export const ROWS_ROW_STYLE_WIDTH = 1_024;
/** The width of the texture of the values of the styles of a layer (texels per line) */
export const ROWS_STYLE_WIDTH = 1_024;

/**
 * Writes one instance
 *
 * @param target The instances
 * @param at The instance written
 * @param kind The kind ({@link ROWS_KIND})
 * @param row The number of the row in its row group
 * @param i0 The first coordinate (-1 for none)
 * @param extra The length of the line before a dashed segment, in CSS px at zoom 0 (0 otherwise)
 * @param t0 The start of the piece of the segment it draws (0: the start of the segment)
 * @param t1 The end of the piece (1: the end of the segment)
 */
export function writeRowsInstance(
  target: Float32Array,
  at: number,
  kind: RowsKind,
  row: number,
  i0: number,
  i1: number,
  i2: number,
  i3: number,
  extra = 0,
  t0 = 0,
  t1 = 1,
): void {
  const base = at * ROWS_INSTANCE_FLOATS;
  target[base] = tagAsFloat(kind, row);
  target[base + 1] = i0;
  target[base + 2] = i1;
  target[base + 3] = i2;
  target[base + 4] = i3;
  // The range of the segment it draws (0 to 1: the whole segment; a piece of it where the line
  // is cut for the surface it is drawn on)
  target[base + 5] = t0;
  target[base + 6] = t1;
  target[base + 7] = extra;
}

/**
 * Writes an instance that draws nothing: a fill whose four corners are one coordinate. The
 * instances of a row its packing no longer fills (a row written in place with fewer) are these,
 * so the row keeps its place in the chunk and draws only what it has
 *
 * @param coord A coordinate of the row (any: the instance has no area)
 */
export function writeCollapsedInstance(
  target: Float32Array,
  at: number,
  row: number,
  coord: number,
): void {
  writeRowsInstance(target, at, ROWS_KIND.fill, row, coord, coord, coord, coord);
}

/**
 * One instance read back
 *
 * @internal
 */
export interface RowsInstance {
  readonly kind: RowsKind;
  readonly row: number;
  readonly indices: readonly [number, number, number, number];
  readonly t0: number;
  readonly t1: number;
  readonly extra: number;
}

/**
 * Reads one instance back (for tests and diagnostics)
 *
 * @internal
 */
export function readRowsInstance(source: Float32Array, at: number): RowsInstance {
  const base = at * ROWS_INSTANCE_FLOATS;
  const tag = tagOfFloat(source[base] as number);
  return {
    kind: (tag >>> ROWS_KIND_SHIFT) as RowsKind,
    row: tag & ROWS_ROW_MASK,
    indices: [source[base + 1], source[base + 2], source[base + 3], source[base + 4]],
    t0: source[base + 5],
    t1: source[base + 6],
    extra: source[base + 7],
  };
}

/**
 * The values of the resolved styles of a layer, as the texture of the values holds them
 *
 * Each resolved style takes {@link ROWS_STYLE_FLOATS} floats under its number. The rows that use
 * each number are counted (`retain`, `release`): every row of every chunk built or being built
 * with the palette, so a number is never given to another style while a chunk drawn (an old one
 * kept drawing until its new one is built included) names it. A number no row uses any more is
 * taken back and given to the next style added (`onFree` tells the side that numbered it).
 *
 * The contract of the values: the values of a number a row uses are written again only with the
 * values of the same resolved style (the pixel ratio changed); a number no row uses is written
 * with the values of a new style. The texture is written from `values` by the renderer
 * (`RowsRenderer`), the lines of the texture written since the last upload (`dirty`) only. A
 * palette belongs to the chunks built with it, and is released when it is retired and the last
 * of them is.
 *
 * @internal
 */
export class RowsPalette {
  /** The values, {@link ROWS_STYLE_FLOATS} per style */
  values = new Float32Array(ROWS_STYLE_FLOATS * 16);
  /** The numbers given so far (held or taken back) */
  count = 0;
  /** The lines of the texture written since the last upload (by the renderer) */
  readonly dirty = new Set<number>();
  /** The chunks built with it that are not released */
  refs = 0;
  /** Whether no chunk is built with it any more (it goes once its chunks are released) */
  retired = false;
  /** The texture of the renderer (null before the first upload) */
  gpu: { texture: WebGLTexture; width: number; height: number } | null = null;
  /** Called with a number no row uses any more, once it is taken back */
  onFree: ((style: number) => void) | null = null;
  /** The rows that use each number */
  private uses = new Int32Array(16);
  /** The numbers taken back, to be given again */
  private readonly free: number[] = [];

  /** The number of styles held (the numbers given and not taken back) */
  get size(): number {
    return this.count - this.free.length;
  }

  /**
   * Adds the values of a style: under a number taken back when there is one, a new one otherwise
   *
   * @returns Its number
   */
  add(values: ArrayLike<number>): number {
    const reused = this.free.pop();
    const index = reused ?? this.count;
    if (reused === undefined) {
      const end = (index + 1) * ROWS_STYLE_FLOATS;
      if (end > this.values.length) {
        let size = this.values.length * 2;
        while (size < end) size *= 2;
        const grown = new Float32Array(size);
        grown.set(this.values);
        this.values = grown;
      }
      if (index >= this.uses.length) {
        const uses = new Int32Array(this.uses.length * 2);
        uses.set(this.uses);
        this.uses = uses;
      }
      this.count++;
    }
    this.uses[index] = 0;
    this.write(index, values);
    return index;
  }

  /**
   * Writes the values of a number again (the same resolved style with other values: a new pixel
   * ratio)
   */
  write(index: number, values: ArrayLike<number>): void {
    const at = index * ROWS_STYLE_FLOATS;
    for (let i = 0; i < ROWS_STYLE_FLOATS; i++) this.values[at + i] = values[i] ?? 0;
    this.dirty.add(Math.floor((index * ROWS_STYLE_TEXELS) / ROWS_STYLE_WIDTH));
  }

  /** The rows that use a number */
  usesOf(index: number): number {
    return this.uses[index] ?? 0;
  }

  /** Counts one more row that uses a number */
  retain(index: number): void {
    this.uses[index]++;
  }

  /** Counts one row less that uses a number, and takes it back when no row uses it any more */
  release(index: number): void {
    if (index < 0 || index >= this.count || this.uses[index] <= 0) return;
    this.uses[index]--;
    if (this.uses[index] > 0) return;
    this.free.push(index);
    this.onFree?.(index);
  }

  /**
   * Counts the rows of a list of numbers less (`-1` names no style), as `release` one by one
   *
   * @internal
   */
  releaseAll(numbers: Int32Array): void {
    for (const index of numbers) if (index >= 0) this.release(index);
  }
}

/**
 * What a chunk of rows keeps once it is on the GPU: where each row is in it (its place: its
 * instances, the instances of its points and its coordinates) and the style of each row, the
 * counts and what it is drawn with. A place is as large as what its row was packed with, and a
 * row written in place fills it or less (`RowsRenderer.patchRows`)
 *
 * @internal
 */
export interface RowsChunkLayout {
  /** The origin the coordinates are offsets from (rounded to Float32) */
  readonly origin: [number, number];
  /** The first row of the chunk in its row group */
  readonly rowBase: number;
  /** The number of rows of the chunk */
  readonly rows: number;
  readonly instanceCount: number;
  readonly pointCount: number;
  readonly coordCount: number;
  /** Where the instances of each row start (rows + 1 entries) */
  readonly rowFirst: Int32Array;
  /** Where the point instances of each row start (rows + 1 entries) */
  readonly pointFirst: Int32Array;
  /** Where the coordinates of each row start (rows + 1 entries) */
  readonly coordFirst: Int32Array;
  /**
   * The number of the resolved style of each row (-1 for a row without one): the rows the chunk
   * counts in its palette
   */
  readonly rowStyle: Int32Array;
  /** The values of the styles the rows name */
  readonly palette: RowsPalette;
  /** The pictures the sprites of the chunk are read from (null when it has none) */
  readonly sprites: RowSpriteSource | null;
}

/**
 * The packed arrays of a chunk of rows, as it is made: what it keeps, and the arrays written to
 * the GPU (dropped once they are written)
 *
 * @internal
 */
export interface RowsChunkData extends RowsChunkLayout {
  /** The instances, {@link ROWS_INSTANCE_FLOATS} floats each */
  readonly instances: Float32Array;
  /** The instances of the points only, in the order of the rows (the drape draws them alone) */
  readonly points: Float32Array;
  /** The coordinates, 2 floats each */
  readonly coords: Float32Array;
  /** The style of each row, {@link ROWS_ROW_STYLE_FLOATS} floats per row */
  readonly rowStyles: Float32Array;
}

/**
 * One picture of a point an extension draws in the place of the built-in point
 *
 * @experimental
 */
export interface RowSprite {
  /** The rectangle of the picture in the texture, `[u0, v0, u1, v1]` (the top left first) */
  readonly uv: readonly [number, number, number, number];
  /** The half width and the half height of the picture on screen, in CSS px */
  readonly halfWidth: number;
  readonly halfHeight: number;
  /**
   * The bearing the picture is turned to, in degrees clockwise from north (the picture keeps it
   * when the map turns), or a negative value for a picture that stays upright on screen
   */
  readonly direction: number;
}

/**
 * The most stops {@link RowSpriteSource.distanceScale} has
 *
 * @internal
 */
export const ROW_SPRITE_SCALE_MAX_STOPS = 8;

/**
 * One stop of how the size of the pictures follows the distance of their point from the camera
 * ({@link RowSpriteSource.distanceScale})
 *
 * @experimental
 */
export interface RowSpriteScaleStop {
  /**
   * The distance of the center of the screen from the camera divided by the distance of the
   * point: 1 for a point as far as the center, more for a point nearer the camera, less for one
   * farther from it
   */
  readonly distanceRatio: number;
  /** The factor the size of the picture is multiplied by at that ratio */
  readonly scale: number;
}

/**
 * The pictures an extension draws points with, in the place of the built-in point: given to
 * the drawing of the rows, which draws such points among the others, in their order, in the
 * draw of their chunk (`FeatureTypeRenderer.rowSprites`)
 *
 * The fragment is the texel of the picture (its colors divided by its alpha for a texture of
 * premultiplied alpha, `premultipliedAlpha`) times the opacity of the layer, blended as the other
 * drawing of the layer is.
 *
 * @experimental
 */
export interface RowSpriteSource {
  /** The texture the pictures are read from (nothing is drawn while it is null) */
  readonly texture: WebGLTexture | null;
  /**
   * Changes whenever the texture or a picture `sprite` gives changes: the rows of the type are
   * classified and packed again
   */
  readonly revision: number;
  /**
   * The picture of a point of a style, or null for a point drawn at once by the renderer of
   * the extension (asked once per style)
   */
  sprite(style: PublicFeatureStyle | undefined): RowSprite | null;
  /**
   * How the size of the pictures follows the distance of their point from the camera in a pitched
   * view, as stops of a curve: from 1 to 8 stops in ascending order of `distanceRatio`, the factor
   * linear between two stops and that of the first or the last stop beyond them. The same size
   * everywhere when omitted or empty, and on the globe. Stops the library cannot read (more than
   * 8, not in ascending order, not finite) are told once in the console and draw the same size
   * everywhere
   */
  readonly distanceScale?: readonly RowSpriteScaleStop[];
  /**
   * True when the texture holds its colors multiplied by their alpha (a canvas uploaded with
   * `UNPACK_PREMULTIPLY_ALPHA_WEBGL`): they are divided back before they are blended as the other
   * drawing of the layer is. Straight alpha when omitted
   */
  readonly premultipliedAlpha?: boolean;
}
