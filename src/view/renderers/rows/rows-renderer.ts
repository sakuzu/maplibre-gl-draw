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
import {
  ROWS_COORD_WIDTH,
  ROWS_INSTANCE_BYTES,
  ROWS_INSTANCE_FLOATS,
  ROWS_ROW_STYLE_FLOATS,
  ROWS_ROW_STYLE_WIDTH,
  ROWS_STYLE_TEXELS,
  ROWS_STYLE_WIDTH,
  type RowsChunkData,
  type RowsPalette,
} from './rows-format.js';
import { buildRowsFragmentSource, buildRowsVertexSource, ROWS_MITER_LIMIT } from './rows-shader.js';

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
  /** The packed arrays (kept for the writes in place) */
  readonly data: RowsChunkData;
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
  /** The coordinates written in place and not uploaded yet, as `[from, to)` pairs */
  readonly coordPatches: number[];
  /** The rows whose style was written in place and not uploaded yet, as `[from, to)` pairs */
  readonly rowStylePatches: number[];
  disposed: boolean;
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
  };
}

/** The textures bound last in a run of draws, and the epoch of the run they were bound in */
interface BoundTextures {
  epoch: number;
  coords: WebGLTexture | null;
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
    coords: null,
    rowStyles: null,
    styles: null,
    sprites: null,
  };
  private readonly originShift: [number, number] = [0, 0];
  private bearingFrame = -1;
  private bearing = 0;

  constructor(
    map: MapLibreMap | null,
    gl: WebGL2RenderingContext,
    pixelRatio?: PixelRatioInput,
    terrain: TerrainContext = new TerrainContext(),
    ledger?: GpuLedger,
  ) {
    this.gl = gl;
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
      data,
      uploaded: false,
      vao: null,
      instanceBuffer: null,
      pointBuffer: null,
      coords: null,
      rowStyles: null,
      pointedFirst: -1,
      coordPatches: [],
      rowStylePatches: [],
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
      if (palette.uploaded < palette.count) return true;
    }
    return false;
  }

  /**
   * Writes what is queued to the GPU: the values of the styles added, the chunks made, the writes
   * in place. Called before the main pass of the frame
   */
  flushUploads(): void {
    for (const palette of this.palettes) {
      if (palette.uploaded < palette.count) this.uploadPalette(palette);
    }
    for (const chunk of this.queued) this.uploadChunk(chunk);
    this.queued.clear();
    for (const chunk of this.patched) this.uploadPatches(chunk);
    this.patched.clear();
  }

  /**
   * Writes rows of a chunk in place: rows packed again whose instances are the ones the chunk
   * holds (the same kinds and coordinates numbered alike), with new coordinates and styles. The
   * write reaches the GPU with the next `flushUploads`
   *
   * @param fromRow The first row written, in the chunk
   * @param patch The rows `[fromRow, fromRow + patch.rows)` packed again on their own, with the
   *   palette of the chunk
   * @returns false when the rows do not have the same instances (nothing is written: the rows
   *   have to be built again)
   */
  patchRows(chunk: RowsChunk, fromRow: number, patch: RowsChunkData): boolean {
    const data = chunk.data;
    const toRow = fromRow + patch.rows;
    if (chunk.disposed || fromRow < 0 || toRow > data.rows || patch.palette !== data.palette) {
      return false;
    }
    const firstInstance = data.rowFirst[fromRow];
    const instances = data.rowFirst[toRow] - firstInstance;
    const firstCoord = data.coordFirst[fromRow];
    const coords = data.coordFirst[toRow] - firstCoord;
    if (
      patch.instanceCount !== instances ||
      patch.coordCount !== coords ||
      patch.pointCount !== data.pointFirst[toRow] - data.pointFirst[fromRow]
    ) {
      return false;
    }
    for (let r = 0; r <= patch.rows; r++) {
      if (patch.rowFirst[r] !== data.rowFirst[fromRow + r] - firstInstance) return false;
      if (patch.coordFirst[r] !== data.coordFirst[fromRow + r] - firstCoord) return false;
    }
    // Every instance the same, but for the shift of the numbers of the coordinates
    for (let i = 0; i < instances; i++) {
      const a = (firstInstance + i) * ROWS_INSTANCE_FLOATS;
      const b = i * ROWS_INSTANCE_FLOATS;
      for (let k = 0; k < ROWS_INSTANCE_FLOATS; k++) {
        const held = data.instances[a + k];
        let packed = patch.instances[b + k];
        if (k >= 1 && k <= 4 && packed >= 0) packed += firstCoord;
        if (held !== packed) return false;
      }
    }
    data.coords.set(patch.coords.subarray(0, coords * 2), firstCoord * 2);
    data.rowStyles.set(
      patch.rowStyles.subarray(0, patch.rows * ROWS_ROW_STYLE_FLOATS),
      fromRow * ROWS_ROW_STYLE_FLOATS,
    );
    if (coords > 0) chunk.coordPatches.push(firstCoord, firstCoord + coords);
    if (patch.rows > 0) chunk.rowStylePatches.push(fromRow, toRow);
    if (chunk.uploaded) this.patched.add(chunk);
    return true;
  }

  /** Releases a chunk (and its palette, when the palette is retired and this was its last) */
  disposeChunk(chunk: RowsChunk): void {
    if (chunk.disposed) return;
    chunk.disposed = true;
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
      program.projection.setUniforms(projectionData, zoom, camera, this.originShift);
    } else {
      program.projection.setUniforms(
        projectionData,
        zoom,
        calculateOffsetUniforms(data.origin, projectionData.mainMatrix as unknown as Float32Array),
      );
    }
    this.writeUniforms(program, chunk, zoom, factors);
    bindRowState(run, program.rowState as RowStateUniforms, rowState);
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
    if (this.emptySprites) gl.deleteTexture(this.emptySprites);
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
   * the draws expects), skipping in a run what the last draw of the run bound
   */
  private bindTextures(chunk: RowsChunk): void {
    const gl = this.gl;
    const run = this.run;
    const bound = this.bound;
    const epoch = run.isOpen ? run.epoch : -1;
    if (epoch < 0 || bound.epoch !== epoch) {
      bound.epoch = epoch;
      bound.coords = null;
      bound.rowStyles = null;
      bound.styles = null;
      bound.sprites = null;
    }
    const data = chunk.data;
    const rowStyles = (chunk.rowStyles as SizedTexture).texture;
    const styles = (data.palette.gpu as SizedTexture).texture;
    const sprites = data.sprites ? (data.sprites.texture ?? this.emptySpriteTexture()) : null;
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
    run.activateUnitZero();
    const coords = (chunk.coords as SizedTexture).texture;
    if (bound.coords !== coords) {
      gl.bindTexture(gl.TEXTURE_2D, coords);
      bound.coords = coords;
    }
    if (epoch < 0) bound.epoch = -1;
  }

  /** A transparent picture of one texel (for sprites whose texture is not there) */
  private emptySpriteTexture(): WebGLTexture | null {
    if (this.emptySprites) return this.emptySprites;
    const gl = this.gl;
    const texture = gl.createTexture();
    if (!texture) return null;
    gl.activeTexture(gl.TEXTURE0 + UNIT_SPRITES);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
    gl.activeTexture(gl.TEXTURE0);
    this.emptySprites = texture;
    return texture;
  }

  // === Uploads ===

  /** Writes the styles of a palette its texture does not hold, growing the texture as needed */
  private uploadPalette(palette: RowsPalette): void {
    const gl = this.gl;
    const texels = palette.count * ROWS_STYLE_TEXELS;
    const height = Math.max(1, Math.ceil(texels / ROWS_STYLE_WIDTH));
    let from = palette.uploaded;
    if (!palette.gpu || palette.gpu.height < height) {
      // A new texture with room for twice the lines, written from the first style
      this.deletePaletteTexture(palette);
      const lines = Math.max(height, (palette.gpu?.height ?? 0) * 2, 1);
      const texture = createFloatTexture(gl, gl.RGBA32F, ROWS_STYLE_WIDTH, lines);
      if (!texture) return;
      this.ledger?.record(
        texture,
        LEDGER_OWNER,
        'texture',
        textureBytes(ROWS_STYLE_WIDTH, lines, 16),
      );
      palette.gpu = { texture, width: ROWS_STYLE_WIDTH, height: lines };
      from = 0;
    }
    const firstLine = Math.floor((from * ROWS_STYLE_TEXELS) / ROWS_STYLE_WIDTH);
    const lineFloats = ROWS_STYLE_WIDTH * 4;
    const data = paddedRange(palette.values, firstLine * lineFloats, height * lineFloats);
    gl.bindTexture(gl.TEXTURE_2D, palette.gpu.texture);
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      0,
      firstLine,
      ROWS_STYLE_WIDTH,
      height - firstLine,
      gl.RGBA,
      gl.FLOAT,
      data,
    );
    gl.bindTexture(gl.TEXTURE_2D, null);
    palette.uploaded = palette.count;
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
    palette.uploaded = 0;
  }

  /** Writes a chunk: its buffers, its textures and its vertex array */
  private uploadChunk(chunk: RowsChunk): void {
    if (chunk.disposed) return;
    const gl = this.gl;
    const data = chunk.data;

    const instances = data.instances.subarray(0, data.instanceCount * ROWS_INSTANCE_FLOATS);
    const instanceBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, instanceBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, instances, gl.STATIC_DRAW);
    this.ledger?.record(instanceBuffer, LEDGER_OWNER, 'buffer', instances.byteLength);
    chunk.instanceBuffer = instanceBuffer;

    if (data.pointCount > 0) {
      const points = data.points.subarray(0, data.pointCount * ROWS_INSTANCE_FLOATS);
      const pointBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, pointBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, points, gl.STATIC_DRAW);
      this.ledger?.record(pointBuffer, LEDGER_OWNER, 'buffer', points.byteLength);
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

    // The writes in place made before the upload are in the arrays already
    chunk.coordPatches.length = 0;
    chunk.rowStylePatches.length = 0;
    chunk.uploaded = true;
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

  /** Uploads the writes in place of a chunk (the lines of its textures they touch) */
  private uploadPatches(chunk: RowsChunk): void {
    if (chunk.disposed || !chunk.uploaded) return;
    const gl = this.gl;
    const data = chunk.data;
    const write = (
      texture: SizedTexture | null,
      format: number,
      floats: number,
      values: Float32Array,
      ranges: number[],
    ): void => {
      if (!texture) return;
      gl.bindTexture(gl.TEXTURE_2D, texture.texture);
      for (let i = 0; i < ranges.length; i += 2) {
        const firstLine = Math.floor(ranges[i] / texture.width);
        const lastLine = Math.floor((ranges[i + 1] - 1) / texture.width);
        const lineFloats = texture.width * floats;
        gl.texSubImage2D(
          gl.TEXTURE_2D,
          0,
          0,
          firstLine,
          texture.width,
          lastLine - firstLine + 1,
          format,
          gl.FLOAT,
          paddedRange(values, firstLine * lineFloats, (lastLine + 1) * lineFloats),
        );
      }
      gl.bindTexture(gl.TEXTURE_2D, null);
    };
    write(chunk.coords, gl.RG, 2, data.coords, chunk.coordPatches);
    write(chunk.rowStyles, gl.RGBA, ROWS_ROW_STYLE_FLOATS, data.rowStyles, chunk.rowStylePatches);
    chunk.coordPatches.length = 0;
    chunk.rowStylePatches.length = 0;
  }
}

/**
 * Points the instance attributes of the bound vertex array at the bound instance buffer, from
 * instance `first`
 */
function pointInstanceAttribs(gl: WebGL2RenderingContext, first: number, setup: boolean): void {
  const base = first * ROWS_INSTANCE_BYTES;
  for (const [location, offset] of [
    [1, 0],
    [2, 16],
  ] as const) {
    if (setup) gl.enableVertexAttribArray(location);
    gl.vertexAttribPointer(location, 4, gl.FLOAT, false, ROWS_INSTANCE_BYTES, base + offset);
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
