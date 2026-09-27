# Hit testing

This document describes how the library decides what a pointer is on:
which feature a click selects, which handle a drag grabs, which
dataset receives a `click` or `hover` event, and what the
cursor shows.

The library draws everything in one maplibre custom layer with its own
WebGL2 renderers, so maplibre's `queryRenderedFeatures` knows nothing about
these features. Hit testing is therefore implemented from scratch, as a
two-stage test: an rbush spatial index narrows the candidates, and a
per-type strategy makes the precise decision.

The types, interfaces and options named here (`HitTestStrategy`,
`HitTestService`, `HitTestOptions` and so on) are documented one by one in
the [generated API reference](../api/index.md). How a custom
feature type registers its own strategy is described in
[Custom feature types](../guides/custom-types.md). This document explains
the design behind them.

## The rule: the frontmost visible thing receives the event

What receives a click is the single frontmost thing among those that are
visible. It does not matter whether that is a feature of the Store (an
editing target) or a feature of a dataset (data).

- What blocks is exactly what is seen. A polygon blocks with its fill, the
  inside of a hole lets the click through, and a line blocks with its line
  width plus the tolerance radius
- Nothing is see-through. A dataset with `interactive: false` still
  blocks what is behind it; it only does not fire events
- The visual stacking order is the only order. Distance never decides
  between two things that are both hit

The reason is that the order in which things are seen and the order in
which they can be grabbed must agree. If the nearest hit won instead, a
point hidden behind a polygon could be clicked through the polygon, and
the user could press something they cannot see.

## The unified z traversal

The entry point is `createTopmostHitTester` in
`src/dispatcher/hit-test/topmost.ts`. It builds the function that the
select mode calls as `hitTestTopmost`:

```typescript
type TopHit =
  | { kind: 'store'; feature: Feature }
  | {
      kind: 'dataset';
      dataset: Dataset;
      feature: Feature | null;
    }
  | { kind: 'companion'; companion: FeatureCompanionHitResult };

type HitTestTopmost = (
  point: ScreenPoint,
  options?: { orderedFeatures?: Feature[] },
) => TopHit | null;
```

### Traversal order

The traversal walks from the front to the back:

1. The datasets on the `above-store` side, from the front
2. The stacking order (`store.getLayerOrder()`) from its end, which is the
   front. When an entry is a layer, the features of that layer are tested
   from the front. When it is a dataset with `order: 'layer-order'`,
   that dataset is tested. An ID that is neither is skipped
3. The datasets on the `below-store` side, from the front

The first hit ends the traversal. The Store side is hit-tested once per
call, at the moment the first layer entry is met; its hits are then looked
up layer by layer in stacking order.

### What decides a hit

- Only the boolean `test()` of each strategy is used. `distance()` plays no
  part in the arbitration between layers or between entries. A strategy
  may still use a distance internally, for example to pick the nearest
  part of a Multi feature
- Visibility is decided by the `visible` flag of the feature, the layer and
  the group, and by local hiding (what this client alone has hidden). The
  result of viewport thinning is not used: thinning in the rendering is an
  optimization and has no meaning for the test
- A dataset with `interactive: false` returns
  `{ kind: 'dataset', feature: null }`. It blocks, but neither `click`
  nor `hover` fires

### The fast path without datasets

When not a single visible dataset exists
(`DatasetManager.hasAny()` is false), the traversal is skipped
and only the Store is examined with `HitTestService.hitTest()`. A map
without datasets pays nothing extra on every `mousemove`, and the
spatial index is queried once.

### Companions

A feature can have companions: things drawn with it and grabbed with it,
supplied by a provider added through
`draw.extensions.companionProviders` (`src/view/feature-companion.ts`).
A companion is drawn one z step below its feature, so the traversal asks
the companions of a feature right after the test of the feature itself
fails, and before it moves on to the next feature behind. The order in
which things are seen and the order in which they can be grabbed agree
here as well.

- The companions of a feature that is not visible are not asked. The
  visibility rule is the same as for the feature itself
- A companion decides a hit by its appearance in screen pixels, so the
  test needs `project` and the zoom. Without them the companion test is
  not performed
- When no provider is registered at all, the detour never happens. This is
  an O(1) check at the entry of the traversal, so the cost and the path of
  the plain traversal do not change

### What the select mode does with the result

The select mode (`src/modes/select/click-handler.ts`, `mode.ts` and
`cursor-handler.ts`) goes through `hitTestTopmost` rather than calling
`HitTestService.hitTest` directly. Selection, the start of a drag and the
cursor all use the same entry point.

- `store`: the click selects the feature, a drag starts on it, and the
  cursor follows the handle or the move area under the pointer
- `dataset`: no Store feature is grabbed. The click clears the
  selection and is left to the dataset's `click` event (only when it
  is interactive). No drag starts, so `dragPan` stays alive. The cursor is
  `pointer` if the dataset is interactive, and the default otherwise
- `companion`: the click is consumed and handed to the companion's
  provider, and the selection does not change
- `null`: nothing is there. The click clears the selection

A `companion` hit does not even clear the selection the way a click on
empty space would. The core does not know what a companion is, so its job
ends at consuming the click and reporting it. The interception of
datasets (`src/dataset/interaction.ts`) does nothing for a
`companion` or `store` result either: neither the dataset's `click` nor
a no-hit notification is emitted.

### Separators between custom layers

When the host splits the drawing into several custom layers placed between
its own maplibre layers, the unified traversal still knows nothing about
the separators. The host compares the draw hit with the result of
`queryRenderedFeatures` by their positions in the respective stacking
orders and takes the one in front. A draw hit carries the layer ID, and its
position is found with `getLayerOrder()`, so no extra API is needed. The
separators themselves are described in [Rendering](./rendering.md).

### Order inside a dataset

Rendering inside a dataset is bundled per chunk as polygons, then
lines, then points, so it does not keep the exact insertion order. Hit
testing judges the candidates of the dataset's spatial index from the
back of the insertion order. The two can disagree only between features of
one dataset, and this is accepted.

## The two-stage hit test on the Store

`HitTestServiceImpl` (`src/dispatcher/hit-test/service.ts`) combines the
two stages for the Store features.

```text
click + tolerance -> search rectangle -> rbush -> candidate IDs
candidate features -> per-type strategy -> hits (with distances)
```

### Stage 1: narrowing the candidates

The click is unprojected, the tolerance is converted into degrees (see
"Tolerance and the local frame"), and the spatial index returns the IDs
whose bounding boxes touch the square of that radius around the click.
Only visible features among `orderedFeatures` are kept.

### Additional reach for the candidates

The search radius is by default the equivalent of `clickTolerance`
(6 px). A type whose strategy treats a wider area as a hit (a point drawn
with a large icon, for instance) would drop out of the candidates before
it ever reached the precise test.

A type can therefore register, in CSS pixels, how far from its indexed
extent a hit is possible: `hitPaddingPx` of a `FeatureTypeDefinition`,
which reaches `HitTestService.registerCandidateReach`. The value may be a
function when it changes with the zoom or with settings; it is evaluated
on every query. With registrations in place the radius grows by the
largest one:

```text
search radius = toleranceLngLat + max(registered reach) x (degrees per pixel)
```

The degrees per pixel are `toleranceLngLat / clickTolerance`, so no extra
`unproject` call is made. With no registration the radius is exactly
`toleranceLngLat`.

Only the candidate set grows. The tolerance handed to the second stage is
still `toleranceLngLat`, and whether something is a hit is still decided by
the strategy. A few more candidates are cheap, so the search is done once
with the maximum rather than per type.

The design deliberately does not bake the appearance into the bounding
boxes of the index. A bounding box is computed only when a feature is
inserted or updated, so a baked appearance would drift away from what is
drawn as soon as a style or the zoom changed, and interaction would depend
on the past. Growing the radius at query time depends on neither.

### Stage 2: the precise test

Each candidate is tested with the strategy registered for its type. When
the strategy has `testDistance`, the test and the distance are computed in
one traversal; otherwise `test()` is followed by `distance()`.
`testDistance` returns `null` exactly when `test()` would be false, and
otherwise the same value as `distance()`.

`hitTestAll()` returns every hit sorted by distance. `hitTest()` does not
look at that distance: it walks `orderedFeatures` from the end (the front)
and returns the first feature that was hit. So on the Store alone:

- A point on top of a polygon wins only when the point is in front; a
  point behind a polygon is blocked by it
- A polygon in front blocks points, lines and polygons behind it
- The inside of a hole is not a hit, so the click falls through to the
  feature behind

### The shape tested on the globe

The strategies take an edge as the straight line between its vertices in
degrees. On the globe an edge is drawn along the straight line of the
Mercator plane carried onto the sphere (see
[Edges on the globe](./rendering.md#edges-on-the-globe)), which leaves the
straight line in degrees on a long edge that is neither a parallel nor a
meridian: at longitude 0 an edge from (-60, 0) to (60, 50) is drawn at
latitude 27.8, not 25.

So the precise test is given the shape the feature is drawn with. The
`drawnShape` option of `HitTestServiceImpl` reshapes a candidate before its
strategy sees it, in `hitTestAll()` and in `hitTestFeature()` (the path the
datasets take), and the result keeps the stored feature.
The draw instance passes `createGlobeShapeResolver(map)`
(`src/dispatcher/hit-test/globe-shape.ts`):

- On a map set to the globe projection (`map.getProjection()`), the lines
  and the rings of LineString, Freehand, Polygon, MultiLineString and
  MultiPolygon are cut along the Mercator plane with the line cell of the
  rendering at the current zoom. Between two close points the two straight
  lines agree, so what can be clicked is what is drawn. Points, circles and
  images keep their shape
- The last cut of each feature object is kept for its cell (a `WeakMap`),
  so hover does not cut the same features again on every move of the
  pointer
- On a Mercator map the resolver returns the feature itself: hit testing
  is unchanged
- An image keeps its own test, the rectangle rotated in degrees scaled by
  cos φ. Its corners are the corners of the drawn image, and an edge along
  a parallel or a meridian is the drawn edge exactly; a slanted edge of a
  rotated image stays within a fraction of a pixel of it

## Tolerance and the local frame

`clickTolerance` is a screen length. The same pixel distance from a
feature must give the same decision whatever the bearing, the pitch or the
latitude. Coordinates are longitude and latitude, so the decision is made
in the local frame of hit testing (`src/dispatcher/hit-test/local-frame.ts`),
in which one unit is the same screen length in every direction.

- The tolerance `toleranceLngLat` is the ground length of `clickTolerance`
  pixels along the screen x axis, measured with `unproject` and expressed
  in degrees of longitude at the click latitude (`toleranceDegrees`). The
  length of a displacement does not change when the map is turned, so it
  does not depend on the bearing, and the screen x axis is never
  foreshortened by pitch
- Distances are measured in the same unit. Near a latitude φ, one degree of
  latitude is 1 / cos φ times longer on screen than one degree of
  longitude (Web Mercator), so latitude differences are divided by cos φ of
  the click latitude (`localDistance`, `localPointToSegmentDistance`,
  `localPointToPolylineDistance`). The inside test of a polygon is not
  affected, because the frame only scales the latitude axis
- A custom strategy receives the tolerance in the same unit. To compare a
  latitude difference, multiply the tolerance by cos φ, as the image test
  does

The unified z traversal hands the same `toleranceDegrees` to the
datasets. Snapping converts pixels with `degreesPerPixel`
from the zoom and the latitude, which is also independent of the bearing
and isotropic.

## Component structure

```text
┌──────────────────────────────────────────────────────┐
│                   HitTestService                     │
│  ┌────────────────────────────────────────────────┐  │
│  │  SpatialIndex (StoreSpatialIndex over rbush)   │  │
│  │  derived from the Store; findNear/findInBounds │  │
│  └────────────────────────────────────────────────┘  │
│  ┌────────────────────────────────────────────────┐  │
│  │  HitTestStrategyRegistry                       │  │
│  │  built in: Point, LineString, Polygon, Circle, │  │
│  │    MultiPoint, MultiLineString, MultiPolygon,  │  │
│  │    Freehand (LineString strategy), Image       │  │
│  │  added: strategies of custom feature types     │  │
│  └────────────────────────────────────────────────┘  │
│  candidate reach per type                            │
│  anchor screen projector (terrain)                   │
└──────────────────────────────────────────────────────┘
```

The handles of the selection UI are not part of `HitTestService`; they are
tested in screen space by `src/view/ui/handle-test.ts` (see "Handles").

## The spatial index

The spatial index wraps rbush (`src/store/spatial/`). Hit testing, box
selection, snapping, tracing and the viewport filter all read it, and they
see only its query side, `findNear(coordinate, tolerance)` and
`findInBounds(bounds)`.

`RBushSpatialIndex` (`src/store/spatial/spatial-index.ts`) holds the tree
and one item per feature ID, and has the writes (`insert`, `update`,
`remove`, `clear`, and `load` for a bulk load). `StoreSpatialIndex`
(`src/store/spatial/store-spatial-index.ts`) wraps it, and only its Store
subscription writes to it.

### A value derived from the Store

`StoreSpatialIndex` subscribes to the Store when the draw instance is
created, before any other subscriber, so a listener that queries the index
during a notification already sees the change. It loads what the Store
already holds, and for every feature a `StoreChange` names in
`features.created`, `updated` or `deleted` it re-derives the entry from the
Store: a feature that is present is measured again, an absent one is
dropped. Because the final state is read from the Store, the order of the
entries within one notification does not matter.

- Every write path reaches the index the same way: the public API, the
  drawing modes, a drag, the Delete key, import, plugins, a mode added by
  an extension, and a change applied to a replaced Store from outside. No
  write path updates the index by hand
- A write the read-only Store refuses notifies nothing, so it leaves no
  trace in the index
- An update of the properties or the style (the radius of a Circle, the
  scale and rotation of an Image) re-measures the feature like an update
  of the coordinates
- The intermediate updates of a drag (`isIntermediate`) are Store updates,
  so the index follows the shape being dragged. The tentative geometry of a
  drawing mode is not a feature and is not indexed
- A type added with `draw.extensions.featureTypes` is measured with the
  `getBoundingBox` of its engine handler, and adding it re-measures the
  features of that type. When its extent changes for a reason the Store
  does not see (a font that arrives later, for example), the extension
  calls `ctx.invalidate({ type })`, which reaches `invalidateType(type)`
- `setTileSize()` re-derives every feature, since the extent of an Image
  depends on the tile size
- `destroy()` of the draw instance stops the subscription and empties the
  index

### Bounding boxes

The extent of a feature comes from the custom calculator of its type when
there is one, and otherwise from `getBoundingBox(feature, tileSize)` in
`src/shared/utils/feature-bbox.ts`:

- Image: the display size (the style size, else the stored image size,
  else 100 px, times `scale`) at `createdZoom` converted to degrees at the
  tile size, then the bounding box of the four corners after rotation
- Circle: the center plus the radius in meters converted to degrees of
  latitude and of longitude at the center latitude (a point when the
  radius is missing)
- Point: the point itself
- LineString, Freehand, Polygon and the Multi types: the minimum and
  maximum over every coordinate. The result is cached in a `WeakMap` keyed
  by the coordinate array, which is valid because coordinates are replaced,
  never rewritten in place
- Empty coordinates and unknown types: the origin

## Strategies per type

The built-in strategies live in `src/dispatcher/hit-test/strategies/`.
`HitTestServiceImpl` registers them in its constructor. Distances are
measured in the local frame, and Freehand is registered with the
LineString strategy.

### Point

A Point is hit when the local distance from the click to the point is
within `toleranceLngLat`. The distance is that same local distance.

The index holds a Point as the point itself, and the strategy looks only
at the anchor. A point type whose drawn footprint is larger than the
tolerance circle (an icon, a label beside it) extends both stages. It
registers `candidateReachPx` so that the first stage keeps it as a
candidate from as far away as its footprint reaches, and a strategy that
tests the footprint itself. Testing the icon and the label as two separate
rectangles, rather than one rectangle around both, keeps the empty space
beside a narrow icon from answering clicks.

### LineString and Freehand

A line is hit when the distance from the click to the polyline is within
the tolerance. `testDistance` computes it in one pass with
`polylineDistanceWithin`: a full scan for ordinary lines, the segment grid
for lines with many vertices (see "A segment index for many vertices").

### Polygon

The per-ring methods take an array of rings, so MultiPolygon reuses them
for each part.

1. Inside test by ray casting over every ring: inside the outer ring and
   not inside any hole. Inside gives distance 0
2. Otherwise the distance to the edges, ring by ring (the segment grid
   above the threshold). Within the tolerance it is a hit with that
   distance

The inside of a hole is therefore a miss unless the click is within the
tolerance of the hole's edge.

### The Multi types

The Multi types have no test logic of their own. Under the rules "a hit on
any part is a hit" and "the distance is the minimum over the parts", they
reuse the single-geometry test per part (`multi.ts`).

| Feature type | Unit of a part | Test reused |
| --- | --- | --- |
| MultiPoint | One coordinate | Local distance between two points |
| MultiLineString | One polyline | Distance from a point to a polyline |
| MultiPolygon | One array of rings | Per-ring methods of Polygon |

A part of a MultiPolygon is an array of rings, so, as with Polygon, the
inside of a hole is a miss.

### Circle

A Circle is hit when the great-circle distance from the click to the
center is at most the radius plus the tolerance. The tolerance is
converted to meters at the center latitude and is never less than 10 m.
The distance is the absolute distance from the circumference, inside or
outside. A Circle without a positive radius is never hit.

### Image

An Image is tested against its oriented bounding box (OBB). Its size is its
pixel size at `createdZoom` (the same computation as `ImageRenderer`), so
the strategy depends on the tile size and is told about changes through
`setTileSize`. The distance is an OBB approximation and is only used for
ordering in `hitTestAll()`.

### Rotation and the latitude correction

A rotated rectangle (an Image, or a rotated custom type) has to be rotated
and tested in latitude-normalized space in order to agree with the
rectangle that is drawn.

One degree of longitude is shorter on the ground at higher latitudes. The
drawing side (`computeQuadVertices` in `src/view/shaders/quad.ts` and the
like) rotates in an isotropic space in which the longitude direction is
multiplied by cos(latitude), and then converts back. A hit test that
rotated the click in raw degree space would shear relative to the drawn
rectangle: parts inside the outline could not be clicked and parts outside
it would respond, more so at higher latitudes.

The test takes three steps:

1. Multiply the longitude difference between the click and the center by
   cos(latitude)
2. Apply the inverse of the rotation in that normalized space
3. Compare with the normalized half width (half width in degrees x
   cos(latitude)) and half height, each widened by the normalized
   tolerance

The result agrees with the drawn rectangle.

## A segment index for many vertices

`src/shared/math/segment-grid.ts` is a static grid index used when one
part (one line or one ring) has at least `SEGMENT_INDEX_THRESHOLD` (1,024)
vertices. The distance queries that hit testing runs on it are in
`src/dispatcher/hit-test/segment-grid.ts`. Segments are registered into a
uniform grid whose size is on the order of the square root of the segment
count, and a query computes distances only for the segments in the cells
that the rectangle of the cursor plus the tolerance touches. For a line of
100,000 vertices this turns a full scan of a couple of milliseconds into a
query of microseconds.

The cache is a `WeakMap` keyed by the coordinate array and has no explicit
invalidation. Coordinates are updated immutably (a change replaces the
array), so the index is valid as long as the reference is the same; when
the coordinates change, the key is replaced with them and the old index is
collected. Line, Polygon (edge distance only; the ray casting of the inside
test is still a full traversal) and the Multi types use it from
`testDistance`.

The snapping providers (`src/snapping/providers/`) reuse the same index to
enumerate only the vertices and segments that touch a bounding box
(`collectVertexCandidatesInBBox`, `collectFeatureSegmentsInBBox`). Parts
below the threshold are enumerated in full.

## Handles

Hits on the handles of the selection UI are not returned by
`HitTestService`. They are tested in screen coordinates by
`hitTestHandles()` in `src/view/ui/handle-test.ts`: each handle position is
projected with the same transform the selection UI is drawn with, and the
pointer is compared with the handle rectangle. The result is a
`HandleHitResult`, whose `type` is one of `rotate`, `resize`, `vertex`,
`midpoint`, `move`, `radius` or `auxiliary`.

A vertex is pointed to by a `VertexRef` (`{ part?, ring, index }`). For a
Polygon, ring 0 is the outer ring and 1 onward are the holes; `part` is the
part number of a Multi type and means 0 when omitted.

The midpoint handle of an edge lies on the edge as drawn, halfway across in
longitude (`mercatorMidpoint`): the average of the latitudes in degrees
lies off a long slanted edge. An edge along a meridian or a parallel keeps
the plain average. The drawing and the test resolve the position with the
same function (`computeMidpointHandles`, `resolveMidpointCoordinate`). The
rotation handle stands on the midpoint of the top edge of the frame found
the same way (`computeRotateHandle`).

### Priority of the handles

`hitTestHandles()` tests in this order, and the first hit wins:

1. The rotate handle (for a Circle, the radius handle instead)
2. The resize handles (the four corners plus additional handles)
3. Auxiliary handles (single selection only)
4. Vertex handles (single selection only)
5. Midpoint handles (single selection only)
6. The inside of the bounding box (move)

Handle positions are enumerated by `computeVertexHandles()` and
`computeMidpointHandles()` in `src/view/ui/handles.ts`. They walk every
ring of a Polygon and every part of a Multi type, so the vertices of holes
and of each part can be selected, moved and deleted too.

When the handles of a feature with many vertices are thinned by screen
density, the test is limited to the handles currently displayed: what can
be seen is what can be operated.

### Auxiliary handles

Auxiliary handles let an extension put out handles that are neither
vertices nor resize handles (`src/view/ui/auxiliary-handles.ts`,
added through `draw.extensions.handleProviders`). They use the
same screen rectangle test as the other handles, sized like the vertex
handles. When one overlaps a vertex or a midpoint, the auxiliary handle
wins; moving it aside and then grabbing the vertex is enough. With no
provider registered, the test is skipped.

Some auxiliary handles do not depend on the selection
(`getGlobalHandles`). They appear even when nothing is selected, so they
cannot be part of `hitTestHandles()`, which presupposes a selection. A
separate entry point, `hitTestGlobalAuxiliaryHandles()`, runs after the
selection handles and before the unified z traversal. The test size, the
cursor and the shape of the result are the same as for auxiliary handles
of a selection, and a drag goes through the same `auxiliary` path. The
only difference is that there is no owning feature, which is expressed by
`auxiliary.global` and an empty `featureId`.

### Frame of a zero-area selection

When the bounding box of a single selection has zero area (a Point, a
MultiPoint with one point), no rotate or resize handles are shown and the
whole inside of the frame means move. The size of that frame can be
registered per type (`getPointFrameExtent` of the engine handler of the type,
resolved by `resolvePointFrameExtent()` of the instance's
`SelectionExtensionRegistry` in
`src/view/ui/selection-ui/extension-registry.ts`). An unregistered type
gets a 12 px square.

The size is consumed in three places, all through the same resolution
function, so they cannot disagree: drawing the selection box
(`src/view/ui/selection-ui/renderer.ts`), the move test and the combined
bounding box (`src/view/ui/bounds.ts`), and drawing the combined bounding
box of a multiple selection.

### The whole pointer resolution of the select mode

1. The handles of the selected features (`hitTestHandles()`)
2. Auxiliary handles that do not depend on the selection
   (`hitTestGlobalAuxiliaryHandles()`)
3. The unified z traversal (`hitTestTopmost()`: features, companions and
   datasets)

## Locked and hidden features

Click selection and box selection treat locking and hiding differently, on
purpose.

Locking forbids operations, not selection or display. When a feature, its
group or its layer is locked, the feature can no longer be moved, resized,
rotated, vertex-edited or deleted, but it can still be selected by
clicking; only its operation handles disappear. A lock is inherited top
down (layer, then group, then feature). The effective lock is decided by
`isFeatureLocked` and `isGroupLocked` in `src/store/lock.ts`.

### Click selection

`HitTestService.hitTestAll` removes only hidden features (`visible: false`
on the feature, its layer or its group, or hidden locally). Locked features
are drawn and can be selected, so they stay among the candidates.

The visibility lookup is built once per test with `createVisibilityLookup`
(`src/dispatcher/hit-test/visibility-lookup.ts`). It reads each layer and
group once per container and applies the result to the features. Calling
`store.getLayer()` per feature would make one test O(N²) on a Store whose
layer reads cost O(N) (a replaced Store that copies its order array on
every read, for example), which stalls every `mousemove` on a few thousand
points. The lookup is not kept between tests, so the next test always sees
the current Store. The companion visibility in the unified traversal uses
the same lookup.

### Box selection

`queryFeaturesInBox` in `src/modes/select/box-selection.ts` excludes locked
features, groups and layers in addition to hidden ones. A box selection is
usually the start of moving or transforming several features at once, and
a locked feature swept into it would be "selected but not operable", so,
unlike a click, it is left out.

```typescript
for (const id of candidateIds) {
  const feature = store.getFeature(id);
  if (!feature) continue;
  if (!feature.visible || feature.locked) continue;
  if (isLocallyHidden(feature, store)) continue;

  const layer = store.getLayer(feature.layerId);
  if (layer && (!layer.visible || layer.locked)) continue;

  if (feature.groupId) {
    const group = store.getGroup(feature.groupId);
    if (group && (!group.visible || group.locked)) continue;
  }

  if (isFeatureInBox(feature, rect, boxSelectionRegistry)) {
    hitIds.push(feature.id);
  }
}
```

The intersection test per type is a `BoxSelectionStrategy`
(`src/dispatcher/hit-test/box-strategy.ts`), with the built-in ones in
`box-strategies.ts`.

## Datasets

Datasets (`src/dataset/`) do not enter the Store, so they
never reach `HitTestService` through the index above. They are hit-tested
where input is dispatched: the InputRouter intercepts the click and the
`mousemove` and asks the unified z traversal.

- When not a single dataset is visible, the interception returns at
  once and the traversal is not performed
- The event fires only when the frontmost hit is a dataset. It does not
  fire when a Store feature is in front. A `below-store` dataset is
  blocked by the Store features above it, while a dataset on the
  `above-store` side, or in front within the stacking order, wins over the
  Store features behind it
- A dataset with `interactive: false` blocks hits but fires nothing
- Among datasets, front and back are the reverse of the draw order.
  `above-store` is in front of `below-store`, and a `layer-order`
  dataset is where its entry sits in the stacking order. On the same
  side a dataset added later is in front, and within a dataset a
  feature later in the array is in front
- Candidates come from the spatial index of each dataset (a static
  R-tree over the bboxes of its rows, packed into typed arrays:
  `table/packed-rtree.ts`), and the precise test borrows
  `HitTestService.hitTestFeature()`. The test is the same as for Store
  features, including the Multi types and holes. A dataset given as a
  table builds the features of the candidate rows only, and the
  hit carries the row as well as the feature
- A hit shows no selection UI and does not change the Store selection. It
  only fires the `click` and `hover` events

## Symbols on terrain

On a map with terrain enabled (`map.setTerrain()`), symbols are tested in
screen space.

Points and vertex handles are drawn without a depth test, so they stay
visible behind a ridge (as faint ghosts; `src/view/terrain/occlusion.ts`)
and can still be selected. On the usual path, "click, terrain-aware
unproject, longitude and latitude, spatial index", the line of sight lands
on the terrain in front, so a click at the visible position could never
hit such a point. Even on an unoccluded slope the landing point shifts and
the effective radius shrinks.

Symbols therefore project their anchors into screen coordinates with the
same projection the drawing uses, and compare them directly with the
screen position of the click. No geographic search is involved.

- The injection point is the `anchorScreen` option of
  `HitTestServiceImpl` (an `AnchorScreenProjector`). Its implementation is
  the anchor projection of the drawing side (`projectAnchor` in
  `src/view/terrain/anchor.ts`), so the drawn position and the hit test
  share one computation
- Only `Point` and `MultiPoint` are tested this way. Polygons, lines,
  circles and images are draped onto the ground and are occluded correctly
  by depth, so the geographic path is right for them
- The reach in pixels is the click tolerance plus the registered candidate
  reach of the type. Occluded points are candidates too, since they are
  visible
- While the projector returns null (terrain disabled, no frame yet), the
  whole path falls back to the geographic one. Hit testing without terrain
  is unchanged
- Vertex handles already share the anchor of the selection UI drawing, so
  they need no special path

## Relationship with snapping

Snapping (`src/snapping/`) is a separate path, but it narrows its
candidates with the same spatial index.

- Vertex candidates share the handle computation of the selection UI
  (`computeVertexHandles`), so the vertices of holes and of the parts of
  Multi types are candidates as they are
- Edge candidates are the segments of LineString, Polygon (holes
  included), MultiLineString and MultiPolygon. Point, Circle, Image and
  Freehand have no snapping edges
- Hidden features, whether by the shared `visible` flags or by local
  hiding, are not candidates

How the pointer, the handles and the snapping candidates meet the right
copy of the world near the antimeridian is described in
[Coordinate precision](./coordinate-precision.md#the-antimeridian).

## Performance considerations

- Viewport filtering belongs to the rendering (`ViewportFilter` in
  `src/view/viewport.ts`). Hit testing searches the whole index, since a
  click is always inside the view
- A bulk creation is loaded into rbush in one pass
  (`RBushSpatialIndex.load`), both when the index is built from a Store
  that already holds features and when one notification creates many
- Lines and rings with many vertices are tested through the segment index
- The visibility of layers and groups is looked up once per container and
  per test
- Without datasets and without companion providers, a
  `mousemove` costs one index query and one pass of the strategies over
  the candidates
