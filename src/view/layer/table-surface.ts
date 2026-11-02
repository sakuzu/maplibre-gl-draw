// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The surface the layers held as rows are drawn on, frame by frame (`TableSurface`)
 *
 * On the terrain and on the globe the chunks drawn in one draw hold their rows cut for the
 * surface (`RowsSurface` of `table-collect.ts`), and the points of the chunks the elevation of
 * the ground under them. This decides, once per frame, what they are cut with and what of the
 * elevations went stale:
 *
 * - the step of the fills: the step of the terrain (the step of its mesh, the tiles it is made
 *   of and the region cut), or the cell of the globe for the fills, with one coarsening for the
 *   whole frame: decided from the cells of the fills of the rows in view whenever the step
 *   changes, by powers of 2, with a margin before it is made finer again, so the fills next to
 *   each other always lie on one mesh
 * - the piece of the lines: on the terrain a length the camera does not change (the step of the
 *   mesh at {@link LINE_PIECE_ZOOM}), on the globe the cell of the globe for the lines
 * - the elevations of the points: the tiles of the terrain drawn changed (`elevationGeneration`),
 *   and the regions of the tiles that came or went, kept for the last generations so a chunk
 *   reads again only the points under them
 *
 * A new surface advances `generation`: the chunks cut for an older one are cut again, a row at a
 * time, the rows whose fingerprint changed (`rowSurfaceKey`).
 */

import type { BoundingBox } from '../../shared/types/model.js';
import { getGlobeTessellationStep, globeGridOf } from '../globe-subdivision.js';
import type { TerrainContext } from '../terrain/context.js';
import { getTerrainMeshSize } from '../terrain/detect.js';
import { TERRAIN_MAX_TILED_COARSEN } from '../terrain/metrics.js';
import { batchTessellationFactor, terrainStepOf } from '../terrain/polygon.js';
import { reportTerrainCoarsening } from '../terrain/state.js';
import {
  cellsInRegion,
  type MercatorRect,
  mercatorX,
  mercatorY,
  type TessellationStep,
} from '../terrain/tessellation.js';
import { TERRAIN_ANALYTIC_MIN_ZOOM } from './drape-planner.js';
import type { RowsSurface } from './table-collect.js';

/**
 * The zoom whose step of the terrain mesh is the piece a line on the terrain is cut into: the
 * finest zoom the lines are drawn at by moving their vertices onto the ground (above it they are
 * draped). A length the camera does not change, so the lines are cut once for a terrain
 *
 * @internal
 */
export const LINE_PIECE_ZOOM = TERRAIN_ANALYTIC_MIN_ZOOM;

/**
 * The factor of the cells below which the coarsening of the fills is made finer again: the
 * cells have to fall to a quarter (twice as fine a step) under the budget, so a view near the
 * budget does not cut the fills again and again
 */
const FINER_MARGIN = 4;

/** The generations of the elevations whose changed regions are kept */
const KEPT_ELEVATION_CHANGES = 8;

/** The changes of the elevations of one generation (null regions: everything changed) */
interface ElevationChange {
  readonly generation: number;
  readonly regions: readonly MercatorRect[] | null;
}

/**
 * The polygon rows a coarsening is decided for: visits the extent of each polygon row that may
 * meet a view (in degrees), passing over the groups whose extent does not meet it
 *
 * @internal
 */
export interface SurfaceCells {
  forEachFill(
    view: BoundingBox,
    visit: (minX: number, minY: number, maxX: number, maxY: number) => void,
  ): void;
}

/**
 * The surface the layers held as rows are drawn on, decided once per frame
 *
 * @internal
 */
export class TableSurface {
  /** How the rows are cut in this frame (null on a flat map) */
  surface: RowsSurface | null = null;
  /** Advances whenever the surface changes */
  generation = 0;
  /** The coarsening of the fills of the frame (a power of 2) */
  private coarsening = 1;
  /** What the coarsening was decided for */
  private coarseningFor = '';
  private key = '';
  /** The index of the tiles of the terrain seen last, and a number for each new one */
  private tiling: object | null = null;
  private tilingCount = 0;
  /** The tiles of the terrain drawn, as the coverage names them, at the generation seen last */
  private tiles = new Set<string>();
  private elevationGeneration = -1;
  private readonly changes: ElevationChange[] = [];

  /**
   * Decides the surface of a frame
   *
   * @param terrain The terrain state of the draw instance
   * @param view The view (the cells of the fills in it decide the coarsening)
   * @param cells The fills of the rows drawn
   */
  update(terrain: TerrainContext, view: BoundingBox, cells: SurfaceCells): void {
    this.trackElevations(terrain);
    const terrainStep = terrainStepOf(terrain);
    const base = terrainStep ?? getGlobeTessellationStep(terrain, 'fill');
    const linePiece = terrainStep ? terrainLinePiece(terrain) : globeGridOf(terrain, 'line');
    if (!base && !(linePiece > 0)) {
      this.set('', null);
      return;
    }
    const tiling = terrainStep?.tiling ?? null;
    if (tiling !== this.tiling) {
      this.tiling = tiling;
      this.tilingCount++;
    }
    const step = terrainStep ? `t${terrain.renderState.generation}` : `g${terrain.globeGeneration}`;
    const decidedFor = base ? `${step}|${base.grid}` : '';
    if (base && decidedFor !== this.coarseningFor) {
      this.coarseningFor = decidedFor;
      this.coarsening = nextCoarsening(this.coarsening, fillCells(base, view, cells));
    }
    // The bias of the depth follows the coarsest step of the generation
    if (terrainStep) reportTerrainCoarsening(terrain, this.coarsening);
    const fill = base ? coarsened(base, this.coarsening) : null;
    const key = `${decidedFor}|${this.tilingCount}|${this.coarsening}|${linePiece}|${terrainStep !== null}`;
    this.set(key, { fill, linePiece, orient: terrainStep !== null });
  }

  /**
   * The regions where the elevations changed since a generation of the elevations (null when
   * everything has to be read again: the generation is older than the ones kept)
   */
  elevationChangesSince(generation: number): readonly MercatorRect[] | null {
    if (generation === this.elevationGeneration) return [];
    const oldest = this.changes[0];
    if (!oldest || generation < oldest.generation - 1) return null;
    const regions: MercatorRect[] = [];
    for (const change of this.changes) {
      if (change.generation <= generation) continue;
      if (!change.regions) return null;
      regions.push(...change.regions);
    }
    return regions;
  }

  private set(key: string, surface: RowsSurface | null): void {
    if (key === this.key) return;
    this.key = key;
    this.surface = surface;
    this.generation++;
  }

  /** Records the tiles of the terrain that came or went with a new generation of the elevations */
  private trackElevations(terrain: TerrainContext): void {
    const generation = terrain.elevationGeneration;
    if (generation === this.elevationGeneration) return;
    const tiles = new Set(terrain.coverageKey.split(',').filter((tile) => tile !== ''));
    const regions: MercatorRect[] = [];
    for (const tile of tiles) if (!this.tiles.has(tile)) regions.push(tileRect(tile));
    for (const tile of this.tiles) if (!tiles.has(tile)) regions.push(tileRect(tile));
    // The first generation seen, or a jump of more than one: everything is read again
    const known = this.elevationGeneration >= 0 && generation === this.elevationGeneration + 1;
    this.changes.push({ generation, regions: known ? regions : null });
    if (this.changes.length > KEPT_ELEVATION_CHANGES) this.changes.shift();
    this.tiles = tiles;
    this.elevationGeneration = generation;
  }
}

/** The piece a line on the terrain is cut into, in Mercator units */
function terrainLinePiece(terrain: TerrainContext): number {
  const source = terrain.anchorFrame.terrain;
  const meshSize = source ? getTerrainMeshSize(source) : 128;
  return 1 / (2 ** LINE_PIECE_ZOOM * meshSize);
}

/** The cells of the fills of the rows in view on a step */
function fillCells(base: TessellationStep, view: BoundingBox, cells: SurfaceCells): number {
  let total = 0;
  cells.forEachFill(view, (minX, minY, maxX, maxY) => {
    if (minX > view.maxX || maxX < view.minX || minY > view.maxY || maxY < view.minY) return;
    // Mercator y decreases as the latitude increases
    total += cellsInRegion(
      mercatorX(minX),
      mercatorY(maxY),
      mercatorX(maxX),
      mercatorY(minY),
      base.grid,
      base.region,
    );
  });
  return total;
}

/**
 * The coarsening of the next step: coarser at once when the cells exceed the budget of the
 * fills, finer only once they fall well under it
 *
 * @internal
 */
export function nextCoarsening(previous: number, cells: number): number {
  const coarser = batchTessellationFactor(cells);
  if (coarser >= previous) return coarser;
  const finer = batchTessellationFactor(cells * FINER_MARGIN);
  return finer < previous ? finer : previous;
}

/** A step coarsened by a factor, as the batches of polygons coarsen theirs */
function coarsened(base: TessellationStep, factor: number): TessellationStep {
  if (!(factor > 1)) return base;
  // On the index of the tiles the factor is kept small (the cut stays on the nodes of the mesh)
  if (base.tiling) return { ...base, coarsen: Math.min(factor, TERRAIN_MAX_TILED_COARSEN) };
  return { grid: base.grid * factor, maxPoints: base.maxPoints, region: base.region };
}

/** The Mercator rectangle of a tile named as the coverage names it (`wrap/z/x/y`) */
function tileRect(tile: string): MercatorRect {
  const [wrap, z, x, y] = tile.split('/').map(Number);
  const size = 1 / 2 ** z;
  return { x0: wrap + x * size, y0: y * size, x1: wrap + (x + 1) * size, y1: (y + 1) * size };
}
