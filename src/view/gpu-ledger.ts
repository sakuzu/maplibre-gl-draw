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
 * is given, nor what the driver keeps after a delete until it frees it.
 */

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
  /** The bytes per renderer */
  readonly byOwner: Readonly<Record<string, number>>;
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
  private readonly owners = new Map<string, number>();

  /**
   * Records the size of a buffer, a texture or a render buffer (a later record of the same object
   * replaces the earlier one, as `bufferData` replaces the storage of a buffer)
   */
  record(object: GpuObject | null, owner: string, kind: GpuObjectKind, bytes: number): void {
    if (!object) return;
    this.release(object);
    const entry: Entry = { owner, kind, bytes: Math.max(0, bytes) };
    this.entries.set(object, entry);
    this.add(entry, 1);
  }

  /** Takes a deleted buffer, texture or render buffer out */
  release(object: GpuObject | null): void {
    if (!object) return;
    const entry = this.entries.get(object);
    if (!entry) return;
    this.entries.delete(object);
    this.add(entry, -1);
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
      byOwner: Object.freeze(byOwner),
    });
  }

  private add(entry: Entry, sign: 1 | -1): void {
    const bytes = sign * entry.bytes;
    if (entry.kind === 'buffer') this.bufferBytes += bytes;
    else this.textureBytes += bytes;
    this.owners.set(entry.owner, (this.owners.get(entry.owner) ?? 0) + bytes);
  }
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
