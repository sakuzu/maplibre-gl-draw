// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The ledger of the GPU memory the drawing allocates (`GpuLedger`)
 *
 * WebGL does not tell how much GPU memory a page uses. The renderers of core record here the
 * size of every buffer, texture and render buffer they allocate (`bufferData`, `texStorage2D`,
 * `texImage2D`, `renderbufferStorage`) and take it out when they delete it, so the drawing can
 * tell what it holds, per renderer. Nothing core allocates on the GPU is left out of it
 * (`gpu-ledger-coverage.test.ts` counts the allocations of a GL and compares them with it).
 *
 * It is a lower bound of what the page uses: what maplibre allocates (the tiles of the base
 * map, the elevation data) is not in it, nor what an extension allocates with the context it
 * does not record (`ExtensionContext.gpu`), nor what the driver keeps after a delete until it
 * frees it: these are numbers kept in JavaScript, which say what was asked and given back, not
 * when the driver gave the memory back.
 *
 * An allocation has an owner, and the ledger belongs to one draw instance: `record` takes no
 * object without an owner. What a part fails to give back is found when the instance is destroyed
 * (`drain`): it is deleted there and counted (`leakedBytes`), and a build that fails gives back
 * what it had made (`scope`).
 */

/**
 * The most bytes a draw instance holds outside the rows, when the application gives no value: what
 * a phone can spare (`RenderingOptions.gpuLimitBytes`)
 */
export const DEFAULT_GPU_LIMIT_BYTES = 64_000_000;

/**
 * The owners of core that hold what is drawn of the features of the document, in proportion to
 * them: the rows. The rest (the work of the drape, the atlas of the elevations, the images, the
 * buffers of what is drawn at once) is held outside the rows, whatever the size of the document
 */
const ROW_OWNERS: ReadonlySet<string> = new Set([
  'rows',
  'row-state',
  'polygons',
  'lines',
  'points',
  'fills',
  'strokes',
  'outlines',
]);

/** What the ledgers of the page found left behind so far, for `leakedBytes` */
const leaked = { bytes: 0, objects: 0 };

/** A buffer or a texture, as the ledger keys it */
type GpuObject = object;

/**
 * What an allocation is: a buffer, a texture, or a render buffer (counted with the textures: it
 * holds the texels of a target as a texture does)
 */
export type GpuObjectKind = 'buffer' | 'texture' | 'renderbuffer';

/** One allocation */
interface Entry {
  readonly owner: string;
  readonly kind: GpuObjectKind;
  readonly bytes: number;
  /** Whether it holds rows */
  readonly rows: boolean;
}

/**
 * What the drawing holds on the GPU
 */
export interface GpuMemorySnapshot {
  /** The bytes of every buffer and texture */
  readonly bytes: number;
  /** The bytes of the buffers */
  readonly bufferBytes: number;
  /** The bytes of the textures (and of the render buffers) */
  readonly textureBytes: number;
  /** The bytes of what is drawn of the features of the document, in proportion to them */
  readonly rowBytes: number;
  /** The bytes per renderer */
  readonly byOwner: Readonly<Record<string, number>>;
  /** The most bytes held at once since the ledger was made */
  readonly peakBytes: number;
  /**
   * The bytes the instances of the page left behind when they were destroyed: 0 unless a part
   * forgot something, which was then deleted
   */
  readonly leakedBytes: number;
  /** The allocations recorded since the ledger was made (a new size of an object is one) */
  readonly allocations: number;
}

/**
 * A ledger and the owner a part records its allocations under in it
 *
 * @internal
 */
export interface GpuLedgerOwner {
  readonly ledger: GpuLedger;
  readonly owner: string;
}

/**
 * The ledger of the GPU memory of one draw instance
 *
 * @internal
 */
export class GpuLedger {
  private readonly entries = new Map<GpuObject, Entry>();
  private bufferBytes = 0;
  private textureBytes = 0;
  private rowBytes = 0;
  private readonly owners = new Map<string, number>();
  private peakBytes = 0;
  private allocations = 0;

  /**
   * Records the size of a buffer, a texture or a render buffer (a later record of the same object
   * replaces the earlier one, as `bufferData` replaces the storage of a buffer)
   *
   * @param rows - Whether it holds rows (the owners of core tell it when it is left out)
   */
  record(
    object: GpuObject | null,
    owner: string,
    kind: GpuObjectKind,
    bytes: number,
    rows = ROW_OWNERS.has(owner),
  ): void {
    if (!object) return;
    if (!owner) throw new Error('A GPU allocation is recorded under the name of its owner');
    this.release(object);
    const entry: Entry = { owner, kind, bytes: Math.max(0, bytes), rows };
    this.entries.set(object, entry);
    this.add(entry, 1);
    this.allocations++;
    this.peakBytes = Math.max(this.peakBytes, this.bufferBytes + this.textureBytes);
  }

  /** Takes a deleted buffer, texture or render buffer out */
  release(object: GpuObject | null): void {
    if (!object) return;
    const entry = this.entries.get(object);
    if (!entry) return;
    this.entries.delete(object);
    this.add(entry, -1);
  }

  /**
   * Whether the sums agree with what is recorded: every object counted once, under its owner
   */
  audit(): boolean {
    let buffers = 0;
    let textures = 0;
    let rows = 0;
    const owners = new Map<string, number>();
    for (const entry of this.entries.values()) {
      if (entry.kind === 'buffer') buffers += entry.bytes;
      else textures += entry.bytes;
      if (entry.rows) rows += entry.bytes;
      owners.set(entry.owner, (owners.get(entry.owner) ?? 0) + entry.bytes);
    }
    if (buffers !== this.bufferBytes || textures !== this.textureBytes) return false;
    if (rows !== this.rowBytes) return false;
    for (const [owner, bytes] of this.owners) {
      if ((owners.get(owner) ?? 0) !== bytes) return false;
    }
    return true;
  }

  /**
   * Deletes what is still recorded, when nothing should be: what a part forgot when the instance
   * is destroyed. It is counted for `leakedBytes`.
   *
   * @returns the owners that left something, with their bytes (empty when nothing was left)
   */
  drain(gl: WebGL2RenderingContext): Record<string, number> {
    const left: Record<string, number> = {};
    for (const [object, entry] of [...this.entries]) {
      left[entry.owner] = (left[entry.owner] ?? 0) + entry.bytes;
      leaked.bytes += entry.bytes;
      leaked.objects++;
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

  /** The bytes held outside the rows, which the limit of the instance holds */
  get outsideRowBytes(): number {
    return this.bufferBytes + this.textureBytes - this.rowBytes;
  }

  /** What is held now */
  snapshot(): GpuMemorySnapshot {
    const byOwner: Record<string, number> = {};
    for (const [owner, bytes] of this.owners) {
      if (bytes !== 0) byOwner[owner] = bytes;
    }
    return Object.freeze({
      bytes: this.bufferBytes + this.textureBytes,
      bufferBytes: this.bufferBytes,
      textureBytes: this.textureBytes,
      rowBytes: this.rowBytes,
      byOwner: Object.freeze(byOwner),
      peakBytes: this.peakBytes,
      leakedBytes: leaked.bytes,
      allocations: this.allocations,
    });
  }

  private add(entry: Entry, sign: 1 | -1): void {
    const bytes = sign * entry.bytes;
    if (entry.kind === 'buffer') this.bufferBytes += bytes;
    else this.textureBytes += bytes;
    if (entry.rows) this.rowBytes += bytes;
    this.owners.set(entry.owner, (this.owners.get(entry.owner) ?? 0) + bytes);
  }
}

/**
 * Gives a texture made and bound its storage: a failure leaves no texture behind
 *
 * @internal
 */
export function giveStorage(
  gl: WebGL2RenderingContext,
  texture: WebGLTexture,
  store: () => void,
): void {
  try {
    store();
  } catch (error) {
    gl.deleteTexture(texture);
    throw error;
  }
}

/** Deletes a buffer, a texture or a render buffer */
function deleteObject(gl: WebGL2RenderingContext, object: GpuObject, kind: GpuObjectKind): void {
  if (kind === 'buffer') gl.deleteBuffer(object as WebGLBuffer);
  else if (kind === 'texture') gl.deleteTexture(object as WebGLTexture);
  else gl.deleteRenderbuffer(object as WebGLRenderbuffer);
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
