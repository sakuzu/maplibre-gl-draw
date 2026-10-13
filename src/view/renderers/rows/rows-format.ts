// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The layout of the rows drawn in one draw (`RowsRenderer`)
 *
 * Every point, segment of a line, edge of the outline of a polygon and pair of triangles of its
 * fill is one instance of 32 bytes, drawn as a strip of 4 vertices by one program. An instance
 * holds no style and no position: it holds its kind, the number of its row in its row group and
 * the numbers of its coordinates, and the vertex shader reads the rest from textures:
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

import type { FeatureStyle } from '../../../shared/types/model.js';

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
 * The factor of the kind in the first float of an instance (`kind * ROWS_KIND_FACTOR + row`):
 * 2^21, so the sum stays an exact integer in a float (below 2^24) for the six kinds and a row
 * group of up to 2^21 rows, whatever number of rows a host builds its groups with
 */
export const ROWS_KIND_FACTOR = 2_097_152;

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
): void {
  const base = at * ROWS_INSTANCE_FLOATS;
  target[base] = kind * ROWS_KIND_FACTOR + row;
  target[base + 1] = i0;
  target[base + 2] = i1;
  target[base + 3] = i2;
  target[base + 4] = i3;
  // The range of the segment it draws (0 to 1: the whole segment on a flat map)
  target[base + 5] = 0;
  target[base + 6] = 1;
  target[base + 7] = extra;
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
  const head = source[base];
  const kind = Math.floor(head / ROWS_KIND_FACTOR) as RowsKind;
  return {
    kind,
    row: head - kind * ROWS_KIND_FACTOR,
    indices: [source[base + 1], source[base + 2], source[base + 3], source[base + 4]],
    t0: source[base + 5],
    t1: source[base + 6],
    extra: source[base + 7],
  };
}

/**
 * The values of the resolved styles of a layer, as the texture of the values holds them
 *
 * Each resolved style takes {@link ROWS_STYLE_FLOATS} floats, numbered in the order they are
 * added. The texture is written from `values` (`RowsRenderer`), from the first style it does
 * not hold yet; a style is never changed once added. A palette belongs to the chunks built with
 * it, and is released when it is retired and the last of them is.
 *
 * @internal
 */
export class RowsPalette {
  /** The values, {@link ROWS_STYLE_FLOATS} per style */
  values = new Float32Array(ROWS_STYLE_FLOATS * 16);
  /** The number of styles */
  count = 0;
  /** The styles the texture holds (written by the renderer) */
  uploaded = 0;
  /** The chunks built with it that are not released */
  refs = 0;
  /** Whether no chunk is built with it any more (it goes once its chunks are released) */
  retired = false;
  /** The texture of the renderer (null before the first upload) */
  gpu: { texture: WebGLTexture; width: number; height: number } | null = null;

  /**
   * Adds the values of a style
   *
   * @returns Its number
   */
  add(values: ArrayLike<number>): number {
    const index = this.count;
    const end = (index + 1) * ROWS_STYLE_FLOATS;
    if (end > this.values.length) {
      let size = this.values.length * 2;
      while (size < end) size *= 2;
      const grown = new Float32Array(size);
      grown.set(this.values);
      this.values = grown;
    }
    const at = index * ROWS_STYLE_FLOATS;
    for (let i = 0; i < ROWS_STYLE_FLOATS; i++) this.values[at + i] = values[i] ?? 0;
    this.count++;
    return index;
  }
}

/**
 * The packed arrays of a chunk of rows, kept with it for the writes in place
 *
 * @internal
 */
export interface RowsChunkData {
  /** The origin the coordinates are offsets from (rounded to Float32) */
  readonly origin: [number, number];
  /** The first row of the chunk in its row group */
  readonly rowBase: number;
  /** The number of rows of the chunk */
  readonly rows: number;
  /** The instances, {@link ROWS_INSTANCE_FLOATS} floats each */
  readonly instances: Float32Array;
  readonly instanceCount: number;
  /** The instances of the points only, in the order of the rows (the drape draws them alone) */
  readonly points: Float32Array;
  readonly pointCount: number;
  /** The coordinates, 2 floats each */
  readonly coords: Float32Array;
  readonly coordCount: number;
  /** The style of each row, {@link ROWS_ROW_STYLE_FLOATS} floats per row */
  readonly rowStyles: Float32Array;
  /** Where the instances of each row start (rows + 1 entries) */
  readonly rowFirst: Int32Array;
  /** Where the point instances of each row start (rows + 1 entries) */
  readonly pointFirst: Int32Array;
  /** Where the coordinates of each row start (rows + 1 entries) */
  readonly coordFirst: Int32Array;
  /** The values of the styles the rows name */
  readonly palette: RowsPalette;
  /** The pictures the sprites of the chunk are read from (null when it has none) */
  readonly sprites: RowSpriteSource | null;
}

/**
 * One picture of a point an extension draws in the place of the built-in point
 *
 * @internal
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
 * How the size of the pictures follows the distance of their point from the camera, in a
 * pitched view: `clamp(base + factor * w0 / w, min, max)`, where `w0` is the distance of the
 * center of the screen and `w` the distance of the point (1 on the globe)
 *
 * @internal
 */
export interface RowSpriteDistanceScale {
  readonly base: number;
  readonly factor: number;
  readonly min: number;
  readonly max: number;
}

/**
 * The pictures an extension draws points with, in the place of the built-in point: given to
 * the drawing of the rows, which draws such points among the others, in their order, in the
 * draw of their chunk (`FeatureTypeRenderer.rowSprites`)
 *
 * The fragment is the texel of the picture times the opacity of the layer, blended as the
 * other drawing of the layer is.
 *
 * @internal
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
  sprite(style: FeatureStyle | undefined): RowSprite | null;
  /** How the size follows the distance from the camera (the same size everywhere when omitted) */
  readonly distanceScale?: RowSpriteDistanceScale;
}
