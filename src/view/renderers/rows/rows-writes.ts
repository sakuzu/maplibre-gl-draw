// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The writes in place of a chunk of rows waiting to be uploaded (`TexelWrites`)
 *
 * A chunk drawn in one draw keeps no copy of its packed arrays once they are on the GPU: what is
 * written in place of its rows is held here until the uploads of the next frame, one entry per
 * texel (or per instance), a later write of the same texel over the earlier one. The upload
 * takes the entries in their order and uploads each run of texels that follow each other on a
 * line of the texture once, so a line written many times in a frame is uploaded once and only
 * the texels written are uploaded: moving one vertex of a line of 100,000 is one texel.
 *
 * Every texture the rows are read from is a power of two wide, and the place of a texel in it is
 * taken out of its number with a shift and a mask (`texelLine`, `texelColumn`): where the CPU
 * writes a texel and where the shaders read it (`texelPlaceGlsl`) come from this one formula.
 */

/**
 * The shift of a width that is a power of two (the width is `1 << shift`)
 *
 * @throws when the width is not a power of two
 * @internal
 */
export function widthShift(width: number): number {
  const shift = Math.log2(width);
  if (!Number.isInteger(shift) || shift < 0) {
    throw new Error(`a texture of the rows is ${width} texels wide, not a power of two`);
  }
  return shift;
}

/**
 * The line of a texel in a texture `1 << shift` texels wide
 *
 * @internal
 */
export function texelLine(texel: number, shift: number): number {
  return texel >> shift;
}

/**
 * The texel on its line of a texel in a texture `1 << shift` texels wide
 *
 * @internal
 */
export function texelColumn(texel: number, shift: number): number {
  return texel & ((1 << shift) - 1);
}

/**
 * The GLSL of the place of a texel (an `ivec2` for `texelFetch`), the formula of `texelColumn`
 * and `texelLine`
 *
 * @param index The GLSL of the number of the texel (an `int`)
 * @param mask The GLSL of the mask of the width (`width - 1`, an `int`)
 * @param shift The GLSL of the shift of the width (an `int`)
 * @internal
 */
export function texelPlaceGlsl(index: string, mask: string, shift: string): string {
  return `ivec2((${index}) & (${mask}), (${index}) >> (${shift}))`;
}

/**
 * The values written of the texels (or instances) of one texture (or buffer) of a chunk
 *
 * @internal
 */
export class TexelWrites {
  /** The slot of the values of each texel written */
  private readonly slots = new Map<number, number>();
  private values: Float32Array;

  /** @param floats The floats of a texel (of an instance) */
  constructor(readonly floats: number) {
    this.values = new Float32Array(floats * 16);
  }

  /** The number of texels written */
  get size(): number {
    return this.slots.size;
  }

  /**
   * Writes a texel from `source` (the floats from `at`), over what was written of it before
   */
  write(texel: number, source: ArrayLike<number>, at = 0): void {
    let slot = this.slots.get(texel);
    if (slot === undefined) {
      slot = this.slots.size;
      const end = (slot + 1) * this.floats;
      if (end > this.values.length) {
        let size = this.values.length * 2;
        while (size < end) size *= 2;
        const grown = new Float32Array(size);
        grown.set(this.values);
        this.values = grown;
      }
      this.slots.set(texel, slot);
    }
    const base = slot * this.floats;
    for (let k = 0; k < this.floats; k++) this.values[base + k] = source[at + k];
  }

  /**
   * Hands the texels written to `upload`, as runs of texels that follow each other on a line of
   * `1 << shift` texels (each texel once), and forgets them
   *
   * @param shift The shift of the width of a line (null for a buffer: a run only ends at a gap)
   * @param upload Receives each run: its line, its first texel on the line, and its values
   */
  drain(
    shift: number | null,
    upload: (line: number, first: number, values: Float32Array) => void,
  ): void {
    if (this.slots.size === 0) return;
    const texels = [...this.slots.keys()].sort((a, b) => a - b);
    const floats = this.floats;
    for (let i = 0; i < texels.length; ) {
      const start = texels[i];
      const line = shift === null ? 0 : texelLine(start, shift);
      let j = i + 1;
      while (
        j < texels.length &&
        texels[j] === texels[j - 1] + 1 &&
        (shift === null || texelLine(texels[j], shift) === line)
      ) {
        j++;
      }
      const run = new Float32Array((j - i) * floats);
      for (let k = i; k < j; k++) {
        const slot = this.slots.get(texels[k]) as number;
        run.set(this.values.subarray(slot * floats, (slot + 1) * floats), (k - i) * floats);
      }
      upload(line, shift === null ? start : texelColumn(start, shift), run);
      i = j;
    }
    this.clear();
  }

  /**
   * Hands each texel written to `read`, in no order, without forgetting them: its number, and the
   * array its values are in from `at`
   */
  forEach(read: (texel: number, values: Float32Array, at: number) => void): void {
    for (const [texel, slot] of this.slots) read(texel, this.values, slot * this.floats);
  }

  /** Forgets the texels written */
  clear(): void {
    this.slots.clear();
  }
}
