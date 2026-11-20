// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The ledger of what the drawing allocates on the GPU (`GpuLedger`)
 *
 * WebGL does not tell how much GPU memory a page uses. The renderers record here every object
 * they make on the GPU (a buffer, a texture, a render buffer, a frame buffer, a vertex array, a
 * program) when they make it, the size of the storage they give it (`bufferData`,
 * `texStorage2D`, `texImage2D`, `renderbufferStorage`), and take it out when they delete it, so
 * the drawing can tell what it holds, per part of the drawing. Nothing the drawing allocates on
 * the GPU is left out of it (`gpu-ledger-coverage.test.ts` counts the allocations of a GL and
 * compares them with it).
 *
 * It is a lower bound of what the page uses: what maplibre allocates (the tiles of the base map,
 * its elevation data and what it draws the terrain with) is not in it, nor what the driver keeps
 * after a delete until it frees it: these are numbers kept in JavaScript, which say what was
 * asked and given back, not when the driver gave the memory back.
 *
 * Every allocation is recorded under the name of the part that holds it, and the ledger belongs
 * to one draw instance: `record` takes no object without the name of its part, and nothing is
 * shared between two instances. What a part fails to give back is found when the GPU side of the
 * instance goes (`drain`): it is deleted there and counted (`leakedBytes`). A build that fails
 * gives back what it had made (`scope`).
 *
 * The bytes held outside the rows (what does not grow with the features: the work of the drape,
 * the atlas of the elevations, the images, the shapes of the points drawn one by one) are held
 * under a limit (`limitBytes`): the parts that would go over it ask first (`fits`) and give
 * something up or draw without it. The rows (what is drawn of the features, in proportion to
 * them) are not held under it.
 */

/**
 * The most bytes a draw instance holds outside the rows: what a phone can spare
 *
 * @internal
 */
export const DEFAULT_GPU_LIMIT_BYTES = 64_000_000;

/**
 * The parts of the drawing that hold what is drawn of the features, in proportion to them: the
 * rows. The rest (the work of the drape, the atlas of the elevations, the images, the shapes of
 * the points drawn one by one) is held outside the rows, whatever the number of the features
 */
const ROW_PARTS: ReadonlySet<string> = new Set([
  'polygons',
  'lines',
  'points',
  'fills',
  'strokes',
  'outlines',
]);

/** A GL object, as the ledger keys it */
type GpuObject = object;

/**
 * What an allocation is: a buffer, a texture, a render buffer (counted with the textures: it holds
 * the texels of a target as a texture does), or an object that holds no bytes of its own, recorded
 * under its part so that it is given back as well
 */
export type GpuObjectKind =
  | 'buffer'
  | 'texture'
  | 'renderbuffer'
  | 'framebuffer'
  | 'vertex-array'
  | 'transform-feedback'
  | 'program';

/** One allocation */
interface Entry {
  readonly holder: string;
  readonly kind: GpuObjectKind;
  readonly bytes: number;
  /** Whether it holds rows */
  readonly rows: boolean;
}

/**
 * What the drawing holds on the GPU
 */
export interface GpuMemorySnapshot {
  /** The bytes of every buffer, texture and render buffer */
  readonly bytes: number;
  /** The bytes of the buffers */
  readonly bufferBytes: number;
  /** The bytes of the textures (and of the render buffers) */
  readonly textureBytes: number;
  /** The bytes of what is drawn of the features, in proportion to them */
  readonly rowBytes: number;
  /** The bytes held outside the rows, which the limit holds */
  readonly outsideRowBytes: number;
  /** The GL objects recorded, those without bytes of their own too */
  readonly objects: number;
  /** The GL objects recorded, per kind */
  readonly objectsByKind: Readonly<Partial<Record<GpuObjectKind, number>>>;
  /** The bytes per part of the drawing */
  readonly byPart: Readonly<Record<string, number>>;
  /** The most bytes held at once since the ledger was made */
  readonly peakBytes: number;
  /**
   * The bytes the parts left behind when the GPU side went: 0 unless a part forgot something,
   * which was then deleted
   */
  readonly leakedBytes: number;
  /** The GL objects the parts left behind, those without bytes of their own too */
  readonly leakedObjects: number;
  /** The allocations recorded since the ledger was made (a new size of an object is one) */
  readonly allocations: number;
}

/**
 * A ledger and the part that records its allocations in it
 *
 * @internal
 */
export interface GpuLedgerPart {
  readonly ledger: GpuLedger;
  readonly part: string;
}

/**
 * The ledger of the GPU memory of one draw instance
 *
 * Not exported from any entry of the package: the renderers that take it are not either.
 */
export class GpuLedger {
  private readonly entries = new Map<GpuObject, Entry>();
  private bufferBytes = 0;
  private textureBytes = 0;
  private rowBytes = 0;
  private readonly parts = new Map<string, number>();
  private peakBytes = 0;
  private allocations = 0;
  private leakedBytes = 0;
  private leakedObjects = 0;

  /**
   * The most bytes the instance holds outside the rows
   *
   * The application gives no value for it: it is the default. The tests lower it to see what the
   * parts do at the limit.
   */
  limitBytes = DEFAULT_GPU_LIMIT_BYTES;

  /**
   * Records a GL object with its size (a later record of the same object replaces the earlier one,
   * as `bufferData` replaces the storage of a buffer)
   *
   * An object is recorded when it is made (with no bytes), and again when it is given its
   * storage, so that one made by a build that fails before its storage is given back as well.
   *
   * @param holder - The part of the drawing that holds it
   * @param rows - Whether it holds rows (the parts of the rows tell it when it is left out)
   */
  record(
    object: GpuObject | null,
    holder: string,
    kind: GpuObjectKind,
    bytes = 0,
    rows = ROW_PARTS.has(holder),
  ): void {
    if (!object) return;
    if (!holder) throw new Error('A GPU allocation is recorded under the name of its part');
    this.release(object);
    const entry: Entry = { holder, kind, bytes: Math.max(0, bytes), rows };
    this.entries.set(object, entry);
    this.add(entry, 1);
    if (entry.bytes > 0) this.allocations++;
    this.peakBytes = Math.max(this.peakBytes, this.bufferBytes + this.textureBytes);
  }

  /** Takes a deleted GL object out */
  release(object: GpuObject | null): void {
    if (!object) return;
    const entry = this.entries.get(object);
    if (!entry) return;
    this.entries.delete(object);
    this.add(entry, -1);
  }

  /**
   * Moves everything recorded here to another ledger, under the same parts (a part made before
   * it was given the ledger of its instance)
   */
  moveTo(target: GpuLedger): void {
    if (target === this) return;
    for (const [object, entry] of [...this.entries]) {
      this.release(object);
      target.record(object, entry.holder, entry.kind, entry.bytes, entry.rows);
    }
  }

  /** Whether an object is recorded */
  holds(object: GpuObject | null): boolean {
    return object !== null && this.entries.has(object);
  }

  /**
   * Whether the sums agree with what is recorded: every object counted once, under its part
   */
  audit(): boolean {
    let buffers = 0;
    let textures = 0;
    let rows = 0;
    const parts = new Map<string, number>();
    for (const entry of this.entries.values()) {
      if (entry.kind === 'buffer') buffers += entry.bytes;
      else textures += entry.bytes;
      if (entry.rows) rows += entry.bytes;
      parts.set(entry.holder, (parts.get(entry.holder) ?? 0) + entry.bytes);
    }
    if (buffers !== this.bufferBytes || textures !== this.textureBytes) return false;
    if (rows !== this.rowBytes) return false;
    for (const [part, bytes] of this.parts) {
      if ((parts.get(part) ?? 0) !== bytes) return false;
    }
    for (const [part, bytes] of parts) {
      if ((this.parts.get(part) ?? 0) !== bytes) return false;
    }
    return true;
  }

  /**
   * Deletes what is still recorded, when nothing should be: what a part forgot when the GPU side
   * of the instance goes. It is counted (`leakedBytes`, `leakedObjects`).
   *
   * @returns the parts that left something, with their bytes (empty when nothing was left)
   */
  drain(gl: WebGL2RenderingContext): Record<string, number> {
    const left: Record<string, number> = {};
    for (const [object, entry] of [...this.entries]) {
      left[entry.holder] = (left[entry.holder] ?? 0) + entry.bytes;
      this.leakedBytes += entry.bytes;
      this.leakedObjects++;
      deleteObject(gl, object, entry.kind);
      this.release(object);
    }
    return left;
  }

  /**
   * Runs a build of GPU resources: when it throws, what it recorded is deleted, so that a part
   * made halfway does not stay
   */
  scope<T>(gl: WebGL2RenderingContext, build: () => T): T {
    const before = new Set(this.entries.keys());
    try {
      return build();
    } catch (error) {
      for (const [object, entry] of [...this.entries]) {
        if (before.has(object)) continue;
        deleteObject(gl, object, entry.kind);
        this.release(object);
      }
      throw error;
    }
  }

  /** Whether more may be held outside the rows, by what everything holds */
  fits(bytes: number): boolean {
    return this.outsideRowBytes + bytes <= this.limitBytes;
  }

  /** The bytes that may be held more outside the rows */
  get roomBytes(): number {
    return Math.max(0, this.limitBytes - this.outsideRowBytes);
  }

  /** The bytes of the rows, out of the limit */
  get rowBytesHeld(): number {
    return this.rowBytes;
  }

  /** The bytes held outside the rows, which the limit holds */
  get outsideRowBytes(): number {
    return this.bufferBytes + this.textureBytes - this.rowBytes;
  }

  /** What is held now */
  snapshot(): GpuMemorySnapshot {
    const byPart: Record<string, number> = {};
    for (const [part, bytes] of this.parts) {
      if (bytes !== 0) byPart[part] = bytes;
    }
    const objectsByKind: Partial<Record<GpuObjectKind, number>> = {};
    for (const entry of this.entries.values()) {
      objectsByKind[entry.kind] = (objectsByKind[entry.kind] ?? 0) + 1;
    }
    return Object.freeze({
      bytes: this.bufferBytes + this.textureBytes,
      bufferBytes: this.bufferBytes,
      textureBytes: this.textureBytes,
      rowBytes: this.rowBytes,
      outsideRowBytes: this.outsideRowBytes,
      objects: this.entries.size,
      objectsByKind: Object.freeze(objectsByKind),
      byPart: Object.freeze(byPart),
      peakBytes: this.peakBytes,
      leakedBytes: this.leakedBytes,
      leakedObjects: this.leakedObjects,
      allocations: this.allocations,
    });
  }

  private add(entry: Entry, sign: 1 | -1): void {
    const bytes = sign * entry.bytes;
    if (entry.kind === 'buffer') this.bufferBytes += bytes;
    else this.textureBytes += bytes;
    if (entry.rows) this.rowBytes += bytes;
    this.parts.set(entry.holder, (this.parts.get(entry.holder) ?? 0) + bytes);
  }
}

/**
 * Gives a texture made and bound its storage: a failure leaves no texture behind
 *
 * @internal
 */
export function giveStorage(
  gl: WebGL2RenderingContext,
  ledger: GpuLedger,
  texture: WebGLTexture,
  store: () => void,
): void {
  try {
    store();
  } catch (error) {
    ledger.release(texture);
    gl.deleteTexture(texture);
    throw error;
  }
}

/** The call that deletes each kind of object */
const DELETE: Readonly<
  Record<GpuObjectKind, (gl: WebGL2RenderingContext, object: GpuObject) => void>
> = {
  buffer: (gl, object) => gl.deleteBuffer(object as WebGLBuffer),
  texture: (gl, object) => gl.deleteTexture(object as WebGLTexture),
  renderbuffer: (gl, object) => gl.deleteRenderbuffer(object as WebGLRenderbuffer),
  framebuffer: (gl, object) => gl.deleteFramebuffer(object as WebGLFramebuffer),
  'vertex-array': (gl, object) => gl.deleteVertexArray(object as WebGLVertexArrayObject),
  'transform-feedback': (gl, object) =>
    gl.deleteTransformFeedback(object as WebGLTransformFeedback),
  program: (gl, object) => gl.deleteProgram(object as WebGLProgram),
};

/**
 * Deletes a GL object
 *
 * @internal
 */
export function deleteObject(
  gl: WebGL2RenderingContext,
  object: GpuObject,
  kind: GpuObjectKind,
): void {
  DELETE[kind](gl, object);
}

/**
 * Deletes a GL object recorded in a ledger and takes it out (nothing for a missing object)
 *
 * @internal
 */
export function deleteRecorded(
  gl: WebGL2RenderingContext,
  ledger: GpuLedger,
  object: GpuObject | null,
  kind: GpuObjectKind,
): void {
  if (!object) return;
  ledger.release(object);
  deleteObject(gl, object, kind);
}

/**
 * The bytes of a texture of a size and a number of bytes per texel
 *
 * @internal
 */
export function textureBytes(width: number, height: number, bytesPerTexel: number): number {
  return Math.max(0, width) * Math.max(0, height) * bytesPerTexel;
}

/**
 * The bytes of a texture of a size with the whole chain of its mipmaps (`generateMipmap`): each
 * level half the size of the one before, rounded down and at least 1, down to 1 x 1
 *
 * @internal
 */
export function mipmappedTextureBytes(
  width: number,
  height: number,
  bytesPerTexel: number,
): number {
  let w = Math.max(0, Math.floor(width));
  let h = Math.max(0, Math.floor(height));
  if (w === 0 || h === 0) return 0;
  let bytes = 0;
  for (;;) {
    bytes += w * h * bytesPerTexel;
    if (w === 1 && h === 1) return bytes;
    w = Math.max(1, w >> 1);
    h = Math.max(1, h >> 1);
  }
}
