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
 * The bytes held outside the rows (what does not grow with the features) are held under a limit
 * (`limitBytes`), in two shares. The parts that are always held (the atlas of the elevations, the
 * shapes of the points drawn one by one, the quads and the grids of the images: without them the
 * features do not follow the ground, or are not drawn) each hold at most a ceiling of bytes of
 * their own, what their build allocates at most. The sum of the ceilings is the floor of the
 * limit. What the limit leaves over the floor is the share of the parts that give way (the
 * textures of the images, the work of the drape): they ask first (`fits`), against what they hold
 * together and their share, and give something up or draw without it. So the bytes held outside
 * the rows never go over the limit, and a part that is always held never has to push another
 * out. The rows (what is drawn of the features, in proportion to them) are not held under it.
 */

import { deepFreeze } from '../shared/utils/deep-freeze.js';
import { QUAD_GRID_MAX_CELLS, QUAD_GRID_MAX_DIVISIONS } from './shaders/quad-grid.js';

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
  'rows',
  'rowState',
  'frames',
]);

/**
 * The most bytes the atlas of the elevations holds: its largest texture (2048 x 2048 texels of
 * RGBA8, the most `computeAtlasLayout` lays out; the texture of another size is deleted before it
 * is made) and the buffer of its quad (4 corners of 2 floats)
 */
const DEM_ATLAS_CEILING_BYTES = 2048 * 2048 * 4 + 4 * 2 * 4;

/**
 * The most bytes the shapes of the points drawn one by one hold: the shapes kept for the next
 * frames and the one drawn once without being kept
 */
const POINT_SHAPES_CEILING_BYTES = 2_000_000;

/**
 * The most vertices a grid of an image has: a grid of nx x ny cells has (nx + 1) x (ny + 1)
 * vertices, nx x ny at most `QUAD_GRID_MAX_CELLS` and nx + ny at most twice
 * `QUAD_GRID_MAX_DIVISIONS`
 */
const IMAGE_GRID_MAX_VERTICES = QUAD_GRID_MAX_CELLS + 2 * QUAD_GRID_MAX_DIVISIONS + 1;

/**
 * The most bytes the quads and the grids of the images hold: the four corners and their texture
 * coordinates (4 corners of 2 floats each), and the largest grid (its vertices of 2 floats, their
 * texture coordinates of 2 floats and 6 indices of 2 bytes per cell)
 */
const IMAGE_QUADS_CEILING_BYTES =
  2 * (4 * 2 * 4) + IMAGE_GRID_MAX_VERTICES * 2 * 4 * 2 + QUAD_GRID_MAX_CELLS * 6 * 2;

/**
 * The parts held outside the rows that are always held, with the most bytes each holds (its
 * ceiling): without them the features do not follow the ground, or are not drawn. A part does
 * not allocate past its ceiling, and the sum of the ceilings (the floor) is kept out of the share
 * of the parts that give way, so they never have to push one another out
 *
 * @internal
 */
export const HELD_PART_CEILINGS: ReadonlyMap<string, number> = new Map([
  ['demAtlas', DEM_ATLAS_CEILING_BYTES],
  ['pointShapes', POINT_SHAPES_CEILING_BYTES],
  ['imageQuads', IMAGE_QUADS_CEILING_BYTES],
]);

/**
 * The parts held outside the rows that give way: each has a way to draw without what does not fit
 * in the share of the limit over the floor, and asks first (`fits`)
 */
const YIELDING_PARTS: ReadonlySet<string> = new Set(['images', 'drape']);

/**
 * The sum of the ceilings of the parts that are always held: the least the limit can be
 *
 * @internal
 */
export const GPU_FLOOR_BYTES = [...HELD_PART_CEILINGS.values()].reduce((sum, b) => sum + b, 0);

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

/** Where the bytes of a part are held: in the rows, always held outside them, or giving way */
type PartGroup = 'rows' | 'held' | 'yielding';

/** The group of a part, or null for a name that is not a part of the drawing */
function groupOf(part: string): PartGroup | null {
  if (ROW_PARTS.has(part)) return 'rows';
  if (HELD_PART_CEILINGS.has(part)) return 'held';
  if (YIELDING_PARTS.has(part)) return 'yielding';
  return null;
}

/** One allocation */
interface Entry {
  readonly holder: string;
  readonly kind: GpuObjectKind;
  readonly bytes: number;
  readonly group: PartGroup;
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
  /** The bytes of the parts that give way, which their share holds */
  private yieldingBytes = 0;
  private readonly parts = new Map<string, number>();
  private peakBytes = 0;
  private allocations = 0;
  private leakedBytes = 0;
  private leakedObjects = 0;

  private limit: number;

  /**
   * @param limitBytes - The most bytes the instance holds outside the rows. The application gives
   *   no value for it: it is the default. The tests lower it to see what the parts do at the limit
   * @throws when it is less than the floor (`GPU_FLOOR_BYTES`): the parts that are always held
   *   would not fit
   */
  constructor(limitBytes = DEFAULT_GPU_LIMIT_BYTES) {
    this.limit = checkedLimit(limitBytes);
  }

  /**
   * The most bytes the instance holds outside the rows (never less than the floor: a lower value
   * throws)
   */
  get limitBytes(): number {
    return this.limit;
  }

  set limitBytes(bytes: number) {
    this.limit = checkedLimit(bytes);
  }

  /** The sum of the ceilings of the parts that are always held */
  get floorBytes(): number {
    return GPU_FLOOR_BYTES;
  }

  /** What the limit leaves over the floor: the share of the parts that give way */
  get shareBytes(): number {
    return this.limit - GPU_FLOOR_BYTES;
  }

  /** The most bytes a part that is always held holds, or undefined for another part */
  ceilingOf(part: string): number | undefined {
    return HELD_PART_CEILINGS.get(part);
  }

  /** The part an object is recorded under, or undefined when it is not recorded */
  partOf(object: GpuObject | null): string | undefined {
    return object ? this.entries.get(object)?.holder : undefined;
  }

  /**
   * Records a GL object with its size (a later record of the same object replaces the earlier one,
   * as `bufferData` replaces the storage of a buffer)
   *
   * An object is recorded when it is made (with no bytes), and again when it is given its
   * storage, so that one made by a build that fails before its storage is given back as well.
   *
   * @param holder - The part of the drawing that holds it: a part of the rows, a part that is
   *   always held or a part that gives way (another name throws)
   */
  record(object: GpuObject | null, holder: string, kind: GpuObjectKind, bytes = 0): void {
    if (!object) return;
    if (!holder) throw new Error('A GPU allocation is recorded under the name of its part');
    const group = groupOf(holder);
    if (!group) throw new Error(`A GPU allocation is recorded under an unknown part: ${holder}`);
    this.release(object);
    const entry: Entry = { holder, kind, bytes: Math.max(0, bytes), group };
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
      target.record(object, entry.holder, entry.kind, entry.bytes);
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
    let yielding = 0;
    const parts = new Map<string, number>();
    for (const entry of this.entries.values()) {
      if (entry.kind === 'buffer') buffers += entry.bytes;
      else textures += entry.bytes;
      if (entry.group === 'rows') rows += entry.bytes;
      if (entry.group === 'yielding') yielding += entry.bytes;
      parts.set(entry.holder, (parts.get(entry.holder) ?? 0) + entry.bytes);
    }
    if (buffers !== this.bufferBytes || textures !== this.textureBytes) return false;
    if (rows !== this.rowBytes || yielding !== this.yieldingBytes) return false;
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

  /**
   * Whether a part that gives way may hold more: what the parts that give way hold together, with
   * it, within their share (what the parts that are always held hold now is not looked at)
   */
  fits(bytes: number): boolean {
    return this.yieldingBytes + bytes <= this.shareBytes;
  }

  /** The bytes the parts that give way may hold more, in their share */
  get roomBytes(): number {
    return Math.max(0, this.shareBytes - this.yieldingBytes);
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
    if (entry.group === 'rows') this.rowBytes += bytes;
    if (entry.group === 'yielding') this.yieldingBytes += bytes;
    this.parts.set(entry.holder, (this.parts.get(entry.holder) ?? 0) + bytes);
  }
}

/** A limit of a ledger: never less than the floor */
function checkedLimit(bytes: number): number {
  if (!(bytes >= GPU_FLOOR_BYTES)) {
    throw new Error(
      `The GPU limit of ${bytes} bytes is less than the ${GPU_FLOOR_BYTES} bytes the parts that are always held may hold`,
    );
  }
  return bytes;
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
> = deepFreeze({
  buffer: (gl, object) => gl.deleteBuffer(object as WebGLBuffer),
  texture: (gl, object) => gl.deleteTexture(object as WebGLTexture),
  renderbuffer: (gl, object) => gl.deleteRenderbuffer(object as WebGLRenderbuffer),
  framebuffer: (gl, object) => gl.deleteFramebuffer(object as WebGLFramebuffer),
  'vertex-array': (gl, object) => gl.deleteVertexArray(object as WebGLVertexArrayObject),
  'transform-feedback': (gl, object) =>
    gl.deleteTransformFeedback(object as WebGLTransformFeedback),
  program: (gl, object) => gl.deleteProgram(object as WebGLProgram),
});

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
