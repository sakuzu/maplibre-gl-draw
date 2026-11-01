# Coordinate precision

This document describes how the library keeps features in place at high
zoom levels, how the same coordinates serve globe mode, pitch and roll,
how the selection UI stays aligned with what is drawn, and how a view
across the antimeridian is drawn and hit-tested.

The offset projection follows deck.gl's approach; the copyright notice for
the ported parts is in `THIRD_PARTY_NOTICES.md` at the root of the
repository.

## Coordinate systems

Data, computation and hit testing are done in geographic coordinates
(longitude and latitude). Only at render time do maplibre's matrices and
the renderers turn them into screen positions, with pitch, roll and globe
mode applied.

- Data is geographic. The coordinates of a feature, bounding boxes and
  handle positions are all longitude and latitude, and so is what the
  Store holds
- Computation is geographic. A length given in pixels for something laid
  on the map is turned into meters on the ground and laid around the
  feature, on the plane tangent to the sphere of the map there, and never
  goes through the screen and back (with terrain, a position projected and
  unprojected again lands elsewhere). There are two scales. A size of the
  current view (the margin of the selection box, the distance of the
  rotate handle, the move of an arrow key) takes the meters of a CSS pixel
  in the frame drawn last (`metersPerPixelInFrame` in
  `src/shared/math/screen-scale.ts`, `ScreenContext.metersPerPixel` for
  extensions): the scale of Web Mercator at the latitude of the feature,
  the scale at the center of the view on the globe, mixed by the transition
  between them. A size kept with a zoom (an image placed at a zoom) takes
  the scale of Web Mercator at that zoom and the latitude of the feature,
  once (`pixelsToMeters` of `/geometry`, which `metersPerPixelAtZoom` in
  `src/shared/math/ground-scale.ts` reads, for extensions too). For
  example, `applyMarginToBoundingBox` widens a geographic bounding box by
  the margin in meters. What keeps its size on the screen (a handle, a
  point marker and the selection box around it) keeps a geographic
  position and is drawn and hit tested on the screen around it
- Renderers receive geographic coordinates and project them in the vertex
  shader with the projection data of the frame
- Hit testing starts from geographic coordinates. The click is unprojected,
  and containment and distances are decided in a local frame around it.
  The exceptions are the handles of the selection UI and the symbols on
  terrain, which are tested in screen space against positions projected
  with the same transform the drawing uses (see
  [Hit testing](./hit-testing.md))

As a result, everything tilts and bends with the map under pitch, roll and
globe mode without special cases, and drawing and hit testing agree.

## The problem: Float32 at high zoom

WebGL shaders compute in Float32, which has about 7 significant digits. A
location near Tokyo Station is about (139.7671248, 35.6812362), or
(0.88824, 0.39891) in normalized Mercator units. At zoom 20 one pixel is
about 0.15 m, which is a change in the eighth or ninth digit of those
Mercator values. Projecting absolute coordinates in Float32 cannot resolve
that, and the symptoms are:

- Features tremble while they are dragged
- Features distort while they are rotated
- The selection UI and the feature it frames do not line up

## The offset method

The shader never sees absolute coordinates, at any zoom and in any
projection. The CPU, which computes in 64 bits, subtracts the center of
the view from every vertex, and the GPU projects only the small
difference.

```text
Absolute (loses precision):
  GPU: gl_Position = matrix * project(lngLat)

Offset (precise):
  CPU: offset = lngLat - centerLngLat           (64-bit)
       projectionCenter = matrix * project(centerLngLat)   (64-bit)
  GPU: gl_Position = matrix * projectOffset(offset)
                   + projectionCenter           (Float32, small values)
```

`projectOffset` turns the offset in degrees into the offset of the space
the matrix of the frame takes: the Mercator plane on Web Mercator, the
unit sphere on the globe, and both, mixed by the transition, in the
transition between them. It is not an approximation around the center:
it is the exact difference, formed so that it keeps the precision of the
offset however small it is.

### The uniforms

`calculateOffsetUniforms(centerLngLat, projection)` in
`src/view/shaders/helpers.ts` computes the uniforms of a center from the
projection data of the frame (its matrices and its transition):

- `centerLngLat`: the center rounded to Float32, what the offsets are
  taken from, sent to the shader as `u_center_lnglat`
- `centerLngLat64`: the same center in 64 bits, used for the offsets on
  the CPU
- `centerMercator`: the center in Mercator units (64 bits), used by the
  terrain to place the DEM atlas relative to the center
- `projectionCenter`: the center in clip space as the frame projects it
  (`clipOfPosition` in `src/view/shaders/center-projection.ts`, in 64
  bits): on Web Mercator, on the globe, or both mixed by the transition,
  sent as `u_projection_center`

`ProjectionUniformManager` (`src/view/shaders/projection.ts`) also writes
`u_center_sine_cosine`: sine and cosine of the latitude and of the
longitude of the center, computed in 64 bits. Without the uniforms of a
center it takes the offsets from (0, 0), as absolute coordinates.

maplibre gives a custom layer the matrix of the globe in its projection
data as 32-bit floats. The center in clip space is that matrix times a
position on the unit sphere scaled by the radius of the globe in pixels,
whose rounding to 32 bits moves it by half a pixel at zoom 18 and twice
that at every zoom above. The CPU
therefore computes the center with the same matrix in 64 bits, which the
render input of the custom layer gives as `modelViewProjectionMatrix`
while the globe is drawn (`mainMatrixOfFrame` in
`src/view/layer/frame-state.ts`, used only when it is the matrix of the
projection data to the precision of 32-bit floats). On Web Mercator the
matrix of the projection data is in 64 bits already.

`calculateLngLatOffset(lngLat, centerLngLat)` is the subtraction on the
CPU. A JavaScript number is a 64-bit float, and the result is small, so it
survives the conversion to Float32.

### The shader side

`OFFSET_MODE_GLSL` in the same file holds the shader functions, and the
part that forms the offsets is in
`src/view/shaders/center-projection.ts`. GLSL ES 3.00 bounds the error of
a few operations only (4.5.1): `+`, `-` and `*` are correctly rounded,
`/` is within 2.5 ULP, `log` within 3 ULP (an absolute 2^-21 for an
argument in [0.5, 2]), `exp(x)` within 3 + 2|x| ULP and `inversesqrt`
within 2 ULP. It gives no bound for the trigonometric built-ins (`sin`,
`cos`, `tan`, `atan`, `sinh` and the others), and some GPUs compute them
loosely: on SwiftShader, which Chrome falls back to without a GPU, the
Mercator y of the latitude of Tokyo computed as
`log(tan(lat) + 1 / cos(lat))` is off by about 4.7e-6, which is 2.5 px at
zoom 10 and 9.9 px at zoom 11.99. The projection of positions therefore
uses only the operations with a bound:

- `offset_sine_cosine(x)`: sine and cosine of half an offset (at most 90
  degrees) by their Taylor polynomials to x^13 and x^14, whose remainders
  are below 10^-9
- `mercator_offset_y(halfLat)`: the Mercator y of the offset of a
  latitude. With h half the offset and m the latitude halfway, the offset
  of the isometric latitude is 2 atanh(w) with w = sin h / cos m, and
  cos m = cos(lat0) cos h - sin(lat0) sin h. A small w (below 0.4) takes
  the series of atanh(w) / w to w^18. A large one takes the log of
  (cos m + sin h) / (cos m - sin h), whose two sides are formed as
  `cos(lat0) cos h + (1 - sin lat0) sin h` and
  `cos(lat0) cos h - (1 + sin lat0) sin h`, with `1 - sin lat0` and
  `1 + sin lat0` formed as `cos² lat0` over the other: no difference of
  numbers close to 1 is left to the log
- `half_latitude_of_mercator_offset(dy)`: the inverse, for a point given
  by its Mercator offset (the stations of a line on the globe): tanh of
  half the isometric offset by its series below 0.4 and by `exp` above,
  `tan h = w cos(lat0) / (1 + w sin(lat0))`, and sine and cosine of h
  with `inversesqrt`
- `sphere_offset(halfLat, halfLng)`: the offset on the unit sphere of the
  globe. Each component is a difference formed from the half offsets
  (`sin(lat) - sin(lat0) = 2 sin h cos m`, and the same for the cosine and
  for the longitude), so it keeps the precision of the offset
- `project_center_offset(...)`: the offset through the matrix, plus the
  center. On the globe, `u_projection_matrix` takes the offset on the
  sphere and the depth that hides the far side of the sphere is computed
  from the position as maplibre's prelude computes it
  (`globeComputeClippingZ`); in the transition, the offset on the
  Mercator plane goes through `u_projection_fallback_matrix` and the two
  are mixed by `u_projection_transition`, as maplibre's
  `interpolateProjection` mixes its own layers (the depth taken from the
  globe from a transition of 0.2 on). The globe branch is compiled only
  in the variant of the globe (`#ifdef GLOBE`)

```glsl
vec4 project_offset_to_clipspace(vec2 lngLatOffset, mat4 viewProjectionMatrix) {
    vec2 halfLat = half_latitude_offset(lngLatOffset.y);
    vec2 mercatorOffset = vec2(lngLatOffset.x / 360, mercator_offset_y(halfLat));
    float elevation = terrain_elevation_from_offset(mercatorOffset);
    return project_center_offset(mercatorOffset, lngLatOffset.x, halfLat,
                                 elevation, viewProjectionMatrix);
}

vec4 project_position_to_clipspace_from_offset(
    vec2 lngLatOffset, mat4 viewProjectionMatrix) {
    // Origin of a retained batch minus the center ((0,0) otherwise, and
    // for a row moved on the GPU, whose offset is from the center)
    return project_offset_to_clipspace(lngLatOffset + origin_shift(),
                                       viewProjectionMatrix);
}
```

The elevation of the terrain is in Mercator units. On the globe it is
handed on as maplibre's prelude would take it from
`projectTileWithElevation`, as meters, so the relief barely shows on the
globe; that is how it has always been drawn.

The terrain reads the DEM atlas at the Mercator offset the vertex is
projected from (`terrain_elevation_from_offset`), and the shading of a
fill samples the same offset (`shade_mercator_offset`), so the elevation
a vertex picks up and the elevation the fill reads are always the same.

The projection is the same at every zoom: there is no branch by zoom.
The anchors over terrain are projected on the CPU with the same formula in
64 bits (`clipOfPosition`), so what is drawn and what is hit agree on Web
Mercator, on the globe and in the transition.

Every program reads its textures at highp. GLSL ES 3.00 gives `sampler2D`
no default precision other than lowp, and a lookup returns the precision of
its sampler, which would quantize the coordinates in the line texture and
the elevations of the DEM atlas on GPUs that honour it. `createProgram`
inserts `precision highp sampler2D;` into both stages of every program
(`withSamplerPrecision`), so no shader source can leave it out.

## Renderers

Every renderer that draws geometry takes the same path: it receives the
offset uniforms of the frame through `setOffsetUniforms`, computes relative
coordinates on the CPU, and projects them with
`project_position_to_clipspace_from_offset`.

| Renderer | Draws |
| --- | --- |
| `PointInstanceRenderer` | Points |
| `PointShapeRenderer` | Handles of the selection UI |
| `StrokeRenderer` | Outline of the selection UI |
| `SDFLineRenderer` | LineString, Freehand (via a texture) |
| `PolygonBatchRenderer` | Polygon fills |
| `SDFPolygonRenderer` | Polygon fill and stroke |
| `FillShaderManager` | Fill of a polygon being drawn |
| `QuadShader` | Images |

The uniforms are computed once per frame, from the map center and the
projection data of the frame, and distributed to every renderer
with `ShaderInitializer.applyOffsetUniforms()` (`buildFrameState` in
`src/view/layer/frame-state.ts`). The frame and its batches are described
in [Rendering](./rendering.md).

### Immediate drawing

What is drawn immediately (the selection UI, the polygon being drawn, and
features that cannot be retained) computes its relative coordinates again
every frame, because the screen center moves from frame to frame and an
offset from last frame's center is useless. The triangulation of a polygon
is cached per feature and part, since indices refer to vertices, not to
coordinate values, and stay valid when the center moves.

### The origin of a retained batch

Retained batches (the Store's `src/view/layer/store-retained.ts` and the
datasets in `src/dataset/`) do not recompute offsets every
frame. Each chunk has its own origin, and the coordinates relative to that
origin are baked into the vertex buffer once, independent of the camera.
Only the projection uniforms change per frame.

- A Store chunk takes the center of its extent. Runs are cut in draw order,
  so the contents of a chunk are not necessarily close together in space
- A dataset chunk takes the center of the bounding box of
  its spatial chunk

Both are rounded to Float32. The baked `vertex - origin` and the uniform
`u_origin_shift` (origin minus screen center) are both rounded to 24 bits
and added on the GPU, so a vertex on screen is off by about
`2^-24 x (|vertex - origin| + |origin - center|)`. That error is fixed in
degrees, so it doubles on screen with every zoom level, and the part from
the shift changes as the camera pans. The rule is that the error for the
part of the chunk on screen stays within 0.1 px
(`RETAINED_ORIGIN_TOLERANCE_PX`). When a chunk seen at high zoom far from
its origin would exceed it, the chunk is rebuilt with the center of its
visible region as the origin (`rebasedRetainedOrigin` in
`src/view/shaders/retained-origin.ts`). Below about zoom 16 a chunk several
degrees wide stays within the tolerance, and the origin chosen for the
view is kept across rebuilds caused by data changes.

Rows dragged in bulk are moved on the GPU by the edit of the drag, with the
formulas the edit is written with (`src/view/renderers/row-motion.ts`): the
differences from the place the screen center is moved from (R) are carried
to the differences from where it goes, and the result is the offset of the
position from the screen center, handed to the projection as it is (the
shift is not added and taken away again). A chunk that holds such rows takes
its origin near the region the view sees them from while they are dragged,
so that the baked offsets are small where it matters.

The offsets are taken from the screen center, not from the chunk origin:
the screen-center uniforms of the frame are used as they are, and
`u_origin_shift` is added to the vertex's relative coordinate first. The
formula is exact from any center, but the offsets of what is on screen are
then small, so they keep their precision. In immediate drawing the shift
is (0, 0).

## Globe mode

maplibre's globe projection is supported with the same data.

- When `u_projection_transition` is greater than 0, the map is on the
  globe (or in the transition to it), and the shader takes the offset on
  the unit sphere from sine and cosine of the half offsets and of the
  center, at every zoom; it does not use maplibre's `projectTile`, which
  takes `sin` and `cos` of the absolute longitude
- In the transition, the offsets on the Mercator plane and on the sphere
  are mixed by the transition as maplibre mixes its own layers.
  `map.project` gives the position on the globe alone in the transition,
  so what is drawn lies off it by the difference of the two projections,
  a small fraction of a pixel near the center of the view at the zooms of
  the transition
- The globe uniforms (`u_projection_clipping_plane`,
  `u_projection_transition`, `u_projection_fallback_matrix`, and
  `u_projection_tile_mercator_coords` of the prelude) come from maplibre's
  prelude and are set directly from `ProjectionData`
- The data is the same, but the edges are cut finer on the globe: two
  projected vertices would be joined by a chord through the sphere, so an
  edge is cut along the Mercator plane before it is projected, as maplibre
  cuts its own layers (`shared/math/globe-subdivision.ts`; see
  [Edges on the globe](./rendering.md#edges-on-the-globe)). The points a
  cut adds are computed in 64 bits on the CPU, or, for the stations of a
  line, on the GPU from the Mercator offsets of the ends of the segment
  (see the precision above)

## The precision of the projection

The precision is derived from the bounds of the operations, not measured
on one GPU: a GPU at the limit of the specification may give any result
within them. `src/test-support/glsl-projection.ts` is a copy of the GLSL
on the CPU, operation by operation, that moves each operation by its bound
in the direction that moves the result most (to the first order), and
`src/view/shaders/projection-precision.test.ts` holds it to the reference
position computed in 64 bits with the matrices maplibre builds.

Every operation leaves an error relative to its result, so the error of a
position is a number of roundoffs of a 32-bit float (u = 2^-24) of its
distance from the center:

- the offset rounded to Float32: 1 u; the half offset in radians: 2 u
- the polynomials of sine and cosine: 2 to 3 u each
- `cos m`: 3 u, times at most 3 where its two terms cancel (a midpoint
  latitude near the limit of Web Mercator)
- the division of w: 5 u (2.5 ULP); the series of atanh and the factors:
  4 u
- the log of a large offset: 6 u (3 ULP), and up to 32 times the
  roundoffs of its two sides where one of them is small, that is where a
  position lies near the limit of Web Mercator (85.05 degrees)
- the offset on the sphere: about 8 u; the matrix and the center: 3 u, and
  the center in clip space rounded to Float32 (1 u of the scale of every
  offset)

Added in their worst directions, a position is off by at most about 25 u
of its distance from the center, and 70 u near the limit of Web Mercator.
None of these depend on the zoom: a pixel at zoom 24 is the same number of
roundoffs as a pixel at zoom 0. So on a screen of 1920 x 1080 px:

- a position on the screen (at most about 1,100 px from the center) is off
  by at most 0.0024 px on Web Mercator, flat and tilted, and 0.0061 px on
  the globe and in the transition, at every zoom from 0 to 24
- a point drawn on an edge whose ends lie outside the screen is between
  them, so it is off by at most what they are. An end D px from the center
  is off by at most 70 u D: 0.27 px for ends 2^16 px (65,536 px) from the
  center, 1 px at 2^18 px. The half pixel is held for edges whose ends are
  within 2^16 px of the center; beyond it the error grows with the
  distance of the ends (the Float32 offsets of the ends alone carry 1 u of
  it), and a longer edge on screen at a high zoom is cut finer to stay
  within it
- the points of a line on the globe are mixed on the Mercator plane from
  the Mercator offsets of its ends: for ends 2^16 px apart, 0.12 px

On the WebGL2 of headless Chromium (SwiftShader),
`src/view/shaders/projection-gpu.test.ts` runs the GLSL through transform
feedback and holds it to 64 bits: offsets of 1e-4 to 60 degrees from
centers at latitudes 0 to 80, seen 500 px away, land within 0.00014 px.
The end-to-end tests `src/e2e/projection-mercator.e2e.test.ts` and
`src/e2e/projection-globe.e2e.test.ts` hold what is drawn (fills, lines,
points, images, vertex handles, the frames of features selected together,
over a Store of objects and the Store of rows) to `map.project` within half
a pixel, at zooms 0 to 24 on Web Mercator and on the globe and in the
transition.

GPUs may fuse a multiplication and an addition into one operation, which
rounds once instead of twice and only lessens the error.

maplibre draws its own layers with the trigonometric built-ins
(`projectToSphere` takes `sin` and `cos` of the longitude, and Web
Mercator keeps absolute Mercator coordinates in Float32). On a GPU at the
limit of the specification its base map may therefore lie off what the
library draws, which stays where `map.project` and hit testing put it.

## Pitch and roll

maplibre's projection matrix already contains pitch and roll. Because
features, the selection box and the handles are all defined in
geographic coordinates and projected in the shader, they follow pitch and
roll with no extra work.

The rule that follows is that nothing on the map is drawn in screen
coordinates. A frame or handle laid out in pixels would stay flat while the
map tilts under it; laid out in geographic coordinates, it tilts with the
map. Pixel sizes are honored by converting them to geographic coordinates
around the feature, as in "Coordinate systems" above.

## The selection UI

The selection UI (the frame, the resize handles, the rotate handle, the
vertex and midpoint handles) is drawn with the same architecture:

1. The bounding box is computed in geographic coordinates; for a rotated
   Image it is the oriented box
2. `applyMarginToBoundingBox()` adds the margin, turned into meters with
   the scale of the frame and laid on the ground at the center of the box;
   `computeRotateHandle()` places the rotate handle the same way (the frame
   of a point is drawn on the screen around it, as its marker is)
3. `StrokeRenderer` draws the frame and `PointShapeRenderer` the handles,
   both with relative coordinates computed on the CPU

### Agreement with hit testing

The handles are hit-tested in screen coordinates
(`src/view/ui/handle-test.ts`): each handle position is projected to the
screen and the pointer is compared with the handle rectangle.

The transform on both sides is the same `CoordinateTransform`, built from
the map by `createCoordinateTransform` in `src/shared/math/transform.ts`.
The drawing and the hit test lay out the pixel-sized parts (the margin, the
handle positions) in geographic coordinates with the same functions and
the same scale, the one of the frame drawn last
(`CoordinateTransform.metersPerPixel`, recorded by the frame with
`setScreenScaleFrame`), and the hit test projects those same positions to
the screen. The selection box of a point is tested on the screen around
the projected point, as it is drawn. maplibre's `project()`
runs in 64 bits on the CPU, and the projection of the shader resolves the
same point to well under a pixel, so a handle is hit where it is drawn at
every zoom.

With terrain, `project` goes through the anchor projection of the frame
(`setAnchorProjector`, implemented by `src/view/terrain/anchor.ts`), the
same projection, elevation and matrix the vertex shader uses for points and
handles. The drawn position and the hit region then agree by construction,
and hit testing does not call `map.project` per vertex (which is fast inside
the rendered tiles but slow outside them, where hit testing and bounding
boxes also project; see item 9 of maplibre-coupling.md).

## The antimeridian

The features are stored with longitudes in [-180, 180], and the offset is
the difference from the camera center (`lng - centerLng`), computed in 64
bits on the CPU. A view across the antimeridian is continuous (maplibre
reports it with unwrapped longitudes, 170 to 190 for example), so it shows
two copies of the world: the stored copy, and the copy moved by 360 degrees
that shows the stored longitudes on the other side of the line.

### Drawing

Each frame draws one pass per copy in view (`splitLongitudeCopies` in
`src/view/viewport.ts`). Away from the line that is the stored copy alone.
Across it, the features of the other side are drawn a second time through a
virtual camera:

- The center moves by `-lngShift` (179.95 becomes -180.05), so every offset
  the CPU computes against it comes out next to the camera: a point stored
  at -179.9 gets an offset of 0.15, not -359.85
- The matrix moves by `+lngShift` (`M' = M * T(lngShift / 360)` in Mercator
  units, `translateMatrixByLongitude` in `src/view/shaders/helpers.ts`), so
  the two cancel for the camera: `calculateOffsetUniforms` gives the same
  projection center
- The DEM atlas is handed to the shader in the frame of that camera

The CPU and the GPU use the same formula, and the shift is a whole number
of turns added in 64 bits, so no precision is lost. Each copy draws the
part of the view it shows (its range thins the chunks and the features), so
a feature is drawn once, on the copy the view shows it on. The selection UI
and the overlays are drawn per copy as well.

The offset is not normalized vertex by vertex into ±180. That would tear
every feature that straddles the meridian opposite the camera: its vertices
would land on both ends of the range, and the edges between them would run
across the whole view. A copy moves every vertex of a feature by the same
turn.

The world copies that maplibre renders at low zoom (`renderWorldCopies`)
are not replicated: when the view is 360 degrees wide or more, a feature is
drawn once, on the stored copy.

### Hit testing, handles and snapping

The pointer unprojects to the unwrapped longitude of the view (above 180 on
the copy east of the line), and every test must meet the copy drawn under
it. The alignment is made in the local frame of each test, around the
pointer:

- `HitTestService` and the unified z traversal test the click on each copy
  of the world it can reach (`clickCopies` in
  `src/dispatcher/hit-test/local-frame.ts`): the click brought into
  [-180, 180], plus the click on the neighbouring copy when its reach runs
  past ±180. A feature hit on several copies counts with its nearest
  distance
- The handle test projects every longitude on its copy nearest to the
  pointer (`alignToPointer` in `src/view/ui/handle-test.ts`), and its
  pre-filtering rectangle compares in the same frame. With terrain, the
  anchor projection (`src/view/terrain/anchor.ts`) takes the copy nearest
  to the camera, which is the copy the anchor is drawn on
- Snapping looks candidates up around the cursor brought into [-180, 180]
  (and on the neighbouring copy) and takes each candidate on its copy
  nearest to the cursor, so the snapped position is in the frame of the
  cursor while the target keeps its stored coordinates
  (`src/snapping/service.ts`)

Away from the antimeridian nothing moves. When the view is 360 degrees wide
or more, a click on an undrawn world copy still reaches the feature stored
under it. Box selection queries the unwrapped rectangle as it is, so a box
across the line does not select the features of the other side.

### What the input stores

The InputRouter is the one entry for coordinates. It brings the longitude
of every event onto the stored copy before snapping and before a mode sees
it (`toStoredCopy` in `src/dispatcher/input-router.ts`):

- A click, a move or a press lands in [-180, 180], the same point
  `clickCopies` starts from
- While a shape is being drawn, the pointer goes to the copy nearest to the
  first vertex of the shape, so a line drawn from 170 to 190 stays 170,
  190 rather than running the other way round the world
- A drag moves all its events by the one shift decided where it started

Input fed straight to the InputRouter (`dispatch`, which the tests use)
takes the same path, so what a mode stores never carries the longitude
of a world copy. A feature drawn across the line can carry longitudes a
little beyond ±180, which the rendering draws on the copy that shows
them. GeoJSON export brings them back into
[-180, 180] position by position, without cutting the geometry at the line
(see [Data format](../reference/data-format.md)).

## Troubleshooting

### Features tremble

- Check that the offset uniforms of the frame reach the renderer
  (`setOffsetUniforms`)
- Check that `u_center_sine_cosine` and `u_projection_center` are written
  from the uniforms of the same center as `u_center_lnglat`
- Check that the renderer computes relative coordinates with
  `calculateLngLatOffset` on the CPU rather than sending absolute ones
- For a retained batch, check that `u_origin_shift` is the origin minus
  the screen center of this frame

### Features are missing or far off

- A renderer whose offset uniforms are not set falls back to a center of
  (0, 0), and a center that differs from the real viewport center
  displaces the drawing by the difference

### The display is wrong in globe mode

- Check that `u_projection_transition` is set from the projection data,
  and that the program was compiled with the `#define` of the globe
  variant (the globe branch of `project_center_offset` is compiled only
  there)
- Check that the center in clip space was computed with the projection
  data of the frame, its fallback matrix and its transition, and on the
  globe with the matrix in 64 bits
- An edge that cuts across the sphere instead of following its parallel or
  meridian was drawn without the cut of the globe: check that the renderer
  takes its step from `getSurfaceTessellationStep` and that the terrain
  context has the cells of the frame (`updateGlobeSubdivision`)

### The selection UI does not line up

- Check that the drawing and the hit test build their transform the same
  way (`createCoordinateTransform`), so both go through the anchor
  projection when terrain is on
- Check that pixel-sized parts are converted to geographic coordinates
  before they are drawn, not drawn in screen coordinates
