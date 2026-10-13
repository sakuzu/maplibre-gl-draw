// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A run of retained draws (`RetainedDrawRun`)
 *
 * The retained batches of a layer are drawn one after another, with nothing else drawn in
 * between: the Store's chunks of a layer, the chunks of a dataset, the chunks of the rows of a
 * layer. Within such a run the GL state one draw leaves is the state the next one starts from,
 * so a draw can skip what is already in place:
 *
 * - the program, when it is the one in use
 * - the texture of the state of the rows on its unit, when it is the one bound (one bind per row
 *   group rather than one per draw)
 * - the choice of the texture unit 0, which the run always leaves active
 * - the unbinding of the vertex array after every draw: the vertex array of a draw stays bound,
 *   and the run unbinds it once, when it ends
 *
 * The run only remembers what it set itself. Anything else that draws (maplibre between the
 * slots, the immediate mode, the renderers of the extensions, the analytic drape) may change any
 * of it, so the side that draws the run calls `forget()` before it hands the context to anything
 * else, and `end()` when the run is over: both unbind the vertex array left bound and forget
 * everything, so the next draw writes it all again. Outside a run (`begin()` not called) every
 * draw sets everything and unbinds its vertex array, as a lone draw always did. A frame that
 * starts while a run is open (an exception skipped its end) forgets what it remembered as well.
 *
 * The uniforms are not here: they belong to the programs, which only these renderers use, and
 * each renderer remembers what it wrote to its programs (`shaders/frame.ts`).
 *
 * A run belongs to the WebGL context whose state it mirrors (one per context), so the renderers
 * of points, lines and polygons of a context share it.
 */

import { getRenderFrame } from '../shaders/frame.js';
import { ROW_STATE_TEXTURE_UNIT } from './row-state.js';

/**
 * The GL state a run of retained draws keeps between its draws
 *
 * @internal
 */
export class RetainedDrawRun {
  /** Whether a run is open (outside one, nothing is remembered or skipped) */
  private open = false;
  /** The frame the remembered state was set in */
  private frame = -1;
  /** The program in use, as the run set it (null = not known) */
  private program: WebGLProgram | null = null;
  /** The texture bound to the unit of the state of the rows, as the run bound it */
  private rowState: WebGLTexture | null = null;
  /** Whether the run left the texture unit 0 active */
  private unitZero = false;
  /** Whether a draw of the run left its vertex array bound */
  private vertexArrayLeft = false;

  constructor(private readonly gl: WebGL2RenderingContext) {}

  /** Whether a run is open */
  get isOpen(): boolean {
    return this.open;
  }

  /**
   * Opens a run (nothing is known of the state yet). Opening a run that is open forgets what it
   * remembered (runs do not nest)
   */
  begin(): void {
    this.forget();
    this.open = true;
    this.frame = getRenderFrame();
  }

  /**
   * Unbinds the vertex array a draw left bound and forgets the state, leaving the run open: call
   * it before anything else draws in the middle of a run
   */
  forget(): void {
    if (this.vertexArrayLeft) this.gl.bindVertexArray(null);
    this.vertexArrayLeft = false;
    this.clear();
  }

  /** Ends the run: unbinds the vertex array left bound and forgets the state */
  end(): void {
    this.forget();
    this.open = false;
  }

  /** Uses a program (no call when the run already uses it) */
  useProgram(program: WebGLProgram | null): void {
    if (this.known() && this.program === program) return;
    this.gl.useProgram(program);
    this.program = this.open ? program : null;
  }

  /**
   * Binds the vertex array of a draw. Call `release()` after the draw: in a run the vertex array
   * stays bound until the run unbinds it
   */
  bindVertexArray(vao: WebGLVertexArrayObject): void {
    this.gl.bindVertexArray(vao);
    if (this.open) this.vertexArrayLeft = true;
  }

  /** The end of a draw: unbinds its vertex array, except in a run */
  release(): void {
    if (!this.open) this.gl.bindVertexArray(null);
  }

  /** Makes the texture unit 0 active (no call when the run left it active) */
  activateUnitZero(): void {
    if (this.known() && this.unitZero) return;
    this.gl.activeTexture(this.gl.TEXTURE0);
    this.unitZero = this.open;
  }

  /**
   * Binds the texture of the state of the rows to its unit and makes the unit 0 active again (no
   * call when the run bound it already)
   */
  bindRowState(texture: WebGLTexture): void {
    if (this.known() && this.rowState === texture) return;
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + ROW_STATE_TEXTURE_UNIT);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.activeTexture(gl.TEXTURE0);
    this.rowState = this.open ? texture : null;
    this.unitZero = this.open;
  }

  /** Whether the remembered state can be trusted: in a run, in the frame it was set in */
  private known(): boolean {
    if (!this.open) return false;
    const frame = getRenderFrame();
    if (frame !== this.frame) {
      this.clear();
      this.frame = frame;
      return false;
    }
    return true;
  }

  /** Forgets the state remembered (what a draw left bound is still unbound by `forget`) */
  private clear(): void {
    this.program = null;
    this.rowState = null;
    this.unitZero = false;
  }
}

/** The run of each WebGL context */
const runs = new WeakMap<WebGL2RenderingContext, RetainedDrawRun>();

/**
 * The run of the retained draws of a WebGL context
 *
 * @internal
 */
export function retainedDrawRun(gl: WebGL2RenderingContext): RetainedDrawRun {
  let run = runs.get(gl);
  if (!run) {
    run = new RetainedDrawRun(gl);
    runs.set(gl, run);
  }
  return run;
}
