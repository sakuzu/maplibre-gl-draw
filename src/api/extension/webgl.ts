// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Drawing with WebGL of your own: what `ctx.webgl` of a plugin holds, and the GPU resources it
 * draws with
 *
 * Everything an extension holds on the GPU is made through a {@link Gpu}: the library allocates it,
 * records it under the name of the plugin in the ledger of the instance, refuses what is over the
 * limit, and gives everything back, however the extension ends. So nothing here has a counterpart
 * that releases what was prepared: a renderer is what `prepare` returns.
 */

import type { DraggedRows } from '../../feature-table/dragged-rows.js';
import type { MemoryUsage } from '../memory.js';
import type { Feature } from '../model.js';
import type { LayerTableView, RowRef } from '../tables.js';
import type { RenderContext } from './render.js';

/**
 * What a plugin draws with WebGL through (`PluginContext.webgl`)
 */
export interface Webgl {
  /**
   * Draws above every feature, overlay and selection box, once in a frame. Overlays of plugins go
   * in the order they were added.
   *
   * @throws `DrawError` with the code `too-large` when the shares of the definitions added come to
   *   more than 0.9 (the rest of the limit stays with the library), and `invalid-input` when
   *   `gpuShare` is not above 0 and at most 1
   */
  addOverlay(definition: GpuDefinition<(context: OverlayContext) => void>): void;
  /**
   * Draws the features of a type at their place in the order. Types given the same `definition`
   * have their rows in one range, also where the rows of the types alternate, and `prepare` runs
   * once for them: the draws of a layer where they alternate do not follow its rows.
   *
   * @param featureType - A type added with `ctx.extensions.featureTypes`
   * @throws `DrawError` as {@link Webgl.addOverlay} does, and with the code `not-found` for a type
   *   that was not added
   */
  addFeatureRenderer(featureType: string, definition: GpuDefinition<FeatureRenderer>): void;
  /**
   * The rows of a layer held as rows, read without making features of them.
   *
   * @returns The rows, or `undefined` when the layer does not hold rows
   */
  rows(layerId: string): LayerTableView | undefined;
  /** The rows being moved together. `null` while none are */
  draggedRows(): DraggedRows | null;
}

/**
 * A part of an extension that holds resources on the GPU
 */
export interface GpuDefinition<R> {
  /**
   * The part of the limit of the instance (`rendering.gpuLimitBytes`) it may hold, above 0 and at
   * most 1. The value belongs in the options of the plugin: a plugin holds no number of bytes.
   */
  readonly gpuShare: number;
  /**
   * Makes the resources and returns what draws with them. It runs once the map gives a WebGL
   * context, and again with a new `gpu` when a lost context is back: what it takes to make them
   * again stays with the plugin.
   */
  prepare(gpu: Gpu): R;
}

/**
 * What an overlay draws with
 */
export interface OverlayContext extends RenderContext {
  /** A render context for each copy of the world in view, for what is drawn on all of them */
  readonly worldCopies: readonly RenderContext[];
}

/**
 * Draws the features of a type (`GpuDefinition.prepare` of {@link Webgl.addFeatureRenderer})
 */
export interface FeatureRenderer {
  /** Draws one feature at its place in the order */
  render(feature: Feature, context: RenderContext): void;
  /**
   * Holds the rows of a layer on the GPU and draws them by range. Without it the rows in view are
   * made features and given to `render`.
   */
  readonly rows?: GpuRowBufferFactory;
}

/**
 * Makes what holds one range of rows of a layer, empty. All that `gpu` makes is rows: it is out of
 * `gpuShare`, may follow the number of rows, and is given back with the range.
 *
 * @param view - The rows of the layer
 * @param gpu - What the range allocates with
 */
export type GpuRowBufferFactory = (view: LayerTableView, gpu: Gpu) => GpuRowBuffer;

/**
 * A range of rows held on the GPU. It can be made again from the rows, so the library may drop it
 * at any time, and it has nothing to release: the library gives back all its `gpu` made.
 *
 * A row is named by its index: the rows it took, counted from 0 in the order it took them.
 */
export interface GpuRowBuffer {
  /**
   * Takes rows after the ones it took, in the order of the layer.
   *
   * Taking a row past `stopAtMilliseconds` is allowed, so that a call always takes one when it can.
   * Returned before that time with fewer rows than given, it refused them: they are drawn by
   * `render`. Returned past it, the rows left are given again in a later frame.
   *
   * @param rows - The rows, read during the call only
   * @param stopAtMilliseconds - When to stop, on the clock of `performance.now()`
   * @returns The number of rows it took, the first ones of `rows`
   */
  add(rows: Int32Array, stopAtMilliseconds: number): number;
  /**
   * Takes a row as it was written, in the frame that shows the write.
   *
   * @returns false when it cannot hold the row as written: the row is drawn by `render` at its
   *   place in the order, and `setStates` hides the row at this index
   */
  update(index: number, row: RowRef): boolean;
  /**
   * Takes the state of rows: the byte `ROW_STATE_GLSL` reads for each row. The rows are given
   * together when they are taken, and for every change of the state of the rows around them.
   *
   * @param from - The index of the first row
   * @param states - One byte per row, read during the call only
   */
  setStates(from: number, states: Uint8Array): void;
  /**
   * Draws the rows `[from, to)` in their order at this place of the order. The hidden rows and
   * the rows out of view are among them. It is called for each part of the range between other
   * rows, and for each copy of the world.
   *
   * @returns false when it did not draw them: `render` draws them one by one in this frame
   */
  render(from: number, to: number, context: RenderContext): boolean;
}

/**
 * The GPU resources of a part of an extension
 *
 * Every allocation is checked against the ledger of the instance before it is made, and refused
 * with `DrawError` of the code `too-large`, which holds nothing: `retryable` is true when only the
 * room of the whole instance is short. Once a `gpu` has ended (`signal`), a call fails with the
 * code `invalid-state` and allocates nothing, so a result that arrives late leaves nothing behind.
 */
export interface Gpu {
  /** The WebGL context, without the calls that make and delete resources */
  readonly gl: GpuContext;
  /** Stops when the resources of this `gpu` are gone: pass it to `fetch` */
  readonly signal: AbortSignal;
  /**
   * What allocates rows: what follows the number of features drawn. It is out of `gpuShare` and of
   * the limit of the instance, and held under what the device has left (`draw.memory`), the rest of
   * the page counted. `draw.debug.gpu()` tells it apart (`rowBytes`). It goes with this `gpu`.
   */
  readonly rows: Gpu;
  /**
   * Makes a buffer and leaves it bound to `target` (`ARRAY_BUFFER` when left out).
   *
   * @param data - The content, or a size in bytes to write later with `gl.bufferSubData`
   * @param options - `usage` is `STATIC_DRAW` for a content and `DYNAMIC_DRAW` for a size when it is
   *   left out
   */
  buffer(
    data: ArrayBufferView | number,
    options?: { readonly target?: number; readonly usage?: number },
  ): WebGLBuffer;
  /**
   * Makes a texture as `texStorage2D` does and leaves it bound to `TEXTURE_2D` of the active unit.
   * Write it with `gl.texSubImage2D`.
   *
   * @param format - The sized internal format
   * @param levels - The levels of mipmaps (1 when it is left out)
   * @throws `DrawError` with the code `invalid-input` for a format that is not a sized one
   */
  texture(width: number, height: number, format: number, levels?: number): WebGLTexture;
  vertexArray(): WebGLVertexArrayObject;
  transformFeedback(): WebGLTransformFeedback;
  /** Sets a fence after what was sent so far (`SYNC_GPU_COMMANDS_COMPLETE`) */
  fence(): WebGLSync;
  /**
   * Links a program, waiting for it.
   *
   * @throws `DrawError` with the code `invalid-input` and the log in its message when it does not
   *   compile or link; nothing is left behind
   */
  program(vertex: string, fragment: string): WebGLProgram;
  /**
   * Links a program without stopping a frame: read `program` once `done` is true.
   *
   * @param options - `varyings` are the outputs a transform feedback captures, one buffer each
   */
  compile(
    vertex: string,
    fragment: string,
    options?: { readonly varyings?: readonly string[] },
  ): ProgramCompile;
  /** Gives back something no longer needed. What is left goes when the `gpu` ends */
  release(
    resource:
      | WebGLBuffer
      | WebGLTexture
      | WebGLVertexArrayObject
      | WebGLTransformFeedback
      | WebGLSync
      | WebGLProgram,
  ): void;
  /** What this `gpu` holds, and in `limitBytes` the most it can hold now */
  memory(): MemoryUsage;
}

/**
 * A program being linked (`Gpu.compile`)
 */
export interface ProgramCompile {
  /** Whether `program` answers without waiting */
  readonly done: boolean;
  /**
   * The linked program.
   *
   * @throws `DrawError` with the code `invalid-input` and the log in its message when it does not
   *   compile or link
   */
  readonly program: WebGLProgram;
}

/**
 * The WebGL context of an extension: WebGL2, without the calls that make and delete resources
 * (they are in {@link Gpu}). Writing into what is made stays, as `bufferSubData` and
 * `texSubImage2D`.
 */
export type GpuContext = Omit<
  WebGL2RenderingContext,
  | 'createBuffer'
  | 'bufferData'
  | 'deleteBuffer'
  | 'createTexture'
  | 'texImage2D'
  | 'texImage3D'
  | 'texStorage2D'
  | 'texStorage3D'
  | 'copyTexImage2D'
  | 'compressedTexImage2D'
  | 'compressedTexImage3D'
  | 'deleteTexture'
  | 'createRenderbuffer'
  | 'renderbufferStorage'
  | 'renderbufferStorageMultisample'
  | 'deleteRenderbuffer'
  | 'createFramebuffer'
  | 'deleteFramebuffer'
  | 'createVertexArray'
  | 'deleteVertexArray'
  | 'createTransformFeedback'
  | 'deleteTransformFeedback'
  | 'fenceSync'
  | 'deleteSync'
  | 'createProgram'
  | 'deleteProgram'
  | 'createShader'
  | 'deleteShader'
>;
