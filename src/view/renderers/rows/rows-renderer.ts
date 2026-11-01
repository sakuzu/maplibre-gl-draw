// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The renderer that draws rows of every kind in one draw (`RowsRenderer`)
 *
 * A chunk of rows is one instance buffer, one texture of its coordinates and one texture of the
 * styles of its rows (`rows-format.ts`), drawn by one program in one draw whatever kinds its rows
 * are. A range of its rows is one range of its instances: the two instance attributes are
 * pointed at the first instance of the range and the draw is given the count, so a chunk is
 * drawn in parts at the cost of one more draw per cut, with the same program and textures.
 *
 * Nothing is written to the GPU while the frame is drawn. The chunks, the values of the styles
 * and the writes in place are queued, and written by `flushUploads`, which the frame calls before
 * maplibre starts its main pass (`prerender`): a texture written in the middle of the pass makes
 * a tiled GPU store and reload the frame. A chunk is drawn from the frame after it was written.
 *
 * The program of each projection variant is compiled when the variant is first seen, without
 * waiting for it where the context can compile in parallel (`KHR_parallel_shader_compile`):
 * `ready` tells whether the program of the current variant can draw, and the side that draws
 * the rows draws them some other way until then.
 */

import type { Map as MapLibreMap, ProjectionData } from 'maplibre-gl';
import type { PixelRatioInput } from '../../../shared/utils/pixel-ratio.js';
import { resolvePixelRatio } from '../../../shared/utils/pixel-ratio.js';
import { type GpuLedger, textureBytes } from '../../gpu-ledger.js';
import { getRenderFrame } from '../../shaders/frame.js';
import {
  calculateOffsetUniforms,
  type OffsetUniforms,
  type ShaderData,
  withSamplerPrecision,
} from '../../shaders/helpers.js';
import { ProjectionUniformManager } from '../../shaders/projection.js';
import { TerrainContext } from '../../terrain/context.js';
import { NEUTRAL_DRAW_FACTORS, type RetainedDrawFactors } from '../draw-factors.js';
import { type RetainedDrawRun, retainedDrawRun } from '../draw-run.js';
import { bindRowState, type RowStateBinding, RowStateUniforms } from '../row-state.js';
import type { RowsCopies } from './rows-copies.js';
import {
  ROWS_COORD_WIDTH,
  ROWS_INSTANCE_BYTES,
  ROWS_INSTANCE_FLOATS,
  ROWS_ROW_STYLE_FLOATS,
  ROWS_ROW_STYLE_WIDTH,
  ROWS_STYLE_TEXELS,
  ROWS_STYLE_WIDTH,
  type RowsChunkData,
  type RowsChunkLayout,
  type RowsPalette,
  writeCollapsedInstance,
} from './rows-format.js';
import { buildRowsFragmentSource, buildRowsVertexSource, ROWS_MITER_LIMIT } from './rows-shader.js';
import { TexelWrites } from './rows-writes.js';

/** The texture units of the program (the state of the rows is on its own unit, 1) */
const UNIT_COORDS = 0;
const UNIT_ROW_STYLES = 2;
const UNIT_STYLES = 3;
const UNIT_SPRITES = 4;

/** The owner of the GPU memory of this renderer in the ledger */
const LEDGER_OWNER = 'rows';

/** `COMPLETION_STATUS_KHR` of `KHR_parallel_shader_compile` */
const COMPLETION_STATUS_KHR = 0x91b1;

/** The corners of the strip of 4 vertices every instance is drawn with */
const CORNERS = new Float32Array([0, 1, 2, 3]);

/** A texture and its size */
interface SizedTexture {
  readonly texture: WebGLTexture;
  readonly width: number;
  readonly height: number;
}

/**
 * A chunk of rows on the GPU (made from its packed arrays, written by `flushUploads`)
 *
 * @internal
 */
export interface RowsChunk {
  /** Where each row is in the chunk, and what it is drawn with */
  readonly data: RowsChunkLayout;
  /**
   * The packed arrays until they are written to the GPU (null after: the chunk keeps no copy of
   * them, and what is written in place is held in `writes` until the next upload)
   */
  packed: RowsChunkData | null;
  /** Whether it is written to the GPU (it can be drawn) */
  uploaded: boolean;
  vao: WebGLVertexArrayObject | null;
  instanceBuffer: WebGLBuffer | null;
  /** The instances of its points alone (drawn where the drape draws the rest) */
  pointBuffer: WebGLBuffer | null;
  coords: SizedTexture | null;
  rowStyles: SizedTexture | null;
  /** The instance the instance attributes of its vertex array point at */
  pointedFirst: number;
  /** The writes in place since the last upload (null before the first) */
  writes: RowsChunkWrites | null;
  disposed: boolean;
}

/**
 * The writes in place of a chunk waiting to be uploaded: the instances (and the instances of the
 * points), the coordinates and the styles of the rows written since the last upload
 *
 * @internal
 */
export interface RowsChunkWrites {
  readonly instances: TexelWrites;
  readonly points: TexelWrites;
  readonly coords: TexelWrites;
  readonly rowStyles: TexelWrites;
}

/** The uniforms of the program that are not the projection */
interface RowsUniformLocations {
  readonly coords: WebGLUniformLocation | null;
  readonly coordWidth: WebGLUniformLocation | null;
  readonly rowStyles: WebGLUniformLocation | null;
  readonly rowStyleWidth: WebGLUniformLocation | null;
  readonly rowBase: WebGLUniformLocation | null;
  readonly styles: WebGLUniformLocation | null;
  readonly styleWidth: WebGLUniformLocation | null;
  readonly viewport: WebGLUniformLocation | null;
  readonly zoom: WebGLUniformLocation | null;
  readonly miterLimit: WebGLUniformLocation | null;
  readonly sizeScale: WebGLUniformLocation | null;
  readonly pixelToClip: WebGLUniformLocation | null;
  readonly screenRatio: WebGLUniformLocation | null;
  readonly cameraToCenterW: WebGLUniformLocation | null;
  readonly bearing: WebGLUniformLocation | null;
  readonly spriteScale: WebGLUniformLocation | null;
  readonly opacity: WebGLUniformLocation | null;
  readonly cullBack: WebGLUniformLocation | null;
  readonly sprites: WebGLUniformLocation | null;
  readonly spritePremultiplied: WebGLUniformLocation | null;
}

/** The program of one projection variant */
interface RowsProgram {
  readonly program: WebGLProgram;
  vertex: WebGLShader | null;
  fragment: WebGLShader | null;
  state: 'compiling' | 'linked' | 'failed';
  locations: RowsUniformLocations | null;
  readonly projection: ProjectionUniformManager;
  rowState: RowStateUniforms | null;
  /** The values written to the uniforms, and the frame they were written in */
  memo: RowsUniformMemo;
}

/** The values last written to the uniforms of a program */
interface RowsUniformMemo {
  frame: number;
  zoom: number;
  scale: number;
  opacity: number;
  coordWidth: number;
  rowBase: number;
  rowStyleWidth: number;
  spriteScale: string;
  spritePremultiplied: number;
}

function emptyMemo(): RowsUniformMemo {
  return {
    frame: -1,
    zoom: Number.NaN,
    scale: Number.NaN,
    opacity: Number.NaN,
    coordWidth: Number.NaN,
    rowBase: Number.NaN,
    rowStyleWidth: Number.NaN,
    spriteScale: '',
    spritePremultiplied: Number.NaN,
  };
}

/**
 * The textures bound last in a run of draws on the units only this renderer uses, and the epoch
 * of the run they were bound in (the unit 0 is used by the other renderers of the run too)
 */
interface BoundTextures {
  epoch: number;
  rowStyles: WebGLTexture | null;
  styles: WebGLTexture | null;
  sprites: WebGLTexture | null;
}

/**
 * The renderer that draws rows of every kind in one draw
 *
 * @internal
 */
export class RowsRenderer {
  private readonly gl: WebGL2RenderingContext;
  private readonly map: MapLibreMap | null;
  private readonly pixelRatio: PixelRatioInput | undefined;
  private readonly terrain: TerrainContext;
  private readonly ledger: GpuLedger | undefined;
  /** What is kept of what the GPU holds, for the checks of what is drawn (null without them) */
  readonly copies: RowsCopies | null;
  private readonly run: RetainedDrawRun;
  private readonly parallel: boolean;
  /** The program of each variant, compiled once */
  private readonly programs = new Map<string, RowsProgram>();
  /** The program of the variant of the frame */
  private current: RowsProgram | null = null;
  private offsetUniforms: OffsetUniforms | null = null;
  private readonly cornerBuffer: WebGLBuffer | null;
  /** The picture drawn for the sprites of a chunk whose texture is not there */
  private emptySprites: WebGLTexture | null = null;
  /** The chunks waiting to be written, in the order they were made */
  private readonly queued = new Set<RowsChunk>();
  /** The chunks with writes in place waiting to be uploaded */
  private readonly patched = new Set<RowsChunk>();
  /** The palettes of the chunks alive */
  private readonly palettes = new Set<RowsPalette>();
  private readonly bound: BoundTextures = {
    epoch: -1,
    rowStyles: null,
    styles: null,
    sprites: null,
  };
  private readonly originShift: [number, number] = [0, 0];
  /** One instance (or texel) being written */
  private readonly scratch = new Float32Array(ROWS_INSTANCE_FLOATS);
  /** The bytes written to the GPU by the uploads so far (buffers and textures) */
  uploadedBytes = 0;
  private bearingFrame = -1;
  private bearing = 0;

  constructor(
    map: MapLibreMap | null,
    gl: WebGL2RenderingContext,
    pixelRatio?: PixelRatioInput,
    terrain: TerrainContext = new TerrainContext(),
    ledger?: GpuLedger,
    copies: RowsCopies | null = null,
  ) {
    this.gl = gl;
    this.copies = copies;
    this.map = map;
    this.pixelRatio = pixelRatio;
    this.terrain = terrain;
    this.ledger = ledger;
    this.run = retainedDrawRun(gl);
    this.parallel = !!gl.getExtension?.('KHR_parallel_shader_compile');
    this.cornerBuffer = gl.createBuffer();
    if (this.cornerBuffer) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.cornerBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, CORNERS, gl.STATIC_DRAW);
      ledger?.record(this.cornerBuffer, LEDGER_OWNER, 'buffer', CORNERS.byteLength);
    }
  }

  /**
   * Starts the compile of the program of a variant the first time it is seen, and makes it the
   * one the next draws use
   */
  ensureShader(shaderData: ShaderData): void {
    let program = this.programs.get(shaderData.variantName);
    if (!program) {
      program = this.startProgram(shaderData);
      this.programs.set(shaderData.variantName, program);
    }
    this.current = program;
  }

  /** Sets the uniforms of the offset mode of the frame */
  setOffsetUniforms(uniforms: OffsetUniforms): void {
    this.offsetUniforms = uniforms;
  }

  /**
   * Whether the program of the current variant can draw (false while it compiles, and for good
   * when it failed)
   */
  get ready(): boolean {
    const program = this.current;
    return program !== null && this.poll(program);
  }

  /** Whether the program of the current variant is still compiling */
  get compiling(): boolean {
    const program = this.current;
    return program !== null && !this.poll(program) && program.state === 'compiling';
  }

  // === Chunks ===

  /**
   * Makes a chunk of packed rows; it is written to the GPU by the next `flushUploads` and can be
   * drawn after that
   */
  createChunk(data: RowsChunkData): RowsChunk {
    const chunk: RowsChunk = {
      data: layoutOf(data),
      packed: data,
      uploaded: false,
      vao: null,
      instanceBuffer: null,
      pointBuffer: null,
      coords: null,
      rowStyles: null,
      pointedFirst: -1,
      writes: null,
      disposed: false,
    };
    data.palette.refs++;
    this.palettes.add(data.palette);
    this.queued.add(chunk);
    return chunk;
  }

  /** Whether something waits to be written by `flushUploads` */
  get hasPendingUploads(): boolean {
    if (this.queued.size > 0 || this.patched.size > 0) return true;
    for (const palette of this.palettes) {
      if (palette.dirty.size > 0) return true;
    }
    return false;
  }

  /**
   * Writes what is queued to the GPU: the values of the styles added, the chunks made, the writes
   * in place. Called before the main pass of the frame
   */
  flushUploads(): void {
    if (this.queued.size > 0) this.ensureEmptySprites();
    for (const palette of this.palettes) {
      if (palette.dirty.size > 0) this.uploadPalette(palette);
    }
    for (const chunk of this.queued) this.uploadChunk(chunk);
    this.queued.clear();
    for (const chunk of this.patched) this.uploadPatches(chunk);
    this.patched.clear();
  }

  /**
   * Writes rows of a chunk in place, when they fit their places in it
   *
   * Every row of a chunk has a place (its instances, the instances of its points and its
   * coordinates, `rowFirst`, `pointFirst` and `coordFirst`), as large as what it was packed with.
   * A row packed again fits when it has no more of each than its place holds: its instances are
   * written over the ones of its place, the rest of the place is filled with instances that draw
   * nothing, and its coordinates and its style are written. The write reaches the GPU with the
   * next `flushUploads`
   *
   * @param fromRow The first row written, in the chunk
   * @param patch The rows `[fromRow, fromRow + patch.rows)` packed again on their own, with the
   *   palette of the chunk (the chunk takes over the counting of their styles)
   * @returns false when a row does not fit its place (nothing is written: the rows have to be
   *   built again)
   */
  patchRows(chunk: RowsChunk, fromRow: number, patch: RowsChunkData): boolean {
    const data = chunk.data;
    const toRow = fromRow + patch.rows;
    if (chunk.disposed || fromRow < 0 || toRow > data.rows || patch.palette !== data.palette) {
      return false;
    }
    for (let r = 0; r < patch.rows; r++) {
      const row = fromRow + r;
      if (
        patch.rowFirst[r + 1] - patch.rowFirst[r] > data.rowFirst[row + 1] - data.rowFirst[row] ||
        patch.pointFirst[r + 1] - patch.pointFirst[r] >
          data.pointFirst[row + 1] - data.pointFirst[row] ||
        patch.coordFirst[r + 1] - patch.coordFirst[r] >
          data.coordFirst[row + 1] - data.coordFirst[row]
      ) {
        return false;
      }
    }
    const scratch = this.scratch;
    for (let r = 0; r < patch.rows; r++) {
      const row = fromRow + r;
      const coordBase = data.coordFirst[row];
      const shift = coordBase - patch.coordFirst[r];
      // The instances, their coordinates numbered in the place of the row, the rest collapsed
      const write = (
        packed: Float32Array,
        from: number,
        to: number,
        placeFrom: number,
        placeTo: number,
        target: 'instances' | 'points',
      ): void => {
        for (let i = placeFrom; i < placeTo; i++) {
          const source = from + i - placeFrom;
          if (source < to) {
            const at = source * ROWS_INSTANCE_FLOATS;
            scratch[0] = packed[at];
            for (let k = 1; k <= 4; k++) {
              const index = packed[at + k];
              scratch[k] = index >= 0 ? index + shift : index;
            }
            scratch[5] = packed[at + 5];
            scratch[6] = packed[at + 6];
            scratch[7] = packed[at + 7];
          } else {
            writeCollapsedInstance(scratch, 0, data.rowBase + row, coordBase);
          }
          this.writeTexel(chunk, target, i, scratch);
        }
      };
      write(
        patch.instances,
        patch.rowFirst[r],
        patch.rowFirst[r + 1],
        data.rowFirst[row],
        data.rowFirst[row + 1],
        'instances',
      );
      write(
        patch.points,
        patch.pointFirst[r],
        patch.pointFirst[r + 1],
        data.pointFirst[row],
        data.pointFirst[row + 1],
        'points',
      );
      for (let c = patch.coordFirst[r]; c < patch.coordFirst[r + 1]; c++) {
        this.writeTexel(chunk, 'coords', c + shift, patch.coords, c * 2);
      }
      this.writeTexel(chunk, 'rowStyles', row, patch.rowStyles, r * ROWS_ROW_STYLE_FLOATS);
      // The row takes the style the patch counted, and stops counting the one it had
      const old = data.rowStyle[row];
      if (old >= 0) data.palette.release(old);
      data.rowStyle[row] = patch.rowStyle[r];
    }
    return true;
  }

  /**
   * Writes coordinates of a chunk in place (the positions only: the rows keep their instances).
   * The write reaches the GPU with the next `flushUploads`
   *
   * @param coordFrom The first coordinate written, in the chunk
   * @param values The coordinates, 2 floats each (offsets from the origin of the chunk)
   * @param count The number of coordinates (all of `values` when omitted)
   */
  patchCoords(
    chunk: RowsChunk,
    coordFrom: number,
    values: ArrayLike<number>,
    count?: number,
  ): void {
    if (chunk.disposed) return;
    const n = count ?? values.length / 2;
    for (let c = 0; c < n; c++) this.writeTexel(chunk, 'coords', coordFrom + c, values, c * 2);
  }

  /**
   * Writes the style of a row of a chunk in place (its instances stay: the new style has the
   * layout of the old one). The chunk takes over the counting of the style given
   *
   * @param row The row, in the chunk
   * @param style The number of its resolved style (counted by the caller for the chunk)
   * @param createdZoom Its created zoom (undefined for a width fixed on screen)
   */
  patchRowStyle(
    chunk: RowsChunk,
    row: number,
    style: number,
    createdZoom: number | undefined,
  ): void {
    if (chunk.disposed) return;
    const data = chunk.data;
    const scratch = this.scratch;
    scratch[0] = style;
    scratch[1] = createdZoom ?? 0;
    scratch[2] = createdZoom === undefined ? 0 : 1;
    scratch[3] = 0;
    this.writeTexel(chunk, 'rowStyles', row, scratch);
    const old = data.rowStyle[row];
    if (old >= 0) data.palette.release(old);
    data.rowStyle[row] = style;
  }

  /**
   * Writes a texel (or an instance): into the packed arrays of a chunk not uploaded yet, into the
   * writes of the next upload otherwise
   */
  private writeTexel(
    chunk: RowsChunk,
    target: 'instances' | 'points' | 'coords' | 'rowStyles',
    texel: number,
    source: ArrayLike<number>,
    at = 0,
  ): void {
    const packed = chunk.packed;
    if (!chunk.uploaded) {
      if (!packed) return;
      const array =
        target === 'instances'
          ? packed.instances
          : target === 'points'
            ? packed.points
            : target === 'coords'
              ? packed.coords
              : packed.rowStyles;
      const floats =
        target === 'coords'
          ? 2
          : target === 'rowStyles'
            ? ROWS_ROW_STYLE_FLOATS
            : ROWS_INSTANCE_FLOATS;
      for (let k = 0; k < floats; k++) array[texel * floats + k] = source[at + k];
      return;
    }
    chunk.writes ??= {
      instances: new TexelWrites(ROWS_INSTANCE_FLOATS),
      points: new TexelWrites(ROWS_INSTANCE_FLOATS),
      coords: new TexelWrites(2),
      rowStyles: new TexelWrites(ROWS_ROW_STYLE_FLOATS),
    };
    chunk.writes[target].write(texel, source, at);
    this.patched.add(chunk);
  }

  /** Releases a chunk (and its palette, when the palette is retired and this was its last) */
  disposeChunk(chunk: RowsChunk): void {
    if (chunk.disposed) return;
    chunk.disposed = true;
    this.copies?.disposed(chunk);
    this.queued.delete(chunk);
    this.patched.delete(chunk);
    const gl = this.gl;
    if (chunk.vao) gl.deleteVertexArray(chunk.vao);
    for (const buffer of [chunk.instanceBuffer, chunk.pointBuffer]) {
      if (!buffer) continue;
      this.ledger?.release(buffer);
      gl.deleteBuffer(buffer);
    }
    for (const texture of [chunk.coords, chunk.rowStyles]) {
      if (!texture) continue;
      this.ledger?.release(texture.texture);
      gl.deleteTexture(texture.texture);
    }
    chunk.vao = null;
    chunk.instanceBuffer = null;
    chunk.pointBuffer = null;
    chunk.coords = null;
    chunk.rowStyles = null;
    chunk.uploaded = false;
    const palette = chunk.data.palette;
    // The rows of the chunk no longer use their styles
    palette.releaseAll(chunk.data.rowStyle);
    palette.refs--;
    this.releasePalette(palette);
  }

  /**
   * Retires a palette: no chunk is built with it any more, and it is released with the last
   * chunk built with it
   */
  retirePalette(palette: RowsPalette): void {
    palette.retired = true;
    this.releasePalette(palette);
  }

  // === Drawing ===

  /**
   * Draws the rows `[fromRow, toRow)` of a chunk, in one draw
   *
   * @param rowState The state of the rows of the group of the chunk
   * @param factors The factors of the drawing (the opacity of the layer)
   */
  drawRange(
    chunk: RowsChunk,
    fromRow: number,
    toRow: number,
    zoom: number,
    projectionData: ProjectionData,
    rowState: RowStateBinding,
    factors: RetainedDrawFactors = NEUTRAL_DRAW_FACTORS,
  ): void {
    const program = this.current;
    if (!chunk.uploaded || !program || !this.poll(program)) return;
    const data = chunk.data;
    const first = data.rowFirst[fromRow];
    const count = data.rowFirst[toRow] - first;
    if (count <= 0 || !chunk.vao || !data.palette.gpu || !chunk.coords || !chunk.rowStyles) return;

    const gl = this.gl;
    const run = this.run;
    run.useProgram(program.program);
    const camera = this.offsetUniforms;
    if (camera) {
      this.originShift[0] = data.origin[0] - camera.centerLngLat[0];
      this.originShift[1] = data.origin[1] - camera.centerLngLat[1];
      program.projection.setUniforms(projectionData, camera, this.originShift);
    } else {
      program.projection.setUniforms(
        projectionData,
        calculateOffsetUniforms(data.origin, projectionData),
      );
    }
    this.writeUniforms(program, chunk, zoom, factors);
    bindRowState(
      run,
      program.rowState as RowStateUniforms,
      rowState,
      data.origin,
      camera ? camera.centerLngLat : data.origin,
    );
    this.bindTextures(chunk);

    run.bindVertexArray(chunk.vao);
    if (chunk.pointedFirst !== first) {
      gl.bindBuffer(gl.ARRAY_BUFFER, chunk.instanceBuffer);
      pointInstanceAttribs(gl, first, false);
      chunk.pointedFirst = first;
    }
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);
    run.release();
  }

  /** Releases every program, chunk and texture */
  dispose(): void {
    const gl = this.gl;
    for (const chunk of [...this.queued]) this.disposeChunk(chunk);
    for (const program of this.programs.values()) {
      if (program.vertex) gl.deleteShader(program.vertex);
      if (program.fragment) gl.deleteShader(program.fragment);
      gl.deleteProgram(program.program);
    }
    this.programs.clear();
    this.current = null;
    for (const palette of this.palettes) this.deletePaletteTexture(palette);
    this.palettes.clear();
    if (this.cornerBuffer) {
      this.ledger?.release(this.cornerBuffer);
      gl.deleteBuffer(this.cornerBuffer);
    }
    if (this.emptySprites) {
      this.ledger?.release(this.emptySprites);
      gl.deleteTexture(this.emptySprites);
    }
    this.emptySprites = null;
  }

  // === Programs ===

  private startProgram(shaderData: ShaderData): RowsProgram {
    const gl = this.gl;
    const vertex = gl.createShader(gl.VERTEX_SHADER) as WebGLShader;
    gl.shaderSource(
      vertex,
      withSamplerPrecision(
        buildRowsVertexSource(shaderData.vertexShaderPrelude, shaderData.define),
      ),
    );
    gl.compileShader(vertex);
    const fragment = gl.createShader(gl.FRAGMENT_SHADER) as WebGLShader;
    gl.shaderSource(fragment, withSamplerPrecision(buildRowsFragmentSource()));
    gl.compileShader(fragment);
    const program = gl.createProgram() as WebGLProgram;
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    return {
      program,
      vertex,
      fragment,
      state: 'compiling',
      locations: null,
      projection: new ProjectionUniformManager(gl, { surface: true }).useTerrainState(this.terrain),
      rowState: null,
      memo: emptyMemo(),
    };
  }

  /** Whether a program can draw: asks the context once it is done compiling */
  private poll(program: RowsProgram): boolean {
    if (program.state === 'linked') return true;
    if (program.state === 'failed') return false;
    const gl = this.gl;
    if (this.parallel && !gl.getProgramParameter(program.program, COMPLETION_STATUS_KHR)) {
      return false;
    }
    if (!gl.getProgramParameter(program.program, gl.LINK_STATUS)) {
      const log = [
        program.vertex ? gl.getShaderInfoLog(program.vertex) : '',
        program.fragment ? gl.getShaderInfoLog(program.fragment) : '',
        gl.getProgramInfoLog(program.program),
      ]
        .filter((text) => text)
        .join('\n');
      console.error(`The program of the rows did not link: ${log}`);
      program.state = 'failed';
      this.releaseShaders(program);
      return false;
    }
    this.releaseShaders(program);
    program.locations = locationsOf(gl, program.program);
    program.projection.getLocations(program.program);
    program.rowState = new RowStateUniforms(gl, program.program);
    program.state = 'linked';
    return true;
  }

  private releaseShaders(program: RowsProgram): void {
    const gl = this.gl;
    if (program.vertex) gl.deleteShader(program.vertex);
    if (program.fragment) gl.deleteShader(program.fragment);
    program.vertex = null;
    program.fragment = null;
  }

  /** Writes the uniforms of a draw (those of the frame once per frame, the others when changed) */
  private writeUniforms(
    program: RowsProgram,
    chunk: RowsChunk,
    zoom: number,
    factors: RetainedDrawFactors,
  ): void {
    const gl = this.gl;
    const locations = program.locations as RowsUniformLocations;
    const memo = program.memo;
    const frame = getRenderFrame();
    const stale = memo.frame !== frame;
    if (stale) {
      memo.frame = frame;
      if (locations.coords) gl.uniform1i(locations.coords, UNIT_COORDS);
      if (locations.rowStyles) gl.uniform1i(locations.rowStyles, UNIT_ROW_STYLES);
      if (locations.styles) gl.uniform1i(locations.styles, UNIT_STYLES);
      if (locations.sprites) gl.uniform1i(locations.sprites, UNIT_SPRITES);
      if (locations.styleWidth) gl.uniform1i(locations.styleWidth, ROWS_STYLE_WIDTH);
      if (locations.viewport) {
        gl.uniform2f(locations.viewport, gl.drawingBufferWidth, gl.drawingBufferHeight);
      }
      if (locations.pixelToClip) {
        gl.uniform2f(locations.pixelToClip, 2 / gl.drawingBufferWidth, 2 / gl.drawingBufferHeight);
      }
      if (locations.miterLimit) gl.uniform1f(locations.miterLimit, ROWS_MITER_LIMIT);
      if (locations.screenRatio) {
        gl.uniform1f(locations.screenRatio, resolvePixelRatio(this.pixelRatio));
      }
      if (locations.cameraToCenterW) {
        gl.uniform1f(locations.cameraToCenterW, this.offsetUniforms?.projectionCenter[3] ?? 0);
      }
      if (locations.bearing) gl.uniform1f(locations.bearing, this.frameBearing());
      // The back faces of the fills are kept on a flat map (the terrain discards them)
      if (locations.cullBack) gl.uniform1f(locations.cullBack, 0);
    }
    if (locations.zoom && (stale || memo.zoom !== zoom)) {
      gl.uniform1f(locations.zoom, zoom);
      memo.zoom = zoom;
    }
    if (locations.sizeScale && (stale || memo.scale !== factors.scale)) {
      gl.uniform1f(locations.sizeScale, factors.scale);
      memo.scale = factors.scale;
    }
    if (locations.opacity && (stale || memo.opacity !== factors.opacity)) {
      gl.uniform1f(locations.opacity, factors.opacity);
      memo.opacity = factors.opacity;
    }
    const coordWidth = (chunk.coords as SizedTexture).width;
    if (locations.coordWidth && (stale || memo.coordWidth !== coordWidth)) {
      gl.uniform1i(locations.coordWidth, coordWidth);
      memo.coordWidth = coordWidth;
    }
    const rowStyleWidth = (chunk.rowStyles as SizedTexture).width;
    if (locations.rowStyleWidth && (stale || memo.rowStyleWidth !== rowStyleWidth)) {
      gl.uniform1i(locations.rowStyleWidth, rowStyleWidth);
      memo.rowStyleWidth = rowStyleWidth;
    }
    const rowBase = chunk.data.rowBase;
    if (locations.rowBase && (stale || memo.rowBase !== rowBase)) {
      gl.uniform1i(locations.rowBase, rowBase);
      memo.rowBase = rowBase;
    }
    const scale = chunk.data.sprites?.distanceScale;
    const spriteScale = scale ? `${scale.base},${scale.factor},${scale.min},${scale.max}` : '';
    if (locations.spriteScale && (stale || memo.spriteScale !== spriteScale)) {
      if (scale) {
        gl.uniform4f(locations.spriteScale, scale.base, scale.factor, scale.min, scale.max);
      } else {
        gl.uniform4f(locations.spriteScale, 1, 0, 1, 1);
      }
      memo.spriteScale = spriteScale;
    }
    const premultiplied = chunk.data.sprites?.premultipliedAlpha === true ? 1 : 0;
    if (locations.spritePremultiplied && (stale || memo.spritePremultiplied !== premultiplied)) {
      gl.uniform1f(locations.spritePremultiplied, premultiplied);
      memo.spritePremultiplied = premultiplied;
    }
  }

  /** The bearing of the map, read once per frame */
  private frameBearing(): number {
    const frame = getRenderFrame();
    if (this.bearingFrame !== frame) {
      this.bearingFrame = frame;
      this.bearing = this.map?.getBearing?.() ?? 0;
    }
    return this.bearing;
  }

  /**
   * Binds the textures of a chunk: on their units, then the unit 0 active again (what the run of
   * the draws expects), skipping in a run what the last draw of the run bound on the units only
   * this renderer uses
   */
  private bindTextures(chunk: RowsChunk): void {
    const gl = this.gl;
    const run = this.run;
    const bound = this.bound;
    const epoch = run.isOpen ? run.epoch : -1;
    if (epoch < 0 || bound.epoch !== epoch) {
      bound.epoch = epoch;
      bound.rowStyles = null;
      bound.styles = null;
      bound.sprites = null;
    }
    const data = chunk.data;
    const rowStyles = (chunk.rowStyles as SizedTexture).texture;
    const styles = (data.palette.gpu as SizedTexture).texture;
    // The unit of the pictures is always given one of this renderer's textures (also for a chunk
    // without pictures): a texture left there by other drawing could be the one drawn into
    const sprites = data.sprites?.texture ?? this.emptySprites;
    let unitMoved = false;
    if (bound.rowStyles !== rowStyles) {
      gl.activeTexture(gl.TEXTURE0 + UNIT_ROW_STYLES);
      gl.bindTexture(gl.TEXTURE_2D, rowStyles);
      bound.rowStyles = rowStyles;
      unitMoved = true;
    }
    if (bound.styles !== styles) {
      gl.activeTexture(gl.TEXTURE0 + UNIT_STYLES);
      gl.bindTexture(gl.TEXTURE_2D, styles);
      bound.styles = styles;
      unitMoved = true;
    }
    if (sprites && bound.sprites !== sprites) {
      gl.activeTexture(gl.TEXTURE0 + UNIT_SPRITES);
      gl.bindTexture(gl.TEXTURE_2D, sprites);
      bound.sprites = sprites;
      unitMoved = true;
    }
    if (unitMoved) gl.activeTexture(gl.TEXTURE0);
    // The coordinates on the unit 0, which the renderers by kind bind their own to in the same
    // run: bound for every draw
    run.activateUnitZero();
    gl.bindTexture(gl.TEXTURE_2D, (chunk.coords as SizedTexture).texture);
    if (epoch < 0) bound.epoch = -1;
  }

  /**
   * Makes the transparent picture of one texel drawn for sprites whose texture is not there (and
   * bound for the chunks without sprites), once, with the uploads
   */
  private ensureEmptySprites(): void {
    if (this.emptySprites) return;
    const gl = this.gl;
    const texture = gl.createTexture();
    if (!texture) return;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
    gl.bindTexture(gl.TEXTURE_2D, null);
    this.ledger?.record(texture, LEDGER_OWNER, 'texture', 4);
    this.emptySprites = texture;
  }

  // === Uploads ===

  /**
   * Writes the lines of the texture of a palette written since the last upload, growing the
   * texture as needed (a new texture is written whole)
   */
  private uploadPalette(palette: RowsPalette): void {
    const gl = this.gl;
    const texels = palette.count * ROWS_STYLE_TEXELS;
    const height = Math.max(1, Math.ceil(texels / ROWS_STYLE_WIDTH));
    if (!palette.gpu || palette.gpu.height < height) {
      // A new texture with room for twice the lines, written whole
      const lines = Math.max(height, (palette.gpu?.height ?? 0) * 2, 1);
      this.deletePaletteTexture(palette);
      const texture = createFloatTexture(gl, gl.RGBA32F, ROWS_STYLE_WIDTH, lines);
      if (!texture) return;
      this.ledger?.record(
        texture,
        LEDGER_OWNER,
        'texture',
        textureBytes(ROWS_STYLE_WIDTH, lines, 16),
      );
      palette.gpu = { texture, width: ROWS_STYLE_WIDTH, height: lines };
      for (let line = 0; line < height; line++) palette.dirty.add(line);
    }
    const lineFloats = ROWS_STYLE_WIDTH * 4;
    gl.bindTexture(gl.TEXTURE_2D, palette.gpu.texture);
    // The lines written, the runs of them next to each other in one upload each
    const lines = [...palette.dirty].filter((line) => line < height).sort((a, b) => a - b);
    for (let i = 0; i < lines.length; ) {
      let j = i + 1;
      while (j < lines.length && lines[j] === lines[j - 1] + 1) j++;
      const first = lines[i];
      const count = lines[j - 1] - first + 1;
      gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,
        0,
        first,
        ROWS_STYLE_WIDTH,
        count,
        gl.RGBA,
        gl.FLOAT,
        paddedRange(palette.values, first * lineFloats, (first + count) * lineFloats),
      );
      this.uploadedBytes += count * lineFloats * 4;
      i = j;
    }
    gl.bindTexture(gl.TEXTURE_2D, null);
    this.copies?.paletteUploaded(palette, lines);
    palette.dirty.clear();
  }

  private releasePalette(palette: RowsPalette): void {
    if (!palette.retired || palette.refs > 0) return;
    this.deletePaletteTexture(palette);
    this.palettes.delete(palette);
  }

  private deletePaletteTexture(palette: RowsPalette): void {
    if (!palette.gpu) return;
    this.ledger?.release(palette.gpu.texture);
    this.gl.deleteTexture(palette.gpu.texture);
    palette.gpu = null;
  }

  /** Writes a chunk: its buffers, its textures and its vertex array */
  private uploadChunk(chunk: RowsChunk): void {
    const data = chunk.packed;
    if (chunk.disposed || !data) return;
    const gl = this.gl;

    const instances = data.instances.subarray(0, data.instanceCount * ROWS_INSTANCE_FLOATS);
    const instanceBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, instanceBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, instances, gl.STATIC_DRAW);
    this.ledger?.record(instanceBuffer, LEDGER_OWNER, 'buffer', instances.byteLength);
    this.uploadedBytes += instances.byteLength;
    chunk.instanceBuffer = instanceBuffer;

    if (data.pointCount > 0) {
      const points = data.points.subarray(0, data.pointCount * ROWS_INSTANCE_FLOATS);
      const pointBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, pointBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, points, gl.STATIC_DRAW);
      this.ledger?.record(pointBuffer, LEDGER_OWNER, 'buffer', points.byteLength);
      this.uploadedBytes += points.byteLength;
      chunk.pointBuffer = pointBuffer;
    }

    chunk.coords = this.uploadTexture(
      gl.RG32F,
      gl.RG,
      2,
      data.coords,
      data.coordCount,
      ROWS_COORD_WIDTH,
    );
    chunk.rowStyles = this.uploadTexture(
      gl.RGBA32F,
      gl.RGBA,
      ROWS_ROW_STYLE_FLOATS,
      data.rowStyles,
      data.rows,
      ROWS_ROW_STYLE_WIDTH,
    );

    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.cornerBuffer);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 1, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, instanceBuffer);
    pointInstanceAttribs(gl, 0, true);
    gl.bindVertexArray(null);
    chunk.vao = vao;
    chunk.pointedFirst = 0;

    chunk.uploaded = true;
    // The packed arrays are on the GPU: the chunk keeps none of them (the copies of the checks
    // keep them as the GPU holds them)
    this.copies?.uploaded(chunk, data);
    chunk.packed = null;
  }

  /** Makes a float texture of `count` texels of `floats` floats and writes them */
  private uploadTexture(
    internalFormat: number,
    format: number,
    floats: number,
    values: Float32Array,
    count: number,
    widest: number,
  ): SizedTexture | null {
    const gl = this.gl;
    const width = Math.max(1, Math.min(widest, count));
    const height = Math.max(1, Math.ceil(count / width));
    const texture = createFloatTexture(gl, internalFormat, width, height);
    if (!texture) return null;
    this.ledger?.record(texture, LEDGER_OWNER, 'texture', textureBytes(width, height, floats * 4));
    this.uploadedBytes += width * height * floats * 4;
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      0,
      0,
      width,
      height,
      format,
      gl.FLOAT,
      paddedRange(values, 0, width * height * floats),
    );
    gl.bindTexture(gl.TEXTURE_2D, null);
    return { texture, width, height };
  }

  /**
   * Uploads the writes in place of a chunk: each run of texels written that follow each other on
   * a line of a texture once (a line written many times in a frame is uploaded once, and only the
   * texels written), and each run of instances written that follow each other once
   */
  private uploadPatches(chunk: RowsChunk): void {
    const writes = chunk.writes;
    if (chunk.disposed || !chunk.uploaded || !writes) return;
    this.copies?.patched(chunk, writes);
    const gl = this.gl;
    const buffer = (target: WebGLBuffer | null, values: TexelWrites): void => {
      if (values.size === 0) return;
      if (!target) {
        values.clear();
        return;
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, target);
      values.drain(Number.POSITIVE_INFINITY, (_line, first, run) => {
        gl.bufferSubData(gl.ARRAY_BUFFER, first * ROWS_INSTANCE_BYTES, run);
        this.uploadedBytes += run.byteLength;
      });
    };
    buffer(chunk.instanceBuffer, writes.instances);
    buffer(chunk.pointBuffer, writes.points);
    const texture = (target: SizedTexture | null, format: number, values: TexelWrites): void => {
      if (values.size === 0) return;
      if (!target) {
        values.clear();
        return;
      }
      gl.bindTexture(gl.TEXTURE_2D, target.texture);
      values.drain(target.width, (line, first, run) => {
        gl.texSubImage2D(
          gl.TEXTURE_2D,
          0,
          first,
          line,
          run.length / values.floats,
          1,
          format,
          gl.FLOAT,
          run,
        );
        this.uploadedBytes += run.byteLength;
      });
      gl.bindTexture(gl.TEXTURE_2D, null);
    };
    texture(chunk.coords, gl.RG, writes.coords);
    texture(chunk.rowStyles, gl.RGBA, writes.rowStyles);
  }
}

/** What a chunk keeps of its packed arrays (not the arrays written to the GPU) */
function layoutOf(data: RowsChunkData): RowsChunkLayout {
  return {
    origin: data.origin,
    rowBase: data.rowBase,
    rows: data.rows,
    instanceCount: data.instanceCount,
    pointCount: data.pointCount,
    coordCount: data.coordCount,
    rowFirst: data.rowFirst,
    pointFirst: data.pointFirst,
    coordFirst: data.coordFirst,
    rowStyle: data.rowStyle,
    palette: data.palette,
    sprites: data.sprites,
  };
}

/**
 * Points the instance attributes of the bound vertex array at the bound instance buffer, from
 * instance `first`
 */
function pointInstanceAttribs(gl: WebGL2RenderingContext, first: number, setup: boolean): void {
  const base = first * ROWS_INSTANCE_BYTES;
  // The tag (the kind and the row): an integer attribute, read as the integer it is
  if (setup) gl.enableVertexAttribArray(1);
  gl.vertexAttribIPointer(1, 1, gl.UNSIGNED_INT, ROWS_INSTANCE_BYTES, base);
  if (setup) gl.vertexAttribDivisor(1, 1);
  // The coordinates 0 to 2, and coordinate 3 with the range of the segment and the length before
  for (const [location, size, offset] of [
    [2, 3, 4],
    [3, 4, 16],
  ] as const) {
    if (setup) gl.enableVertexAttribArray(location);
    gl.vertexAttribPointer(location, size, gl.FLOAT, false, ROWS_INSTANCE_BYTES, base + offset);
    if (setup) gl.vertexAttribDivisor(location, 1);
  }
}

/** The uniforms of the program */
function locationsOf(gl: WebGL2RenderingContext, program: WebGLProgram): RowsUniformLocations {
  const at = (name: string) => gl.getUniformLocation(program, name);
  return {
    coords: at('u_coords'),
    coordWidth: at('u_coord_width'),
    rowStyles: at('u_row_styles'),
    rowStyleWidth: at('u_row_style_width'),
    rowBase: at('u_row_base'),
    styles: at('u_styles'),
    styleWidth: at('u_style_width'),
    viewport: at('u_viewport'),
    zoom: at('u_zoom'),
    miterLimit: at('u_miter_limit'),
    sizeScale: at('u_size_scale'),
    pixelToClip: at('u_pixel_to_clip'),
    screenRatio: at('u_screen_ratio'),
    cameraToCenterW: at('u_camera_to_center_w'),
    bearing: at('u_bearing'),
    spriteScale: at('u_sprite_scale'),
    opacity: at('u_opacity'),
    cullBack: at('u_cull_back'),
    sprites: at('u_sprites'),
    spritePremultiplied: at('u_sprite_premultiplied'),
  };
}

/**
 * Makes a float texture read with `texelFetch` (bound to the active unit when it returns)
 */
function createFloatTexture(
  gl: WebGL2RenderingContext,
  internalFormat: number,
  width: number,
  height: number,
): WebGLTexture | null {
  const texture = gl.createTexture();
  if (!texture) return null;
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texStorage2D(gl.TEXTURE_2D, 1, internalFormat, width, height);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return texture;
}

/**
 * The floats `[from, to)` of an array, padded with zeros past its end (an upload of whole lines
 * of a texture reads past the last value)
 */
function paddedRange(values: Float32Array, from: number, to: number): Float32Array {
  if (to <= values.length) return values.subarray(from, to);
  const out = new Float32Array(to - from);
  if (from < values.length) out.set(values.subarray(from));
  return out;
}
