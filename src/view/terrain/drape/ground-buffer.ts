// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The ground seen at each pixel, for the polygons and the lines drawn in the order of their rows
 *
 * The tiles of the terrain are drawn once a frame into a texture of the size of the target, by
 * the mesh of the drape and with its depth, so each pixel keeps the ground seen there, in four
 * unsigned 16-bit integers (8 bytes, a format every WebGL2 draws into): the tile, as its slot
 * plus one (0 where no ground is seen), the place in the tile (x and y, in 65,535ths of its
 * side), and the shading of the terrain there (in 65,535ths of `DRAPE_GROUND_SHADE_RANGE`). A
 * polygon or a line drawn in the order of its rows then reads the ground of each pixel it may
 * cover and tells, as the drape does, whether the pixel is in it or how far it is from it on the
 * screen. Its draws are those of the rows, so whatever is drawn between them (points, pictures)
 * keeps its place in the order in every pixel.
 */

import type { GpuLedger } from '../../gpu-ledger.js';
import { setDepthTestEnabled } from '../../layer/depth-state.js';

/** The steps of a place in a tile across its side (an unsigned 16-bit integer) */
export const DRAPE_GROUND_PLACE_STEPS = 65_535;

/** The shading kept: from 0 up to this (the shading of the terrain is within it) */
export const DRAPE_GROUND_SHADE_RANGE = 2;

/** The owner of the texture of the ground in the ledger of the GPU */
const LEDGER_OWNER = 'ground';

/** The slots of tiles the ground holds at most */
export const DRAPE_GROUND_MAX_SLOTS = 128;

/**
 * The blocks of a tile on a side the ranges of the elevations of its ground are kept for: a
 * polygon or a line is drawn as a box on the screen that holds its ground between the lowest and
 * the highest elevation of the blocks it meets
 */
export const DRAPE_GROUND_BLOCKS = 32;

/** The coarser blocks of a tile on a side, each of 4 x 4 blocks (for a box over many blocks) */
export const DRAPE_GROUND_COARSE_BLOCKS = 8;

/** The ranges of the blocks of a tile: the blocks, then the coarser blocks */
export const DRAPE_GROUND_BLOCK_TEXELS =
  DRAPE_GROUND_BLOCKS * DRAPE_GROUND_BLOCKS +
  DRAPE_GROUND_COARSE_BLOCKS * DRAPE_GROUND_COARSE_BLOCKS;

/**
 * The texture of the ground seen at each pixel, and the framebuffer that draws it, kept at the
 * size of the target
 */
export class DrapeGroundBuffer {
  private ground: WebGLTexture | null = null;
  private depth: WebGLRenderbuffer | null = null;
  private target: WebGLFramebuffer | null = null;
  private width = 0;
  private height = 0;
  private failed = false;
  private previous: WebGLFramebuffer | null = null;
  private previousViewport: Int32Array | null = null;
  /** The bytes the texture and the depth hold */
  bytes = 0;
  /** The frame the ground was last drawn in (the caller tells it) */
  drawnFrame = -1;

  constructor(
    private readonly gl: WebGL2RenderingContext,
    private readonly ledger?: GpuLedger,
  ) {}

  /** The texture of the ground (null before `ensure`) */
  get texture(): WebGLTexture | null {
    return this.ground;
  }

  /**
   * Makes the texture the size of the viewport of the target bound now (again when it changed)
   *
   * @returns false when it cannot be made
   */
  ensure(): boolean {
    if (this.failed) return false;
    const gl = this.gl;
    const viewport = gl.getParameter(gl.VIEWPORT) as Int32Array;
    const width = (viewport[0] as number) + (viewport[2] as number);
    const height = (viewport[1] as number) + (viewport[3] as number);
    if (width <= 0 || height <= 0) return false;
    if (this.ground && width === this.width && height === this.height) return true;
    this.release();
    const ground = gl.createTexture();
    const depth = gl.createRenderbuffer();
    const target = gl.createFramebuffer();
    if (!ground || !depth || !target) {
      this.failed = true;
      return false;
    }
    const previous = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, ground);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA16UI, width, height);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, width, height);
    gl.bindRenderbuffer(gl.RENDERBUFFER, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, target);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, ground, 0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
    const complete = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, previous);
    gl.bindTexture(gl.TEXTURE_2D, null);
    this.ground = ground;
    this.depth = depth;
    this.target = target;
    this.width = width;
    this.height = height;
    this.bytes = width * height * (8 + 4);
    this.ledger?.record(ground, LEDGER_OWNER, 'texture', width * height * 8);
    this.ledger?.record(depth, LEDGER_OWNER, 'texture', width * height * 4);
    if (!complete) {
      this.release();
      this.failed = true;
      return false;
    }
    return true;
  }

  /**
   * Starts the pass of the ground: its target bound and cleared (no ground), the depth test
   * keeping the ground in front, no blending (`end` binds back what was bound)
   */
  begin(): void {
    const gl = this.gl;
    this.previous = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
    this.previousViewport = gl.getParameter(gl.VIEWPORT) as Int32Array;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.target);
    gl.viewport(0, 0, this.width, this.height);
    gl.disable(gl.BLEND);
    gl.disable(gl.POLYGON_OFFSET_FILL);
    gl.colorMask(true, true, true, true);
    gl.clearBufferuiv(gl.COLOR, 0, NONE);
    gl.depthMask(true);
    gl.clearDepth(1);
    gl.clear(gl.DEPTH_BUFFER_BIT);
    setDepthTestEnabled(gl, true);
    gl.depthFunc(gl.LESS);
  }

  /** Ends the pass: binds back the target and the viewport bound before it */
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
    gl.depthMask(false);
  }

  /** Releases the texture and the framebuffer */
  release(): void {
    const gl = this.gl;
    this.ledger?.release(this.ground);
    this.ledger?.release(this.depth);
    if (this.ground) gl.deleteTexture(this.ground);
    if (this.depth) gl.deleteRenderbuffer(this.depth);
    if (this.target) gl.deleteFramebuffer(this.target);
    this.ground = null;
    this.depth = null;
    this.target = null;
    this.width = 0;
    this.height = 0;
    this.bytes = 0;
  }
}

const NONE = new Uint32Array(4);
