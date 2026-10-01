# Coupling Points into maplibre Internals

This document lists the places where `@sakuzu/maplibre-gl-draw` relies on
the internal behavior of maplibre-gl-js. The library draws with a
CustomLayer rather than with style layers, so the public API alone is not
enough, and some code touches or imitates the upstream implementation. The
terrain code in particular contains imitations and avoidances written
against the maplibre source, and a version upgrade can break them
silently.

The peer declaration is `~6.11.1` (the patch releases of 6.11). Every
reliance below was checked against the 6.11.1 implementation, the exact
version in `devDependencies` that the tests and the examples run on; a new
minor version is admitted only after the same check.
Upstream file paths and line numbers refer to the maplibre-gl-js 6.11.1
source tree.
When upgrading, check the upstream location of each item against the new
source (the release procedure is in [releasing](./releasing.md)).

## How to Read This

Each item has the same five parts.

- Upstream behavior — where in maplibre something is done, and what
- What we rely on — which file of this library depends on it and how,
  labelled as one of imitation (we copied upstream logic), avoidance (we
  steer around an upstream property) or assumption (we ride on upstream
  behavior)
- Symptoms when it breaks — what a user sees
- Check when upgrading — the automated test that guards it, if there is
  one, and the manual check otherwise
- Conditions for removal — what upstream change would make the item
  unnecessary

## 1. The Depth State Passed to a `'3d'` CustomLayer

- Upstream behavior — `webgl/draw/draw_custom.ts:68` passes
  `painter.getDepthModeFor3D()` when `renderingMode === '3d'`: `LEQUAL`,
  `DepthMode.ReadWrite` and `renderContext.depthRangeFor3D`
  (`render/painter.ts:489`). `depthRangeFor3D` is recomputed every frame
  (`render/painter.ts:581`) as
  `[0, 1 - (style._order.length + 2) * numSublayers * depthEpsilon]`, and
  the same range is given to the terrain mesh and to `'3d'` custom layers.
  Depth test and blending are on, face culling is off.
- What we rely on — assumption. Every frame of the stacking order in
  `src/view/layer/custom-layer.ts` is registered with `renderingMode: '3d'`
  and receives the depth test enabled with `LEQUAL`.
  `applySegmentDepthState` in `src/view/layer/gl-state.ts` (at the start
  of a slot and again after the drape) keeps the test and `LEQUAL` and
  turns off depth writes only, because the stacking order of the library
  must not be reordered by depth.
  `gl.depthRange` is never overwritten. Face culling is applied by us only
  to the terrain fill (`pushOriented` in `src/view/terrain/tessellation.ts`).
- Symptoms when it breaks — if the `depthRange` formula changes, the depth
  of our polygons and of maplibre's terrain mesh no longer mesh, and dotted
  breakthroughs appear on ridges and in valleys. With `renderingMode: '2d'`
  maplibre passes `DepthMode.disabled` while terrain is on, and features
  behind a mountain are always drawn in front.
- Check when upgrading — `src/e2e/terrain-occlusion.e2e.test.ts`
  (`npm run test:e2e`) reads the pixels behind a peak and in front of it
  for lines and polygons of both paths, and checks that points behind it
  are drawn faintly. Manually, enable terrain, tilt the view to 60
  degrees or more, and see that polygons and lines behind a ridge are
  hidden. Read the GL state (depth test, depth mask, depth range) right
  before the CustomLayer call and compare it with the values above.
- Conditions for removal — none. As long as we draw with a CustomLayer we
  follow the upstream depth convention.

## 2. The Shader Prelude Lacks the `TERRAIN3D` Clause

- Upstream behavior — `shaders/glsl/_prelude.vertex.glsl:137-169` defines
  `ele(ivec2)` and `get_elevation(vec2)` inside `#ifdef TERRAIN3D`, and
  `webgl/program.ts:102` adds `#define TERRAIN3D;` only for maplibre's own
  programs with `useTerrain`. The prelude handed to a CustomLayer contains
  only the projection part, so adding the `#define` ourselves does not help:
  the function bodies are missing. The DEM texture of a tile is `dim + 4`
  texels on a side, the pixels behind a border of 2 texels
  (`data/dem_data.ts:54` and `_idx` at `:140`, filled from the neighbors by
  `backfillBorder` at `:157`), and `get_elevation` reads the texel
  coordinate `uv * u_terrain_dim + 1.5`: DEM pixel `i` is centred on
  `(i + 0.5) / dim`. The CPU sampler behind `map.queryTerrainElevation`
  places the pixels the same way (`DEM_CELL_CENTER_OFFSET`,
  `render/terrain.ts:60`). Up to 6.7 the border was 1 texel and the offset
  `+ 1.0`; 6.8.0 and 6.9.1 changed both (maplibre-gl-js#8420).
- What we rely on — imitation. Everything that depends on the layout is in
  `src/view/terrain/upstream-terrain.ts` (`DEM_BORDER_TEXELS`,
  `DEM_TEXEL_OFFSET`, `demLastTexel` and the GLSL `UPSTREAM_DEM_GLSL`),
  whose header names the upstream files and lines it copies. The drape
  (`TERRAIN_SAMPLE_GLSL` and the shading window `drapeShadeWindow` in
  `src/view/terrain/drape/shared.ts`, `drape_edge_elevation` in
  `drape/edge-constrain.ts`) and the bake of the DEM atlas
  (`src/view/terrain/dem-atlas.ts`) read maplibre's DEM textures only
  through it: the same `texelFetch` of four texels and hand-written
  bilinear interpolation (an encoded DEM cannot be interpolated linearly).
  `dem_elevation_meters` in `src/view/shaders/helpers.ts` reads the atlas,
  not maplibre's textures, so it holds no copy.
- Symptoms when it breaks — if upstream changes the DEM encoding, the
  border or the offset, our elevations drift away from maplibre's terrain
  surface by part of a DEM pixel. The drift is largest on slopes: the fill
  is eaten by the terrain in a dendritic pattern, or it breaks through
  ridges. With the 6.7 offset on 6.11.1 the test terrain of the end-to-end
  test is off by 26 m in the drape and 28 m in the atlas.
- Check when upgrading — `src/e2e/terrain.e2e.test.ts`
  (`npm run test:e2e`) draws a known DEM with a real maplibre, evaluates
  `drape_get_elevation` on the GPU with the DEM textures maplibre renders
  with, reads the baked atlas back, and compares both with
  `map.queryTerrainElevation` (within 0.05 m).
  `src/view/terrain/drape/shade.test.ts` models the border for the shading
  window. By hand, compare `ele`, `get_elevation` and `DEMData` with
  `upstream-terrain.ts`.
- Conditions for removal — if upstream includes the `TERRAIN3D` clause in
  the prelude it passes to custom layers, the port can go and we call
  upstream's `get_elevation`. This is worth requesting upstream.

## 3. The Generation Rule of `Terrain.getTerrainMesh`

- Upstream behavior — `getTerrainMesh` (`render/terrain.ts:445`) with
  `meshSize = 128` (`render/terrain.ts:179`). Vertices are laid out in
  row-major order at `(x * delta, y * delta)`, `delta = EXTENT / meshSize`,
  over the closed interval `x, y = 0..meshSize`, and each cell is split into
  two triangles along the main diagonal from `(x, y)` to `(x+1, y+1)`
  (`render/terrain.ts:460-465`). Unless `_terrainSkirtLength` is `'none'`,
  `_buildSkirts` adds a skirt around the tile.
- What we rely on — imitation. `buildTerrainMeshArrays` in
  `src/view/terrain/drape/mesh.ts` builds vertices and triangles by the
  same rule. `emitFan` in `src/view/terrain/tessellation.ts` splits cells
  along the same diagonal (the corner with the smallest Mercator coordinate
  is the fan origin). We build no skirts: their walls would stand on the
  same plane as maplibre's own skirts and show as bands along tile
  boundaries.
- Symptoms when it breaks — if the vertex order or the diagonal changes,
  the two surfaces agree at the nodes but twist apart inside each cell. The
  fill is shaved along the creases of a slope and shows thin streaks.
- Check when upgrading — `src/view/terrain/drape/mesh.test.ts` pins our
  own generation rule. It cannot see upstream, so compare the new
  `getTerrainMesh` with it by hand.
- Conditions for removal — if upstream exposes mesh generation as a public
  API, call it instead of the port.

## 4. The Mesh Step Changes per Tile (`meshSize` and Variable Zoom)

- Upstream behavior — terrain is a piecewise-linear surface over a fixed
  grid per tile; the grid spacing is the tile's Mercator width divided by
  `terrain.meshSize`. Tile zoom is chosen by distance, so a pitched view
  mixes tiles of many zoom levels on one screen.
- What we rely on — imitation (exact match). `buildTessellationTiling` in
  `src/view/terrain/tiling.ts` maps each cell of the finest tile size to
  the mesh step of the tile that covers it, and `subdivideTriangles` in
  `src/view/terrain/tessellation.ts` splits each cell with that step. The
  step comes from `getTerrainMeshSize()` in `src/view/terrain/detect.ts`
  (128 when absent) and `stepGrid` in `src/view/terrain/context.ts`
  (`1 / (2^z * meshSize)`). Coarsening is limited to powers of two, capped
  by `TERRAIN_MAX_TILED_COARSEN` in `src/view/terrain/metrics.ts`.
- Symptoms when it breaks — where our step is finer than the tile's mesh,
  our nodes follow the DEM down into a valley while maplibre's coarse chord
  spans above it, and the fill sinks below the terrain and is shaved by
  depth. Where our step is coarser, our chord dives under ridges. A finer
  step is not safer; only an exact match is. The height differences are
  metres to tens of metres on steep terrain, far beyond what a depth bias
  can absorb.
- Check when upgrading — `src/view/terrain/tiling.test.ts` and
  `src/view/terrain/tessellation.test.ts`. By hand, view a steep slope with
  terrain enabled at a pitch of 60 degrees or more and see that the fill
  has no dropouts.
- Conditions for removal — none while upstream discretizes the terrain. A
  different default `meshSize` is followed automatically because
  `getTerrainMeshSize()` reads it.

## 5. `deltaZoom = 1` and the Coarse DEM of Neighboring Tiles

- Upstream behavior — `tile/terrain_tile_manager.ts:72-73` sets
  `deltaZoom = 1` and `tileSize = source.tileSize * 2 ** deltaZoom`.
  `getSourceTile` (`tile/terrain_tile_manager.ts:288`) looks for the DEM at
  `tileID.overscaledZ - deltaZoom`, capped at the source maxzoom, and walks
  up the ancestors while that DEM has not arrived (`searchForDEM`). Every
  drawing tile therefore uses a DEM one level coarser, and adjacent tiles of
  different zoom read DEMs of different resolution.
- What we rely on — assumption + avoidance. `src/view/terrain/drape/stitch.ts`
  returns, per tile edge, the coarser neighbor and a coordinate transform
  (`computeEdgeStitch`, `computeEdgeSteps`, `neighborTileTransform`). The
  vertex shader function `drape_constrain`
  (`src/view/terrain/drape/edge-constrain.ts`) takes the elevation of the
  finer side's boundary vertices from the coarse side's DEM itself. The
  mapping is a power-of-two scale plus a translation by whole mesh cells,
  so it is exact in float and the constrained nodes land on the coarse
  side's mesh nodes.
- Symptoms when it breaks — if the finer side sampled its own DEM at the
  coarse step, the two surfaces would separate by the difference in DEM
  resolution: thin or dotted seams along tile boundaries through which the
  basemap shows, most visible when overzoomed past the DEM maxzoom.
- Check when upgrading — `src/view/terrain/drape/stitch.test.ts`. In the
  new `terrain_tile_manager.ts`, confirm that `deltaZoom` is still 1 and
  that `getSourceTile` still falls back to ancestors.
- Conditions for removal — if upstream stitches elevations between
  adjacent tiles itself, the constraint can go. `deltaZoom = 0` would
  reduce the level differences but not remove them while zoom is variable.

## 6. A Parent DEM Stands In Until the Tile's DEM Arrives

- Upstream behavior — `getTerrainData(tileID)` (`render/terrain.ts:378`)
  looks up the DEM with `tileManager.getSourceTile(tileID, true)` and
  returns an ancestor's texture and matrix until the intended zoom arrives.
  The real one is swapped in as soon as it arrives, while the tile IDs
  returned by `getRenderableTiles()` stay the same. The call also uploads a
  DEM texture lazily when needed, and it is the only legitimate route for a
  CustomLayer to obtain a DEM texture.
- What we rely on — assumption + avoidance. The plan of `DrapePlanner` in
  `src/view/layer/drape-planner.ts` stores only the tile ID, the row number
  and the ground size; the DEM texture and matrix are looked up again on
  every draw. `QuadDrapeFrame` in `src/view/terrain/drape/quad.ts` takes a
  lookup function for the same reason.
- Symptoms when it breaks — if the texture and matrix were cached in the
  plan, the ground would keep the coarse parent's elevations and disagree
  with maplibre's mesh: polygons and lines lose to depth and disappear, or
  float like a tent over summits. Moving the zoom (which changes the tile
  IDs) would fix it, while moving the bearing would not.
- Check when upgrading — manual. Reload a terrain map several times and
  see that the polygon fill covers the same pixels every time and after a
  zoom round trip.
- Conditions for removal — none. Upstream's lazy resolution is correct
  behavior; we only need to look it up every frame.

## 7. Where the Terrain Objects Live

- Upstream behavior — in v6 the DEM tiles are reached through
  `terrain.tileManager` (`TileManager`, formerly `SourceCache`) and the
  transform through `map.painter.transform`. None of these carry public
  types.
- What we rely on — avoidance. `src/view/terrain/detect.ts` is the only
  place that reaches into these objects. `getMapTerrain()` checks the shape
  structurally and returns null when it does not match, which falls back to
  flat rendering. `getRenderableTerrainTiles()` tries `tileManager` and
  then the v5 `sourceCache`, and returns an empty list when neither exists.
  `getCameraMercator()` looks at both transform locations.
  `getTerrainTileData()` reads `texture`, `u_terrain_matrix`,
  `u_terrain_unpack` and `u_terrain_dim` from `TerrainData` and rejects them
  unless the matrix has 16 elements and the unpack vector 4. No values are
  imported from `maplibre-gl` at runtime; where only `LngLat.wrap()` is
  needed we use our own container, so peer version differences cannot leak
  in.
- Symptoms when it breaks — if detection fails, terrain is treated as
  absent and features are drawn on a plane at sea level: lines become
  straight horizontal strokes across the screen and polygons become
  parallelograms unrelated to the terrain. A mere field rename upstream is
  enough to cause this.
- Check when upgrading — `src/view/terrain/anchor.test.ts` and
  `src/view/terrain/context.test.ts` use fake terrain objects, so confirm
  by hand that `terrain.tileManager`, `getRenderableTiles` and the
  `TerrainData` fields still exist in the new version.
- Conditions for removal — a typed public API for DEM textures would let
  this layer shrink. The v5 fallbacks (`sourceCache`, `map.transform`)
  serve no supported version and can be removed.

## 8. The Elevation of Symbols Comes from `map.queryTerrainElevation`

- Upstream behavior — `map.queryTerrainElevation` (`ui/map.ts:1528`) calls
  `Terrain.getElevationForLngLat` (`render/terrain.ts:246`). Where a
  terrain tile maplibre draws covers the point and its DEM has arrived, it
  samples that tile (the coverage index, `getCoverageIndex` at `:289` and
  `sampleAt` at `:574`), so the value is the elevation of the drawn
  surface, exaggeration included; elsewhere it walks the covering tiles of
  the whole view on every call. `MercatorTransform.locationToScreenPoint`
  (`geo/projection/mercator_transform.ts:368`), behind `map.project`, reads
  the same function (since 6.7, maplibre-gl-js#8212). Elevations in meters
  are turned into Mercator units on a sphere of radius `6371008.8`
  (`geo/lng_lat.ts:8`, `geo/mercator_coordinate.ts:14`).
- What we rely on — assumption + imitation. `groundElevationMeters` in
  `src/view/terrain/ground.ts` asks `map.queryTerrainElevation` for points
  inside the drawn tiles. `TerrainCoverage` indexes the tiles of
  `getRenderableTiles` (item 7) with the same keys as the coverage index
  (`wrap/z/x/y`, finest zoom first) to tell those points apart. Outside
  them nothing is drawn and the public method costs about 40 us a point,
  so the elevation comes from `getElevationForLngLatZoom(floor(zoom))`
  (`render/terrain.ts:232`), which is cheap; a change of the drawn tiles
  advances the anchor generation, and whatever baked an elevation is
  rebuilt. `anchorElevationMeters` and `projectAnchor`
  (`src/view/terrain/anchor.ts`) and the occlusion test (`occlusion.ts`)
  read it on the copy of the world the point is drawn on. The meters to
  Mercator factor (`circumferenceAtLatitude` in
  `src/view/terrain/metrics.ts`) uses maplibre's sphere
  (`UPSTREAM_EARTH_CIRCUMFERENCE_METERS` in `upstream-terrain.ts`), not
  the WGS84 equator of the geometry functions.
- Symptoms when it breaks — a symbol floats above or sinks into the slope
  it stands on, and is drawn and hit away from where `map.project` puts the
  ground. Before this item, symbols took `getElevationForLngLatZoom` at
  `floor(zoom)`: on 6.11.1 that is a different DEM tile from the drawn one
  wherever the view mixes zoom levels (up to 26 m off on the test terrain
  in a pitched view). The WGS84 circumference made every elevation
  0.1 % too small (1 px at the top of a 6,700 m exaggerated peak).
- Check when upgrading — `src/e2e/terrain.e2e.test.ts` compares
  `ExtensionContext.terrain.elevation` with `map.queryTerrainElevation`
  (within 1e-6 m) and `ExtensionContext.terrain.project` with `map.project`
  (within 0.01 px) over a pitched view of a known DEM.
  `src/view/terrain/ground.test.ts` covers the coverage keys and the
  fallback.
- Conditions for removal — a public way to ask whether a point is covered
  by a drawn tile, or a `queryTerrainElevation` that is cheap outside the
  coverage, would remove `TerrainCoverage` and the fallback.

## 9. `map.project` Is Not Used for Hit Testing

- Upstream behavior — with terrain, `map.project` multiplies the point and
  the elevation of item 8 by `_pixelMatrix3D`. Up to 6.6 that elevation
  walked the covering tiles of the view on every call, which made it
  hundreds of times slower than without terrain; since 6.7 the drawn tiles
  are sampled through the coverage index. Measured on 6.11.1 in headless
  Chromium (SwiftShader) with 10,000 points in view, it takes 2.6 ms at
  pitch 0 and 4.1 to 4.4 ms at pitch 60, about the cost of
  `queryTerrainElevation` itself (2.0 to 4.0 ms). For points outside the
  drawn tiles it is 36 to 48 us a point, because the elevation still walks
  the covering tiles there.
  `map.unproject` returns the intersection of the pointer ray with the
  terrain surface and is called for one point at a time.
- What we rely on — avoidance. `createCoordinateTransform` in
  `src/shared/math/transform.ts` routes `project` to our own anchor
  projection through `setAnchorProjector` / `getAnchorProjector` (the
  dependency is inverted because `shared` cannot depend on `view`). It is
  the CPU copy of the vertex shader's projection with the elevation of item
  8, so hit testing follows what is drawn, and it costs 5 to 7 ms per
  10,000 points on the first lookup of a frame (1.5 ms from the cache of the
  frame) and 0.6 us a point outside the drawn tiles. With the same
  elevation it lands within 0.01 px of `map.project`. `unproject` cannot be
  derived from the matrix alone, so maplibre's is used as is.
  `clampLatitude` avoids `map.project()` throwing beyond latitude ±90.
- Symptoms when it breaks — if the anchor projection drifts from the
  shader, symbols are hit away from where they are drawn. Handing hit
  testing to `map.project` would stall on vertices outside the drawn tiles
  (hit testing, bounding boxes and margins project them).
- Check when upgrading — the hit-testing insertion cases of
  `src/view/terrain/anchor.test.ts`, and the `map.project` comparison of
  `src/e2e/terrain.e2e.test.ts`. Measure `map.project` outside the drawn
  tiles again.
- Conditions for removal — a `map.project` that is cheap outside the drawn
  tiles would let hit testing use it, as long as the shader's projection
  stays within a fraction of a pixel of it. The single source of elevation
  (item 8) stays.

## 10. `terrain.depthAtPoint` Is Not Used

- Upstream behavior — up to 6.9 it read the depth buffer with a
  synchronous `readPixels` for each point. 6.10.0 removed it: markers are
  now tested with a CPU ray walk over the DEM (`isLocationOccluded`,
  `geo/projection/mercator_transform.ts:913`), which is internal.
- What we rely on — avoidance. `isAnchorOccluded` in
  `src/view/terrain/occlusion.ts` steps along the segment from the camera
  to the anchor and reports occlusion when the ground rises above it. The
  step follows `stepGrid` (the terrain mesh spacing). Billboards are not
  depth-tested at all: their order comes from the depth of one centre
  point, so a depth test would hide a whole label buried a few metres into
  the ground.
- Symptoms when it breaks — if `depthAtPoint` were used, rendering would
  stall in proportion to the number of symbols, reaching seconds per frame
  on label-heavy maps.
- Check when upgrading — `src/view/terrain/occlusion.test.ts`.
- Conditions for removal — a public upstream occlusion query (such as the
  internal `isLocationOccluded`) could be considered. A synchronous
  `readPixels` stays rejected.

## 11. `transform.cameraPosition` Is Not Used

- Upstream behavior — the value is in mixed units (x and y in world
  pixels, z on another scale), and the factor to convert it to Mercator
  depends on the version.
- What we rely on — avoidance. `getCameraMercator()` in
  `src/view/terrain/detect.ts` assembles the camera position from
  `getCameraLngLat()` and `getCameraAltitude()`.
- Symptoms when it breaks — the camera used for occlusion is misplaced, so
  symbols in front of a ridge disappear or symbols behind it appear, and a
  version change breaks it silently.
- Check when upgrading — `src/view/terrain/occlusion.test.ts`. By hand, at
  a pitch of 70 degrees, see symbols appear and disappear correctly across
  a ridge.
- Conditions for removal — if upstream exposes a camera position in
  consistent units, we may switch to it.

## 12. The Two Holes in `getProjectionData`

- Upstream behavior — `getProjectionData({ tileID: null })` throws
  (`Cannot read properties of null (reading 'canonical')`) although the
  documentation comment suggests null is allowed. With a real tile ID,
  `applyTerrainMatrix: true` returns the same matrix as false: the
  `OverscaledTileID` a CustomLayer sees has a null `terrainRttPosMatrix32f`,
  so the terrain branch is never taken. The flag is dead for custom layers.
- What we rely on — avoidance. We never pass null and never set
  `applyTerrainMatrix`. The drape (`src/view/layer/drape-planner.ts`) and
  the textured-quad frame (`src/view/layer/frame-state.ts`) call
  `getProjectionData` with the tile IDs of the renderable terrain tiles,
  wrapped in try/catch; a failure yields null and that tile is skipped.
  Everything else uses `args.defaultProjectionData`.
- Symptoms when it breaks — an exception that escaped would lose a whole
  frame, and the map would flicker or freeze.
- Check when upgrading — manual. See whether the new version accepts null
  and whether `applyTerrainMatrix` has an effect for custom layers.
- Conditions for removal — if upstream accepts null as documented and
  honours `applyTerrainMatrix` for custom layers, the try/catch and part
  of our matrix assembly can go. A candidate to report upstream.

## 13. The Exaggeration Is Read from `terrain.exaggeration`

- Upstream behavior — the `Terrain` class keeps the factor given to
  `setTerrain` in its `exaggeration` field (1 when omitted) and multiplies
  every elevation by it: `u_terrain_exaggeration` from `getTerrainData`,
  `getElevation` (`render/terrain.ts:271`) and the coverage sampler behind
  `queryTerrainElevation`. `map.getTerrain()` returns the
  specification as passed, where `exaggeration` may be undefined.
- What we rely on — assumption. `getTerrainExaggeration()` in
  `src/view/terrain/detect.ts` reads `terrain.exaggeration` from the same
  internal object as item 7, then `terrain.options.exaggeration`, then 1.
  The DEM atlas (`src/view/terrain/dem-atlas.ts`) bakes elevations
  multiplied by it, and `applyDrapeTerrainUniforms()` in
  `src/view/terrain/drape/shared.ts` writes it to
  `u_terrain_exaggeration`. CPU-side anchors use
  `queryTerrainElevation` (item 8), which already includes it, so all
  three paths stand on the map's surface.
- Symptoms when it breaks — after a field rename the factor falls back to
  the specification or to 1. With an exaggeration other than 1, polygons
  and lines then sink below or float above the terrain while symbols (CPU
  side) stay on it. The atlas stores exaggerated elevations in a range of
  ±32768 m, so a factor that pushes the highest peaks past it clips them.
- Check when upgrading — `src/view/terrain/detect.test.ts` and
  `src/view/terrain/drape/shared.test.ts` use fake terrain objects.
  Confirm by hand that `Terrain` still has the `exaggeration` field, and
  draw a polygon on terrain with `exaggeration: 1.5` to see it stays on the
  ground.
- Conditions for removal — a typed public API for the effective
  exaggeration would replace the internal read.

## 14. The Projection Uniform in the Prelude

- Upstream behavior — the globe prelude declares `u_projection_transition`
  and the Mercator prelude does not. The globe declarations sit inside
  `#ifndef PROJECTION_UBO`; maplibre's own programs define it and read the
  values from a uniform block, while the prelude handed to a custom layer
  (`webgl/draw/draw_custom.ts:27`) leaves it undefined, so the plain
  uniforms stay. Only the projection part of the
  prelude reaches a CustomLayer, and `projectTile` is implemented
  differently for globe and Mercator.
- What we rely on — avoidance + assumption.
  `getProjectionTransitionUniform(prelude)` in
  `src/view/shaders/helpers.ts` inspects the prelude string and adds the
  uniform declaration only when the prelude lacks it. At high zoom (item
  15) the shaders use a linearized projection derived from deck.gl instead
  of `projectTile`; at low zoom they use `projectTileWithElevation`,
  relying on it being identical to `projectTile` at elevation 0.
- Symptoms when it breaks — a duplicate or a missing declaration fails the
  shader compilation, and nothing of the library is drawn.
- Check when upgrading — `src/view/shaders/compile.test.ts` runs a
  maplibre map in headless Chromium, takes the Mercator and globe preludes
  it hands to a custom layer, and compiles and links every program of the
  library with each. `npm run typecheck` cannot catch this. By hand, see
  that drawing appears in both projections.
- Conditions for removal — if upstream documents the prelude contents as a
  stable contract, a plain conditional can replace the string inspection.

## 15. The `zoom >= 12` Branch for Offset Mode

- Upstream behavior — not an upstream mechanism as such, but maplibre's
  matrices work in Mercator world coordinates 0..1, and in Float32 that
  leaves several pixels of rounding inside a z16 tile. The matrices are
  assembled with factors taken from the centre latitude of the view.
- What we rely on — assumption. `src/view/shaders/projection.ts` raises
  `u_use_offset_mode` at `zoom >= 12`. `OFFSET_MODE_MIN_ZOOM = 12` in
  `src/view/terrain/anchor.ts` must always equal that threshold.
  `metersToMercatorScale()` in `src/view/terrain/metrics.ts` produces the
  same factor as `MercatorCoordinate.fromLngLat(lngLat, meters).z`; it
  depends on latitude but may be taken at the screen centre. Elevations
  passed to vertices must be in Mercator units, never in metres. The
  method is explained in [coordinate precision](./coordinate-precision.md).
- Symptoms when it breaks — if the thresholds differ, CPU anchors and GPU
  vertices go through different projection formulas and a symbol is drawn
  away from where it is hit. Elevations passed in metres send features
  into the stratosphere.
- Check when upgrading — `src/view/terrain/anchor.test.ts`. Whether
  upstream still assembles its matrices from the centre latitude is
  checked by hand.
- Conditions for removal — none. It is our own precision branch.

## 16. The `premultipliedAlpha` Canvas

- Upstream behavior — the WebGL context maplibre creates uses
  `premultipliedAlpha` (the WebGL default).
- What we rely on — avoidance. `applyDrawBlendState` in
  `src/view/layer/blend.ts` blends alpha with `ONE, ONE_MINUS_SRC_ALPHA`
  rather than the RGB factors. Applying the RGB factors to alpha would give
  `dst.a = a * a + (1 - a) * dst.a` and square the alpha.
- Symptoms when it breaks — translucent fills become far too faint (a 25 %
  fill ends up near 6 %), and on exported images only the opaque outlines
  of features remain.
- Check when upgrading — manual. Overlap translucent polygons and see that
  the density is as expected.
- Conditions for removal — none. If upstream changes the canvas settings,
  revisit the blend factors.

## 17. Passing Input Events Through to maplibre

- Upstream behavior (mouse) — maplibre's pan and zoom listen to mousedown,
  mousemove and mouseup on the canvas; `preventDefault` stops them.
- What we rely on (mouse) — avoidance. `src/dispatcher/input-router.ts`
  passes mousedown, mouseup and drag events through unless a mode consumes
  them. `onMouseDown` in `src/modes/select/mode.ts` returns true only when
  the press hits a handle or a feature; the router then stops the event,
  and the mode disables `dragPan` for the drag. A press on empty map
  returns false and maplibre pans.
- Upstream behavior (double click) — maplibre's double-click zoom reads
  the `defaultPrevented` flag of its own `MapMouseEvent`, not of the DOM
  event.
- What we rely on (double click) — `handleDoubleClick` in
  `src/dispatcher/normalizer.ts` calls `MapMouseEvent.preventDefault()`
  when a mode consumed the dblclick, so finishing a line or double-clicking
  a feature does not zoom.
- Upstream behavior (keyboard) — maplibre's keyboard handler (arrow keys,
  `+`, `-`) listens for keydown on the map container, the canvas's parent.
- What we rely on (keyboard) — the normalizer listens on the canvas and
  sees a key first. When a mode used a key the map also uses (it prevented
  the default, for example an arrow key moving the selection), the
  normalizer calls `stopPropagation()` so the container never sees it.
  Other keys keep bubbling to maplibre and the page.
- Upstream behavior (touch) — maplibre fires the map events `touchstart`,
  `touchmove`, `touchend` and `touchcancel` from passive listeners on the
  canvas container. `preventDefault()` on the `touchstart` map event
  (`MapTouchEvent`) stops its drag pan, pinch, rotate and tap zoom for that
  touch; on the DOM `touchstart` it has no effect. A DOM `preventDefault()`
  on `touchend` suppresses the compatibility mouse events and with them
  maplibre's `click` map event. Since 6.11.0 a single finger held still
  for 500 ms fires a `contextmenu` map event built from a synthetic
  `MouseEvent` (`ui/handler/map_event.ts:163`).
- What we rely on (touch) — avoidance. `src/dispatcher/normalizer.ts`
  subscribes to the four touch map events, never calls `preventDefault` on
  them, and leaves every gesture with two or more fingers to maplibre (a
  second finger cancels the one-finger press with `dragcancel`).
  Compatibility mouse events after a tap are filtered inside the
  normalizer instead of being suppressed, so the host's `map.on('click')`
  keeps working on touch screens. maplibre's long-press `contextmenu`
  arrives while the finger is still down, so the same filter drops it and
  the normalizer's own long press stays the only one a mode sees. A mode
  that takes over a one-finger press calls `dragPan.disable()`; maplibre
  checks `isEnabled()` per event, so disabling it inside the `touchstart`
  listener applies to that touch.
- Symptoms when it breaks — the map stops panning in editing modes; a
  double click that finishes a line also zooms; an arrow key both moves the
  selection and pans. On touch screens pinch zoom stops working, a tap is
  delivered twice, or the host's click handlers never fire.
- Check when upgrading — `npm run test:e2e` drives the real mouse and
  keyboard. By hand on a touch screen, see that one finger drags a feature,
  two fingers pinch the map, and a tap adds one vertex.
- Conditions for removal — none.

## 18. `EXTENT` Is 8192

- Upstream behavior — the side length of the tile coordinate system, also
  used in `delta = EXTENT / meshSize` in `render/terrain.ts`.
- What we rely on — assumption. `TILE_EXTENT = 8192` is hard-coded in
  `src/view/terrain/dem-atlas.ts` and `src/view/terrain/drape/mesh.ts`.
- Symptoms when it breaks — terrain mesh coordinates are wrong everywhere
  and the drape collapses.
- Check when upgrading — confirm the definition of `EXTENT` in the new
  source and update the two constants if it changed.
- Conditions for removal — if upstream exports `EXTENT` publicly, read it
  instead.

## 19. No Global State (Several Maps on a Page)

- Upstream behavior — several Maps and CustomLayers can live on one page
  (a main view, thumbnails, previews, print). maplibre gives each its own
  terrain and painter.
- What we rely on — assumption. The library keeps nothing per page. The
  terrain frame state, the generation counter, the subdivision cache and
  the DEM coverage generation live in `TerrainContext`
  (`src/view/terrain/context.ts`), and each CustomLayer owns one in its
  render scope (`src/view/layer/render-scope.ts`) together with the
  per-feature triangulation and style caches. No reader looks up "the
  instance drawn last": renderers receive their context at construction,
  an extension renderer gets its anchors as `RenderContext.terrain`, a
  plugin projects through `ExtensionContext.terrain.project`, and hit testing is
  bound per map with `setAnchorProjector(map, ...)`. The registries of the
  extension points belong to the draw instance as well (see
  [architecture](./architecture.md)). The depth-test record is kept per
  WebGL context, which owns the state it mirrors. `onRemove` and `destroy`
  release only their own state.
- Symptoms when it breaks — with module-level state, two instances
  interfere: one instance's counter hides another's change so flat
  geometry is never rebuilt over terrain, auxiliary handles of one instance
  appear in the other, and a feature with the same ID in two instances is
  drawn with the other's triangles.
- Check when upgrading — `src/view/terrain/context.test.ts`,
  `src/api/impl/extensions.test.ts` and
  `src/view/layer/render-scope.test.ts`.
- Conditions for removal — none. It matches upstream's design.

## 20. The Tiling Fingerprint Uses Absolute Steps

- Upstream behavior — moving the camera changes the zoom of the distant
  tiles, and a one-level zoom change moves both the tile zooms and the
  finest zoom in view together.
- What we rely on — assumption. `tilingSignature()` in
  `src/view/terrain/tiling.ts` encodes each step as an absolute log2
  exponent. A step relative to the finest tile in view would stay the same
  across a zoom change even though the real step doubled. A step converted
  to metres is wrong too: it changes with tiny latitude moves and would
  advance the generation every frame.
- Symptoms when it breaks — polygons subdivided for the old tiling remain,
  their chords disagree with the new mesh, and dotted breakthroughs and
  seams appear on ridges and in valleys. The view is clean after a reload
  but degrades after panning and zooming. With a metre-based fingerprint,
  every frame rebuilds and panning becomes sluggish.
- Check when upgrading — the `tilingSignature` cases of
  `src/view/terrain/tiling.test.ts`.
- Conditions for removal — none.

## 21. Tile Skirts (`terrainSkirtLength`)

- Upstream behavior — `getSkirtLength` (`render/terrain.ts:486`) returns
  `2πR / 2^zoom / 5`, and `webgl/draw/draw_terrain.ts:58` passes it as
  `u_ele_delta`. `terrain.vertex.glsl` and `terrain_depth.vertex.glsl`
  lower the edge vertices (`a_pos3d.z == 1.0`) by that amount, so a
  vertical wall stands at each tile edge and writes depth. It plugs
  hairline gaps against neighbors of another zoom. The default is `'auto'`;
  `MapOptions.terrainSkirtLength: 'none'` builds none.
- What we rely on — assumption. The drape paints the ground surface
  itself, so at an LOD boundary the skirt wall of the finer tile stands in
  front of it and wins the depth test. The library does not touch this
  setting; the host decides it when creating the `Map`. T-junctions at
  tile boundaries are closed by the library's own edge constraint
  (`src/view/terrain/drape/edge-constrain.ts`), shared by polygons and
  lines (`src/view/terrain/drape/renderer.ts`) and textured quads
  (`src/view/terrain/drape/quad.ts`), so the library's drawing has no
  cracks with `'none'`.
- Symptoms when it breaks — with skirts enabled the drape fill disappears
  in a band along LOD boundaries, and the basemap shows there as a
  vertically stretched pattern. With `'none'`, maplibre's own terrain mesh
  may show hairline gaps at LOD boundaries (a known upstream trade-off; our
  edge constraint only affects our drawing).
- Check when upgrading — `src/view/terrain/drape/renderer.test.ts` (the
  edge texture unit does not collide with the DEM atlas) and
  `src/view/terrain/drape/stitch.test.ts` (steps and mapping). The walls
  themselves can only be checked by eye: terrain on, pitch 60 degrees or
  more, an LOD boundary in view.
- Conditions for removal — if upstream constrains terrain mesh edges to
  their neighbors without skirts, this item goes away.

## 22. Whether the Style Accepts Layers, and Where the Slots Go

- Upstream behavior — `Map.addLayer` (`ui/map.ts:3520`) calls
  `Style.addLayer`, which calls `Style._checkLoaded()`
  (`style/style.ts:706`) and throws `Style is not done loading.` while
  `Style._loaded` is false. `Style._load` (`style/style.ts:485`) sets
  `_loaded` as soon as the stylesheet is parsed, before sprites, glyphs and
  tiles, then fires `styledata` and `style.load`. The public
  `map.loaded()` and `map.isStyleLoaded()` are also false while tiles or
  images load, which happens after every pan, so neither answers "can a
  layer be added now". maplibre has no public API for that.
  A diffed `setStyle` (the default) goes through `Style.setState`
  (`style/style.ts:856`), which diffs `Style.serialize()` against the new
  stylesheet. `serialize()` skips custom layers (`_serializeByIds`,
  `style/style.ts:636`), so the diff neither removes nor adds them, and
  `diffLayers` of the style specification inserts each new layer before
  the next layer of the new stylesheet, or at the top when there is none:
  the layers of the new style end up above the custom layers. When the
  diff changed something, `setState` fires `style.load`
  (`style/style.ts:887`) at once, and `styledata` follows with the next
  frame (`Style.update`). A diff that changes nothing fires neither. A
  layer added or moved by the host fires `styledata` alone, never
  `style.load`.
- What we rely on — assumption. `styleAcceptsLayers()` in
  `src/view/layer/attach.ts` reads `map.style?._loaded === true`, the same
  condition `_checkLoaded` checks, and is the only reader.
  `attachSlotLayers()` checks it when Draw is created and on every
  `styledata` and `style.load`, and adds the frames missing from the map
  (a missing frame goes just behind the next frame on the map, so the
  frames stay in order). On `style.load` only, it also puts the frames
  back on top of the map with the public `map.getLayersOrder()` and
  `map.moveLayer()`: the block from the backmost frame to the frontmost
  one moves to the top, each frame with the native layers that sat just
  above it (the separators of the host), and the layers that were above
  the frontmost frame stay below the block. Nothing moves when the block
  is already on top, so the `styledata` that follows a move finds nothing
  to do. Since a host's own `addLayer` fires no `style.load`, a layer the
  host puts above the drawing stays there until the style changes. The
  field `_loaded` is in the type definitions but its leading `_` marks it
  internal; the timing of `styledata` and `style.load` is part of the
  reliance.
- Symptoms when it breaks — if the field is renamed, the check is always
  false and the frames are never added. Nothing throws and nothing
  is logged: features exist in the Store but nothing is drawn. If
  `styledata` stops firing after a style change, the slots are not
  restored after a full `setStyle`, with the same silent result. If a
  diffed `setStyle` stops firing `style.load`, the frames stay under the
  layers of the new style and the drawing is hidden under the basemap.
  If `serialize()` starts to include custom layers, the diff removes the
  frames and `styledata` adds them back on top, which also works.
- Check when upgrading — `src/view/layer/attach.test.ts` uses a stand-in
  map. The E2E case "a diffed setStyle on a real map" in
  `src/e2e/draw.e2e.test.ts` diffs to a style with layers on a real map
  and checks the order of the layers and a pixel of a feature. By hand
  with the real version, create Draw before the style is parsed, after
  `load`, and during a pan with tiles loading; call `setStyle` with and
  without `diff`; features must be drawn above the style every time.
- Conditions for removal — a public method or event that says the style
  accepts layers would replace `styleAcceptsLayers()`. The move on
  `style.load` can go if a diffed `setStyle` keeps the custom layers on
  top by itself.

## 23. WebGL Context Loss Removes Every Custom Layer

- Upstream behavior — `Map._contextLost` (`ui/map.ts:4246`) calls
  `preventDefault()` on the canvas's `webglcontextlost` event (allowing the
  browser to restore the context), destroys the painter, serializes the
  style and destroys it. `Style.destroy()` (`style/style.ts:2186`) calls
  `onRemove` of every layer, custom ones included, and `Style.serialize()`
  skips custom layers (`_serializeByIds`, `style/style.ts:636`), with a
  warning that they cannot be restored. `Map._contextRestored`
  (`ui/map.ts:4280`) calls `setStyle` with the serialized style (no custom
  layers), builds a new painter on the same context and fires
  `webglcontextrestored`. maplibre never calls a custom layer's `onAdd`
  again by itself.
- What we rely on — assumption. `src/view/layer/custom-layer.ts` keeps
  everything that lives in the GL context in one pair,
  `buildGpuResources` / `releaseGpuResources`, run by `onAdd` /
  `onRemove`, so a layer removed and added again comes back whole; overlay
  renderers and custom feature renderers stay registered and receive
  `onAdd` again. After a restore, `attachSlotLayers()` (item 22) adds the
  slots back on the restored style's `styledata`. The layer also listens to
  `webglcontextlost` / `webglcontextrestored` on the canvas (these are GL
  context events, not input, so the input normalizer does not handle them)
  for a version that would keep custom layers through a loss. It does not
  call `preventDefault()` itself. Nothing is built or drawn while
  `gl.isContextLost()` is true.
- Symptoms when it breaks — if the slots are not added back after a
  restore, nothing of the library is drawn from then on, silently. A
  renderer that kept a GL object outside the pair would draw with a dead
  object: some features, images or text are missing while the rest draws.
- Check when upgrading — `src/view/layer/context-loss.test.ts`. By hand,
  take the `WEBGL_lose_context` extension of the map canvas's `webgl2`
  context, call `loseContext()` and then `restoreContext()` on the same
  extension object, and see that features, the selection UI and the
  snapping indicator come back, with and without terrain.
- Conditions for removal — the canvas listener can go once no supported
  version keeps custom layers through a loss. The resource pair stays,
  since `onAdd` / `onRemove` use it.

## 24. Unwrapped Longitudes from `getBounds` and `unproject`

- Upstream behavior — in Mercator, `MercatorTransform.getBounds()`
  (`geo/projection/mercator_transform.ts:534`) extends a `LngLatBounds`
  with `screenPointToLocation` of the four screen corners, which converts
  through `MercatorCoordinate.toLngLat()` (`geo/mercator_coordinate.ts:128`)
  without wrapping. A view across the antimeridian reports an east edge
  above 180 (or a west edge below -180), and a zoomed-out view can span
  more than 360 degrees. `map.getCenter()` is wrapped into [-180, 180].
- What we rely on — assumption. `src/view/viewport.ts` expands the
  unwrapped bounds without clamping longitude and splits them into the
  world copies they cover (`splitLongitudeCopies`), relying on the wrapped
  centre lying inside the unwrapped bounds. Rendering draws each copy
  through a virtual camera built from `defaultProjectionData` (`planCopies`
  in `src/view/layer/frame-state.ts`) and keeps a single copy while
  `projectionTransition` is above 0 (the globe has no seam). The DEM atlas
  (`src/view/terrain/dem-atlas.ts`) places each terrain tile on the world
  copy nearest the centre, and `visibleTessellationRect` in
  `src/view/layer/terrain-resolver.ts` intersects it with the unwrapped
  view, so both sides of the antimeridian sit side by side. Input takes the
  unwrapped pointer from `unproject`: `toStoredCopy` in
  `src/dispatcher/input-router.ts` brings every event onto the stored copy
  (into [-180, 180], or next to the first vertex of the shape being drawn)
  before a mode sees it, so stored coordinates never carry a world-copy
  longitude. Hit testing, handles and snapping do the same. Box selection
  (`boxRects` in `src/modes/select/box-selection.ts`) splits a box that
  crosses the antimeridian into two rectangles within [-180, 180]. No
  internal field of the transform is read.
- Symptoms when it breaks — wrapped bounds (west 170, east -170) would read
  as empty or reversed: features on one side of the antimeridian vanish,
  the second copy is not drawn, and the terrain subdivision region falls
  back to the whole atlas. A wrapped `unproject` would leave hit testing
  unaffected but make a box drawn across the line select the rest of the
  world instead.
- Check when upgrading — `src/view/viewport.test.ts`,
  `src/view/layer/world-copies.test.ts`,
  `src/view/terrain/dem-atlas.test.ts`,
  `src/dispatcher/hit-test/antimeridian.test.ts`,
  `src/snapping/antimeridian.test.ts` and
  `src/dispatcher/input-router-longitude.test.ts`. By hand, centre the map
  on longitude 180 at zoom 6, check that `map.getBounds().getEast()` is
  above 180, that features at 179.9 and -179.9 are drawn next to each other
  and can be selected and snapped to, and that a point placed just east of
  the line is stored with a negative longitude.
- Conditions for removal — none while features are stored in
  [-180, 180] and the view is continuous.

## 25. Pixel Store and Texture Bindings Are Borrowed During Uploads

- Upstream behavior — maplibre caches the GL state it sets in its
  `Context` (`webgl/context.ts`), including `UNPACK_FLIP_Y_WEBGL`,
  `UNPACK_PREMULTIPLY_ALPHA_WEBGL` and texture bindings, and skips calls
  whose value matches the cache. `Texture.update`
  (`webgl/texture.ts:77-126`) sets the pixel store for its own upload and
  resets it afterwards. After a custom layer's `render` and `prerender`,
  `webgl/draw/draw_custom.ts:58,76` calls `context.setDirty()`. Nothing
  resets the cache when a custom layer touches the context outside those
  calls.
- What we rely on — avoidance + assumption. Every texture is uploaded
  during rendering: an image decoded in `img.onload` is only kept, and the
  next frame that needs it uploads it (`TextureCache.acquireImageTexture`
  in `src/view/cache/texture.ts`). `uploadRgbaTexture` sets
  `UNPACK_FLIP_Y_WEBGL` and `UNPACK_PREMULTIPLY_ALPHA_WEBGL` to false
  explicitly (the shaders expect straight alpha, first row at the top) and
  restores the previous values and the texture binding afterwards, so it
  borrows the state rather than relying on `setDirty`. A decode that
  finishes after the layer is removed is dropped. Images are scaled down to
  `MAX_TEXTURE_SIZE` and get mipmaps.
- Symptoms when it breaks — an upload outside `render` would desynchronize
  maplibre's cache, and a later upstream upload could skip a pixel store
  call: a raster or icon premultiplied twice (dark halos) or flipped.
  Inheriting the values instead of setting them would give images dark
  translucent edges or turn them upside down depending on what maplibre
  uploaded last.
- Check when upgrading — `src/view/cache/texture.test.ts`. By hand, place
  a PNG with translucent edges over a raster basemap and check that the
  edges are not darkened.
- Conditions for removal — none while the library shares the context with
  maplibre.

## 26. DEM Textures Are Rewritten in Place

- Upstream behavior — `Terrain.getTerrainData` (`render/terrain.ts:378`)
  uploads a tile's DEM into `sourceTile.demTexture` when
  `needsTerrainPrepare` is set, reusing the tile's texture object
  (`demTexture.update`, line 395). The flag is set when a DEM tile loads
  (`source/raster_dem_tile_source.ts:102`) and when its border is filled
  from a neighbor that arrived later (`fillBorder` in
  `tile/tile_manager_raster_dem.ts:26`). The texture object stays the same
  while its texels change. `map.areTilesLoaded()` (`ui/map.ts:3065`) is
  true only once every tile of every source, the DEM source included, has
  loaded.
- What we rely on — assumption. `DemAtlas.build` in
  `src/view/terrain/dem-atlas.ts` skips a bake when everything it reads is
  unchanged (layout, tiles with their DEM texture objects, matrices, unpack
  vectors, dimension, exaggeration). An in-place rewrite does not show in
  that key, so the key is trusted only after `areTilesLoaded()` (read in
  `src/view/layer/terrain-resolver.ts`): while tiles load, the atlas is
  baked every frame, and once more on the first frame after all have
  arrived.
- Symptoms when it breaks — if a DEM texture could change without a tile
  load (a new upstream path setting `needsTerrainPrepare`), the atlas would
  keep old elevations and fills and lines would sink into or float above
  the terrain, most visibly at tile borders, until the camera changes the
  layout. If `areTilesLoaded()` never became true, the atlas would be baked
  every frame (slower, not wrong).
- Check when upgrading — `src/view/terrain/dem-atlas.test.ts`. By hand,
  compare `getTerrainData` and the places that set `needsTerrainPrepare`
  with the new source, and load a terrain view from a cold cache to check
  that no seam is left along tile borders once loading ends.
- Conditions for removal — an upstream version number or event for DEM
  uploads would let the key include it and drop the `areTilesLoaded()`
  rule.

## 27. `prerender` Runs Before the Main Pass

- Upstream behavior — `Painter.render` (`render/painter.ts:557`) runs an
  offscreen pass before binding and clearing the main framebuffer; a custom
  layer's `prerender` is called there (`webgl/draw/draw_custom.ts:50-59`),
  only while the layer is on the map (after `onAdd`) and visible, followed
  by `context.setDirty()`. `render` is called later in the translucent
  pass.
- What we rely on — assumption. The first slot layer
  (`src/view/layer/custom-layer.ts`) resolves the frame's terrain state in
  `prerender` (`TerrainResolver` in `src/view/layer/terrain-resolver.ts`),
  which bakes the DEM atlas into its own framebuffer when it changed (item
  26); `render` then uses that state. Switching framebuffers in the middle
  of the main pass would make a tiled GPU store and reload the whole frame.
  When `prerender` did not run for a frame, `render` resolves the state
  itself, so a version without the offscreen pass still draws correctly.
  The atlas restores the framebuffer, viewport and capabilities it changed.
- Symptoms when it breaks — if `prerender` ran for a frame that is then not
  rendered, the state would be one frame old; if it ran before `onAdd`,
  nothing would happen (the GPU side is checked first). If `prerender` were
  no longer called, the only sign would be slower terrain frames on mobile
  GPUs.
- Check when upgrading — compare the offscreen pass of `Painter.render`
  and `draw_custom.ts` with the new source.
  `src/view/layer/context-loss.test.ts` covers rendering without
  `prerender`.
- Conditions for removal — none while the atlas is baked on the GPU.

## 28. The Subdivision of the Globe and Its Bounds

- Upstream behavior — on the globe maplibre cuts fills, their outlines and
  lines on the Mercator plane before projecting them, with the granularity
  of `vertical_perspective_projection.ts:14-26`: fills 128 cells per tile
  side at zoom 0, halved per zoom level down to 2, lines 512 down to 1
  (`SubdivisionGranularityExpression.getGranularityForZoomLevel` in
  `render/subdivision_granularity_settings.ts`). `projectionTransition` of
  the projection data is the globeness of `GlobeTransform`
  (`geo/projection/globe_transform.ts:296`), above 0 while the globe is
  drawn and 0 once a globe map has zoomed in past its switch to Mercator.
  `getBounds()` on the globe (`vertical_perspective_transform.ts:606`)
  unprojects eight points of the screen edge, snapped to the horizon, and
  takes their extremes, so it falls short of the edge of the sphere, by
  several degrees of latitude on a rotated map.
- What we rely on — imitation and avoidance. `globeSubdivisionGrid` in
  `src/shared/math/globe-subdivision.ts` copies the granularity, and
  `updateGlobeSubdivision` in `src/view/globe-subdivision.ts` (called from
  `src/view/layer/custom-layer.ts` each frame) cuts only while
  `projectionTransition` is above 0, so an edge follows the path of
  maplibre's layers instead of a chord through the sphere. Hit testing
  (`src/dispatcher/hit-test/globe-shape.ts`) cuts on a map whose
  `map.getProjection()` is not Mercator. `getViewportCopies` in
  `src/view/viewport.ts` keeps the latitude margin of the expanded view
  when the longitudes span 360 degrees, and `computeThinningViewport` in
  `src/view/ui/selection-ui-drawer.ts` does not narrow by the bounds on the
  globe, so nothing between the bounds and the edge of the sphere is
  culled.
- Symptoms when it breaks — with another granularity our edges follow
  maplibre's paths at a different fineness, visible only as a slight gap
  against maplibre's lines at the zoom where the cells change. If the
  transition stopped reaching 0, the geometry would stay cut after the
  switch to Mercator (correct, but heavier). If the bounds became tighter
  still, the latitude margin might no longer cover the points near the
  edge of the sphere, and they would vanish while the lines reaching there
  stay.
- Check when upgrading — `src/e2e/globe.e2e.test.ts` holds a line, a
  fill and an image along parallels, the dashes and a click on a long
  slanted edge to `map.project`, and a point near the edge of a rotated
  globe to maplibre's own circle layer. `src/shared/math/globe-subdivision.test.ts`
  holds the granularity. Compare the granularity settings and the globe
  `getBounds` with the new source.
- Conditions for removal — none while the engine projects its vertices
  itself; the bounds item goes away if maplibre's globe bounds come to
  cover the whole visible cap.

## 29. `idle` Does Not Wait for a Frame a Custom Layer Asked For

- Upstream behavior — at the end of `Map._render` (`ui/map.ts`, around
  line 4480) maplibre asks for another frame only for its own dirty state
  (sources, style, placement, render to texture) or `repaint`; otherwise
  it fires `idle` when the map is not moving and loaded. `triggerRepaint`
  called by a custom layer during `render` schedules the next frame
  (`_frameRequest` was cleared before `_render`), and `idle` still fires
  after the frame that asked for it.
- What we rely on — avoidance. Work spread over frames (the chunks of a
  dataset, the triangulation of huge polygons, the index of the terrain
  drape, the hand-over of the drape) asks for the next frame with
  `triggerRepaint`, which maplibre does not count as unfinished.
  `Draw.hasPendingWork()` (`src/api/impl/drawing.ts`, asking the
  custom layer in `src/view/layer/custom-layer.ts`) reports that work, and
  a host that reads the picture back waits for `idle` and then for a
  `render` after which it is false
  ([Performance](../guides/performance.md#complete-frames-for-a-picture)).
- Symptoms when it breaks — none here: if `idle` came to wait for the
  frames a custom layer asks for, waiting for `idle` would be enough and
  `hasPendingWork()` would simply be false when it fires.
- Check when upgrading — read the end of `Map._render` in the new source.
- Conditions for removal — `idle` waiting for the frames requested during
  `render`; `hasPendingWork()` stays useful for the work that no frame
  finishes (the answer of a provider).

## When Upgrading the Version

When moving to a new maplibre version, do the following.

- Compare the "Upstream behavior" of every item above with the new source
- Run `npm test` (vitest). The terrain coupling points are guarded by the
  tests under `src/view/terrain/`: `anchor`, `context`, `occlusion`,
  `polygon`, `tessellation`, `tiling`, and `drape/mesh`, `drape/stitch`,
  `drape/quad`, `drape/pass`, `drape/binning`, `drape/bin-store`
- `src/view/shaders/compile.test.ts` compiles every shader with the
  preludes of the new version in headless Chromium from playwright-core
  (install it once with `npx playwright-core install
  chromium-headless-shell`)
- Run `npm run test:e2e` for the real input route (item 17), for the
  ground on a known DEM (items 2, 8 and 9) and for the globe (item 28)
- Run `npm run typecheck` and `npm run lint`
- The unit tests use fake terrain objects, so always confirm the real
  upstream shape (item 7) and the GL state (item 1) by hand
- Update the peer range in `package.json` and the notes in
  [releasing](./releasing.md)
