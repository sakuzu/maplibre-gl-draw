// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The frames of the rows of a selection of many features, drawn on the GPU
 *
 * Features selected one by one get a frame each from the selection UI, made on the CPU from each
 * feature (`selection-ui/renderer.ts`). When more features are selected than the layer keeps
 * features of, the rows of the built-in points, lines and areas that are not drawn one at a time
 * in the frame get the same frames drawn from the boxes of their rows, in one draw per row group:
 * every row of
 * the group with a frame is an instance, and the vertex shader reads the byte of the state of its
 * row (the texture the rows are drawn with, `renderers/row-state.ts`) and draws a frame only for a
 * row marked as selected and not hidden. No feature is made for it, and nothing is done for a row
 * in a frame that changes nothing.
 *
 * A frame is drawn as the selection UI draws the frame of a feature of a selection of several:
 *
 * - a row with an extent: the box of the row widened by the margin on the map plane, as
 *   `applyMarginToBoundingBox` widens it with the zoom (every side moved out by the margin, in
 *   the pixels of the latitude of the center of the box), stroked as `StrokeRenderer` strokes a
 *   closed path (the same miters, the same band of one pixel the coverage fades in, the same
 *   triangles, the color given to the whole color). On the terrain and on the globe the sides are
 *   cut into segments as the path of the frame is densified there: no longer than a cell of the
 *   ground on the terrain, and short enough on the globe for a segment to keep within a pixel of
 *   the sphere, up to {@link MAX_SEGMENTS} a side (the segments of a group follow its largest box)
 * - a row of one position (no extent): the rectangle of the extent of its marker plus the
 *   margin, laid on the screen around the point, as `AnchoredOutlineRenderer` draws the frame of a
 *   point (the color given to the alpha)
 *
 * The rows drawn one at a time in the frame (the images, the custom types, the features with
 * companions, the rows of a chunk drawn at once) get no instance here: their frames are drawn from
 * their features, as before, so that a frame fades with its point where the terrain fades it. On a
 * frame the analytic drape paints, the frame of a point the terrain hides from the camera fades
 * with it here too: the vertex shader makes the test the points drawn from their rows make
 * (`rows-occlusion.ts`), and the frame is drawn as faint as the frame of its feature.
 *
 * The instances of a group are made from its rows when it is first drawn, and again when the rows
 * of the Store change; the instances of the groups not drawn in a frame are released at its end,
 * and everything (the program too) when no selection of many features is drawn. Every buffer, vertex
 * array and program is recorded in the ledger of the instance under `frames`, a part of the rows:
 * the instances grow with the rows of the groups selected, as the rows themselves do.
 *
 * @internal
 */

import type { ProjectionData } from 'maplibre-gl';
import type { SelectionUIConfig } from '../../shared/config/selection.js';
import { getDashPattern, pixelsToDegreesLng, RENDERING_DEFAULTS } from '../../shared/math/index.js';
import type { PixelRatioInput } from '../../shared/utils/pixel-ratio.js';
import { resolvePixelRatio } from '../../shared/utils/pixel-ratio.js';
import { type DrawnRows, pageRowBox, type RowGroup } from '../../store/built-in/drawn-rows.js';
import type { Feature } from '../../store/types.js';
import { getSurfaceTessellationStep } from '../globe-subdivision.js';
import { GpuLedger } from '../gpu-ledger.js';
import type { DrawnRowGroup } from '../layer/table-retained.js';
import {
  ROW_HIDDEN_POSITION_GLSL,
  ROW_STATE_GLSL,
  ROW_STATE_SELECTED_GLSL,
  RowStateUniforms,
} from '../renderers/row-state.js';
import {
  TERRAIN_OCCLUSION_GLSL,
  TerrainOcclusionUniforms,
} from '../renderers/rows/rows-occlusion.js';
import {
  createProgram,
  getProjectionTransitionUniform,
  OFFSET_MODE_GLSL,
  type OffsetUniforms,
  type ShaderData,
} from '../shaders/helpers.js';
import { ProjectionUniformManager } from '../shaders/projection.js';
import type { TerrainContext } from '../terrain/context.js';
import { SelectedRows } from './bulk-selection.js';

/** The part the frames record what they hold on the GPU under (a part of the rows) */
const FRAMES_PART = 'frames';

/**
 * The floats of the instance of a row: its box from the origin of its group, its row, its marker,
 * and its kind (bit 0: a row of one position; bit 1: its box is taken from the second origin)
 */
const FLOATS_PER_ROW = 8;
const STRIDE = FLOATS_PER_ROW * 4;
/** The vertices of a side of a frame (two triangles) */
const VERTICES_PER_SIDE = 6;

/**
 * The most segments a side of a frame is cut into on the terrain and on the globe
 *
 * Every instance of a group draws the vertices of as many segments a side as the largest box of
 * the group needs, up to this many; a longer side is drawn in this many segments.
 */
export const MAX_SEGMENTS = 64;

/** The types whose rows the drawing of the rows draws (an image is drawn from its feature) */
const ROW_DRAWN_TYPES: ReadonlySet<string> = new Set([
  'Point',
  'MultiPoint',
  'LineString',
  'MultiLineString',
  'Polygon',
  'MultiPolygon',
  'Circle',
  'Freehand',
]);

/** The types whose box is that of one position, whatever their positions are (no empty box) */
const POSITION_TYPES: ReadonlySet<string> = new Set(['Point', 'Circle']);

/**
 * How the frames of the rows of a frame are read: which rows are framed from their features, and
 * the extent of the marker of a row of one position
 *
 * @internal
 */
export interface BulkFrameRows {
  readonly reader: DrawnRows;
  /** Changes whenever the instances are to be made again (the rows, their classification) */
  readonly revision: string;
  /**
   * Whether the rows of a type are framed from their features (the images, the custom types, a
   * type whose box is worked out by a calculator registered for it)
   */
  framedByFeature(type: string): boolean;
  /**
   * The half width and the half height, in CSS px, of the marker of a row of one position of a
   * type, a style and a position (the extent the frame of a point spans before the margin)
   */
  pointExtent(type: string, style: Feature['style'] | undefined, at: [number, number]): PointHalf;
}

/** The half width and the half height of the marker of a point, in CSS px */
export type PointHalf = readonly [number, number];

/**
 * Whether the box of a row is that of its feature and not of its row (the types that are not
 * built-in points, lines and areas, and the types whose box a calculator works out)
 *
 * @internal
 */
export function boxedByFeature(rows: Pick<BulkFrameRows, 'framedByFeature'>, type: string) {
  return !ROW_DRAWN_TYPES.has(type) || rows.framedByFeature(type);
}

/**
 * Whether the frame of a row is drawn from its feature (and not by the frames of the rows): its
 * box is that of its feature, or it is drawn one at a time in the frame
 *
 * @internal
 */
export function framedByFeature(
  rows: Pick<BulkFrameRows, 'framedByFeature'>,
  type: string,
  drawnAtOnce: () => boolean,
): boolean {
  return boxedByFeature(rows, type) || drawnAtOnce();
}

/**
 * The view the frames of a copy of the world are drawn in
 *
 * @internal
 */
export interface BulkFramesView {
  readonly shaderData: ShaderData;
  readonly projectionData: ProjectionData;
  readonly offsetUniforms: OffsetUniforms | null;
  /** The style zoom of the frame (the margin is laid on the map plane with it) */
  readonly zoom: number;
  readonly config: SelectionUIConfig;
  /** The terrain state of the instance */
  readonly terrain: TerrainContext;
  /**
   * Whether the frames of the points take the test of the terrain hiding them (a frame the analytic
   * drape paints; none when omitted)
   */
  readonly ghosts?: boolean;
}

/** The instances of the framed rows of a group */
interface GroupFrames {
  readonly revision: string;
  readonly buffer: WebGLBuffer | null;
  readonly vao: WebGLVertexArrayObject | null;
  readonly origin: [number, number];
  /** The second origin, of the rows more than 180 degrees of longitude away from the first */
  readonly second: [number, number];
  readonly count: number;
  /** The longest side of the box of a row framed, in Mercator units */
  readonly longest: number;
}

/** The uniforms of the program of the frames (besides those of the projection and the rows) */
type UniformName =
  | 'u_viewport'
  | 'u_width'
  | 'u_miter_limit'
  | 'u_margin'
  | 'u_deg_per_px'
  | 'u_origins'
  | 'u_shifts'
  | 'u_segments'
  | 'u_segment_length'
  | 'u_world'
  | 'u_ratio'
  | 'u_pixel_to_clip'
  | 'u_flat_surface'
  | 'u_color'
  | 'u_dash_array'
  | 'u_dash_enabled';

/** The uniforms whose locations are looked up */
const UNIFORMS: readonly UniformName[] = [
  'u_viewport',
  'u_width',
  'u_miter_limit',
  'u_margin',
  'u_deg_per_px',
  'u_origins',
  'u_shifts',
  'u_segments',
  'u_segment_length',
  'u_world',
  'u_ratio',
  'u_pixel_to_clip',
  'u_flat_surface',
  'u_color',
  'u_dash_array',
  'u_dash_enabled',
];

/**
 * The instance data of the rows of a group: the box of each framed row from the origin of the
 * group, its row, and the half extent of the marker of a row of one position (none for a box)
 *
 * The box of a row more than 180 degrees of longitude away from the first origin (a group on both
 * sides of the antimeridian) is taken from a second origin, its own box, so that no offset of a
 * row holds the whole turn of the world, which Float32 holds to about a pixel only
 *
 * @returns The data, the two origins and the number of rows framed
 * @internal
 */
export function buildFrameInstances(
  group: RowGroup,
  rows: BulkFrameRows,
  drawnAtOnce: (row: number) => boolean,
): {
  data: Float32Array;
  origin: [number, number];
  second: [number, number];
  count: number;
  longest: number;
} {
  const reader = rows.reader;
  const n = group.data.length;
  const box = new Float64Array(4);
  const values = new Float32Array(n * FLOATS_PER_ROW);
  let origin: [number, number] | null = null;
  let second: [number, number] | null = null;
  let count = 0;
  let longest = 0;
  /** The extents of the markers by type and style, made once per group */
  const extents = new Map<string, PointHalf>();
  for (let row = 0; row < n; row++) {
    if (!reader.hasGeometry(group, row)) continue;
    const type = reader.typeOf(group, row);
    if (framedByFeature(rows, type, () => drawnAtOnce(row))) continue;
    if (!pageRowBox(group.data, row, box)) continue;
    if (!POSITION_TYPES.has(type) && box[0] === 0 && box[1] === 0 && box[2] === 0 && box[3] === 0) {
      // The selection UI gives such a feature no frame
      continue;
    }
    if (!origin) origin = [Math.fround(box[0]), Math.fround(box[1])];
    let from = origin;
    let kind = 0;
    if (Math.abs(box[0] - origin[0]) > 180) {
      second ??= [Math.fround(box[0]), Math.fround(box[1])];
      from = second;
      kind = 2;
    }
    const at = count * FLOATS_PER_ROW;
    values[at] = box[0] - from[0];
    values[at + 1] = box[1] - from[1];
    values[at + 2] = box[2] - from[0];
    values[at + 3] = box[3] - from[1];
    values[at + 4] = row;
    values[at + 7] = kind;
    if (box[0] === box[2] && box[1] === box[3]) {
      const style = reader.styleNumberOf(group, row);
      const key = `${type}\u0000${style}`;
      let extent = extents.get(key);
      if (!extent) {
        extent = rows.pointExtent(type, reader.styleOf(style), [box[0], box[1]]);
        extents.set(key, extent);
      }
      values[at + 5] = extent[0];
      values[at + 6] = extent[1];
      values[at + 7] = kind + 1;
    } else {
      const width = (box[2] - box[0]) / 360;
      const height = Math.abs(mercatorY(box[3]) - mercatorY(box[1]));
      longest = Math.max(longest, width, height);
    }
    count++;
  }
  return {
    data: values.subarray(0, count * FLOATS_PER_ROW),
    origin: origin ?? [0, 0],
    second: second ?? origin ?? [0, 0],
    count,
    longest,
  };
}

/**
 * Draws the frames of the rows of a selection of many features, one draw per row group
 *
 * @internal
 */
export class BulkFramesRenderer {
  /** The reading of the selection of many features (what the frames are drawn for) */
  readonly selection = new SelectedRows();
  private readonly gl: WebGL2RenderingContext;
  private readonly ledger: GpuLedger;
  private readonly pixelRatio: PixelRatioInput | undefined;
  private program: WebGLProgram | null = null;
  private variantName = '';
  private failed = '';
  private projection: ProjectionUniformManager;
  private rowState: RowStateUniforms | null = null;
  private ghosts: TerrainOcclusionUniforms | null = null;
  private locations: Partial<Record<UniformName, WebGLUniformLocation | null>> = {};
  private readonly frames = new Map<RowGroup, GroupFrames>();
  /** The groups drawn since the last end of a frame */
  private readonly drawn = new Set<RowGroup>();
  /** The projection takes the offsets from the camera as they are given (the shifts are added) */
  private readonly noShift: [number, number] = [0, 0];
  /** The draw calls made, counted for the tests */
  draws = 0;

  constructor(gl: WebGL2RenderingContext, ledger?: GpuLedger, pixelRatio?: PixelRatioInput) {
    this.gl = gl;
    this.ledger = ledger ?? new GpuLedger();
    this.pixelRatio = pixelRatio;
    this.projection = new ProjectionUniformManager(gl);
  }

  /** The GL objects it holds (the buffers, the vertex arrays and the program) */
  get heldObjects(): number {
    let objects = this.program ? 1 : 0;
    for (const frames of this.frames.values()) {
      if (frames.buffer) objects++;
      if (frames.vao) objects++;
    }
    return objects;
  }

  /**
   * Draws the frames of the rows selected of the groups given, on one copy of the world: one
   * draw per group that holds a row selected (`selected`) and whose texture of the state is
   * written
   *
   * @returns The draws made
   */
  drawGroups(
    view: BulkFramesView,
    rows: BulkFrameRows,
    groups: Iterable<DrawnRowGroup>,
    selected: ReadonlySet<RowGroup>,
  ): number {
    let made = 0;
    let begun = false;
    const segmentLength = segmentLengthOf(view);
    for (const entry of groups) {
      if (!entry.texture || !selected.has(entry.group)) continue;
      const frames = this.framesOf(entry, rows);
      this.drawn.add(entry.group);
      if (!frames || frames.count === 0 || !frames.vao) continue;
      if (!begun) {
        if (!this.begin(view, segmentLength)) return made;
        begun = true;
      }
      const gl = this.gl;
      const camera = view.offsetUniforms;
      this.projection.setUniforms(view.projectionData, view.zoom, camera, this.noShift);
      this.ghosts?.write(view.ghosts === true, view.terrain, camera);
      const loc = this.locations;
      // The two origins from the camera (in 64 bits, then given to Float32), and their latitudes
      const cx = camera ? camera.centerLngLat[0] : 0;
      const cy = camera ? camera.centerLngLat[1] : 0;
      const { origin, second } = frames;
      if (loc.u_shifts) {
        gl.uniform4f(loc.u_shifts, origin[0] - cx, origin[1] - cy, second[0] - cx, second[1] - cy);
      }
      if (loc.u_origins) gl.uniform2f(loc.u_origins, origin[1], second[1]);
      const segments = segmentsOfGroup(frames.longest, segmentLength, view);
      if (loc.u_segments) gl.uniform1i(loc.u_segments, segments);
      this.rowState?.bind(entry.texture);
      gl.bindVertexArray(frames.vao);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 4 * segments * VERTICES_PER_SIDE, frames.count);
      gl.bindVertexArray(null);
      made++;
      this.draws++;
    }
    return made;
  }

  /**
   * Ends a frame: the instances of the groups not drawn in it are released
   */
  endFrame(): void {
    for (const [group, frames] of this.frames) {
      if (this.drawn.has(group)) continue;
      this.release(frames);
      this.frames.delete(group);
    }
    this.drawn.clear();
  }

  /** Releases every GL object it holds (a frame with no selection of many features) */
  releaseAll(): void {
    for (const frames of this.frames.values()) this.release(frames);
    this.frames.clear();
    this.drawn.clear();
    if (this.program) {
      this.ledger.release(this.program);
      this.gl.deleteProgram(this.program);
      this.program = null;
    }
    this.variantName = '';
    this.rowState = null;
    this.ghosts = null;
    this.locations = {};
  }

  /** Releases everything (the renderers go) */
  dispose(): void {
    this.releaseAll();
    this.selection.clear();
  }

  /** Uses the program of the view and writes the uniforms of the frame */
  private begin(view: BulkFramesView, segmentLength: number): boolean {
    if (!this.ensureProgram(view.shaderData)) return false;
    const gl = this.gl;
    gl.useProgram(this.program);
    this.projection.useTerrainState(view.terrain);
    const loc = this.locations;
    const ratio = resolvePixelRatio(this.pixelRatio);
    const box = view.config.boundingBox;
    const stroke = box.stroke;
    if (loc.u_viewport) gl.uniform2f(loc.u_viewport, gl.drawingBufferWidth, gl.drawingBufferHeight);
    if (loc.u_width) gl.uniform1f(loc.u_width, stroke.width * ratio);
    if (loc.u_miter_limit) gl.uniform1f(loc.u_miter_limit, RENDERING_DEFAULTS.MITER_LIMIT);
    if (loc.u_margin) gl.uniform1f(loc.u_margin, box.margin);
    if (loc.u_deg_per_px) gl.uniform1f(loc.u_deg_per_px, pixelsToDegreesLng(1, 0, view.zoom));
    if (loc.u_segment_length) gl.uniform1f(loc.u_segment_length, segmentLength);
    if (loc.u_world) gl.uniform1f(loc.u_world, 512 * 2 ** view.zoom);
    if (loc.u_ratio) gl.uniform1f(loc.u_ratio, ratio);
    if (loc.u_pixel_to_clip) {
      gl.uniform2f(loc.u_pixel_to_clip, 2 / gl.drawingBufferWidth, 2 / gl.drawingBufferHeight);
    }
    if (loc.u_flat_surface) {
      gl.uniform1f(loc.u_flat_surface, view.terrain.surfacesFlattened ? 1 : 0);
    }
    if (loc.u_color) {
      gl.uniform4f(
        loc.u_color,
        stroke.color[0],
        stroke.color[1],
        stroke.color[2],
        stroke.color[3] * stroke.opacity,
      );
    }
    const dash = stroke.dashArray ?? getDashPattern(stroke.lineStyle);
    const dashed = stroke.lineStyle !== 'solid' && dash.length >= 2;
    if (loc.u_dash_enabled) gl.uniform1f(loc.u_dash_enabled, dashed ? 1 : 0);
    if (dashed && loc.u_dash_array)
      gl.uniform4f(loc.u_dash_array, dash[0], dash[1], dash[0] + dash[1], 0);
    return true;
  }

  /**
   * Makes the program of a projection variant, once
   *
   * @returns Whether the frames can be drawn with it
   */
  ensureProgram(shaderData: ShaderData): boolean {
    if (this.program && this.variantName === shaderData.variantName) return true;
    if (this.failed === shaderData.variantName) return false;
    const gl = this.gl;
    if (this.program) {
      this.ledger.release(this.program);
      gl.deleteProgram(this.program);
      this.program = null;
    }
    let program: WebGLProgram;
    try {
      program = createProgram(
        gl,
        buildBulkFramesVertexSource(shaderData.vertexShaderPrelude, shaderData.define),
        BULK_FRAMES_FRAGMENT_SOURCE,
      );
    } catch (error) {
      this.failed = shaderData.variantName;
      console.warn('The frames of a selection of many features cannot be drawn:', error);
      return false;
    }
    this.ledger.record(program, FRAMES_PART, 'program');
    this.program = program;
    this.variantName = shaderData.variantName;
    this.projection = new ProjectionUniformManager(gl);
    this.projection.getLocations(program);
    this.rowState = new RowStateUniforms(gl, program);
    this.ghosts = new TerrainOcclusionUniforms(gl, program);
    const locations: Partial<Record<UniformName, WebGLUniformLocation | null>> = {};
    for (const name of UNIFORMS) locations[name] = gl.getUniformLocation(program, name);
    this.locations = locations;
    return true;
  }

  /** The instances of a group (made again when the rows changed) */
  private framesOf(entry: DrawnRowGroup, rows: BulkFrameRows): GroupFrames | null {
    const revision = `${rows.revision}|${entry.generation}`;
    const known = this.frames.get(entry.group);
    if (known && known.revision === revision) return known;
    if (known) {
      this.release(known);
      this.frames.delete(entry.group);
    }
    const built = buildFrameInstances(entry.group, rows, (row) => entry.drawnAtOnce(row));
    const gl = this.gl;
    let buffer: WebGLBuffer | null = null;
    let vao: WebGLVertexArrayObject | null = null;
    if (built.count > 0) {
      buffer = gl.createBuffer();
      vao = gl.createVertexArray();
      if (!buffer || !vao) {
        // A lost context: nothing is made
        if (buffer) gl.deleteBuffer(buffer);
        if (vao) gl.deleteVertexArray(vao);
        return null;
      }
      this.ledger.record(buffer, FRAMES_PART, 'buffer');
      this.ledger.record(vao, FRAMES_PART, 'vertex-array');
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, built.data, gl.STATIC_DRAW);
      this.ledger.record(buffer, FRAMES_PART, 'buffer', built.data.byteLength);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 4, gl.FLOAT, false, STRIDE, 0);
      gl.vertexAttribDivisor(0, 1);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 4, gl.FLOAT, false, STRIDE, 16);
      gl.vertexAttribDivisor(1, 1);
      gl.bindVertexArray(null);
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
    }
    const frames: GroupFrames = {
      revision,
      buffer,
      vao,
      origin: built.origin,
      second: built.second,
      count: built.count,
      longest: built.longest,
    };
    this.frames.set(entry.group, frames);
    return frames;
  }

  private release(frames: GroupFrames): void {
    if (frames.vao) {
      this.ledger.release(frames.vao);
      this.gl.deleteVertexArray(frames.vao);
    }
    if (frames.buffer) {
      this.ledger.release(frames.buffer);
      this.gl.deleteBuffer(frames.buffer);
    }
  }
}

/**
 * The longest segment of a side of a frame in a view, in Mercator units (0 on a flat map: a side is
 * one segment): no longer than a cell of the step of the surface (the terrain, the cells of the
 * globe), and on the globe short enough for the chord of a segment to keep within a pixel of the
 * sphere (the sagitta `R (1 - cos(a / 2))` of an arc `a` on a sphere of `R` px)
 *
 * @internal
 */
export function segmentLengthOf(view: Pick<BulkFramesView, 'terrain' | 'projectionData' | 'zoom'>) {
  let length = Number.POSITIVE_INFINITY;
  const step = getSurfaceTessellationStep(view.terrain, 'line');
  if (step && step.grid > 0) length = step.grid;
  if ((view.projectionData.projectionTransition ?? 0) > 0) {
    const radius = (512 * 2 ** view.zoom) / (2 * Math.PI);
    const arc = 2 * Math.acos(Math.max(-1, 1 - 1 / radius));
    length = Math.min(length, arc / (2 * Math.PI));
  }
  return Number.isFinite(length) ? length : 0;
}

/**
 * The segments a side of the frames of a group is cut into: as many as its largest box needs for
 * the segments of the view (with the margin), from 1 to {@link MAX_SEGMENTS}
 *
 * @internal
 */
export function segmentsOfGroup(
  longest: number,
  segmentLength: number,
  view: Pick<BulkFramesView, 'config' | 'zoom'>,
): number {
  if (!(segmentLength > 0) || !(longest > 0)) return 1;
  const margin = (2 * view.config.boundingBox.margin) / (512 * 2 ** view.zoom);
  return Math.max(1, Math.min(MAX_SEGMENTS, Math.ceil((longest + margin) / segmentLength)));
}

/** The Web Mercator y of a latitude (the world is 1 high) */
function mercatorY(lat: number): number {
  const latRad = (lat * Math.PI) / 180;
  return (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2;
}

/**
 * The vertex shader of the frames
 *
 * Every instance is a row; its vertices are the sides of its frame, two triangles a side, in the
 * order `StrokeRenderer` (a frame with an extent) and `AnchoredOutlineRenderer` (the frame of a
 * point) lay them in their triangle strips, so that the same triangles are drawn: for the side
 * from the point `k` of the outline to the next, the vertices `(k, +)`, `(k, -)`, `(k + 1, +)`,
 * `(k, -)`, `(k + 1, +)`, `(k + 1, -)`. The vertices of the segments a row does not need are
 * moved out of the clip space, as are those of a row not selected or hidden.
 *
 * @internal
 */
export function buildBulkFramesVertexSource(prelude: string, define: string): string {
  return `#version 300 es
${prelude}
${define}
${getProjectionTransitionUniform(prelude)}${OFFSET_MODE_GLSL}${ROW_STATE_GLSL}${ROW_STATE_SELECTED_GLSL}${TERRAIN_OCCLUSION_GLSL}

// The box of the row from the origin of its group: west, south, east, north
layout(location = 0) in vec4 a_bounds;
// x: the row in its group; y and z: the half extent of the marker of a row of one position
// (CSS px); w: its kind (bit 0: a row of one position; bit 1: its box is from the second origin)
layout(location = 1) in vec4 a_meta;

uniform vec2 u_viewport;
// The width of the line (device px), the miter limit, the margin (CSS px)
uniform float u_width;
uniform float u_miter_limit;
uniform float u_margin;
// The degrees of longitude of a CSS px at the zoom of the frame (on the map plane)
uniform float u_deg_per_px;
// The latitudes of the two origins of the group, and the two origins from the camera
uniform vec2 u_origins;
uniform vec4 u_shifts;
// The most segments a side of a frame of the group is cut into, and the longest segment of the
// surface (Mercator; 0 on a flat map)
uniform int u_segments;
uniform float u_segment_length;
// The CSS px of the world at the zoom of the frame (the distances of the dashes)
uniform float u_world;
// Device px per CSS px, and device px to clip space
uniform float u_ratio;
uniform vec2 u_pixel_to_clip;
// 1 when the frame lays the surfaces flat on the terrain (the frames with an extent are flat then)
uniform float u_flat_surface;

out float v_dist;
out float v_width;
out float v_distance;
out float v_point;
// The faintness of the frame of a point the terrain hides (1 for every other frame)
flat out float v_ghost;

// The corners of the outline: from the origin of the group (a frame with an extent) or on the
// screen around the point (CSS px, y down); top left, top right, bottom right, bottom left
vec2 g_corners[4];
// The segments of a side
int g_per_side = 1;
// The latitude of the origin of the row, and the origin from the camera
float g_origin_lat = 0.0;
vec2 g_shift = vec2(0.0);

// Projects a position from the origin of the row
vec4 projectFromOrigin(vec2 offset) {
    return project_position_to_clipspace_from_offset(offset + g_shift, u_projection_matrix);
}

vec2 clipToScreen(vec4 clip) {
    vec2 ndc = clip.xy / clip.w;
    return (ndc * 0.5 + 0.5) * u_viewport;
}

vec2 screenToClipOffset(vec2 screenOffset, float w) {
    return screenOffset * 2.0 / u_viewport * w;
}

float mercatorYOf(float latitude) {
    float latRad = radians(latitude);
    return (1.0 - log(tan(latRad) + 1.0 / cos(latRad)) / PI) / 2.0;
}

// The point i of the outline of a frame with an extent (the corners, and the points between)
vec2 pathPoint(int i) {
    int side = (i / g_per_side) % 4;
    int j = i - (i / g_per_side) * g_per_side;
    float t = float(j) / float(g_per_side);
    return mix(g_corners[side], g_corners[(side + 1) % 4], t);
}

// The CSS px between two points of the map plane (from the origin), as the dashes measure them
float planeDistance(vec2 a, vec2 b) {
    float dx = (b.x - a.x) / 360.0 * u_world;
    float dy = (mercatorYOf(b.y + g_origin_lat) - mercatorYOf(a.y + g_origin_lat)) * u_world;
    return sqrt(dx * dx + dy * dy);
}

// The distance along the outline of a frame with an extent to its point i (0 to 4 sides)
float pathDistance(int i) {
    int side = i / g_per_side;
    float d = 0.0;
    for (int k = 0; k < 4; k++) {
        if (k >= side) break;
        d += planeDistance(g_corners[k], g_corners[(k + 1) % 4]);
    }
    if (side < 4) d += planeDistance(g_corners[side], pathPoint(i));
    return d;
}

void main() {
    v_dist = 0.0;
    v_distance = 0.0;
    v_ghost = 1.0;
    bool second = a_meta.w > 1.5;
    float point = second ? a_meta.w - 2.0 : a_meta.w;
    v_point = point;
    g_origin_lat = second ? u_origins.y : u_origins.x;
    g_shift = second ? u_shifts.zw : u_shifts.xy;
    float halfWidth = u_width / 2.0;
    float expanded = halfWidth + 1.0;
    v_width = halfWidth;
    uint state = readRowState(int(a_meta.x));
    if (rowStateHidden(state) || !rowStateSelected(state)) {
        gl_Position = ${ROW_HIDDEN_POSITION_GLSL};
        return;
    }
    int quad = gl_VertexID / ${VERTICES_PER_SIDE};
    int vertex = gl_VertexID - quad * ${VERTICES_PER_SIDE};
    bool atEnd = vertex == 2 || vertex == 4 || vertex == 5;
    float across = (vertex == 0 || vertex == 2 || vertex == 4) ? 1.0 : -1.0;
    int k = quad + (atEnd ? 1 : 0);
    v_dist = across * expanded;

    if (point > 0.5) {
        // A row of one position: the rectangle of its marker and the margin around the point
        if (quad >= 4) {
            gl_Position = ${ROW_HIDDEN_POSITION_GLSL};
            return;
        }
        vec2 halfSize = a_meta.yz + u_margin;
        g_corners[0] = vec2(-halfSize.x, -halfSize.y);
        g_corners[1] = vec2(halfSize.x, -halfSize.y);
        g_corners[2] = vec2(halfSize.x, halfSize.y);
        g_corners[3] = vec2(-halfSize.x, halfSize.y);
        int c = k % 4;
        vec2 corner = g_corners[c];
        vec2 arriving = normalize(corner - g_corners[(c + 3) % 4]);
        vec2 leaving = normalize(g_corners[(c + 1) % 4] - corner);
        vec2 n1 = vec2(-arriving.y, arriving.x);
        vec2 n2 = vec2(-leaving.y, leaving.x);
        vec2 normal = n1;
        float scale = 1.0;
        vec2 sum = n1 + n2;
        float sumLength = length(sum);
        if (sumLength > 0.001) {
            vec2 miter = sum / sumLength;
            float cosHalf = dot(miter, n1);
            if (cosHalf > 0.001 && 1.0 / cosHalf <= u_miter_limit) {
                normal = miter;
                scale = 1.0 / cosHalf;
            }
        }
        vec2 offset = corner * u_ratio + normal * across * expanded * scale;
        vec4 centerClip = projectFromOrigin(a_bounds.xy);
        if (centerClip.w <= 0.0) {
            gl_Position = ${ROW_HIDDEN_POSITION_GLSL};
            return;
        }
        // Hidden by the terrain from the camera: as faint as the point (its ground read from the
        // atlas, as the frame stands on it)
        if (u_ghost_on > 0.5) {
            vec2 anchor = shade_mercator_offset(a_bounds.xy + g_shift);
            v_ghost = terrainGhostOpacity(anchor, dem_elevation_meters(anchor) * u_elevation_params.x);
        }
        gl_Position = vec4(
            centerClip.xy / centerClip.w + vec2(offset.x, -offset.y) * u_pixel_to_clip,
            centerClip.z / centerClip.w,
            1.0
        );
        float along = 0.0;
        for (int i = 0; i < 4; i++) {
            if (i >= k) break;
            along += (i % 2 == 0) ? 2.0 * halfSize.x : 2.0 * halfSize.y;
        }
        v_distance = along;
        return;
    }

    // A row with an extent: its box widened by the margin on the map plane, in the pixels of the
    // latitude of its center
    float latitude = g_origin_lat + (a_bounds.y + a_bounds.w) * 0.5;
    vec2 margin = vec2(u_deg_per_px, u_deg_per_px * cos(radians(latitude))) * u_margin;
    g_corners[0] = vec2(a_bounds.x - margin.x, a_bounds.w + margin.y);
    g_corners[1] = vec2(a_bounds.z + margin.x, a_bounds.w + margin.y);
    g_corners[2] = vec2(a_bounds.z + margin.x, a_bounds.y - margin.y);
    g_corners[3] = vec2(a_bounds.x - margin.x, a_bounds.y - margin.y);
    // On the terrain and on the globe the sides are cut into segments no longer than those of
    // the surface
    if (u_segment_length > 0.0 && u_segments > 1) {
        float width = (g_corners[1].x - g_corners[0].x) / 360.0;
        float height = abs(mercatorYOf(g_corners[0].y + g_origin_lat) - mercatorYOf(g_corners[3].y + g_origin_lat));
        g_per_side = clamp(int(ceil(max(width, height) / u_segment_length)), 1, u_segments);
    }
    int n = 4 * g_per_side;
    if (quad >= n) {
        gl_Position = ${ROW_HIDDEN_POSITION_GLSL};
        return;
    }
    vec2 position = pathPoint(k % n);
    vec2 previous = pathPoint((k + n - 1) % n);
    vec2 next = pathPoint((k + 1) % n);
    if (u_flat_surface > 0.5) {
        // Laid flat, as the surfaces of the frame are
        g_anchor_elevation_m = 0.0;
        g_anchor_elevation_on = 1.0;
    }
    vec4 currentClip = projectFromOrigin(position);
    vec4 prevClip = projectFromOrigin(previous);
    vec4 nextClip = projectFromOrigin(next);
    vec2 currentScreen = clipToScreen(currentClip);
    vec2 prevScreen = clipToScreen(prevClip);
    vec2 nextScreen = clipToScreen(nextClip);
    bool hasPrev = distance(position, previous) > 0.0000001;
    bool hasNext = distance(position, next) > 0.0000001;
    vec2 normal;
    float miterScale = 1.0;
    if (!hasPrev && hasNext) {
        vec2 dir = normalize(nextScreen - currentScreen);
        normal = vec2(-dir.y, dir.x);
    } else if (hasPrev && !hasNext) {
        vec2 dir = normalize(currentScreen - prevScreen);
        normal = vec2(-dir.y, dir.x);
    } else if (hasPrev && hasNext) {
        vec2 dir1 = normalize(currentScreen - prevScreen);
        vec2 dir2 = normalize(nextScreen - currentScreen);
        vec2 normal1 = vec2(-dir1.y, dir1.x);
        vec2 normal2 = vec2(-dir2.y, dir2.x);
        vec2 avgNormal = normal1 + normal2;
        float avgLen = length(avgNormal);
        if (avgLen > 0.001) {
            normal = avgNormal / avgLen;
            float cosHalf = dot(normal, normal1);
            if (cosHalf > 0.001) {
                miterScale = 1.0 / cosHalf;
                if (miterScale > u_miter_limit) {
                    miterScale = 1.0;
                    normal = normal1;
                }
            }
        } else {
            normal = normal1;
        }
    } else {
        normal = vec2(0.0, 1.0);
    }
    vec2 screenOffset = normal * across * expanded * miterScale;
    gl_Position = currentClip + vec4(screenToClipOffset(screenOffset, currentClip.w), 0.0, 0.0);
    v_distance = pathDistance(k);
}`;
}

/**
 * The fragment shader of the frames: the coverage of the line as `StrokeRenderer` and
 * `AnchoredOutlineRenderer` compute it (HHAA), given to the whole color for a frame with an extent
 * (as `StrokeRenderer` gives it) and to the alpha for the frame of a point (as
 * `AnchoredOutlineRenderer` gives it)
 *
 * @internal
 */
export const BULK_FRAMES_FRAGMENT_SOURCE = `#version 300 es
precision highp float;

uniform vec4 u_color;
uniform vec4 u_dash_array;
uniform float u_dash_enabled;

in float v_dist;
in float v_width;
in float v_distance;
in float v_point;
flat in float v_ghost;

out vec4 fragColor;

float pixelLine(float x) {
    return clamp(x + 0.5, 0.0, 1.0);
}

void main() {
    if (u_dash_enabled > 0.5) {
        float patternLength = u_dash_array.z;
        if (patternLength > 0.0 && mod(v_distance, patternLength) > u_dash_array.x) discard;
    }
    float coverage = pixelLine(v_dist + v_width) - pixelLine(v_dist - v_width);
    fragColor = v_point > 0.5 ? vec4(u_color.rgb, u_color.a * coverage * v_ghost) : u_color * coverage;
}`;

/**
 * The corners of the frame of a row with an extent, as the vertex shader lays them on the map
 * plane: top left, top right, bottom right, bottom left (for the tests, which hold them to the
 * frame of a feature)
 *
 * @internal
 */
export function rowFrameCorners(
  box: readonly [number, number, number, number],
  margin: number,
  zoom: number,
): [number, number][] {
  const lng = pixelsToDegreesLng(1, 0, zoom) * margin;
  const lat = lng * Math.cos((((box[1] + box[3]) / 2) * Math.PI) / 180);
  return [
    [box[0] - lng, box[3] + lat],
    [box[2] + lng, box[3] + lat],
    [box[2] + lng, box[1] - lat],
    [box[0] - lng, box[1] - lat],
  ];
}
