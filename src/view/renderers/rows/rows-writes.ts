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
 */

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
   * `width` texels (each texel once), and forgets them
   *
   * @param width The texels of a line (Infinity for a buffer: a run only ends at a gap)
   * @param upload Receives each run: its line, its first texel on the line, and its values
   */
  drain(width: number, upload: (line: number, first: number, values: Float32Array) => void): void {
    if (this.slots.size === 0) return;
    const texels = [...this.slots.keys()].sort((a, b) => a - b);
    const floats = this.floats;
    for (let i = 0; i < texels.length; ) {
      const start = texels[i];
      const line = Number.isFinite(width) ? Math.floor(start / width) : 0;
      let j = i + 1;
      while (
        j < texels.length &&
        texels[j] === texels[j - 1] + 1 &&
        (!Number.isFinite(width) || Math.floor(texels[j] / width) === line)
      ) {
        j++;
      }
      const run = new Float32Array((j - i) * floats);
      for (let k = i; k < j; k++) {
        const slot = this.slots.get(texels[k]) as number;
        run.set(this.values.subarray(slot * floats, (slot + 1) * floats), (k - i) * floats);
      }
      upload(line, Number.isFinite(width) ? start - line * width : start, run);
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
