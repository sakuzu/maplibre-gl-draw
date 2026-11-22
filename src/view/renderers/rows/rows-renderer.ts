// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The renderer that draws rows of every kind in one draw (`RowsRenderer`)
 *
 * A chunk of rows is one instance buffer, one texture of its coordinates and one texture of the
 * styles of its rows (`rows-format.ts`), drawn by one program in one draw whatever kinds its rows
 * are. A range of its rows is one range of its instances: the instance attributes are pointed at
 * the first instance of the range and the draw is given the count, so a chunk is drawn in parts at
 * the cost of one more draw per cut, with the same program and textures.
 *
 * Nothing is written to the GPU while the frame is drawn. The chunks, the values of the styles
 * and the writes in place are queued, and written by `flushUploads`, which the frame calls before
 * maplibre starts its main pass (`prerender`): a texture written in the middle of the pass makes
 * a tiled GPU store and reload the frame. A chunk is drawn from the frame after it was written.
 *
 * On the terrain and on the globe a chunk packed for the surface is drawn with the stations of the
 * lines (`resolveLineStations`): every instance is drawn as a strip of `2 * (stations + 1)`
 * vertices, the stations of its longest segment bounded by its instances, as a batch of lines is;
 * a segment takes the stations a batch of its line alone takes (from the longest segment of its
 * line), at most those, and repeats its last station past them; the other kinds repeat their last
 * corner. Its fills drop the faces turned away from the camera while
 * the terrain is drawn, as the fills of the polygons do (`drawFillWithTerrainCull`).
 *
 * The program is made for the projection of the frame (`ensureShader`, as the other renderers
 * make theirs). When it cannot be made (`failed`), the side that draws the rows draws them another
 * way.
 *
 * Everything it holds on the GPU is in the ledger of its instance, under the part of the rows
 * (`rows`): the chunks, the values of the styles of each layer, the corners of the strip and the
 * program. A chunk can be made under a part that gives way instead (the chunks of the points of
 * the frames the analytic drape paints, under `drape`): it is written only when it fits in the
 * share of the parts that give way (`fits`), and is refused otherwise (`refused`), drawing nothing;
 * the side that draws the rows draws them another way then.
 *
 * On a frame the drape paints, the points of a chunk packed for the surface take the test of the
 * terrain hiding them from the camera (`rows-occlusion.ts`; `drawRange` with `ghosts`).
 */

import type { ProjectionData } from 'maplibre-gl';
import { RENDERING_DEFAULTS } from '../../../shared/math/index.js';
import { globeGridOf } from '../../globe-subdivision.js';
import { type GpuLedger, giveStorage, textureBytes } from '../../gpu-ledger.js';
import { getRenderFrame } from '../../shaders/frame.js';
import {
  calculateOffsetUniforms,
  createProgram,
  type OffsetUniforms,
  type ShaderData,
} from '../../shaders/helpers.js';
import { ProjectionUniformManager } from '../../shaders/projection.js';
import { TerrainContext } from '../../terrain/context.js';
import { NEUTRAL_DRAW_FACTORS, type RetainedDrawFactors } from '../draw-factors.js';
import {
  lineStationsOnMercatorPlane,
  MAX_LINE_STATIONS,
  resolveLineStations,
} from '../line/line-geometry.js';
import { type RowStateTexture, RowStateUniforms } from '../row-state.js';
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
import { TerrainOcclusionUniforms } from './rows-occlusion.js';
import { buildRowsFragmentSource, buildRowsVertexSource } from './rows-shader.js';
import { TexelWrites } from './rows-writes.js';

/** The texture units of the program (the state of the rows is on its own unit, 1) */
const UNIT_COORDS = 0;
const UNIT_ROW_STYLES = 2;
const UNIT_STYLES = 3;

/** The part the GPU memory of this renderer is recorded under in the ledger (row data) */
export const ROWS_PART = 'rows';

/**
 * The part that gives way the chunks of the points of the frames the analytic drape paints are
 * recorded under: they are the work of the drape (with them, its frames draw the points from their
 * rows) and are held in the share of the parts that give way
 */
export const DRAPED_ROWS_PART = 'drape';

/**
 * The vertices of the strip every instance is drawn with: as many as the most stations of a
 * segment take (a flat map draws the first 4, the corners of a quad)
 */
const CORNERS: readonly number[] = Object.freeze(
  Array.from({ length: 2 * (MAX_LINE_STATIONS + 1) }, (_, vertex) => vertex),
);

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
  /** The packed arrays until they are written to the GPU (null after) */
  packed: RowsChunkData | null;
  /** Whether it is written to the GPU (it can be drawn) */
  uploaded: boolean;
  vao: WebGLVertexArrayObject | null;
  instanceBuffer: WebGLBuffer | null;
  coords: SizedTexture | null;
  rowStyles: SizedTexture | null;
  /** The instance the instance attributes of its vertex array point at */
  pointedFirst: number;
  /** The writes in place since the last upload (null before the first) */
  writes: RowsChunkWrites | null;
  disposed: boolean;
  /** The part it is recorded under in the ledger (`rows`, or a part that gives way) */
  readonly part: string;
  /**
   * The bytes it was refused for, when it did not fit in the share of the parts that give way (it
   * is not written and draws nothing); 0 otherwise
   */
  refused: number;
}

/**
 * The writes in place of a chunk waiting to be uploaded
 *
 * @internal
 */
export interface RowsChunkWrites {
  readonly instances: TexelWrites;
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
  readonly opacity: WebGLUniformLocation | null;
  readonly stations: WebGLUniformLocation | null;
  readonly stationStep: WebGLUniformLocation | null;
  readonly stationGrid: WebGLUniformLocation | null;
  readonly stationMercator: WebGLUniformLocation | null;
  readonly surface: WebGLUniformLocation | null;
  readonly surfacesFlat: WebGLUniformLocation | null;
  readonly fillCull: WebGLUniformLocation | null;
}

/** The program of the projection of the frame */
interface RowsProgram {
  readonly program: WebGLProgram;
  readonly locations: RowsUniformLocations;
  readonly projection: ProjectionUniformManager;
  readonly rowState: RowStateUniforms;
  readonly ghosts: TerrainOcclusionUniforms;
  /** The values written to the uniforms, and the frame they were written in */
  readonly memo: RowsUniformMemo;
}

/** The values last written to the uniforms of the program */
interface RowsUniformMemo {
  frame: number;
  zoom: number;
  scale: number;
  opacity: number;
  coordWidth: number;
  rowBase: number;
  rowStyleWidth: number;
  stations: number;
  stationStep: number;
  stationGrid: number;
  stationMercator: number;
  surface: number;
  surfacesFlat: number;
  fillCull: number;
}

/**
 * The renderer that draws rows of every kind in one draw
 *
 * @internal
 */
export class RowsRenderer {
  private readonly gl: WebGL2RenderingContext;
  private readonly terrain: TerrainContext;
  private readonly ledger: GpuLedger;
  private program: RowsProgram | null = null;
  /** The variant of the projection the program was made for */
  private variantName = '';
  /** Whether the program could not be made (for the variant of `variantName`) */
  private broken = false;
  private offsetUniforms: OffsetUniforms | null = null;
  private readonly cornerBuffer: WebGLBuffer | null;
  /** The chunks waiting to be written, in the order they were made */
  private readonly queued = new Set<RowsChunk>();
  /** The chunks with writes in place waiting to be uploaded */
  private readonly patched = new Set<RowsChunk>();
  /** The palettes of the chunks alive */
  private readonly palettes = new Set<RowsPalette>();
  private readonly originShift: [number, number] = [0, 0];
  /** One instance (or texel) being written */
  private readonly scratch = new Float32Array(ROWS_INSTANCE_FLOATS);
  /** The bytes written to the GPU by the uploads so far (buffers and textures) */
  uploadedBytes = 0;
  /** The draws issued so far */
  draws = 0;

  /**
   * @param makeProgram Makes the program from its sources (`createProgram` when omitted; the tests
   *   give one that fails)
   */
  constructor(
    gl: WebGL2RenderingContext,
    ledger: GpuLedger,
    terrain: TerrainContext = new TerrainContext(),
    private readonly makeProgram: typeof createProgram = createProgram,
  ) {
    this.gl = gl;
    this.terrain = terrain;
    this.ledger = ledger;
    this.cornerBuffer = gl.createBuffer();
    if (this.cornerBuffer) {
      ledger.record(this.cornerBuffer, ROWS_PART, 'buffer');
      gl.bindBuffer(gl.ARRAY_BUFFER, this.cornerBuffer);
      const corners = new Float32Array(CORNERS);
      gl.bufferData(gl.ARRAY_BUFFER, corners, gl.STATIC_DRAW);
      ledger.record(this.cornerBuffer, ROWS_PART, 'buffer', corners.byteLength);
    }
  }

  /**
   * Makes the program for the projection of the frame (again when it changed)
   *
   * @returns Whether the program can draw
   */
  ensureShader(shaderData: ShaderData): boolean {
    if (this.variantName !== shaderData.variantName) {
      this.releaseProgram();
      this.variantName = shaderData.variantName;
      this.broken = false;
      try {
        const program = this.makeProgram(
          this.gl,
          buildRowsVertexSource(shaderData.vertexShaderPrelude, shaderData.define),
          buildRowsFragmentSource(),
        );
        this.ledger.record(program, ROWS_PART, 'program');
        this.program = {
          program,
          locations: locationsOf(this.gl, program),
          projection: (() => {
            // Not drawn flat as a whole on a frame that draws the polygons and the lines flat:
            // the points keep their elevations, and the program lays the rest flat itself
            const manager = new ProjectionUniformManager(this.gl);
            manager.useTerrainState(this.terrain);
            manager.getLocations(program);
            return manager;
          })(),
          rowState: new RowStateUniforms(this.gl, program),
          ghosts: new TerrainOcclusionUniforms(this.gl, program),
          memo: emptyMemo(),
        };
      } catch (error) {
        console.error('The program of the rows could not be made', error);
        this.broken = true;
      }
    }
    return this.program !== null;
  }

  /** Whether the program can draw */
  get ready(): boolean {
    return this.program !== null;
  }

  /** Whether the program could not be made for the projection of the frame */
  get failed(): boolean {
    return this.broken;
  }

  /** Sets the uniforms of the offset mode of the frame */
  setOffsetUniforms(uniforms: OffsetUniforms): void {
    this.offsetUniforms = uniforms;
  }

  // === Chunks ===

  /**
   * Makes a chunk of packed rows; it is written to the GPU by the next `flushUploads` and can be
   * drawn after that
   *
   * @param part The part it is recorded under: the rows, or `DRAPED_ROWS_PART`, a part that gives
   *   way (written only when it fits, refused otherwise)
   */
  createChunk(data: RowsChunkData, part: string = ROWS_PART): RowsChunk {
    const chunk: RowsChunk = {
      part,
      refused: 0,
      data: layoutOf(data),
      packed: data,
      uploaded: false,
      vao: null,
      instanceBuffer: null,
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
   * Every row of a chunk has a place (its instances and its coordinates, `rowFirst` and
   * `coordFirst`), as large as what it was packed with. A row packed again fits when it has no
   * more of each than its place holds: its instances are written over the ones of its place, the
   * rest of the place is filled with instances that draw nothing, and its coordinates and its style
   * are written. The write reaches the GPU with the next `flushUploads`
   *
   * @param fromRow The first row written, in the chunk
   * @param patch The rows packed again on their own, with the palette of the chunk (the chunk takes
   *   over the counting of their styles)
   * @returns false when a row does not fit its place (nothing is written)
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
        patch.coordFirst[r + 1] - patch.coordFirst[r] >
          data.coordFirst[row + 1] - data.coordFirst[row]
      ) {
        return false;
      }
    }
    // The longest segment of the rows written may be longer than the ones of the chunk
    const lines = data.lines;
    lines.maxSegmentMeters = Math.max(lines.maxSegmentMeters, patch.lines.maxSegmentMeters);
    lines.maxSegmentMercator = Math.max(lines.maxSegmentMercator, patch.lines.maxSegmentMercator);
    const scratch = this.scratch;
    for (let r = 0; r < patch.rows; r++) {
      const row = fromRow + r;
      const coordBase = data.coordFirst[row];
      const shift = coordBase - patch.coordFirst[r];
      const from = patch.rowFirst[r];
      const to = patch.rowFirst[r + 1];
      for (let i = data.rowFirst[row]; i < data.rowFirst[row + 1]; i++) {
        const source = from + i - data.rowFirst[row];
        if (source < to) {
          const at = source * ROWS_INSTANCE_FLOATS;
          scratch[0] = patch.instances[at];
          for (let k = 1; k <= 4; k++) {
            const index = patch.instances[at + k];
            scratch[k] = index >= 0 ? index + shift : index;
          }
          scratch[5] = patch.instances[at + 5];
          scratch[6] = patch.instances[at + 6];
          scratch[7] = patch.instances[at + 7];
        } else {
          writeCollapsedInstance(scratch, 0, data.rowBase + row, coordBase);
        }
        this.writeTexel(chunk, 'instances', i, scratch);
      }
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
   * Writes coordinates of a chunk in place (the positions only: the rows keep their instances)
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
    target: 'instances' | 'coords' | 'rowStyles',
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
    this.queued.delete(chunk);
    this.patched.delete(chunk);
    const gl = this.gl;
    if (chunk.vao) {
      this.ledger.release(chunk.vao);
      gl.deleteVertexArray(chunk.vao);
    }
    if (chunk.instanceBuffer) {
      this.ledger.release(chunk.instanceBuffer);
      gl.deleteBuffer(chunk.instanceBuffer);
    }
    for (const texture of [chunk.coords, chunk.rowStyles]) {
      if (!texture) continue;
      this.ledger.release(texture.texture);
      gl.deleteTexture(texture.texture);
    }
    chunk.vao = null;
    chunk.instanceBuffer = null;
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
    this.palettes.add(palette);
    this.releasePalette(palette);
  }

  // === Drawing ===

  /**
   * Draws the rows `[fromRow, toRow)` of a chunk, in one draw
   *
   * @param rowState The state of the rows of the group of the chunk
   * @param factors The factors of the drawing (the opacity of the layer)
   * @param ghosts Whether its points take the test of the terrain hiding them (a frame the
   *   analytic drape paints)
   * @returns Whether it was drawn (false for a chunk not written yet, or without a program)
   */
  drawRange(
    chunk: RowsChunk,
    fromRow: number,
    toRow: number,
    zoom: number,
    projectionData: ProjectionData,
    rowState: RowStateTexture,
    factors: RetainedDrawFactors = NEUTRAL_DRAW_FACTORS,
    ghosts = false,
  ): boolean {
    const program = this.program;
    if (!chunk.uploaded || !program) return false;
    const data = chunk.data;
    const first = data.rowFirst[fromRow];
    const count = data.rowFirst[toRow] - first;
    if (count <= 0) return true;
    if (!chunk.instanceBuffer || !chunk.vao || !data.palette.gpu || !chunk.coords) return false;
    if (!chunk.rowStyles) return false;

    const gl = this.gl;
    gl.useProgram(program.program);
    const camera = this.offsetUniforms;
    let center: OffsetUniforms;
    if (camera) {
      center = camera;
      this.originShift[0] = data.origin[0] - camera.centerLngLat[0];
      this.originShift[1] = data.origin[1] - camera.centerLngLat[1];
      program.projection.setUniforms(projectionData, zoom, camera, this.originShift);
    } else {
      center = calculateOffsetUniforms(
        data.origin,
        projectionData.mainMatrix as unknown as Float32Array,
      );
      program.projection.setUniforms(projectionData, zoom, center);
    }
    const stations = this.stationsOf(chunk);
    this.writeUniforms(program, chunk, zoom, factors, stations);
    program.ghosts.write(ghosts && data.lines.surface, this.terrain, center);
    program.rowState.bind(rowState);
    this.bindTextures(chunk);
    // The faces of the fills are told apart by their winding on the screen (counterclockwise is
    // in front, as the fills cut on the terrain are wound)
    if (this.terrain.renderState.active) gl.frontFace(gl.CCW);

    gl.bindVertexArray(chunk.vao);
    // The attributes point at the instances of the chunk from the first one drawn
    if (chunk.pointedFirst !== first) {
      gl.bindBuffer(gl.ARRAY_BUFFER, chunk.instanceBuffer);
      pointInstanceAttribs(gl, first, false);
      chunk.pointedFirst = first;
    }
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 2 * (stations + 1), count);
    this.draws++;
    gl.bindVertexArray(null);
    return true;
  }

  /**
   * The stations the segments of a chunk are drawn in: those of a batch of lines on the surface
   * of the frame, for a chunk packed for the surface (1 on a flat map, and for a chunk packed for
   * it). Every instance of the chunk draws the strip, so the vertices are bounded by all of them
   */
  private stationsOf(chunk: RowsChunk): number {
    const lines = chunk.data.lines;
    if (!lines.surface) return 1;
    return resolveLineStations(
      this.terrain,
      lines.maxSegmentMeters,
      chunk.data.instanceCount,
      lines.maxSegmentMercator,
    );
  }

  /** Releases the program, every chunk and texture */
  dispose(): void {
    const gl = this.gl;
    for (const chunk of [...this.queued]) this.disposeChunk(chunk);
    this.releaseProgram();
    for (const palette of this.palettes) this.deletePaletteTexture(palette);
    this.palettes.clear();
    if (this.cornerBuffer) {
      this.ledger.release(this.cornerBuffer);
      gl.deleteBuffer(this.cornerBuffer);
    }
  }

  private releaseProgram(): void {
    if (!this.program) return;
    this.ledger.release(this.program.program);
    this.gl.deleteProgram(this.program.program);
    this.program = null;
  }

  /** Writes the uniforms of a draw (those of the frame once per frame, the others when changed) */
  private writeUniforms(
    program: RowsProgram,
    chunk: RowsChunk,
    zoom: number,
    factors: RetainedDrawFactors,
    stations: number,
  ): void {
    const gl = this.gl;
    const locations = program.locations;
    const memo = program.memo;
    const frame = getRenderFrame();
    const stale = memo.frame !== frame;
    if (stale) {
      memo.frame = frame;
      if (locations.coords) gl.uniform1i(locations.coords, UNIT_COORDS);
      if (locations.rowStyles) gl.uniform1i(locations.rowStyles, UNIT_ROW_STYLES);
      if (locations.styles) gl.uniform1i(locations.styles, UNIT_STYLES);
      if (locations.styleWidth) gl.uniform1i(locations.styleWidth, ROWS_STYLE_WIDTH);
      if (locations.viewport) {
        gl.uniform2f(locations.viewport, gl.drawingBufferWidth, gl.drawingBufferHeight);
      }
      if (locations.pixelToClip) {
        gl.uniform2f(locations.pixelToClip, 2 / gl.drawingBufferWidth, 2 / gl.drawingBufferHeight);
      }
      if (locations.miterLimit) gl.uniform1f(locations.miterLimit, RENDERING_DEFAULTS.MITER_LIMIT);
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
    const terrain = this.terrain;
    const surface = chunk.data.lines.surface ? 1 : 0;
    // What the stations of a segment are decided from, as `resolveLineStations` decides them: the
    // step of the terrain while it is drawn with one, else the cell of the globe for the lines
    const state = terrain.renderState;
    const stationStep = state.active && state.stepMeters > 0 ? state.stepMeters : 0;
    const stationGrid = stationStep > 0 ? 0 : Math.max(globeGridOf(terrain, 'line'), 0);
    const values: Array<[WebGLUniformLocation | null, keyof RowsUniformMemo, number]> = [
      [locations.stations, 'stations', stations],
      [locations.stationStep, 'stationStep', stationStep],
      [locations.stationGrid, 'stationGrid', stationGrid],
      [
        locations.stationMercator,
        'stationMercator',
        stations > 1 && lineStationsOnMercatorPlane(terrain) ? 1 : 0,
      ],
      [locations.surface, 'surface', surface],
      [
        locations.surfacesFlat,
        'surfacesFlat',
        terrain.renderState.active && terrain.surfacesFlattened ? 1 : 0,
      ],
      [locations.fillCull, 'fillCull', terrain.renderState.active ? 1 : 0],
    ];
    for (const [location, key, value] of values) {
      if (location && (stale || memo[key] !== value)) {
        gl.uniform1f(location, value);
        memo[key] = value;
      }
    }
  }

  /** Binds the textures of a chunk on their units, the unit 0 active again afterwards */
  private bindTextures(chunk: RowsChunk): void {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + UNIT_ROW_STYLES);
    gl.bindTexture(gl.TEXTURE_2D, (chunk.rowStyles as SizedTexture).texture);
    gl.activeTexture(gl.TEXTURE0 + UNIT_STYLES);
    gl.bindTexture(gl.TEXTURE_2D, (chunk.data.palette.gpu as SizedTexture).texture);
    gl.activeTexture(gl.TEXTURE0 + UNIT_COORDS);
    gl.bindTexture(gl.TEXTURE_2D, (chunk.coords as SizedTexture).texture);
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
      const texture = this.createFloatTexture(gl.RGBA32F, ROWS_STYLE_WIDTH, lines, 16);
      if (!texture) return;
      palette.gpu = { texture, width: ROWS_STYLE_WIDTH, height: lines };
      for (let line = 0; line < height; line++) palette.dirty.add(line);
    }
    const lineFloats = ROWS_STYLE_WIDTH * 4;
    gl.bindTexture(gl.TEXTURE_2D, palette.gpu.texture);
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
    palette.dirty.clear();
  }

  private releasePalette(palette: RowsPalette): void {
    if (!palette.retired || palette.refs > 0) return;
    this.deletePaletteTexture(palette);
    this.palettes.delete(palette);
  }

  private deletePaletteTexture(palette: RowsPalette): void {
    if (!palette.gpu) return;
    this.ledger.release(palette.gpu.texture);
    this.gl.deleteTexture(palette.gpu.texture);
    palette.gpu = null;
  }

  /**
   * Writes a chunk: its buffer, its textures and its vertex array. A chunk of a part that gives way
   * is written only when what it holds fits in the share of the parts that give way; it is refused
   * otherwise (it keeps nothing, and draws nothing)
   */
  private uploadChunk(chunk: RowsChunk): void {
    const data = chunk.packed;
    if (chunk.disposed || !data) return;
    const gl = this.gl;
    if (chunk.part !== ROWS_PART) {
      const bytes = chunkBytesOf(data);
      if (!this.ledger.fits(bytes)) {
        chunk.refused = bytes;
        chunk.packed = null;
        return;
      }
    }
    const part = chunk.part;

    const instances = data.instances.subarray(0, data.instanceCount * ROWS_INSTANCE_FLOATS);
    const instanceBuffer = gl.createBuffer();
    if (!instanceBuffer) return;
    this.ledger.record(instanceBuffer, part, 'buffer');
    gl.bindBuffer(gl.ARRAY_BUFFER, instanceBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, instances, gl.STATIC_DRAW);
    this.ledger.record(instanceBuffer, part, 'buffer', instances.byteLength);
    this.uploadedBytes += instances.byteLength;
    chunk.instanceBuffer = instanceBuffer;

    chunk.coords = this.uploadTexture(
      gl.RG32F,
      gl.RG,
      2,
      data.coords,
      data.coordCount,
      ROWS_COORD_WIDTH,
      part,
    );
    chunk.rowStyles = this.uploadTexture(
      gl.RGBA32F,
      gl.RGBA,
      ROWS_ROW_STYLE_FLOATS,
      data.rowStyles,
      data.rows,
      ROWS_ROW_STYLE_WIDTH,
      part,
    );

    const vao = gl.createVertexArray();
    if (vao) this.ledger.record(vao, part, 'vertex-array');
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
    chunk.packed = null;
  }

  /** Makes a float texture read with `texelFetch`, recorded in the ledger (bound when it returns) */
  private createFloatTexture(
    internalFormat: number,
    width: number,
    height: number,
    bytesPerTexel: number,
    part: string = ROWS_PART,
  ): WebGLTexture | null {
    const gl = this.gl;
    const texture = gl.createTexture();
    if (!texture) return null;
    this.ledger.record(texture, part, 'texture');
    gl.bindTexture(gl.TEXTURE_2D, texture);
    giveStorage(gl, this.ledger, texture, () =>
      gl.texStorage2D(gl.TEXTURE_2D, 1, internalFormat, width, height),
    );
    this.ledger.record(texture, part, 'texture', textureBytes(width, height, bytesPerTexel));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return texture;
  }

  /** Makes a float texture of `count` texels of `floats` floats and writes them */
  private uploadTexture(
    internalFormat: number,
    format: number,
    floats: number,
    values: Float32Array,
    count: number,
    widest: number,
    part: string,
  ): SizedTexture | null {
    const gl = this.gl;
    const { width, height } = textureSizeOf(count, widest);
    const texture = this.createFloatTexture(internalFormat, width, height, floats * 4, part);
    if (!texture) return null;
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
   * a line of a texture once, and each run of instances written that follow each other once
   */
  private uploadPatches(chunk: RowsChunk): void {
    const writes = chunk.writes;
    if (chunk.disposed || !chunk.uploaded || !writes) return;
    const gl = this.gl;
    if (writes.instances.size > 0) {
      if (chunk.instanceBuffer) {
        gl.bindBuffer(gl.ARRAY_BUFFER, chunk.instanceBuffer);
        writes.instances.drain(Number.POSITIVE_INFINITY, (_line, first, run) => {
          gl.bufferSubData(gl.ARRAY_BUFFER, first * ROWS_INSTANCE_BYTES, run);
          this.uploadedBytes += run.byteLength;
        });
      } else {
        writes.instances.clear();
      }
    }
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

function emptyMemo(): RowsUniformMemo {
  return {
    frame: -1,
    zoom: Number.NaN,
    scale: Number.NaN,
    opacity: Number.NaN,
    coordWidth: Number.NaN,
    rowBase: Number.NaN,
    rowStyleWidth: Number.NaN,
    stations: Number.NaN,
    stationStep: Number.NaN,
    stationGrid: Number.NaN,
    stationMercator: Number.NaN,
    surface: Number.NaN,
    surfacesFlat: Number.NaN,
    fillCull: Number.NaN,
  };
}

/** The size of a texture of `count` texels, `widest` texels wide at most */
function textureSizeOf(count: number, widest: number): { width: number; height: number } {
  const width = Math.max(1, Math.min(widest, count));
  return { width, height: Math.max(1, Math.ceil(count / width)) };
}

/**
 * The bytes a chunk holds on the GPU once written: its instances, and the textures of its
 * coordinates and of the styles of its rows
 */
function chunkBytesOf(data: RowsChunkData): number {
  const coords = textureSizeOf(data.coordCount, ROWS_COORD_WIDTH);
  const styles = textureSizeOf(data.rows, ROWS_ROW_STYLE_WIDTH);
  return (
    data.instanceCount * ROWS_INSTANCE_BYTES +
    textureBytes(coords.width, coords.height, 2 * 4) +
    textureBytes(styles.width, styles.height, ROWS_ROW_STYLE_FLOATS * 4)
  );
}

/** What a chunk keeps of its packed arrays (not the arrays written to the GPU) */
function layoutOf(data: RowsChunkData): RowsChunkLayout {
  return {
    origin: data.origin,
    rowBase: data.rowBase,
    rows: data.rows,
    instanceCount: data.instanceCount,
    coordCount: data.coordCount,
    rowFirst: data.rowFirst,
    coordFirst: data.coordFirst,
    rowStyle: data.rowStyle,
    palette: data.palette,
    lines: { ...data.lines },
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
  // The coordinates 0 to 2, and coordinate 3 with the length before
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
    opacity: at('u_opacity'),
    stations: at('u_stations'),
    stationStep: at('u_station_step'),
    stationGrid: at('u_station_grid'),
    stationMercator: at('u_station_mercator'),
    surface: at('u_surface'),
    surfacesFlat: at('u_surfaces_flat'),
    fillCull: at('u_fill_cull'),
  };
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
