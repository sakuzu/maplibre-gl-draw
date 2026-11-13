// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The GPU resources of a part: what makes the `Gpu` of the extension contract
 *
 * A part allocates here, so nothing it holds can miss the ledger of the instance: every object is
 * recorded under the owner the part was opened with, checked against the limit before it is made,
 * and deleted when the part ends, whichever way it ends (removed, destroyed, an error in the middle
 * of a build, a lost context). A call after the end makes nothing, which is what keeps a result
 * that arrives late from leaving anything behind.
 */

import type { Gpu, GpuContext, ProgramCompile } from '../api/extension/webgl.js';
import type { MemoryUsage } from '../api/memory.js';
import { DrawError, limitError } from '../shared/draw-error.js';
import { deleteObject, type GpuLedger, type GpuObjectKind } from './gpu-ledger.js';
import { createProgram, ProgramLink } from './shaders/helpers.js';

/** The bytes of a texel of the sized formats, by the name of the format */
const TEXEL_BYTES: Readonly<Record<string, number>> = {
  R8: 1,
  R8UI: 1,
  R8I: 1,
  R8_SNORM: 1,
  RG8: 2,
  RG8UI: 2,
  RG8I: 2,
  RG8_SNORM: 2,
  R16F: 2,
  R16UI: 2,
  R16I: 2,
  RGB565: 2,
  RGBA4: 2,
  RGB5_A1: 2,
  RGB8: 3,
  SRGB8: 3,
  RGBA8: 4,
  SRGB8_ALPHA8: 4,
  RGBA8UI: 4,
  RGBA8I: 4,
  RGBA8_SNORM: 4,
  RGB10_A2: 4,
  RG16F: 4,
  RG16UI: 4,
  RG16I: 4,
  R32F: 4,
  R32UI: 4,
  R32I: 4,
  R11F_G11F_B10F: 4,
  RGB9_E5: 4,
  RGB16F: 6,
  RGBA16F: 8,
  RGBA16UI: 8,
  RGBA16I: 8,
  RG32F: 8,
  RG32UI: 8,
  RG32I: 8,
  RGB32F: 12,
  RGBA32F: 16,
  RGBA32UI: 16,
  RGBA32I: 16,
};

/** The bytes of a texel of each format of a context */
const texelBytesOf = new WeakMap<object, Map<number, number>>();

function texelBytes(gl: WebGL2RenderingContext, format: number): number | undefined {
  let bytes = texelBytesOf.get(gl);
  if (!bytes) {
    bytes = new Map();
    const constants = gl as unknown as Record<string, number>;
    for (const name of Object.keys(TEXEL_BYTES)) bytes.set(constants[name], TEXEL_BYTES[name]);
    texelBytesOf.set(gl, bytes);
  }
  return bytes.get(format);
}

/**
 * The bytes of a texture and its levels: each level half the size of the one before, rounded down
 * and at least 1
 */
function levelsBytes(width: number, height: number, levels: number, perTexel: number): number {
  let bytes = 0;
  let w = width;
  let h = height;
  for (let level = 0; level < levels; level++) {
    bytes += w * h * perTexel;
    w = Math.max(1, w >> 1);
    h = Math.max(1, h >> 1);
  }
  return bytes;
}

/**
 * What resources are opened with
 *
 * @internal
 */
export interface GpuResourcesOptions {
  readonly gl: WebGL2RenderingContext;
  readonly ledger: GpuLedger;
  /** The name the resources are recorded under */
  readonly owner: string;
  /**
   * The part of the limit of the instance they may hold (absent for a part of the library, which
   * only the limit of the instance holds)
   */
  readonly share?: number;
  /** Rows: they are out of the limit of the instance, and held under this one */
  readonly rowLimitBytes?: () => number;
  /** The limit of the rows its `rows` allocate (no limit when it is left out) */
  readonly rowsLimitBytes?: () => number;
}

/** The resources of a part */
export class GpuResources implements Gpu {
  readonly gl: GpuContext;
  readonly #gl: WebGL2RenderingContext;
  readonly #ledger: GpuLedger;
  readonly #owner: string;
  readonly #share: number | undefined;
  readonly #rowLimitBytes: (() => number) | undefined;
  readonly #rowsLimitBytes: () => number;
  #rows: GpuResources | null = null;
  readonly #stop = new AbortController();
  readonly #objects = new Map<object, { kind: GpuObjectKind; bytes: number }>();
  readonly #compiles = new Set<LinkedProgram>();
  readonly #children = new Set<GpuResources>();
  #heldBytes = 0;
  #peakBytes = 0;
  #allocations = 0;
  #closed = false;

  constructor(options: GpuResourcesOptions) {
    this.gl = options.gl;
    this.#gl = options.gl;
    this.#ledger = options.ledger;
    this.#owner = options.owner;
    this.#share = options.share;
    this.#rowLimitBytes = options.rowLimitBytes;
    this.#rowsLimitBytes = options.rowsLimitBytes ?? (() => Number.POSITIVE_INFINITY);
  }

  get rows(): GpuResources {
    if (this.#rowLimitBytes) return this;
    this.#rows ??= this.openRows(this.#rowsLimitBytes);
    return this.#rows;
  }

  get signal(): AbortSignal {
    return this.#stop.signal;
  }

  /** The name the resources are recorded under */
  get owner(): string {
    return this.#owner;
  }

  /** Whether the resources are gone */
  get closed(): boolean {
    return this.#closed;
  }

  /**
   * Opens resources that end with these ones at the latest and are rows: they are out of the share,
   * and held under the limit given
   */
  openRows(rowLimitBytes: () => number): GpuResources {
    this.#open();
    const rows = new GpuResources({
      gl: this.#gl,
      ledger: this.#ledger,
      owner: this.#owner,
      rowLimitBytes,
    });
    this.#children.add(rows);
    rows.signal.addEventListener('abort', () => this.#children.delete(rows), { once: true });
    return rows;
  }

  buffer(
    data: ArrayBufferView | number,
    options?: { readonly target?: number; readonly usage?: number },
  ): WebGLBuffer {
    const gl = this.#gl;
    this.#open();
    const size = typeof data === 'number';
    const bytes = size ? data : data.byteLength;
    if (!Number.isFinite(bytes) || bytes < 0) {
      throw new DrawError('invalidInput', 'The size of a buffer is a number of bytes');
    }
    this.#reserve(bytes);
    const target = options?.target ?? gl.ARRAY_BUFFER;
    const buffer = this.#made(gl.createBuffer());
    try {
      gl.bindBuffer(target, buffer);
      const usage = options?.usage ?? (size ? gl.DYNAMIC_DRAW : gl.STATIC_DRAW);
      gl.bufferData(target, data as ArrayBufferView, usage);
    } catch (error) {
      gl.deleteBuffer(buffer);
      throw error;
    }
    this.#keep(buffer, 'buffer', bytes);
    return buffer;
  }

  texture(width: number, height: number, format: number, levels = 1): WebGLTexture {
    const gl = this.#gl;
    this.#open();
    const perTexel = texelBytes(gl, format);
    if (perTexel === undefined) {
      throw new DrawError('invalidInput', `${format} is not a sized format of a texture`);
    }
    const bytes = levelsBytes(width, height, levels, perTexel);
    this.#reserve(bytes);
    const texture = this.#made(gl.createTexture());
    try {
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texStorage2D(gl.TEXTURE_2D, levels, format, width, height);
    } catch (error) {
      gl.deleteTexture(texture);
      throw error;
    }
    this.#keep(texture, 'texture', bytes);
    return texture;
  }

  vertexArray(): WebGLVertexArrayObject {
    this.#open();
    const array = this.#made(this.#gl.createVertexArray());
    this.#keep(array, 'vertex-array', 0);
    return array;
  }

  transformFeedback(): WebGLTransformFeedback {
    this.#open();
    const feedback = this.#made(this.#gl.createTransformFeedback());
    this.#keep(feedback, 'transform-feedback', 0);
    return feedback;
  }

  fence(): WebGLSync {
    const gl = this.#gl;
    this.#open();
    const sync = this.#made(gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0));
    this.#keep(sync, 'sync', 0);
    return sync;
  }

  program(vertex: string, fragment: string): WebGLProgram {
    this.#open();
    let program: WebGLProgram;
    try {
      program = createProgram(this.#gl, vertex, fragment);
    } catch (error) {
      throw new DrawError('invalidInput', (error as Error).message);
    }
    this.#keep(program, 'program', 0);
    return program;
  }

  compile(
    vertex: string,
    fragment: string,
    options?: { readonly varyings?: readonly string[] },
  ): ProgramCompile {
    this.#open();
    const link = new ProgramLink(this.#gl, vertex, fragment, options?.varyings);
    const compile = new LinkedProgram(link, (program) => {
      this.#compiles.delete(compile);
      if (program) this.#keep(program, 'program', 0);
    });
    this.#compiles.add(compile);
    return compile;
  }

  release(resource: object | null): void {
    if (!resource) return;
    const entry = this.#objects.get(resource);
    if (!entry) return;
    this.#forget(resource, entry.bytes);
    deleteObject(this.#gl, resource, entry.kind);
  }

  memory(): MemoryUsage {
    const held = this.#heldBytes;
    return {
      jsBytes: 0,
      gpuBytes: held,
      bytes: held,
      limitBytes: this.#limitBytes(),
      peakGpuBytes: this.#peakBytes,
      gpuAllocations: this.#allocations,
    };
  }

  /**
   * The resources are gone: `signal` stops, and everything made is deleted (a no-op on a lost
   * context) and taken out of the ledger
   */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#stop.abort();
    for (const child of [...this.#children]) child.close();
    for (const compile of [...this.#compiles]) compile.close();
    this.#compiles.clear();
    for (const [resource, { kind, bytes }] of [...this.#objects]) {
      this.#forget(resource, bytes);
      deleteObject(this.#gl, resource, kind);
    }
  }

  /** The most these resources can hold now */
  #limitBytes(): number {
    const ledger = this.#ledger;
    if (this.#rowLimitBytes) {
      return this.#heldBytes + Math.max(0, this.#rowLimitBytes() - ledger.rowBytesHeld);
    }
    const room = this.#heldBytes + ledger.roomBytes;
    return this.#share === undefined ? room : Math.min(this.#share * ledger.limitBytes, room);
  }

  #open(): void {
    if (this.#closed) {
      throw new DrawError('invalidState', `The GPU resources of ${this.#owner} are gone`);
    }
  }

  /** Refuses what does not fit, before anything is made */
  #reserve(bytes: number): void {
    const ledger = this.#ledger;
    if (this.#rowLimitBytes) {
      if (ledger.rowBytesHeld + bytes <= this.#rowLimitBytes()) return;
      throw this.#refusal(bytes, true);
    }
    if (this.#share !== undefined && this.#heldBytes + bytes > this.#share * ledger.limitBytes) {
      throw this.#refusal(bytes, false);
    }
    if (this.#share !== undefined && !ledger.fits(bytes)) throw this.#refusal(bytes, true);
  }

  #refusal(bytes: number, retryable: boolean): DrawError {
    return limitError(`${bytes} bytes of ${this.#owner} do not fit on the GPU`, retryable);
  }

  /** A context that is lost makes nothing */
  #made<T>(object: T | null): T {
    if (object) return object;
    throw new DrawError('invalidState', 'The WebGL context is lost');
  }

  #keep(object: object, kind: GpuObjectKind, bytes: number): void {
    this.#objects.set(object, { kind, bytes });
    // The owners of the library tell by their name
    const rows = this.#rowLimitBytes ? true : this.#share === undefined ? undefined : false;
    this.#ledger.record(object, this.#owner, kind, bytes, rows);
    this.#heldBytes += bytes;
    this.#peakBytes = Math.max(this.#peakBytes, this.#heldBytes);
    if (bytes > 0) this.#allocations++;
  }

  #forget(object: object, bytes: number): void {
    this.#objects.delete(object);
    this.#ledger.release(object);
    this.#heldBytes -= bytes;
  }
}

/** A program being linked, with what ends it */
class LinkedProgram implements ProgramCompile {
  readonly #link: ProgramLink;
  readonly #linked: (program: WebGLProgram | null) => void;
  #program: WebGLProgram | null = null;
  #failed: DrawError | null = null;

  constructor(link: ProgramLink, linked: (program: WebGLProgram | null) => void) {
    this.#link = link;
    this.#linked = linked;
  }

  get done(): boolean {
    return this.#program !== null || this.#failed !== null || this.#link.done;
  }

  get program(): WebGLProgram {
    if (this.#failed) throw this.#failed;
    if (this.#program) return this.#program;
    try {
      this.#program = this.#link.take();
    } catch (error) {
      this.#failed = new DrawError('invalidInput', (error as Error).message);
      this.#linked(null);
      throw this.#failed;
    }
    this.#linked(this.#program);
    return this.#program;
  }

  /** Lets go of a program not taken */
  close(): void {
    this.#link.dispose();
    this.#failed ??= new DrawError('invalidState', 'The program was given back before it linked');
  }
}
