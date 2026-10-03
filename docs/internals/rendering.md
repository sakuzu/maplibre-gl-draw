# Rendering

This document describes how the library draws: the WebGL2 pipeline behind
the maplibre custom layer, the renderers, the retained batches of the Store
and of datasets, terrain, and the display order that ties
them together. It is written for contributors who know maplibre-gl but not
the internals of this library.

Related: [Architecture](./architecture.md) for the layers and the Store,
[Hit testing](./hit-testing.md) for the order a click walks,
[Coordinate precision](./coordinate-precision.md) for offset mode and the
antimeridian, [maplibre coupling](./maplibre-coupling.md) for the maplibre
internals relied on, and the [Performance](../guides/performance.md) and
[Large data](../guides/large-data.md) guides for the user-facing side.

## Overview

Everything is drawn with WebGL2 through the `CustomLayerInterface` of
maplibre-gl. The library adds one or more custom layers to the map (see
[Slots and separators](#slots-and-separators)) and draws all features,
the selection UI and the drawing preview inside them.

- One renderer per kind of geometry: points, lines, polygons, images and
  selection handles. Circle, Freehand and Multi geometries reuse them
- Store features are drawn in retained mode by default: GPU resources are
  built per layer in advance, and a frame only binds, sets uniforms and
  draws. Datasets have their own retained mode
- The stacking order is the order of the draw calls. No depth buffer
  orders our own drawings against each other
- The RenderCoordinator asks maplibre for a repaint when the Store changes,
  so modes never request one themselves

The code lives in these directories of `src/`:

- `view/` - the rendering of the Store: the coordinator, the viewport
  filter, the style rule evaluation (`view/style-rule.ts`, pure functions)
- `view/layer/` - the custom layer, the slots, the frame state, the render
  loop and the retained cache of the Store
- `view/renderers/` - the renderers of features
- `view/ui/` - the selection UI (bounding box, handles, box selection)
- `view/shaders/` - shader sources and helpers
- `view/cache/` - triangulation, style rule and texture caches
- `view/terrain/` - terrain support
- `dataset/` - datasets. They borrow the renderers of
  `view/` but share no state with the Store path

## The flow of a frame

```text
Store change
  │ RenderCoordinator: map.triggerRepaint()
  ▼
maplibre frame
  │ prerender (first slot)   terrain state, DEM atlas bake
  ▼
render of slot 0 ─────────── beginFrame + buildFrameState (once)
  │                          projection, shaders, drape plan,
  │                          display list, selection, world copies
  │ renderSegment(0)         GL state, drape of the segment,
  │                          renderLayers once per world copy
  ▼
render of slot 1..n-1        renderSegment(i) with the shared frame
  │                          (maplibre native layers can sit between)
  ▼
last slot                    renderForeground: selection UI,
                             tentative geometry, overlays
```

## RenderCoordinator

`RenderCoordinatorImpl` (`view/coordinator.ts`) subscribes to the Store and
calls `map.triggerRepaint()` when a change can alter the picture. Modes and
the API never request a repaint for a Store change themselves.

```typescript
interface RenderCoordinator {
  start(): void; // subscribe to the Store (idempotent)
  stop(): void; // unsubscribe
  requestRender(): void; // manual repaint for special cases
}
```

`shouldRepaint(changes)` is true when the `StoreChange` carry any of
`features`, `layers` (including the order between layers), `groups`,
`layerReorder`, `groupReorder`, `selection`, `tentative` (the in-progress
geometry of a drawing mode) or `uiStateChanged` (drag state, box
selection).

The coordinator only schedules a frame. What the frame redraws, and what
it rebuilds, is decided by the custom layer from its own Store
subscription (see [Invalidation](#invalidation)).

## Why a custom layer

Libraries such as mapbox-gl-draw put the drawing into a GeoJSON source and
style it with the map's style layers. This library draws everything
itself. That gives rendering the style layers cannot express (rotated
images, handles drawn in the same pass, fills and lines on terrain), a
draw order under its own control, hit testing that matches what is drawn,
and no GeoJSON re-upload on every edit.

The cost is that the features are not in the map's style
(`queryRenderedFeatures`, `feature-state` and style expressions do not see
them), that a single feature cannot be placed between style layers, and
that the library relies on maplibre-gl internals, so each maplibre-gl
version is checked before the peer range is widened
([maplibre coupling](maplibre-coupling.md)).

## The custom layer

`createCustomLayer()` (`view/layer/custom-layer.ts`) implements the maplibre
interface and ties the parts together. Each part holds its own state and
receives what it reads as arguments.

- `SlotManager` (`slot-manager.ts`) keeps the slots in step with the
  stacking order and counts how many are on the map
- `TerrainResolver` (`terrain-resolver.ts`) resolves the terrain state of a
  frame: the DEM atlas, the subdivision step and region
- `DrapePlanner` (`drape-planner.ts`) decides whether the analytic drape is
  used in the frame and why, holds its tile plan and the hand-over to the
  datasets
- `buildFrameState` (`frame-state.ts`) builds the state of a frame, once,
  in the first slot
- `renderSegment` / `renderForeground` (`frame-render.ts`) draw one segment
  and the foreground pass
- `gl-state.ts` holds every switch of the GL state the layer makes outside
  the renderers
- `createRenderScope` (`render-scope.ts`) holds the caches and the terrain
  context owned by this draw instance

### The engine behind the slots

All slots of one draw instance share one engine: the WebGL context, the
renderers, the retained cache of the Store and the frame being drawn. The
first slot that goes onto the map builds it, and the last one that leaves
tears it down. The outline below keeps the names of the implementation and
leaves out the terrain and the drape.

```typescript
function engineAdd(mapInstance, glContext) {
  if (!slots.attach()) return; // only the first slot builds it
  engine.gl = glContext;
  installAnchorProjector(mapInstance, renderScope.terrain);
  engine.unsubscribeStore = store.subscribe((changes) => {
    engine.storeRetainedCache?.applyChanges(changes); // and caches
  });
  watchContextLoss(mapInstance);
  buildGpuResources(); // skipped while the context is lost
  slots.sync();
}

function renderSlot(index: number, input: CustomRenderMethodInput) {
  if (!engine.gl || !engine.renderers) return;
  if (engine.gl.isContextLost()) return;
  // the first slot of a maplibre frame prepares the shared state
  if (engine.frame === null || index <= engine.frame.lastIndex) {
    engine.frame = beginFrame(input);
  }
  const frame = engine.frame;
  if (!frame) return;
  renderSegment(renderDeps, frame, index);
  frame.lastIndex = index;
  if (index === frame.segments.length - 1) {
    renderForeground(renderDeps, frame);
    engine.frame = null;
  }
}
```

The layer itself has the id `maplibre-gl-draw-layer`, `renderingMode: '3d'`,
`onAdd: engineAdd`, `render` calling `renderSlot(0, ...)`, and a
`prerender` that resolves the terrain state of the frame before maplibre's
main pass. `onRemove` tears the engine down only when the last slot leaves:
it unsubscribes, releases the GPU resources and the terrain context, and
uninstalls the anchor projector.

`beginFrame` reads the style zoom and the terrain state, then
`buildFrameState` sets up the shaders and the projection (through the
ShaderInitializer), the anchor projection, the plan of the drape, the
choice between retained and immediate mode, the features for immediate
mode (from the display list), the selected features
(`getSelectedFeatureIds`) and the copies of the world (`planCopies`).
Every later slot of the same maplibre frame reuses it.

The style zoom (`StyleZoom` in `frame-state.ts`) is the zoom the sizes are
derived from. It follows the increments of the zoom while the camera
moves. When the zoom number changes with nothing moving, the position of
the camera decides: if its altitude stayed the same, it was the elevation
settlement of maplibre (the zoom and the center solved again onto the
terrain, the picture unchanged), and the change is absorbed so that nothing
resizes. If the camera moved, as after `jumpTo` or `setZoom`, the style
zoom takes the zoom as it is.

The test rests on an invariant rather than on a measured threshold. A
settlement keeps the camera where it is in space and only describes it
again; any change of the zoom at the same pitch moves the camera along its
line of sight and multiplies its altitude by `2^-Δzoom`. The altitude is
compared with a tolerance relative to it (1e-7, with a floor of 1 cm),
which takes any change of the zoom above about 1.5e-7 for a move at every
altitude while the noise of describing the same camera again stays far
below it. The position on the ground is compared as well, with a bound
(about 40 m) well above the drift of a settlement and far below a jump
made on purpose, so a jump sideways at the same altitude is not taken for
a settlement.

The gap between the style zoom and the raw zoom comes from settlements
only, and the kind of move decides what happens to it:

- a move that changes the zoom within one frame (`jumpTo`, `setZoom`):
  the next frame sees the camera moved and takes the raw zoom, dropping
  the gap
- an animated move (`easeTo`, `flyTo`, a gesture, inertia): the frames of
  the move follow the increments of the raw zoom and keep the gap, so no
  size jumps when the move starts; the gap stays after the move ends
- a settlement: absorbed, the gap changes by its step (about ±0.3 at
  most as the elevation under the camera changes)

Right after the style zoom, `beginFrame` starts the frame of the datasets
(`DatasetManager.beginFrame`): each visible dataset decides the zoom band
of its collision thinning from the style zoom, before the drape plan and
before any layer of the frame draws (see
[Collision thinning](#collision-thinning)).

`renderForeground` runs once per world copy in the last slot. It draws the
selection UI (only the selection frame when editing is blocked), the
vertices that follow a shared vertex, the tentative vertices and those of
the layer-aware renderers, the box selection (base copy only) and the
overlays that are not layer-aware.

### GL state of a slot

maplibre resets the GL state between layers, so every slot establishes the
state its frame assumes and hands the maplibre defaults back at the end.
Every switch of blending, depth test, depth function, depth mask and
polygon offset made by the layer itself is in `gl-state.ts`.

- `applySegmentGlState()` starts a slot. It applies the blend state of
  `applyDrawBlendState()` (see [Alpha blending](#alpha-blending)) and binds
  the DEM atlas to its dedicated texture unit when terrain is active
- `applySegmentDepthState()` sets the depth state of the layer rendering.
  Without terrain the depth test is off. With terrain (outside the
  zoomed-out fallback) the depth test is on with `LEQUAL` so that the
  terrain hides what is behind a mountain, but depth writes are off: our
  drawings never order each other by depth, and a slope-proportional
  polygon offset is applied. `applySegmentGlState()` calls it at the start
  of a slot, and the drape calls it again when it is done, so the layers
  are drawn in one depth state whether or not the drape was used
- `applyDrapeGlState()` switches to the state of the analytic drape
  (premultiplied alpha, `LEQUAL`, no offset)
- `enterSymbolGlState()` turns the depth test off for the foreground pass
  (the selection UI, the vertices being drawn and the overlays), which is
  always in front. The symbols drawn during the layer rendering (points and
  other billboards) turn it off themselves around their own drawing
  (`drawBillboardsWithoutDepth`, `renderers/point/billboard-depth.ts`)
- `restoreSegmentGlState()` gives back the maplibre defaults (depth mask on,
  `LESS`, depth test on, no polygon offset)

### GPU resources and WebGL context loss

Every object that lives in the WebGL context (buffers, textures, programs,
vertex arrays, framebuffers: the renderers, the retained batches of the
Store and of the datasets, the DEM atlas and the drape) is
created by one function, `buildGpuResources`, and dropped by one function,
`releaseGpuResources`. Nothing else holds a GL object across frames. The
CPU-side state (the Store subscription, the triangulation and style rule
caches, the collected drape elements) is outside the pair.

- `onAdd` builds the pair and `onRemove` releases it. Feature type
  renderers and overlay renderers (`draw.extensions.overlays`) stay registered
  across a removal and receive `onAdd` again when the layer comes back; an
  overlay added before the layer is on the map receives its `onAdd` when
  the engine is built
- A lost context invalidates every GL object at once. The layer listens to
  `webglcontextlost` / `webglcontextrestored` on the canvas (events of the
  GL context, not input, so they bypass the InputNormalizer). The loss runs
  `releaseGpuResources` (WebGL ignores deletes on a lost context), and the
  restore runs `buildGpuResources` and requests a repaint. Nothing is built
  or drawn while `gl.isContextLost()` is true
- maplibre removes every custom layer when the context is lost and does not
  add it back. The slots return through `attachSlotLayers()` on the
  `styledata` of the restored style, and `onAdd` builds everything again

A renderer, including an extension's, must therefore create its GL objects
in `onAdd` (or lazily while drawing), release them in `onRemove`, and accept
`onAdd` again. `disposeRenderers` (`view/layer/renderers.ts`) lists every
member of `Renderers` with a `dispose()`, and a missing member is a compile
error.

### Copies of the world across the antimeridian

`buildFrameState` plans the copies of the world in view (`planCopies`,
`frame-state.ts`). Away from the antimeridian, on the globe, and when the
view is 360 degrees wide or more, there is one copy: the base copy. A view
across the antimeridian gives two, and each carries what drawing on it
needs:

- `view`: the part of the view seen from the copy, in stored longitudes,
  and the ids inside it. `renderLayers` thins retained chunks, immediate
  chunks and datasets with it
- `projectionData` and `offsetUniforms`: a virtual camera, with the center
  moved by `-lngShift` and the matrix by `+lngShift`
  (`translateMatrixByLongitude`). `ShaderInitializer.applyOffsetUniforms`
  hands them to every renderer
- `customRendererContext`: the same center and matrix, for custom feature
  renderers and extension overlays
- `features` and `selectedFeatures`: what is drawn in immediate mode and
  what is selected on that copy
- `terrainState`: the DEM atlas placed in the frame of that camera

Each slot draws its drape once (the drape is drawn per terrain tile with
the matrix maplibre gives each tile, and tiles carry their own wrap), then
calls `renderLayers` once per copy. The foreground is drawn once per copy
too, except the box selection, which is drawn on the base copy only. After
the copies the base copy is applied again. The precision side of this is in
[Coordinate precision](./coordinate-precision.md).

## renderLayers

`renderLayers()` (`view/layer/render.ts`) is the loop over the stacking
order. Store features take one of two paths, and both give the same
picture, z-order included.

- Retained mode: when a `StoreRetainedCache` is passed and the renderers
  provide the retained API, each layer draws its prebuilt chunks
- Immediate mode: the features of the layer are walked every frame and
  pushed through the BatchManager

```typescript
if (drawBelow) datasets?.draw('below-store', /* ... */);
for (const entryId of layerOrder) { // the entries of this segment
  const layer = store.getLayer(entryId);
  if (!layer) { // a dataset in the sequence, or unknown
    datasets?.drawOne(entryId, /* ... */);
    continue;
  }
  if (useRetained) {
    storeRetained.drawLayer(entryId, layer, /* ... */);
  } else {
    r.batchManager.beginFrame(projectionData, zoom, layer);
    for (const feature of layerFeatures) {
      drawFeatureCompanionsInFrame(companions, feature, /* ... */);
      const custom = customRenderers.get(feature.type);
      if (custom) { // flush, draw, restore blending, reopen
        r.batchManager.endFrame();
        custom.draw(/* ... */);
        restoreBlendState?.();
        r.batchManager.beginFrame(projectionData, zoom, layer);
      } else {
        r.batchManager.processFeature(feature, isSelected);
      }
    }
    r.batchManager.endFrame();
  }
  // local tentative geometry, then layer-aware overlays (drawForLayer)
}
if (drawAbove) datasets?.draw('above-store', /* ... */);
```

The entries mix layer ids and dataset ids, and the
stacking order alone decides the order:

- An entry that is a layer is drawn in retained or immediate mode
- An entry that is a dataset with `order: 'layer-order'` is drawn with
  `drawOne`
- Any other entry is skipped, which is not an error. This is also how
  separators and stale ids are ignored

The bounding box of the expanded viewport (`viewportBounds`) does not
depend on the number of features, so it is computed once per frame and
passed to `drawLayer` and to the datasets, whether or not retained mode
is in use. The set of visible ids for immediate chunks (`getVisibleIds`) is
queried at most once per frame, and only when a first immediate chunk needs
it. If the renderers lack the retained API (a test stub, for example),
`getRetainedRenderers()` returns `undefined` and the loop falls back to
immediate mode.

## ViewportFilter

`ViewportFilter` (`view/viewport.ts`) decides what is near enough to the
view to be drawn.

```typescript
class ViewportFilter {
  constructor(deps: ViewportFilterDeps,
    expansionFactor = DEFAULT_VIEWPORT_EXPANSION_FACTOR);
  getVisibleIds(): Set<string>; // ids in the expanded view
  getCopies(): ViewportCopy[]; // world copies the view covers
  getVisibleIdsIn(bounds: BoundingBox): Set<string>;
  getBounds(): BoundingBox; // bbox of the expanded view
  filter(features: Feature[]): Feature[]; // keeps draw order
}
```

- The view is expanded by `DEFAULT_VIEWPORT_EXPANSION_FACTOR` (2.0), so
  panning and zooming do not show features popping in at the edges
- Queries go through the R-tree of the Store's spatial index
- Across the antimeridian maplibre reports the view with unwrapped
  longitudes (an east edge above 180), and the view covers two copies of
  the world. `getCopies()` (`splitLongitudeCopies`) returns each copy with
  its shift (0 or ±360) and its range in stored longitudes. The rendering
  draws each copy with its own range (`getVisibleIdsIn(bounds)`).
  `getVisibleIds()` queries every range, and `getBounds()` returns one bbox
  that then covers every stored longitude
- When the expanded view is 360 degrees wide or more, the longitudes of the
  view itself are used, but the latitudes keep the expansion. On the globe
  the whole sphere is often in view, and the bounds maplibre reports fall
  short of the edge of the sphere by up to several degrees of latitude
  (more when the map is rotated). Without the margin the points between the
  bounds and the edge were culled, while a line reaching there was kept by
  the rest of its box. For the same reason the narrowing of the vertex
  handles of a selection by the view (`computeThinningViewport`) is skipped
  on the globe

Neither path calls `filter()` in a frame.

- The immediate path keeps the ordered list of features to display
  (`DisplayListCache`, `view/layer/display-list.ts`), rebuilt only after a
  Store change that can alter it (features, layers, groups, their order,
  local visibility). It takes the ids in view from `getVisibleIds()` and
  puts them in draw order by their rank in that list, so a frame costs in
  proportion to what is on screen. When more than a quarter of the list is
  visible, one pass over the list is cheaper than sorting and is used
  instead
- The retained path never walks the feature list. Chunks are thinned by
  their bbox against `getBounds()`, and `getVisibleIds()` is used only for
  immediate chunks, memoized per frame

## ShaderInitializer

`ShaderInitializer` (`view/shaders/initializer.ts`) sets up shaders and
projection data for all renderers in one place.

```typescript
class ShaderInitializer {
  ensureShaders(shaderData: ShaderData): void;
  setProjectionData(projectionData: ProjectionData): void;
  setOffsetUniforms(centerLngLat, mainMatrix): void;
  applyOffsetUniforms(uniforms: OffsetUniforms): void;
  incrementSdfLineFrame(): void;
}
```

`ensureShaders` compiles each renderer's programs against the shader
prelude maplibre gives the custom layer for the current projection.
`applyOffsetUniforms` takes offset-mode uniforms that were computed once
per frame and per world copy, instead of recomputing them per renderer.

Every program is compiled by `createProgram` (`view/shaders/helpers.ts`),
which gives both stages `precision highp sampler2D;`. The unit tests use a
stub GL, so `view/shaders/compile.test.ts` compiles and links every program
on a real WebGL2 in headless Chromium, with the preludes maplibre produces
for Mercator and the globe. It also counts the `createProgram` call sites,
so a new program must be added to it.

## BatchManager

`BatchManager` (`view/renderers/batch-manager.ts`) is the immediate-mode
batcher. It accumulates features of the same kind and style and draws them
in as few draw calls as the draw order allows.

```typescript
batchManager.beginFrame(projectionData, zoom, layer); // styleRule
for (const feature of features) {
  batchManager.processFeature(feature, isSelected);
}
batchManager.endFrame(); // flushes what remains
```

`getRetainedRenderers()` exposes the retained API of the same renderers
(undefined on a stub), and `getTerrain()` the terrain context.

- When a feature of a different kind arrives, the current batch is flushed
  first, so the draw order is kept
- Features whose styles differ only in instance attributes stay in one
  batch
- Images and custom types are always drawn individually
- Selected features are batched too. Their highlight is the selection UI,
  drawn in the foreground

### Parts of Multi geometries

Multi geometries have no batch of their own. `processFeature()` decomposes
them and pushes each part through the path of the single geometry.

- MultiPoint: each coordinate goes the way of a Point
- MultiLineString: each polyline goes the way of a LineString or Freehand
- MultiPolygon: each ring array goes the way of a Polygon

The per-part work is shared with the single geometries in
`processPointCoord`, `processLineCoords` and `processPolygonRings`. Parts
with too few coordinates (a line with fewer than 2 points, an outer ring
with fewer than 3) are skipped. The part number goes into the earcut cache
key. The individual drawing path (FeatureDrawer) iterates parts as well and
keys each part as `<featureId>:part:<i>`, with `:stroke:<ring>` appended
for polygon outlines, so cache keys never collide.

### Polygons with holes

Polygon coordinates are an array of rings: `rings[0]` is the outer ring,
the rest are holes. `buildEarcutInput()`
(`view/renderers/polygon/earcut-input.ts`) turns the rings into a flat
coordinate list and `holeIndices`.

- The closing point of each ring is dropped before flattening
- `holeIndices` holds the start of each inner ring in coordinates, not in
  floats
- An outer ring with fewer than 3 vertices gives an empty result and the
  caller skips the polygon. An inner ring with fewer than 3 vertices is
  skipped rather than treated as a hole
- The returned rings are normalized (rings with an area, without the
  closing point) and are used as they are for the outlines

The fill gets its holes from `earcut(flatCoords, holeIndices)`. The outline
draws each ring as a closed path, so holes get an edge line too. This is
shared by the fill-only PolygonBatchRenderer, the fill-and-outline
SDFPolygonRenderer and the FillShaderManager used for the drawing preview.

### Batching points

Points are drawn with instancing. Color, size and stroke width are instance
attributes, so differences in style do not split the batch.

- The key is the shape only (`circle` / `square` / `triangle` / `star`,
  decided by `toInstancedPointShape`)
- The style is folded into `PointInstanceDataFull` (coordinates, fill
  color, radius, stroke color, stroke width), with opacity multiplied into
  the alpha of the colors
- A point whose stroke opacity is 0 is treated as having stroke width 0
- `icon` does not support instancing and is drawn individually (as a
  circle) by `PointShapeRenderer`

### Batching lines

`SDFLineRenderer.drawAll()` draws many lines in one draw call. Color,
opacity, width and `createdZoom` are instance attributes.

- The key is `lineStyle:dashArray`. For solid lines the dash array is
  dropped so that all solid lines share one key
- Only the line shape splits a batch, because it is a per-batch uniform
- The coordinates of all lines of a batch go to the GPU in one coordinate
  texture
- Dashed and dotted lines are cut into solid fragments on the CPU and
  accumulated with the shape `solid` (next section)

### Dashes

Dashes take one of two paths, both measured in screen pixels on the 512-pixel
Web Mercator world. In Web Mercator one degree of longitude is
`tileSize * 2^zoom / 360` pixels at every latitude, and one degree of
latitude is stretched by `1 / cos(lat)`, with `tileSize` 512, so a dash keeps
its length on screen at any zoom and latitude.

#### Features: split on the CPU

`splitIntoDashes()` (`view/renderers/line/dash.ts`) cuts a dashed or dotted
path into dashes and gaps and accumulates each dash as an independent solid
line, which the BatchManager draws with the shape `solid`. The step comes
from `getStrokeDashPattern()` and the effective line width (a dash is 4
times the width and a gap 2 times; dotted is nearly round), so its unit is
screen pixels.

The latitude correction uses the latitude at the middle of each segment;
within a segment the mapping is affine, so the cut positions are exact.

Because the conversion depends on the zoom, dashed and dotted lines cannot
be retained and always take the immediate path (see
[Runs and chunks](#runs-and-chunks)).

#### On the terrain: laid out by the drape

With the terrain on, the analytic drape paints dashed and dotted lines, and
dashed outlines, on the ground like solid ones (see
[Analytic drape](#analytic-drape)); the CPU split above is left to frames
the drape does not paint. A ribbon widened on the screen around a line
that lies on the ground has the depth of the middle of the line, so on a
pitched view its side towards the camera sank into the nearer ground.

The pattern comes from the same table as the CPU split
(`DASH_COEFFICIENTS` in `dash.ts`: a dash is `max(a, b * w)` and a gap
`max(w + 1, c * w)` for a width `w`), and it is measured the same way, in
pixels of the 512-pixel world at the zoom of the frame. The binning keeps,
next to each edge of a dashed element, where it starts along its path
(`drapePathStarts`, worked out only for dashed elements); the shader turns
the width of the frame into the dash and the gap, finds the dash closest
to the pixel on the edge, and measures the distance to that piece of the
edge. A dash cut by a vertex is drawn by both edges and meets in a round
joint, as a solid line does.

#### Helper lines: the dash branch of the shader

The lines drawn by calling `SDFLineRenderer.draw()` directly (the
unconfirmed line while drawing, the snapping guides and the radius line of
a circle) use the dash branch of the SDF line shader (`u_dashEnabled`,
`v_linesofar`) with the `dashArray` of their style, given in CSS pixels.

- `writeLineInstances` writes the cumulative distance at the start of each
  segment (`a_extra.x`) with `screenPixelDistance()` at the draw zoom,
  multiplied by the screen pixel ratio (`resolvePixelRatio`), so it is in
  drawing-buffer pixels
- Inside a segment the vertex shader adds the length it measures on screen,
  which is in drawing-buffer pixels too
- `resolveDashUniform()` scales the dash and the gap by the same ratio into
  `u_dashArray`

The distance at a vertex is exact for an untilted view. In a tilted or
globe view the far side shrinks on screen, so the phase of the pattern can
jump at a vertex; the dash length itself stays right because each segment
is measured on screen.

`StrokeRenderer` (the rubber band of box selection) has the same kind of
branch. Its cumulative distance (`strokeDashDistances()`) and its dash
pattern are both in CSS pixels, measured the same way.

### Batching polygons

There are two polygon batchers, chosen by whether there is an outline:

- Without an outline: PolygonBatchRenderer (fill only)
- With an outline: SDFPolygonRenderer (fill and outline in one draw)

Both draw with `drawElements` (`UNSIGNED_INT`). Only as many vertices as
the rings have are accumulated, earcut indices are shifted by the vertex
base of each polygon, and the indices follow the input order, so z-order
holds inside a single draw call.

### Flush timing

A batch is flushed:

- When the feature kind changes (only the line batch is flushed;
  `endSDFLineDraw` is not called)
- When the style changes in a way that is not an instance attribute
- Before an image or a custom type, which are drawn individually
- At the end of the frame, the only place `endSDFLineDraw()` is called, to
  avoid needless shader state changes

These boundaries are the same positions at which retained mode cuts its
runs, which is what makes the two modes give the same picture.

### Custom features and draw order

Draw order is the painter's algorithm: what is drawn later is on top. Our
drawings never write depth, so the final stacking is exactly the order of
the draw calls, and the order within a layer must match
`store.listFeaturesInOrder()` (see [Display order](#display-order)).

Core features are accumulated and drawn together at `endFrame()`, whereas
features of the types added with `draw.extensions.featureTypes` are drawn at once
by their own renderer. So `renderLayers` flushes the core batches with
`batchManager.endFrame()` just before a custom feature, and reopens them
with `beginFrame()` after it. Without that flush, every custom feature of a
layer would be painted first and the core batches over them afterwards,
putting core features on top regardless of the order.

### Companion drawing

A feature companion (`view/feature-companion.ts`, added through
`draw.extensions.companionProviders`) lets an extension draw something that
belongs to a feature, at the same z position, and that can be grabbed at
the same z order. The core does not know what a companion means; drawing is
up to the provider.

- The companion is drawn just before the feature, one step lower in z. As
  for custom features, the core flushes the batch before the call and, when
  it returns, restores the blend state and reopens the batch. Without the
  flush the companion would be painted before features behind it in the
  same layer
- While `has(feature)` is false nothing is flushed or drawn, so maps and
  features without a provider keep full batching. `has` runs for every
  feature on every frame and must be O(1)
- The registry belongs to the draw instance (`featureCompanions` is a
  required argument of `createCustomLayer`), like every extension point
  registry. A provider encloses its own Store, and feature ids are the same
  across instances showing the same document, so a shared registry would
  draw a feature twice with the geometry of another instance

## Renderers

### SDFLineRenderer

`SDFLineRenderer` (`view/renderers/line/sdf-line.ts`) draws lines with the
HHAA (half-plane anti-aliasing) method.

- The CPU passes geographic coordinates only. Mercator conversion,
  projection, normals and miter or bevel joins are done on the GPU
- A coordinate texture plus instancing draws many lines in one draw call
- Offsets are computed in screen space, so the width is uniform along the
  line
- Color, opacity and width are instance attributes, so lines differing in
  them share a draw call as long as the shape is the same
- An instance is 12 floats (48 bytes): `a_indices` (vec4), `a_extra`
  (vec4) and `a_color` (vec4, premultiplied, with the opacity folded in)

```typescript
class SDFLineRenderer {
  draw(coords, style, options, zoom, projectionData?): void;
  drawAll(items, shape, zoom, projectionData): void; // one call
  buildRetainedBatch(items, shape, options?): RetainedLineBatch | null;
  drawRetainedBatch(batch, zoom, projectionData, factors?): void;
  patchRetainedBatchCoords(batch, updates): void; // vertex drag
  disposeRetainedBatch(batch): void;
}
```

In immediate mode the renderer keeps its coordinate texture and instance
buffer alive instead of creating them per frame:

- The coordinate texture is immutable (`texStorage2D`), with a power-of-two
  side at least as large as the required `texSize`. Only the data is
  uploaded (`texSubImage2D`) and `u_tex_size` receives the data's
  `texSize`; `texelFetch` reads only that top-left square, so a larger
  allocation reads correctly
- It is reallocated only when a larger `texSize` arrives (grow-only)
- One instance buffer is reused and orphaned with `bufferData`
  (`STREAM_DRAW`) on every draw. `vertexAttribPointer` records the
  `ARRAY_BUFFER` bound when it is called, so attributes must be set up with
  this buffer bound

Retained batches share none of this. Their coordinate texture has exactly
the size the batch needs, and the VAO and quad vertices belong to the
batch.

### SDFPolygonRenderer

`SDFPolygonRenderer` (`view/renderers/polygon/sdf-polygon.ts`) draws the
fill and the outline of polygons in one draw call: the fill by earcut
triangulation, the outline with the HHAA method, in input order.

```typescript
class SDFPolygonRenderer {
  drawBatch(polygons, projectionData, zoom, viewport): number;
  buildRetained(polygons, options?): RetainedPolygonBatch | null;
  drawRetained(batch, zoom, projectionData, viewport, factors?): void;
  disposeRetained(batch): void;
}
```

Immediate and retained mode build vertices the same way
(`buildGeometry()`), and fill and outline go out in one `drawElements`
(`UNSIGNED_INT`):

- Indices are laid out as fill of polygon 0, outline of polygon 0, fill of
  polygon 1, and so on, so z-order holds within the draw call
- The fill keeps only the ring's own vertices, and earcut indices are
  shifted by the vertex base (no duplication per triangle)
- The outline is a quad per edge: 4 vertices and 6 indices per segment
- Construction takes two passes. The first collects the triangulation and
  the rings and counts the array lengths; the second writes straight into
  `Float32Array` / `Uint32Array` with no intermediate `number[]`
- A vertex is 15 floats: position 2, color 4, type 1, previous 2, next 2,
  side 1, extra 3

A retained polygon batch holds a VAO, a vertex buffer, an index buffer and
the index count. The `ELEMENT_ARRAY_BUFFER` binding is VAO state, so the
indices are uploaded with the VAO bound.

#### EarcutCache

`EarcutCache` (`view/cache/earcut.ts`) caches triangulations keyed by
feature id and part number. A MultiPolygon has one entry per part, and
`delete(featureId)` drops all of them. The cache belongs to the draw
instance (the `earcut` of the render scope), and the custom layer's Store
subscription deletes the entry of an updated or deleted feature.

It matters for the immediate path and for huge polygons of
datasets. Retained mode triangulates once when a chunk is built and
keeps the result on the GPU, so it normally does not consult the cache.

Huge polygons of datasets (more than 10,000 vertices) are the exception:
their result is cached so that replacing the data does not redo a long
triangulation. Their ids can change between fetches, so these entries also
carry a fingerprint of the geometry (vertex count, inner ring positions, a
sample of coordinates) that must match.

### PointInstanceRenderer

`PointInstanceRenderer` (`view/renderers/point/point-instance.ts`) draws
points with instancing. Points differing in color or size share one draw
call as long as the shape is the same. It has the same trio of retained
methods as the polygon renderer (`buildRetained`, `drawRetained`,
`disposeRetained`) next to the immediate `drawAll`.

One instance is a finished symbol, fill and stroke together. If fill and
stroke were separate draws, the stroke of a point behind would land on the
fill of a point in front. In one draw, primitives stack in instance order,
which is feature order.

- Every shape uses one billboard of 4 vertices (`TRIANGLE_STRIP`), sized to
  the outer radius (radius plus stroke width) plus 1 pixel for
  anti-aliasing
- The fragment shader splits by distance from the center: inside is the
  fill color, the outer band is the stroke color, outside is discarded.
  Half a pixel on each side of a boundary is smoothed with `smoothstep`
- The shape is a distance function selected by `u_shape` (0 to 3 for
  `circle`, `square`, `triangle`, `star`; `POINT_SDF_GLSL` in
  `point-sdf.ts`, shared with the per-point renderer). The vertex buffer
  is the same
- With stroke width 0 the outer radius equals the radius, so points with
  and without stroke share an instance array
- The radius and stroke boundary follow the same formula as the pure
  function `pointSdfEdges()`, and the shader embeds the same margins

An instance is 12 floats: relative coordinates 2, fill color 4, stroke
color 4, radius 1, stroke width 1. The order is exactly the input order;
nothing is thinned or reordered. Uniform locations of the projection are
cached per program and dropped with it. A retained point batch holds one
billboard buffer, one instance buffer and one VAO, and draws in one call.

### FeatureDrawer

`FeatureDrawer` (`view/renderers/drawer.ts`) is the facade that draws one
feature with the right renderer, and the place where style rules are
evaluated.

```typescript
class FeatureDrawer {
  drawFeature(feature, projectionData, zoom, layer?): void;
  // used by the batchers; the layer's styleRule is evaluated here
  getPointStyle(feature, layer?): PointStyle;
  getLineStringStrokeStyle(feature, layer?): SDFStrokeStyle;
  getPolygonStyles(feature, layer?): { fillColor; strokeStyle };
}
```

A layer's `styleRule` is evaluated just before drawing, and the Store is
never rewritten with rule colors. The three getters call `resolveStyle()`:

1. `getStyleRuleChannel(feature.type)` picks the channel: `point` for Point
   and MultiPoint, `stroke` for LineString, MultiLineString and Freehand,
   `fill` for everything else (Polygon, MultiPolygon, Circle, Image and
   custom types)
2. The draw instance's `StyleRuleCache` (the `styleRules` of the render
   scope) resolves `(feature, layer?.styleRule)` to a rule color
3. `applyRuleColor(feature.style, ruleColor, channel)` puts it on the
   style. A feature with its own color for that channel keeps it, so the
   priority is per-feature color, then layer rule, then default

The evaluation itself is a pure function in `view/style-rule.ts`, usable
without rendering. The rule types are described in the
[Styles guide](../guides/styles.md).

#### StyleRuleCache

`StyleRuleCache` (`view/cache/style-rule.ts`) caches rule results by feature
id. A hit needs the same feature id and the same rule reference; the rule's
contents are not compared. It is invalidated in two ways:

- By the custom layer's Store subscription. Updating or deleting a feature
  drops its entry. A layer whose `styleRule` changes to another reference
  drops the whole cache, because there is no reverse lookup from a rule to
  its features
- By the reference check inside `resolve()`, so a replaced rule shows even
  on paths without a subscription (tests, datasets)

Datasets have one `StyleRuleCache` per dataset and do
not touch the draw instance's cache.

### SelectionHandlesRenderer

`SelectionHandlesRenderer` (`view/ui/handles.ts`) draws the vertex,
midpoint, resize and rotate handles of selected features, the handles of
Circles, and the vertices that follow a shared vertex. Vertex and midpoint
handles go through the PointInstanceRenderer, so even a line with hundreds
of vertices needs only a few draw calls. The handles can be thinned by
density (`view/ui/handle-thinning.ts`), and while a vertex is being dragged
only that vertex is drawn.

### ImageRenderer

`ImageRenderer` (`view/renderers/image.ts`) draws Image features as
textured quads; `draw()` takes an `onNeedRedraw` callback that fires when
the image becomes ready.

- It asks the `TextureCache` (`view/cache/texture.ts`) for the texture of
  the image's data URL (`acquireImageTexture`). The first call starts the
  decode (one per data URL, shared by every caller) and returns null;
  nothing is drawn until the decode finishes and requests a redraw
- The next frame that asks uploads the decoded image. Uploads happen only
  while rendering, never from `img.onload`: the context is shared with
  maplibre, which caches its GL state and resets that cache only after a
  custom layer's `render`. The upload sets `UNPACK_FLIP_Y_WEBGL` and
  `UNPACK_PREMULTIPLY_ALPHA_WEBGL` to false (the shaders expect straight
  alpha) and restores the values and the texture binding it found
- An image larger than `MAX_TEXTURE_SIZE` is scaled down to fit, and image
  textures get mipmaps, since images are often drawn smaller than their
  size. The display size still comes from the image's own size
- A failed decode is not retried every frame (only after
  `invalidateImage`), and a decode that finishes after the layer is removed
  is dropped
- The quad is drawn with the `QuadShader`, scaled with the zoom relative to
  `createdZoom`

## Retained mode for Store features

Immediate mode repeats style resolution, relative coordinates, CPU vertex
construction and upload for every visible feature on every frame, even for
features that do not move. As the count grows this dominates the frame.

Store features are therefore drawn in retained mode by default
(`StoreRetainedCache`, `view/layer/store-retained.ts` and its
`store-retained-*.ts` parts). Retained batches are built per layer, and a
frame only binds them, sets uniforms and draws. The vertex data does not
depend on the camera (projection is done with per-frame uniforms), so it is
rebuilt only when the features or their style change. The option
`rendering.cacheGeometry: false` (`storeRetained` in the internal
rendering configuration) returns to immediate mode; both give the same
picture, z-order included.

### Runs and chunks

Retained mode must produce the same picture as immediate mode, so a layer's
feature sequence is cut into runs at exactly the positions where the
BatchManager would flush, and the runs are drawn in order.
`classifyFeature()` (`store-retained-classify.ts`) returns one of seven run
kinds, and a run ends where the kind changes:

- `polygon`: Polygon, MultiPolygon, Circle (fill only or a solid outline)
- `line`: LineString, Freehand, MultiLineString (solid)
- `point-circle`, `point-square`, `point-triangle`, `point-star`: Point
  and MultiPoint with that shape
- `immediate`: anything that cannot be retained

A run is cut into chunks of at most `STORE_CHUNK_TARGET` (512) features, and
a chunk owns one retained batch. Fill-only polygons are built as SDF
polygons without an outline (stroke opacity 0), so they share a run with
solid-outlined polygons.

The `immediate` kind covers:

- Dashed and dotted lines, and polygons with a dashed outline (the dash
  cutting depends on the zoom). With the terrain on, the drape paints them
  instead
- The point shape `icon` (no instancing)
- Kinds retained mode does not handle, such as Image
- Feature types added with `draw.extensions.featureTypes`
- Features with a companion, which need a hook right before the feature

An immediate chunk owns no batch and is drawn with the same procedure as
the immediate layer loop, flushing before custom types and companions, so
the painter's order is the same as in immediate mode.

The vertices of a batch are baked as Float32 offsets from an origin, the
center of the chunk's bbox. When the error this leaves on screen would
exceed a tenth of a pixel at high zoom, the chunk is rebuilt around the
view (`view/shaders/retained-origin.ts`, at most once per frame per chunk).
The details are in [Coordinate precision](./coordinate-precision.md).

### Fixed widths in shared batches

Features without a `createdZoom` keep a constant width on screen. `u_zoom`
is a per-batch uniform, so they could not share a batch with zoom-scaled
features, which would split the batch and break z-order. A negative stroke
width is used to express a fixed width instead (see
[Fixed width](#fixed-width-negative-stroke-width)), for lines and polygon
outlines alike.

### Viewport thinning of chunks

Retained batches do not depend on the camera, but drawing every chunk every
frame would send much off-screen geometry to the GPU when the data is far
wider than the view. Each chunk carries a longitude and latitude bbox, and
chunks that do not intersect the expanded viewport are skipped.

- Only whole chunks are skipped and batches are never rebuilt for it, so
  z-order does not change
- The expanded viewport is `ViewportFilter.getBounds()`, the same range as
  immediate mode, so retained mode draws a superset of immediate mode
- The bbox is computed when the chunk is built. A chunk without
  coordinates has a null bbox and is always drawn
- Longitude min and max are taken on raw values. Data crossing ±180 gets a
  huge bbox and is always drawn, which is the safe side
- A Circle's bbox comes from the four extreme points of the drawn polygon

Immediate chunks are also thinned per feature with
`ViewportFilter.getVisibleIds()`, so touching the view does not draw every
off-screen feature of the chunk. The query runs only in frames that draw an
immediate chunk, once per frame.

### Invalidation

Invalidation comes from the Store subscription (in `onAdd`) and from
snapshots compared at the start of a frame. It is conservative: rebuilding
too much is still correct, rebuilding too little leaves a stale picture.

| Change                                          | Rebuilt            |
| ----------------------------------------------- | ------------------ |
| Feature created or deleted                      | its layer          |
| Feature coordinates or properties               | its chunk          |
| Feature type, visible, style reference, groupId | its layer          |
| Feature moved to another layer                  | both layers        |
| Layer styleRule, visible, order; layer deleted  | that layer         |
| Layer opacity alone                             | nothing            |
| Reordering inside a layer (layerReorder)        | that layer         |
| Group changes (groups, groupReorder)            | all layers         |
| Locally hidden set                              | all layers         |
| Overlay renderer or custom type registered      | all layers         |
| Companion provider registered or removed        | all layers         |
| Terrain subdivision or anchor elevation changed | all layers         |
| Globe cells changed (`globeGeneration`)         | all layers         |

- Reordering between layers (`layers.orderChanged`) discards nothing: the
  loop calls `drawLayer()` in layer order and chunk contents do not change.
  Selection, mode and UI state changes discard nothing either
- Groups have no reverse lookup to their layers, so they discard
  everything; both are rare
- The locally hidden set (`store.listHidden()`) is updated in place,
  so `RetainedInvalidationWatch` (`store-retained-invalidation.ts`)
  compares its size and elements with the previous frame
- The companion registry has a generation number that changes on every
  registration and removal. Comparing one integer per frame catches a
  change of the "has a companion" classification
- The terrain generations cover the subdivision step baked into polygon
  vertices and the ground elevation baked into point instances. The globe
  generation covers the cut of the fills on the globe (see
  [Edges on the globe](#edges-on-the-globe))
- The classification is checked again when a chunk is rebuilt. If it
  disagrees with the chunk's kind (a property change moved a style rule
  result, say), the whole layer is cut again. If it disagrees a second
  time, the frame is drawn in immediate mode and the next frame retries. A
  chunk whose GPU resources could not be created (shaders not ready) is
  drawn in immediate mode for that frame as well

Small coordinate changes such as a vertex drag do not rebuild. For
LineString and Freehand, an update that keeps the coordinate count and moves
at most `MAX_PATCHED_VERTICES` (8) vertices only rewrites those texels of
the coordinate texture with `texSubImage2D`
(`store-retained-coord-patch.ts`, `patchRetainedBatchCoords`), and grows
the chunk bbox to cover the new position (never shrinks it). In a solid
retained line batch the shader recomputes caps and widths in screen space
and dashes are off, so the accumulated distance in the instance attributes
is unused and updating the texels alone is correct. Dragging a vertex of a
very long line is then O(1) per move, and committing the drag needs no
rebuild. Other updates rebuild the chunk.

GPU resources are released from `onRemove()` through `dispose()`, before
the renderers are destroyed.

### Selection UI in retained mode

The features of the selection UI are looked up from the selected ids
(`getSelectedFeatureIds()`), not from the drawn features, so the UI is the
same in both modes and an off-screen selection still gets its box.

## Retained mode for datasets

The data of a dataset never enters the Store, so it is not part of the Store's
retained batches. `Dataset` (`dataset/`) has its own retained
mode. The data is assumed never to be edited and never to change order, so
chunks are cut by space rather than by draw order.

`DatasetImpl` (`dataset/dataset.ts`) is a thin surface holding
the public API, the events and the contents, and delegates to:

- `DisplaySource` (`source.ts`): the contents, whatever form they were
  given in (see [Contents and their forms](#contents-and-their-forms))
- `DisplayChunkSet` (`chunk-set.ts`): building, drawing and invalidating
  the chunks
- `DisplayProviderLoader` (`provider.ts`): debounce, tile cache and order
  of provider responses
- `CollisionThinningState` (`thinning.ts`): the winners
- `selection.ts`: the selection highlight and the hit test
- `DisplayFeatureStyler` (`style.ts`): rule colors and base style

Each dataset has its own spatial index and style rule cache, so it does
not pollute the caches of the Store path. How datasets take part in hit
testing is in [Hit testing](./hit-testing.md).

### Contents and their forms

The dataset reads its contents only through the `DisplaySource`
contract: rows numbered in draw order, the bbox of each row, the spatial
chunks and the spatial index over them, the id and the feature of a row,
what the collision thinning reads, and a collector that walks the rows of a
chunk into the intermediate data of its build. The drawing, the hit test,
the selection, the thinning and the terrain drape are written against it,
so a new input form is one more implementation.

- `FeatureArraySource` (`source.ts`) holds an array of features
  (`rows`, `setRows`, a provider). Its collector resolves the style
  of each feature as the Store path does
- `TableSource` (`table-source.ts`) holds a table
  (`table`, `setTable`). Its collector reads the coordinates from the
  typed arrays of the table and packs points and lines straight into the
  arrays of the GPU (`buildRetainedPacked` of the point renderer,
  `buildRetainedPackedBatch` of the line renderer), with no object per row.
  Polygons are handed to the polygon renderer as rings, as on the feature
  path. A row has no individual style, so the style is resolved once per
  rule color: the collector evaluates the rule on the column it reads
  (once per code for a dictionary column) and asks the resolver of the
  renderers with a feature that carries only that color. The packed arrays
  hold the same values as the arrays of objects, so both forms draw the
  same picture (`view/renderers/packed.test.ts`,
  `dataset/table-dataset.test.ts` and `e2e/table.e2e.test.ts`
  compare them)
- The bboxes, the chunks and the spatial index of a table come from
  `prepareTable` (`table/prepare.ts`), a pure function that runs in a
  Worker. The public subpath `@sakuzu/maplibre-gl-draw/table` exports it
  with `transferList`, the building of a table from GeoJSON and the types
  of a table, and its runtime imports are checked to stay pure
  (`table/index.test.ts`). Without it, `setTable` computes the same
  arrays on the main thread
- A table builds a feature for a row only when one is asked for: a hit,
  the selection, `getFeatures`, `collectVisible`, `getRow`, the
  predicate of `externalPointRender` (for the point rows), a row drawn in
  immediate mode (a dashed line or outline, a point shape without
  instancing), and the lines and polygons handed to the terrain drape.
  `collectDrawnRows` and the other `getRow*` reads build none: they read
  the thinning mask, the spatial index and the bbox array
  (`DisplaySpatialIndex.searchWhere` filters the rows before it sorts
  them). `findRow` reads an index of the ids built on its first call
  (`DisplaySource.rowOfId`; a table without an ids column parses the
  number instead)

### Spatial chunks

`partitionRows()` (`table/partition.ts`) splits the rows at the median
of the centers of their bboxes along the axis of the larger extent, the way
a k-d tree is built, until a range is small enough. It reads only typed
arrays (the bboxes and the vertex counts), so the same function splits an
array of features and, in a Worker, a table. A chunk holds the
numbers of its rows, not the features.

- A range stops when it has at most `CHUNK_TARGET_SIZE` (96) features and
  at most `CHUNK_TARGET_VERTICES` (40,000) vertices. A single feature above
  the vertex target becomes a chunk of its own
- Datasets of more than 50,000 features use a target of 4,096 features
  (`chunkTargetSizeFor()`). A chunk is also the unit of drawing, and each
  one costs a program switch and uniform setup per frame. Culling gets
  coarser, but off-screen vertices are dropped by clipping, so the GPU
  processes the same number of vertices
- Cutting at the median evens out the counts whatever the distribution. A
  single very wide feature (a whole country, a feature across the date
  line) goes into its own side and does not distort the rest
- Inside a chunk the original order (draw order) is kept. Chunks are
  ordered by their first row, so the overall draw order is roughly kept
- A row without a geometry (its bbox is NaN) is left out of the chunks and
  of the spatial index
- Culling at draw time is an AABB test between the chunk bbox and the view.
  Hit testing uses the spatial index of the rows instead, a static R-tree
  packed into typed arrays (`table/packed-rtree.ts`), built in one pass
  when the contents are replaced

### Chunk batches

`buildChunkBatches()` (`dataset/retained.ts`) builds the GPU resources of
one chunk: polygon, line and point retained batches, plus the features that
cannot be retained, drawn in immediate mode.

- Vertices are baked relative to an origin. Only the projection uniforms
  and the zoom change per frame. A chunk that spreads widely is rebuilt
  around the view at high zoom, as on the Store path
- Line widths and point sizes are baked in physical pixels. Features
  without a `createdZoom` are built with a width zoom of 0 and drawn with
  0, which keeps their width constant on screen. Fixed-width and
  zoom-scaled polygons and lines go into separate batches
- Within a chunk the order is polygons, lines, points, then the immediate
  features, then the immediate points. The exact original order within a
  chunk is the price of batching
- Dashed or dotted outlines and lines, images and point shapes without
  instancing are drawn immediately after the chunk's batches
- The point batches and the immediate points form the point part of the
  chunk. `rebuildChunkPoints` rebuilds it alone, without touching the
  polygons and the lines: the anchor elevations of the terrain and the
  collision thinning change only the points

### Building across frames

A chunk is built only when it first intersects the view, and building is
sliced by time: at most `CHUNK_BUILD_BUDGET_MS` (12 ms) per frame, always at
least one chunk. Chunks not built yet appear over the next frames, much
like tiles arriving. Polygons are built in bundles of about 2,000 vertices,
so one large surface does not stall a frame, and a chunk that is being
rebuilt keeps drawing its previous batches until the new ones are ready.
With `timeSlicing: false` in the rendering settings the budget is
infinite, and every chunk in view is built in the frame (see
[Complete frames](#complete-frames)).

A build has two phases, and the budget covers both. The first walks the
rows of the chunk, applies the rule colors and resolves the styles into
the intermediate data (`ChunkCollector`, in slices of
`COLLECT_SLICE_ROWS`, 512 rows); the second builds the GPU resources from
it. Starting a build does no work, so a first frame with hundreds of
visible chunks walks only the chunks it has the budget for, instead of
resolving the styles of the whole view at once.

With terrain, a chunk is also re-baked when the tile composition that
covers it changes (`needsRetessellation`, a fingerprint from
`tilingSignature` in `view/terrain/tiling.ts`), and only then. A chunk
baked flat before terrain was active is re-baked once terrain is live.

### Rebuilding and disposal

The batches of a chunk are discarded and rebuilt only when something baked
into them changes:

- `setRows()`, `setTable()` or a provider response (the chunking
  starts over)
- `setStyleRule()`, `setBaseStyle()` (colors change; chunks are kept)
- `setExternalPointRender()` (see
  [Delegating point rendering](#delegating-point-rendering))
- A change of the rendering pixel ratio, since widths are baked in physical
  pixels. A `pixelRatio` passed in the options is fixed and never triggers
  this
- The hand-over of polygons and lines to the terrain drape starting or
  stopping (see [Terrain](#terrain))
- The triangulation of a huge polygon finishing (only that chunk)

A change of the rows the collision thinning draws discards nothing. Each
chunk records the mask of drawn rows its point part was built with, and
the draw rebuilds the point part of a chunk whose mask differs before it
draws the chunk (see [Collision thinning](#collision-thinning)).

`onRemove()` of the custom layer releases only the GPU resources. The
dataset itself survives and is rebuilt on the next draw once the layer
is added back.

### Triangulating huge polygons across frames

A single polygon with a million vertices (a coastline, a large lake) can
take many seconds to triangulate. On the path of the datasets the
triangulation is chopped up and advanced across frames, and the geometry is
never simplified.

- Only polygons above `ASYNC_TRIANGULATION_VERTEX_THRESHOLD` (10,000
  vertices) take this path; ordinary data is triangulated on the spot
- A slice is `TRIANGULATION_SLICE_MS` (8 ms). The budget is shared by the
  whole map (`TriangulationScheduler`), so more datasets do not mean
  more time per frame
- The fill of the polygon appears when its triangulation finishes; the
  outline appears from the first frame. On completion only that chunk is
  rebuilt and a repaint is requested
- `SlicedEarcut` (`view/renderers/polygon/earcut-sliced.ts`) is a port of
  earcut's ear clipping loop that can stop and resume. Its result is
  identical to earcut's. The preprocessing is not sliced
- No worker is used, so the library does not depend on how the host
  bundles workers
- Drawing that happens once and is read back (an export, a thumbnail) sets
  `timeSlicing: false` in the rendering style, so fills are ready in the
  first frame

### Complete frames

A host that reads the picture back (a print, a thumbnail) needs to know
when it is complete. Two things answer it.

`timeSlicing` (rendering settings, true by default) is the one switch of
the work that is spread over frames. With false, every frame is complete
while the camera is still:

- the chunks of the datasets in view are built in the frame
  (`buildBudgetMs` of the chunk set is infinite)
- every polygon is triangulated on the spot (the threshold of
  `TriangulationScheduler` is infinite)
- the tile index of the analytic drape is built in the frame
  (`DrapePlanner` prepares it without a budget)

The rebuilds that wait for the camera to stop still wait; a capture is
taken with the camera still.

`Draw.hasPendingWork()` reports the work later frames finish on
their own. It asks the engine (`CustomLayerInterface.hasPendingWork`),
which asks:

- the drape planner: tiles of the index left for the next frames (the
  previous plan drawn meanwhile), or a hand-over to the datasets waiting
  for `DRAPE_STABLE_FRAMES` usable frames. It requests the frames that
  finish either
- the datasets (`DatasetManager.hasPendingWork`): a queued triangulation;
  a chunk the most recent frame left unbuilt, for a visible dataset that
  frame drew (a hidden one, or one on no side of the frame, has no work);
  a provider call waiting for its debounce or its response
- the overlay renderers, through the optional
  `EngineOverlayRenderer.hasPendingWork` (`OverlayRenderer.hasPendingWork`
  of the extension contract)

maplibre fires `idle` after a frame even when a custom layer asked for
another frame while drawing it, so `idle` alone does not tell. The host
waits for `idle` (the tiles and the DEM of the map), then for a `render`
after which `hasPendingWork()` is false.

### Insertion points in the render loop

A dataset is drawn at one of three places in the render loop:

- `below-store`: before the layer loop, behind every Store layer
- `above-store`: after the layer loop, in front of every Store layer but
  behind the selection UI and the drawing preview
- `layer-order`: inside the loop, at the position of the dataset's own
  id in the stacking order (`store.getLayerOrder()`)

All three are outside the per-layer `beginFrame` / `endFrame`, so the
Store's batches and GL state never mix with a dataset's. Datasets on
the same side are drawn in the order they were added, so the later one is
in front. The rules of the `layer-order` position are in
[Display order](#display-order).

### Provider tile cache

A dataset with a `provider` asks for data when the displayed range
changes.

- The requested range is rounded to an integer zoom and tile coordinates,
  and the rounded range is the key, so moves within the same tiles cause
  no call
- Results go into an LRU cache under that key (`DEFAULT_TILE_CACHE_SIZE`,
  32 entries). Returning to a range seen before restores it at once,
  without waiting for the debounce
- Calls are debounced (`DEFAULT_PROVIDER_DEBOUNCE_MS`, 200 ms). Only the
  response to the latest request is applied; an older one arriving later is
  discarded
- The previous result stays on screen while fetching

## Zoom-dependent scaling

Line widths are computed on the GPU from `createdZoom`, so a feature keeps
its size relative to the ground:

```glsl
float lineWidth = strokeWidth * pow(2.0, u_zoom - createdZoom);
```

- Lines and polygon outlines scale `strokeWidth` this way
- Images keep the pixel size they had at `createdZoom`, scaled the same way
- Computing it on the GPU keeps it out of the vertex data, which is what
  lets retained batches survive zooming

### Fixed width (negative stroke width)

A negative `strokeWidth` means a fixed width of `-strokeWidth` pixels,
ignoring `createdZoom` and the current zoom. It is a convention shared by
the SDF line and SDF polygon shaders:

```glsl
// sdf-line
float lineWidth = strokeWidth > 0.0
    ? strokeWidth * pow(2.0, u_zoom - createdZoom)
    : (strokeWidth < 0.0 ? -strokeWidth : u_width);

// sdf-polygon
float lineWidth = strokeWidth >= 0.0
    ? strokeWidth * pow(2.0, u_zoom - createdZoom)
    : -strokeWidth;
```

Because `u_zoom` is per batch, the convention is what lets fixed-width and
zoom-scaled features share a batch and keep their z-order. The Store path
uses it for every feature without a `createdZoom`, in retained and
immediate mode alike (`withFixedWidth`, `collectPolygons`). Zero means
something different per renderer: the per-batch `u_width` for lines, and
no outline for polygons.

### Draw-time factors

A retained batch bakes sizes and colors. For adjustments that change every
frame ("a little thinner and fainter as the zoom changes"), two uniforms
are multiplied onto the baked values at draw time:

- `u_size_scale` (vertex) multiplies point diameters, line widths and
  polygon outline widths. For lines and polygons it is applied outside the
  fixed-width branch, so both branches get it by construction
- `u_opacity` (fragment) multiplies the opacity. Points and polygons
  multiply only the alpha component; lines multiply the whole color, in
  the same way as their coverage

They are passed as `RetainedDrawFactors { scale, opacity }`
(`view/renderers/draw-factors.ts`), with `NEUTRAL_DRAW_FACTORS` (scale 1,
opacity 1) as the default.

Uniforms are residual per-program state, so every path that has no factors
(`draw`, the immediate draws of a dataset, the selection UI) must write
the neutral values. Otherwise the factors of a dataset or a layer drawn
just before leak into whatever is drawn next.

### The opacity of a Store layer

`Layer.opacity` is the draw-time factor of the Store, computed by
`layerDrawFactors(layer)` (scale 1, opacity clamped to 0..1). It never
reaches the baked data, so a change of the opacity alone rebuilds nothing
(`isOpacityOnlyLayerChange`), and every path multiplies the same factor:

- Retained chunks pass it to `drawRetained` / `drawRetainedBatch`
- In immediate mode `BatchManager.beginFrame(…, layer)` takes it for the
  frame and passes it to the immediate `drawAll` and `drawBatch`. The
  paths without a factor uniform multiply it into their colors: the
  fill-only polygon batch (per-vertex colors), the per-point shapes, and
  `FeatureDrawer.drawFeature` (images through `ImageRenderer`, which also
  covers the images interleaved into the drape)
- The analytic drape gives each Store layer a factor source of its own
  (below)
- Custom renderers and feature companions receive it as
  `RenderContext.opacity` (`layerRendererContext` in
  `render.ts`) and multiply it into their own alpha. Overlays, the
  tentative geometry and the selection UI are not content of a layer and
  get 1

Hit testing does not read it, so a feature in a layer at opacity 0 can
still be selected.

### zoomScale of datasets

The factors of a dataset come from `DatasetOptions.zoomScale`
(replaceable with `setZoomScale`):

```typescript
type DatasetZoomScale = (zoom: number) => { scale: number; opacity: number };
```

- It is evaluated once per frame, and the same value goes to every chunk
  and batch of that frame
- The factors apply only at draw time, so changing the function does not
  rebuild batches, unless the thinning footprint changes the winners
- A NaN, infinite or out-of-range result does not break drawing
  (`sanitizeDrawFactors` clamps scale to a positive finite number and
  opacity to 0..1)
- A frame where `opacity` is 0 skips the dataset entirely
- It applies per dataset, never to the Store, and multiplies with the
  render scale
- Features drawn in immediate mode (dashed lines, the point shape `icon`)
  do not get the factors

## Collision thinning

With hundreds of thousands of points in a dataset, the
markers overlap at low zoom and the picture turns to mush.
`collisionThinning` (`dataset/thinning.ts`) stops drawing point markers
that overlap on screen. It is off by default, and when off, rendering does
not change at all.

- The test uses the drawn size. The footprint radius is the resolved point
  radius (feature style, then base style, then core default) plus the
  stroke width, times the `scale` of `zoomScale`, plus a margin
  (`DEFAULT_THINNING_MARGIN_PX`, 2). Bigger markers thin more
- Winners are chosen over the whole dataset per integer zoom band
  `b = floor(zoom)`. The view is not used, so winners do not change while
  panning. With pitch, `zoom` is the effective zoom (below)
- Distances are compared in Mercator world coordinates (0..1). In band `b`
  one screen pixel is `1 / (512 * 2^b)` at every latitude
- Features are taken greedily in reverse draw order (front first). One is
  taken when `dist < r_i + r_j` holds for none of the winners taken so far.
  Neighbors are found with a spatial hash grid whose cell is the largest
  footprint diameter of the band, but the test always uses the real
  distance, since a winner in a neighboring cell can be adjacent
- Only `Point` is thinned. Lines, polygons and MultiPoints always win,
  because one footprint cannot decide for several separated parts
- At or above `fullDisplayZoom` (`DEFAULT_FULL_DISPLAY_ZOOM`, 17) thinning
  stops and everything is drawn, so no source feature is invisible at every
  zoom

The winners are held as one byte per row (`selectCollisionWinnerRows`),
whatever the form of the contents; the set of ids that
`getVisibleFeatureIds` returns is built from it on the first request.

Chunk batches are built from the winners only, and losers are removed
from hit testing and from snapping to display data
(`snapping/providers/display.ts`), so nothing invisible can be grabbed.

### Hit radius of thinned points

A point of a dataset can be grabbed anywhere inside its marker as
drawn: the hit radius is resolved like the footprint (`pointMarkerRadiusPx`)
and the caller's click tolerance is only its lower bound. Otherwise a large
marker would miss clicks inside its visible circle. Lines and polygons are
tested against their shape with the tolerance alone.

### Pitch correction

With pitch, the top of the screen shows the distance at a smaller effective
scale. Taking the band from the camera zoom would let the whole volume flow
into the distance and turn to mush there. The band and the
`fullDisplayZoom` test therefore use the shallowest effective zoom on
screen.

- The screen center and the middle of the top edge are unprojected, and
  their distance in Mercator world coordinates is measured
- On a plane this distance is `half the screen height / (512 * 2^zoom)`.
  With `r` the ratio of the measured distance to it,
  `effectiveZoom = zoom - log2(r)` (`effectiveZoomForPitch`)
- At pitch 0 nothing is measured and the camera zoom is used, which keeps
  projections that cannot be measured as a plane, such as the globe,
  unchanged
- The same camera always gives the same value. The ratio diverges once the
  horizon is on screen, so the drop is capped at `MAX_PITCH_ZOOM_DROP` (8)
- `getThinningStats().band` reports the effective band

### Following the zoom

The drawn rows follow one zoom: the style zoom of the frame being drawn,
lowered by the drop of the pitch correction. The zoom of the map is not
read again. The elevation settlement of the terrain changes it without
changing the picture, and a band taken from it would flip while nothing
moves. `CollisionThinningState.sync(zoom)` is the only way the drawn rows
change: it picks the winners of the band of `zoom` for the current
contents, style and settings, and does nothing when they are already
those.

- Every frame calls it first, in `DatasetManager.beginFrame`, before the
  drape plan and before any layer draws, for every visible dataset. A
  layer that draws in the same frame reads the rows the frame draws. The
  draw of a dataset calls it again with the same zoom, which finds
  nothing to do (and keeps a draw without a frame, in a test, correct)
- A change made by the host picks the winners at once, with the zoom of
  the most recent frame (the zoom of the map before the first frame):
  replaced contents, a new style, new zoom factors, new settings. The next
  frame draws them
- A hidden dataset keeps its rows; the first frame that draws it again
  brings them up to date

The winners of up to six bands are kept per (feature generation, style
revision), least recently used first out, so the selection runs once per
band crossed and going back to a band costs nothing. The selection of a
band over 260,000 points takes 20 to 75 ms (more winners, more work), more
than a frame, so while the page is idle the bands within two of the
current one are picked ahead. `CollisionSelection` advances a selection
in slices of `SELECTION_SLICE_ROWS` (4,096) rows, under 2 ms each at that
size, and stops at the deadline of the idle period
(`CollisionThinningState.prefetch`). A frame that needs a band being
picked ahead finishes that selection instead of starting over. A
selection sliced this way gives the same winners as one run in one go.

### Drawing the new rows

A change of the drawn rows discards no batch and does not advance the
revision of the drape (the drape draws polygons and lines, which the
thinning never removes; `drapeFeatures` ignores the drawn rows). A mask
is never modified once it is in use, so its identity names it:

- A build of a chunk collects the mask of the moment it starts, and the
  chunk records it with its batches (`pointsMask`)
- Before a chunk is drawn, a chunk whose mask differs from the current
  one has its point part rebuilt (`rebuildChunkPoints`). When its rows are
  drawn alike in both masks (it has no point, or none of its points
  changed) it only records the new mask
- This rebuild runs in every frame, while the camera moves as well: until
  it does, the points of another band would be drawn at this scale (after
  a large zoom out, piled up into a solid patch). It costs a walk over the
  rows of the chunk plus the packing of the points it draws, which the
  thinning bounds by what fits on screen: about 2 ms to bring the whole of
  260,000 points in view to a band with a few thousand winners, on the
  CPU. The other rebuilds keep waiting for the camera to stop

So the frame that switches the rows draws exactly those rows, and the
queries (`collectDrawnRows`, `getVisibleFeatureIds`, `getThinningStats`)
and the hit test answer for them from the start of that frame. Every
change of the drawn rows advances `getDrawnRowsRevision()`, a number a
listener can keep its derived data under. The `change` event (`reason:
'thinning'`) of a band entered by a frame is sent after that frame (a
microtask), so no listener runs in the middle of drawing; a change made by
the host sends it at once, like its other events.
`DatasetImpl.drawnRowsChanged` is the one place that handles a change of
the rows.

## Delegating point rendering

To show points as something other than a circle (an icon drawn by an
extension, say), the extension draws the picture and the core only stops
drawing the point. This is `DatasetOptions.externalPointRender`:

```typescript
externalPointRender?: (feature: Feature) => boolean;
```

- A `Point` for which it returns true is not drawn by the core. What makes
  it true is up to the caller; the core only reads the boolean
- The point stays subject to collision thinning, hit testing and selection.
  Its footprint still comes from `pointRadius`, so thinning and hits match
  the picture when the external picture is drawn at that size
- Only the Point channel is affected. `MultiPoint` is excluded, for the
  same reason as in collision thinning
- Without a predicate the test is never reached and rendering is unchanged
- `setExternalPointRender(predicate | undefined)` replaces or removes it.
  The result is baked into the chunk batches, so a replacement discards as
  many batches as `setStyleRule` does

The test is one helper, `isExternallyRenderedPoint` on
`DatasetImpl`, and every path that can draw a point calls it:

- The retained path (`collectPoint` in `dataset/retained.ts`) neither
  batches the point nor sends it to the immediate list
- The immediate path (`drawImmediate`) removes it from the targets
- The selection path (`dataset/selection.ts`) still draws the halo (the
  key color, radius plus 3 pixels) and skips only the redraw of the point
  on top, so the external picture sits on the halo

Skipping the point only on the retained path would bring the circle back
whenever the point is selected, so all three paths must honor the helper.

## Globe and Mercator

maplibre supports both the Mercator and the globe projection. A custom
layer draws correctly in both by using the matrix maplibre passes to
`render()`: `CustomRenderMethodInput.defaultProjectionData.mainMatrix` is
the transformation for the current projection, and the prelude maplibre
provides implements the projection functions for that mode.

```text
longitude/latitude (WGS84)
  │  Mercator coordinates (0..1), relative to a center
  ▼  prelude projection + mainMatrix in the vertex shader
clip coordinates (-1..1)
  │  GPU
  ▼
screen
```

- On the globe, geometry on the far side is clipped by the projection
- The shaders do not branch on the projection for the vertices themselves.
  What changes on the globe is how finely the edges are cut before they
  are projected (below). When code must know the projection,
  `projectionTransition` of the projection data tells the frame (above 0
  while the globe is drawn), and `map.getProjection()` the setting

The offset-mode computation that keeps precision at high zoom, and how it
works on the globe and with pitch, is in
[Coordinate precision](./coordinate-precision.md).

### Edges on the globe

The vertex shaders project each vertex onto the sphere, and the GPU joins
two projected vertices with a straight line in space: a chord through the
sphere. maplibre draws its own layers differently. An edge is the straight
line of the Mercator plane carried onto the sphere, so it looks as it does
on the Mercator map: a parallel stays a parallel and a meridian a meridian.
maplibre gets there by cutting the geometry on the Mercator plane before it
is projected (its subdivision). The core does the same
(`view/globe-subdivision.ts`, the pure parts in
`shared/math/globe-subdivision.ts`), so an edge between two vertices follows
the path of maplibre's layers.

- The cell is maplibre's granularity on the globe
  (`globeSubdivisionGrid`): fills and their outlines 128 cells along the
  world at zoom 0 and at least 2 per tile, lines 512 at zoom 0 and at least
  1 per tile, halved at each zoom level of the tile (the integer part of
  the zoom). A cell changes only when the zoom crosses an integer above 6
  for fills and 9 for lines
- `updateGlobeSubdivision` records the cells on the terrain context at the
  start of each frame from `projectionTransition` and the zoom, and
  advances `globeGeneration` when they change (the globe switched on or
  off, a cell halved)
- Fills and their outlines are cut on the CPU through the subdivision of
  the terrain (`subdivideTriangles`, `densifyRings`) with the fill cell:
  `getSurfaceTessellationStep` gives the renderers the terrain's step when
  the terrain is drawn and the globe's otherwise. A fill inside one cell is
  left as it is (`tessellateSurfaceFill`), which keeps a large dataset
  of small features cheap
- Lines are cut on the GPU. `resolveLineStations` splits every segment of
  a batch into as many stations as its longest segment on the Mercator
  plane needs (`maxSegmentMercator` of the batch) with the line cell, and
  `u_station_mercator` makes the vertex shader place the stations along the
  Mercator plane instead of along the degrees, the way the terrain places
  them. Nothing is baked, so zooming rebuilds nothing
- The other paths drawn on the CPU are cut with the line cell before they
  are drawn: the dashes of features (`densifyPathForGlobe` before
  `splitIntoDashes`) and the outlines of the selection UI
  (`StrokeRenderer`). The frame of a point is a figure of the screen laid
  around an anchor (`AnchoredOutlineRenderer`), so there is nothing to cut
- Images (`QuadShader`) are cut with the fill cell into the grid of the
  terrain's degraded path (`buildQuadGrid`, one piece per cell): the
  corners are interpolated on the Mercator plane and the texture
  coordinates with them, so a picture is pasted on the sphere the way it
  lies on the Mercator map. An image inside one cell keeps its four corners
- The retained batches of the Store rebuild when `globeGeneration`
  changes (`RetainedInvalidationWatch`), and the chunks of the
  datasets when the fill cell differs from the one they were baked with
  (`needsRetessellation`)
- On a flat map the cells are 0: nothing is cut, one station is drawn per
  segment and the vertex data is exactly what it was
- While the terrain is drawn its step takes precedence and the globe adds
  nothing

Hit testing tests the same paths (`dispatcher/hit-test/globe-shape.ts`,
see [Hit testing](./hit-testing.md)). The midpoint handle of an edge is the
point on the edge as drawn halfway across in longitude
(`mercatorMidpoint`), on the Mercator map as on the globe; so is the
anchor of the rotation handle on the top edge of the frame.

## Terrain

On a map with `map.setTerrain()`, features have to look as though they sit
on the ground. The core does this on its own; the code is in
`view/terrain/`. The user-facing side is in the
[Terrain guide](../guides/terrain.md), and the maplibre internals it
depends on are in [maplibre coupling](./maplibre-coupling.md).

### Detection

There is no API to turn it on. Every frame the custom layer looks at the
map's terrain and takes the terrain path when there is one. The core holds
no knowledge of DEM sources or encodings; the DEM passed to `setTerrain` is
the host's business. A map without terrain draws exactly as if terrain
support did not exist. Reaching maplibre's internal terrain is confined to
`view/terrain/detect.ts`, which returns null where it cannot reach it, and
then the flat rendering is used.

### DEM atlas

The DEM tiles in view are baked into one texture, the DEM atlas
(`view/terrain/dem-atlas.ts`), that every vertex shader reads. The bake
renders into its own framebuffer, so it runs in the `prerender` of the
first slot, in maplibre's offscreen pass: switching framebuffers during the
main pass makes a tiled GPU store and reload the whole frame. A frame whose
`prerender` did not run resolves the terrain state in `render` instead.

A bake is skipped when nothing it reads changed (layout, tiles and their
DEM textures, matrices, dimension, exaggeration). maplibre rewrites DEM
textures in place while tiles load, which that key cannot see, so it is
trusted only after `map.areTilesLoaded()`; until then the atlas is baked
every frame. The atlas stays bound to its own texture unit
(`TERRAIN_ATLAS_TEXTURE_UNIT`) for the whole frame, and the drape binds its
DEMs elsewhere, so later drawings never read elevations from a wrong
texture.

Everything uses the map's own vertical exaggeration: the atlas bakes
exaggerated elevations, the drape receives `u_terrain_exaggeration`, and
anchor elevations come from maplibre with it included.

The atlas bake and the drape read maplibre's DEM textures with the layout
maplibre gives them (a border of 2 texels, pixels centred on their cells).
That layout, and the sphere maplibre turns elevations into Mercator units
on, are copied in one place, `terrain/upstream-terrain.ts`, and the
end-to-end test `src/e2e/terrain.e2e.test.ts` holds what the GPU reads to
`map.queryTerrainElevation` on a known DEM.

### Analytic drape

Polygons and lines are not triangles laid on top of the terrain; they paint
the pixels of the ground. The drape rebuilds maplibre's terrain mesh with
the same generation rule (vertex order and main diagonal), displaces it
with the same DEM, and its fragment shader solves analytically whether a
pixel is inside a polygon or how far it is from a line.

- Our own triangulation and maplibre's mesh disagree on slopes, which
  shows as tears, streaks and holes. Drawing the ground surface itself
  leaves nothing to disagree
- Lines map tile-space distances to screen distances through the inverse
  Jacobian, so they keep a constant pixel width and need no
  re-tessellation while editing. Anti-aliasing is a `smoothstep` of the
  distance
- Edges are binned into cells within each tile on the CPU and passed as a
  float texture (`drape/binning.ts`). A tile over
  `DRAPE_MAX_EDGES_PER_TILE` (120,000) edges is degraded without being
  built. The index is kept per tile, and only tiles newly in view are
  built, within a per-frame budget (`drape/bin-store.ts`)
- The element order and the index are swapped as a pair and never mixed,
  and drawing continues with the previous pair while a new one is built.
  Anything that takes an element number (the ranges of the slots, below)
  must take it from the same version
- Depth meshes by lifting the vertices by `DRAPE_LIFT_RATIO` (1/2,500 of a
  tile's ground size, well under a pixel). `polygonOffset` is not used on
  the drape: its factor follows the depth gradient on screen and
  overshoots on shallow slopes
- T-junctions at tile borders are closed by edge constraints
  (`drape/edge-constrain.ts`): border vertices lie on the polyline of the
  coarser side, with elevations from the coarser DEM, so no crack opens at
  any zoom difference. Polygons, lines and textured quads share this
- The tile plan holds only tile ids, rows and ground sizes. DEM textures
  and matrices are looked up on every draw, because maplibre substitutes a
  parent tile's DEM until the real one arrives
- Datasets are collected into the same element list as the
  Store (`collectDrapeElements`, `drape/pass.ts`). Once the drape has been
  usable for `DRAPE_STABLE_FRAMES` frames, the planner hands their
  polygons and lines over (`setDrapedDatasets`), and those datasets
  stop baking them into their chunk batches. The hand-over is released at
  once when the drape stops being usable for a lasting reason, and kept
  through transient ones, so batches are not re-baked back and forth
- Dashed and dotted lines and outlines are elements too. Their style
  carries the coefficients of the pattern (`DRAPE_DASH_TEXEL`), the
  binning stacks the start of each edge along its path next to the edge
  texture (`u_edge_start_tex`), and the shader draws the outline where
  the dashes are. The fill and the selection highlight read the whole
  outline (see [Dashes](#dashes))
- Each element carries a factor source (`u_source_factors`, opacity and
  size, written every frame). Source 0 is neutral, the
  datasets come next (their `zoomScale`), and then each Store layer
  (its opacity; `drapeLayerSource`). A change of those factors does not
  rebuild the index. A layer past `DRAPE_MAX_SOURCES` (64) has its
  opacity baked into its colors instead, and the planner puts that
  opacity into the dataset key

### Choosing the path

`DrapePlanner.planFrame()` decides per frame whether the drape is used, and
records the reason in the diagnostic values (`getTerrainDrapeDebug`):
`terrain-off`, `wide-zoom`, `no-drapeable-features`, `vertex-budget`,
`cell-overflow`, `no-dem-tiles`, `stale-plan`, `texture-limit` or `ok`.

- The elements are collected before the band is decided, because the band
  depends on their cost. Dataset is folded behind a key (feature
  revision, stacking order, dataset revisions), so it costs nothing
  while the contents do not change
- The drape is used above `TERRAIN_ANALYTIC_MIN_ZOOM` (11), and below it
  too when the map is light (at most `DRAPE_WIDE_EDGE_BUDGET` edges in
  total). A light map therefore never switches path while zooming, which
  would make features jump between pinned to the ground and flat
- The band is decided with the real zoom, not the smoothed zoom the
  rendering reads, which can lag behind it
- A map over the vertex budget (`canDrape`) never uses the drape

### Vertex displacement fallback

Tiles over the budget and maps over the vertex budget use vertex
displacement instead:
subdivision aligned with the nodes of the terrain mesh (`densifyPath`,
`densifyRings`, `subdivideTriangles` in `tessellation.ts`) plus a
slope-proportional `polygonOffset`. The step is bounded above by the ground
size of a DEM pixel and below by a fixed length on screen, and changes with
the zoom.

In a frame that uses the drape, what it cannot paint is drawn after it by
this path: the geometry being drawn, the features of extensions, and the
datasets not yet handed over to the drape. It is drawn in the same depth
state as in a frame without the drape (`applySegmentDepthState`), so the
terrain hides it behind a mountain in both. The end-to-end test
`src/e2e/terrain-occlusion.e2e.test.ts` checks the pixels behind a peak and
in front of it for solid and dashed lines and outlines, of the Store and of
a dataset.

In the zoomed-out fallback (`wideFallback`: terrain on, the real zoom at or
below the analytic band, and the drape unusable) polygons and lines are
drawn flat and without the depth test. Over a wide area the relief is tiny
on screen, and without depth nothing can sink into the terrain mesh.

### Images in the stacking order

Textured quads (images, and quads drawn by extensions) cannot join the
analytic compositing, but they are pasted onto the same terrain mesh
(`drape/quad.ts`). To keep the stacking order, the element list is cut at
the images, each section is drawn with a range (`u_paint_range`), and the
images are drawn in between. A map without cut points draws everything in
one go. The runs of a cell are in draw order, so a section stops at the end
of its range. The selection highlight is accumulated over all sections and
overlaid once, by the last one, so it is neither buried nor doubled.

### Terrain shading of fills

While terrain is shown, polygon fills are multiplied by the same shading as
the ground, so an opaque polygon does not hide the shape of the terrain.
The Lambert term is normalized against flat ground, so hue is kept and only
lightness changes. The light comes from 335 degrees (northwest), anchored
to the viewport, at 45 degrees elevation with strength 0.45, matching the
hillshade defaults; light from the southeast would make the relief look
inverted. Lines, points, labels and handles are not shaded.

The same formula (`terrain/shade.ts`) is used on the vertex displacement
path and in the zoomed-out fallback, reading the DEM atlas instead of tile
DEMs (`shaders/terrain-shade.ts`). The path switches with cost and viewing
angle, and a fill that lost its shading at the switch would visibly jump.
Shading stops only when there is no terrain and for figures drawn in screen
space, such as a rubber band.

### Symbols

Points, vertex handles and billboards take the elevation of one anchor
point plus a tiny lift. They are drawn without the depth test, since a
billboard carries the depth of its center and would vanish as soon as it
sank a few meters.

`terrain/anchor.ts` is the single source of anchor positions:
`projectAnchor` (longitude and latitude to screen, with elevation) and
`anchorElevationMeters`, shared by rendering, hit testing and extensions.
The elevation is the one maplibre draws: `map.queryTerrainElevation`
inside the drawn terrain tiles, and the DEM tile of the current zoom level
outside them, where nothing is drawn and the public method is slow
(`terrain/ground.ts`). The projection is a CPU mirror of the shader
formula, so hit testing follows what is drawn; it lands within a hundredth
of a pixel of `map.project`, which is not used because it is slow for
points outside the drawn tiles ([maplibre coupling](./maplibre-coupling.md),
items 8 and 9). The whole selection
UI follows the same reference: outlines take the drape path of the feature,
handles use the ground anchor without depth test.

A symbol drawn without depth would look in front of a mountain that hides
it, so an occluded symbol is drawn as a ghost (`occlusion.ts`,
`TERRAIN_GHOST_OPACITY` 0.35) rather than removed, and can still be
selected. The test steps along the segment from the camera to the anchor
(up to 24 samples) and checks whether the ground rises above it; maplibre's
`depthAtPoint` is avoided because it waits on `readPixels`. Ghosting is
applied only on paths redrawn every frame, never baked into retained
batches, and the editing UI of the current selection is never ghosted.

### Terrain state per instance

The terrain frame state, generation counters and caches live in a
`TerrainContext` (`terrain/context.ts`), one per custom layer. There is no
current context: renderers receive it at construction, extension renderers
through `RenderContext.terrain`, and plugins use
`ExtensionContext.terrain.project`. Draw instances on one page (a main map, a
thumbnail) must not share counters, or a retained batch could wrongly
conclude that nothing changed.

How an extension draws its own symbols on terrain is described in the
[Custom types guide](../guides/custom-types.md).

## Performance

### How GPU resources are held

Renderers create their VAOs and buffers once and only upload data
(`bufferData`, `texSubImage2D`) and draw per frame; no `createBuffer` or
`delete*` per draw. StrokeRenderer, AnchoredOutlineRenderer,
FillShaderManager, PolygonBatchRenderer and SDFPolygonRenderer keep their
VAO and buffers
(index buffers bound into the VAO), SDFLineRenderer keeps its coordinate
texture and instance buffer, and PointInstanceRenderer keeps a VAO and an
instance buffer per shape.

Textures are bounded by `MAX_TEXTURE_SIZE`, read once per renderer. An
allocation beyond it fails and leaves a texture that samples as zeros, so a
part of the map would silently vanish. A line batch's coordinate texture is
never built past it, images are scaled down, and the drape lays out its
tables in rows of 2,048 texels; when a table would still be too tall, or an
allocation fails, the frame is drawn without the drape (`texture-limit`).

### Uniforms written once per frame

Retained mode issues one draw per visible chunk, so rewriting the same
projection and camera uniforms per chunk would spend the frame on setup
alone. Each renderer remembers the value it wrote last and skips
`gl.uniform*` when it is unchanged.

- Matrices and camera values are compared by the reference of the
  `ProjectionData` or `OffsetUniforms` they come from. Both are recreated
  every frame, so the same reference means the same contents
- Scalars (canvas size, `u_use_offset_mode`, `u_origin_shift`, zoom,
  widths) are compared by value; `u_origin_shift` is the one that really
  changes between chunks
- `beginRenderFrame()` (`view/shaders/frame.ts`) advances a frame number at
  the entry of `render`, and a new frame number discards the remembered
  values, in case maplibre ever reuses an object with new contents
- Relinking a program discards them too

Redundant `gl.useProgram` calls are not avoided: the current program is
context-wide state that maplibre and extension renderers also change.

The viewport size given to shaders comes from `gl.drawingBufferWidth` and
`gl.drawingBufferHeight`, the size of the framebuffer actually drawn into,
which keeps `gl.getParameter(gl.VIEWPORT)` out of the drawing path.

### Rendering pixel ratio

Widths, point sizes and outlines are specified in CSS pixels and converted
to physical pixels when drawn. All reads of the ratio go through
`resolvePixelRatio()` (`shared/utils/pixel-ratio.ts`); renderers never read
`window.devicePixelRatio` themselves.

- The context creates one source with `createPixelRatioSource()`. It
  returns `Options.pixelRatio` when given, and otherwise reads
  `map.getPixelRatio()` on every call, so it follows the ratio a map was
  created with and a window moved to another display
- Renderers and datasets receive the source itself
  (`PixelRatioInput = number | (() => number) | PixelRatioProvider`), so a
  change reaches every reader from the next frame on. Extension renderers
  get the resolved value as `RenderContext.pixelRatio`
- `rendering.renderScale` of the options multiplies a factor on top
  (default 1). A host that shows the map scaled down uses it to shrink what
  is fixed in screen pixels by the same ratio
- Retained batches bake the ratio and are rebuilt when it changes: the
  Store path compares `builtPixelRatio`, datasets use
  `syncDevicePixelRatio()`

The render scale applies only to dimensions fixed in screen pixels, and a
dimension that already scales with the zoom must not get it twice:

- Fixed in screen pixels, `resolvePixelRatio()`: point sizes, negative
  (fixed) line widths, widths through `u_width`
- Scaled with the zoom, `resolveContentPixelRatio()`: positive line widths
  (the GPU multiplies by `2^(zoom - createdZoom)`), widths in meters

A host that zooms the camera out by `d` and sets the render scale to
`2^-d` has already shrunk zoom-scaled widths through the camera. The sign
of the stroke width is how the CPU side declares which kind a width is.

### Alpha blending

`applyDrawBlendState()` (`view/layer/blend.ts`) sets up blending for the
frame:

```text
blendFuncSeparate(SRC_ALPHA, ONE_MINUS_SRC_ALPHA, ONE, ONE_MINUS_SRC_ALPHA)
```

The renderers output straight (non-premultiplied) colors, so RGB composites
with `SRC_ALPHA` / `ONE_MINUS_SRC_ALPHA`. The maplibre canvas is
premultiplied, and its alpha is the opacity composited so far. Using the RGB
factors for alpha would give `a * a + (1 - a) * dst.a`, so a 25% fill would
drop to 6.25%, and where the canvas is still transparent translucent fills
would all but vanish. `ONE` for the alpha source gives the correct
`a + (1 - a) * dst.a`, and RGB is unchanged.

The custom layer owns this state for the whole frame. Anyone else may
change the blend function only during its own drawing and must restore it
with `applyDrawBlendState()` (exported for extension renderers) before
returning. Because an extension may not, the core calls
`restoreBlendState()` again right after every point where control went to
external code: custom feature renderers (in `render.ts` and in the
immediate chunks of the retained cache), `drawForLayer` and `drawVertices`
of layer-aware overlays, and `draw` of overlay renderers. Otherwise
everything drawn later in the frame would be composited wrongly.

## Display order

At every level the end of an array is the foreground:

1. Between layers: the end of `store.getLayerOrder()` is in front
2. Within a layer: the end of `layer.order` is in front
3. Within a group: the end of `group.featureIds` is in front

`listFeaturesInOrder()` walks the levels in that order:

```typescript
for (const layerId of layerOrder) {
  const layer = layers.get(layerId);
  if (!layer) continue;
  for (const itemId of layer.items) {
    const group = groups.get(itemId);
    if (group) {
      for (const featureId of group.featureIds) {
        const feature = features.get(featureId);
        if (feature) result.push(feature);
      }
    } else {
      const feature = features.get(itemId);
      if (feature) result.push(feature);
    }
  }
}
```

The drawing uses `getDisplayFeatures(store)` (`store/local-visibility.ts`),
this order without the features that a visible flag hides (on the feature,
its group or its layer) and without locally hidden features. Hit testing
walks the same order in reverse; see [Hit testing](./hit-testing.md).

### The stacking sequence

The layer order is also the stacking sequence of datasets.
Rather than anchoring a dataset before or after a layer, which would put
the authority for the order in two places, a dataset joins the sequence
by its own id.

- An element of `layerOrder` (a `string[]`) is a layer id or a dataset
  id. `DatasetOrder` is
  `'below-store' | 'above-store' | 'layer-order'`
- A `layer-order` dataset is drawn and hit-tested at the position of its
  id. The below and above sides and `DatasetPlacement.index`
  (`moveDataset`) play no part in that order. `below-store` and
  `above-store` are for uses that do not join the sequence, such as
  previews
- A `layer-order` dataset whose id is not in the sequence (forgotten,
  or racing a deletion) is not drawn, and is never demoted to a side
- `setLayerOrder` keeps ids that are not layers; it drops only what is not
  a non-empty string and folds a repeated id to its first position.
  `createLayer` appends its id unless the sequence already holds it, and
  `deleteLayer` removes its own id. Removing a dataset id is the
  caller's job: `removeDataset` does not touch `layerOrder`,
  since the dataset layer does not know the Store
- The sequence is part of the document (the `StoreContract` rules): the
  native format writes it whole as `layerOrder` and a native load replaces
  it whole, and a replaced store holds it with the entries of the
  host. The datasets themselves are not in the document; the host adds
  them again after a load and they are drawn at their saved positions

The sequence is not a reason to rebuild anything: the Store's retained
cache discards nothing on `layers.orderChanged`, and moving a dataset
(`setOrder`, `moveDataset`) touches none of its batches,
providers or chunks.

## Slots and separators

A maplibre style is one ordered list of layers, and nothing can be inserted
inside a custom layer. So that a host can place maplibre's native layers
(vector tiles, rasters) within the stacking sequence, the library cuts the
sequence into segments and draws each with its own custom layer, a slot
(`view/layer/slots.ts`, `slot-manager.ts`, `custom-layer.ts`).

### Separators

- The host passes `isExternalEntry(entryId)` in the options. Entries for
  which it returns true are separators, and the library does not draw them.
  The Store is unchanged: `layerOrder` stays a `string[]`, and the meaning
  of an entry is decided by the reader
- `partitionLayerOrder()` cuts the sequence at the separators. A run of
  entries between separators is one segment; adjacent separators make no
  empty segment. Without separators there is one segment. A sequence with
  nothing to draw still gets one empty segment, because the foreground
  needs a slot

### Slots

- One custom layer per segment. The first has the id
  `maplibre-gl-draw-layer` and the others `maplibre-gl-draw-layer:<n>`
  (`slotLayerId`). `SlotManager` follows changes of `layerOrder`,
  creates and removes slots, and adds and removes them from the map
- Each slot's `render` passes only its own segment to `renderLayers`. The
  preparation of the frame (projection, terrain state, shaders, viewport)
  is done once by the first slot and shared
- `below-store` datasets are drawn by the first slot and `above-store`
  datasets by the last
- The foreground (overlays, selection handles, the drawing preview) is
  drawn by the last slot. Nothing in the foreground can be placed above a
  separator
- `draw.getLayerStack()` returns the segments and the layer ids of the
  frames, and the `layerStack.changed` event announces changes. The host moves each
  native layer to just after the slot of the preceding segment; placing
  native layers is the host's job
- After a style change (`style.load`), the slots go back on top of the
  map in their order (`attachSlotLayers`, `view/layer/attach.ts`). A
  diffed `setStyle` leaves custom layers in place and adds the new
  style's layers above them, so the block from the first slot to the last
  is moved to the top, each slot with the native layers just above it.
  A native layer that sat above the last slot stays below the block
  ([maplibre coupling](./maplibre-coupling.md), item 22)
- Retained batches stay per layer. A change of segments, or of the segment
  a layer belongs to, touches no batch

### Hit testing across separators

The library's hit test knows nothing about separators. The host compares
the library's hit with the result of maplibre's `queryRenderedFeatures` by
their positions in the sequence and takes the one in front. The library
returns the layer id of a hit, and its position is in `getLayerOrder()`.

### Separators on terrain

With terrain, maplibre bundles consecutive fill-type layers, bakes each
bundle into a per-tile texture and pastes it on the terrain mesh; a custom
layer splits the bundle. A slot draws the same mesh directly with the
analytic drape, so the two stack in order at the same depth. The cost is
the number of bundles plus slots, times the mesh rendering of the visible
terrain tiles.

The drape keeps one element list and one tile index for all slots. The
elements follow the stacking sequence, and the start of each entry
(`entryStarts`) is recorded at dataset time, so a slot paints only the
range of its segment with the same ranged drawing used for images. For the
few frames after the sequence changes, while the index being drawn does not
match the current sequence, the first slot paints every element.

## Invariants

These are easy to break and hard to notice:

- Retained and immediate mode must give the same picture. Keep
  `classifyFeature` in step with `BatchManager.processFeature`, and do not
  resolve styles differently in the two paths
- Do not add reasons for invalidation to `StoreRetainedCache.applyChanges`
  that the order between layers could trigger
- Do not discard chunk batches in `setOrder` or `moveDataset`
- Do not call `getLayerOrder()` more often within a frame
- Do not remove the `hasAny()` short-circuit of the datasets, which
  keeps the cost on maps without datasets at zero
- Restore the blend state after every call into external code, and write
  neutral draw factors on every path that does not use them
- Create GL objects only in `onAdd` or while drawing, release them in
  `onRemove`, and add every new renderer to `disposeRenderers`
- Take drape element numbers and the drape index from the same version
