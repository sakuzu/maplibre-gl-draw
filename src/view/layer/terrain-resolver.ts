// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * TerrainResolver
 *
 * Resolves the terrain state of a frame: the DEM atlas, the subdivision step, the region that
 * may be subdivided and the index of the real mesh step per tile. It owns the DEM atlas (the GPU
 * texture) and the key of the index, and writes the generation counters of the terrain context
 * of the instance.
 */

import type { Map as MapLibreMap } from 'maplibre-gl';
import {
  INACTIVE_TERRAIN_STATE,
  type TerrainContext,
  type TerrainRenderState,
} from '../terrain/context.js';
import { DemAtlas } from '../terrain/dem-atlas.js';
import { getMapTerrain, getRenderableTerrainTiles, getTerrainMeshSize } from '../terrain/detect.js';
import {
  circumferenceAtLatitude,
  metersToMercatorScale,
  TERRAIN_REGION_MARGIN,
  terrainLiftMeters,
} from '../terrain/metrics.js';
import {
  atlasCoverage,
  containsRect,
  expandRect,
  intersectRect,
  type MercatorRect,
  mercatorX,
  mercatorY,
} from '../terrain/tessellation.js';
import { buildTessellationTiling } from '../terrain/tiling.js';

/**
 * Resolves the terrain state frame by frame
 *
 * @internal
 */
export class TerrainResolver {
  private readonly map: MapLibreMap;
  private readonly terrainContext: TerrainContext;
  /**
   * DEM atlas (used only in the frames where the terrain is active)
   *
   * No GL resource is created on a map where the terrain never becomes active (lazy creation).
   */
  private demAtlas: DemAtlas | null = null;
  /** Key of the conditions under which the tile step index was built most recently */
  private tilingCacheKey = '';

  constructor(map: MapLibreMap, terrainContext: TerrainContext) {
    this.map = map;
    this.terrainContext = terrainContext;
  }

  /**
   * Resolves the terrain state of this frame
   *
   * It returns INACTIVE when there is no terrain or when not a single DEM has arrived yet.
   * Making "terrain present but DEM empty" active would only leave the features pinned at sea
   * level and fighting the terrain mesh (also flat, with the same empty DEM), so staying with the
   * previous rendering is safer.
   */
  resolve(gl: WebGL2RenderingContext | null): TerrainRenderState {
    const map = this.map;
    const terrainContext = this.terrainContext;
    const terrain = getMapTerrain(map);
    if (!terrain || !gl) return this.markInactive();

    if (!this.demAtlas) this.demAtlas = new DemAtlas(gl);
    const center = map.getCenter();
    // The tiles are placed around the camera (across the antimeridian the two ends of the world
    // sit next to each other in the atlas)
    const atlas = this.demAtlas.build(
      terrain,
      mercatorX(center.lng),
      map.areTilesLoaded?.() === true,
    );
    if (!atlas) return this.markInactive();

    const centerLat = center.lat;
    const circumference = circumferenceAtLatitude(centerLat);

    // The subdivision grid is placed exactly on the nodes of the terrain mesh of MapLibre.
    // The node spacing is 1/(2^z * meshSize) (in mercator units).
    const meshSize = getTerrainMeshSize(terrain);
    const stepGrid = 1 / (2 ** atlas.maxTileZoom * meshSize);
    const stepMeters = stepGrid * circumference;
    let stepChanged = false;
    // The ratio by which the step got finer. The shapes already baked are coarse by that ratio,
    // so it is used as the initial value of the depth bias (this keeps a hole from appearing for
    // one frame before the re-bake; the retained batch side also reports its own ratio on every
    // draw)
    let staleRatio = 1;
    if (stepGrid !== terrainContext.stepGrid) {
      if (terrainContext.stepGrid > stepGrid && stepGrid > 0) {
        staleRatio = terrainContext.stepGrid / stepGrid;
      }
      terrainContext.stepGrid = stepGrid;
      stepChanged = true;
    }

    // Decide the region that may be subdivided. It is taken again only when the step changed and
    // when the region now needed left the previous region (following it every frame would re-bake
    // the retained batches).
    //
    // The needed region is "the DEM atlas ∩ the view". Outside the atlas the elevation is capped
    // at the value of the edge, so subdividing there is pointless, and outside the view nobody
    // sees it. The atlas spreads up to 8 of the finest tiles (at most 2048 texels), so it is
    // often much wider than the view. At zoom 13 the view was 15 km while the atlas was 39 km,
    // and the features being subdivided ballooned by a factor of 6.
    const covered = this.visibleTessellationRect(atlasCoverage(atlas.rect));
    const region = terrainContext.tessellationRegion;
    if (stepChanged || !region || !containsRect(region, covered)) {
      terrainContext.tessellationRegion = expandRect(covered, TERRAIN_REGION_MARGIN);
      terrainContext.generation++;
      // The coarseness is measured again for each generation (the value of the previous
      // generation is not carried over)
      terrainContext.tessellationCoarsening = staleRatio;
    }

    // Index of the real mesh step per tile. Rebuilt when the region or the tile set changed
    const tilingKey = `${terrainContext.generation}|${terrainContext.coverageKey}`;
    if (tilingKey !== this.tilingCacheKey) {
      this.tilingCacheKey = tilingKey;
      terrainContext.tessellationTiling = buildTessellationTiling(
        getRenderableTerrainTiles(terrain),
        meshSize,
        terrainContext.tessellationRegion,
      );
    }

    return {
      active: true,
      atlasTexture: atlas.texture,
      atlasRect: atlas.rect,
      atlasSize: atlas.size,
      elevationScale: metersToMercatorScale(centerLat),
      liftMeters: terrainLiftMeters(atlas.maxTileZoom, centerLat),
      stepMeters,
      stepGrid,
      tessellationRegion: terrainContext.tessellationRegion,
      tessellationTiling: terrainContext.tessellationTiling,
      generation: terrainContext.generation,
    };
  }

  /** Drops the DEM atlas and the key of the index (the GPU side went away) */
  releaseGpu(): void {
    if (this.demAtlas) {
      this.demAtlas.dispose();
      this.demAtlas = null;
    }
    this.tilingCacheKey = '';
  }

  /**
   * The region that currently needs subdivision (atlas ∩ view)
   *
   * maplibre reports the view with unwrapped longitudes (across the antimeridian the east edge
   * is above 180), which is the frame the atlas is placed in as well (the copy nearest to the
   * camera). When the view cannot be obtained or does not form a rectangle, the atlas is
   * returned (it only subdivides too much; the picture is correct).
   */
  private visibleTessellationRect(atlasRect: MercatorRect): MercatorRect {
    const bounds = this.map?.getBounds?.();
    if (!bounds) return atlasRect;
    const west = bounds.getWest();
    const east = bounds.getEast();
    const south = bounds.getSouth();
    const north = bounds.getNorth();
    if (!(east > west) || !(north > south)) return atlasRect;

    const view: MercatorRect = {
      x0: mercatorX(west),
      y0: mercatorY(north),
      x1: mercatorX(east),
      y1: mercatorY(south),
    };
    return intersectRect(atlasRect, view) ?? atlasRect;
  }

  /**
   * Falls back to no terrain (the step counts as changed, so the generation is advanced)
   */
  private markInactive(): TerrainRenderState {
    const terrainContext = this.terrainContext;
    if (terrainContext.stepGrid !== 0) {
      terrainContext.stepGrid = 0;
      terrainContext.generation++;
    }
    return { ...INACTIVE_TERRAIN_STATE, generation: terrainContext.generation };
  }
}
