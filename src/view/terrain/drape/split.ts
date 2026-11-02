// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The keys of the points drawn among the elements of a drape (`DrapeSplit`)
 *
 * A point stands on the ground, so a drape cannot paint it: it is drawn on the screen, and the
 * elements of the drape before it in the order go under it, those after it over it. Rather than
 * cutting the drape at every point (its draws would follow the points that meet later elements),
 * each pixel learns where its points lie among the elements that paint it, and both are drawn in
 * a few segments, each pixel for itself. Step `s` finds bound `s + 1` of every pixel from bound
 * `s` (none for the first step):
 *
 * - the lowest key of the points of the pixel from bound `s` on, over 2^24 as a depth (a depth
 *   test keeps the lowest; 1 where no point is)
 * - bound `s + 1`: the key of the first element after that lowest point that paints the pixel
 *   (`DRAPE_SPLIT_NONE` for none), written by a pass of the drape into a channel of its own,
 *   whose depth keeps the ground in front
 *
 * Segment `s` is then drawn: the elements from bound `s` up to bound `s + 1`, then the points
 * between them (all its elements are before all its points in the pixel). Two bounds are kept,
 * bound `s` in channel `s % 2`. What is past the last bound is the last segment, in order where
 * a pixel holds no more elements after a point than the steps (each step takes one of them).
 */

import { setDepthTestEnabled } from '../../layer/depth-state.js';
import { DRAPE_SPLIT_NONE } from './renderer.js';

/** The largest key the depth holds exactly (a key over 2^24 is an exact float below 1) */
export const DRAPE_SPLIT_MAX_KEY = 2 ** 24 - 1;

/**
 * The textures of the lowest keys of the points and of the bounds, and the framebuffers that
 * draw them, kept at the size of the target
 */
export class DrapeSplit {
  private low: WebGLTexture | null = null;
  private bounds: WebGLTexture | null = null;
  private boundsDepth: WebGLRenderbuffer | null = null;
  private lowTarget: WebGLFramebuffer | null = null;
  private boundsTarget: WebGLFramebuffer | null = null;
  private width = 0;
  private height = 0;
  private failed = false;
  /** What was bound before a pass (restored by `end`) */
  private previous: WebGLFramebuffer | null = null;
  private previousViewport: Int32Array | null = null;
  /** The bytes the textures hold */
  bytes = 0;

  constructor(private readonly gl: WebGL2RenderingContext) {}

  /** The texture of the lowest keys (null before `ensure`) */
  get lowTexture(): WebGLTexture | null {
    return this.low;
  }

  /** The texture of the bounds (null before `ensure`) */
  get boundsTexture(): WebGLTexture | null {
    return this.bounds;
  }

  /**
   * Makes the textures the size of the viewport of the target bound now (again when it changed)
   *
   * @returns false when they cannot be made (the caller draws without the split)
   */
  ensure(): boolean {
    if (this.failed) return false;
    const gl = this.gl;
    const viewport = gl.getParameter(gl.VIEWPORT) as Int32Array;
    const width = (viewport[0] as number) + (viewport[2] as number);
    const height = (viewport[1] as number) + (viewport[3] as number);
    if (width <= 0 || height <= 0) return false;
    if (this.low && width === this.width && height === this.height) return true;
    this.release();
    // The bounds are floats drawn into
    if (!gl.getExtension('EXT_color_buffer_float')) {
      this.failed = true;
      return false;
    }
    const low = gl.createTexture();
    const bounds = gl.createTexture();
    const boundsDepth = gl.createRenderbuffer();
    const lowTarget = gl.createFramebuffer();
    const boundsTarget = gl.createFramebuffer();
    if (!low || !bounds || !boundsDepth || !lowTarget || !boundsTarget) {
      this.failed = true;
      return false;
    }
    const previous = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, low);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.DEPTH_COMPONENT32F, width, height);
    nearest(gl);
    gl.bindTexture(gl.TEXTURE_2D, bounds);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RG32F, width, height);
    nearest(gl);
    gl.bindRenderbuffer(gl.RENDERBUFFER, boundsDepth);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, width, height);
    gl.bindRenderbuffer(gl.RENDERBUFFER, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, lowTarget);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, low, 0);
    gl.drawBuffers([gl.NONE]);
    gl.readBuffer(gl.NONE);
    const lowComplete = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, boundsTarget);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, bounds, 0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, boundsDepth);
    const boundsComplete = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, previous);
    gl.bindTexture(gl.TEXTURE_2D, null);
    this.low = low;
    this.bounds = bounds;
    this.boundsDepth = boundsDepth;
    this.lowTarget = lowTarget;
    this.boundsTarget = boundsTarget;
    this.width = width;
    this.height = height;
    this.bytes = width * height * (4 + 8 + 4);
    if (!lowComplete || !boundsComplete) {
      this.release();
      this.failed = true;
      return false;
    }
    return true;
  }

  /**
   * Starts the pass of the lowest keys: its target bound and cleared, the depth test keeping the
   * lowest key, no blending (`end` binds back what was bound)
   */
  beginLow(): void {
    const gl = this.gl;
    this.save();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.lowTarget);
    gl.viewport(0, 0, this.width, this.height);
    gl.disable(gl.BLEND);
    gl.disable(gl.POLYGON_OFFSET_FILL);
    gl.depthMask(true);
    gl.clearDepth(1);
    gl.clear(gl.DEPTH_BUFFER_BIT);
    setDepthTestEnabled(gl, true);
    gl.depthFunc(gl.LESS);
  }

  /**
   * Starts the pass of the bounds: its target bound, the depth test keeping the ground in front,
   * no blending
   *
   * @param channel The bound the pass writes, cleared to none first (the others kept as they
   *   are); null for every bound
   */
  beginBounds(channel: number | null = null): void {
    const gl = this.gl;
    this.save();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.boundsTarget);
    gl.viewport(0, 0, this.width, this.height);
    gl.disable(gl.BLEND);
    gl.disable(gl.POLYGON_OFFSET_FILL);
    // The clear writes only the channels the pass writes
    if (channel === null) gl.colorMask(true, true, true, true);
    else gl.colorMask(channel === 0, channel === 1, false, false);
    gl.clearBufferfv(gl.COLOR, 0, NONE);
    gl.depthMask(true);
    gl.clearDepth(1);
    gl.clear(gl.DEPTH_BUFFER_BIT);
    setDepthTestEnabled(gl, true);
    gl.depthFunc(gl.LESS);
  }

  /**
   * Ends a pass: binds back the target and the viewport bound before it (the caller sets the
   * blending and the depth state of what it draws next)
   */
  end(): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.previous);
    const viewport = this.previousViewport;
    if (viewport) {
      gl.viewport(
        viewport[0] as number,
        viewport[1] as number,
        viewport[2] as number,
        viewport[3] as number,
      );
    }
    gl.colorMask(true, true, true, true);
    gl.depthMask(false);
  }

  /** Releases the textures and the framebuffers */
  release(): void {
    const gl = this.gl;
    if (this.low) gl.deleteTexture(this.low);
    if (this.bounds) gl.deleteTexture(this.bounds);
    if (this.boundsDepth) gl.deleteRenderbuffer(this.boundsDepth);
    if (this.lowTarget) gl.deleteFramebuffer(this.lowTarget);
    if (this.boundsTarget) gl.deleteFramebuffer(this.boundsTarget);
    this.low = null;
    this.bounds = null;
    this.boundsDepth = null;
    this.lowTarget = null;
    this.boundsTarget = null;
    this.width = 0;
    this.height = 0;
    this.bytes = 0;
  }

  private save(): void {
    const gl = this.gl;
    this.previous = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
    this.previousViewport = gl.getParameter(gl.VIEWPORT) as Int32Array;
  }
}

const NONE = new Float32Array(4).fill(DRAPE_SPLIT_NONE);

function nearest(gl: WebGL2RenderingContext): void {
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
}
