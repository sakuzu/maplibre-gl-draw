# Snapping and geometry

This guide covers the tools that make drawn shapes fit together:
snapping to vertices, edges, intersections and guide lines, tracing the
boundary of an existing feature, moving shared vertices together, and the
operations that combine and split features (union, subtract, intersect,
split, buffer). It ends with the geometry entry, a set of functions that
measure and combine shapes without a map, also outside the browser.

## Minimal code

<!-- docs-check:
declare const statusBar: HTMLElement;
declare const parcelA: string;
declare const parcelB: string;
-->

```ts
import { createDraw } from '@sakuzu/maplibre-gl-draw';

const draw = createDraw(map, {
  snapping: { tolerancePx: 12 },
  topology: { sharedVertexDrag: true },
});

draw.on('snap.changed', ({ result }) => {
  statusBar.textContent = result?.target?.kind ?? '';
});

// Merge two areas into one feature
// The new feature, or null when the change is refused
const merged = draw.features.union([parcelA, parcelB]);
```

## Snapping

While drawing and while dragging a vertex, the pointer snaps to what is
near it. Snapping happens where the input enters the library, so it works
the same in every drawing mode, in vertex drags and in the modes you add.

It is on by default:

| `snapping` | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | snapping on or off |
| `tolerancePx` | `10` | how near, in screen pixels |
| `disableKey` | `'alt'` | held, it stops snapping |
| `kinds` | all `true` | on or off per kind |
| `datasets` | `true` | snap to the rows of datasets too |
| `guideStepDegrees` | `45` | step angle of the north-based guides |

`disableKey` is `'alt'`, `'shift'`, `'ctrl'`, `'meta'` or `'none'`. While
the key is held nothing snaps, so a single point can be placed at its
plain position. The tolerance is the same distance on screen in every
direction and at every latitude.

The same settings change while the instance runs, through
`draw.options`. Only the keys you give change:

```ts
draw.options.update({ snapping: { enabled: false } });
draw.options.update({ snapping: { kinds: { guide: false } } });
draw.options.update({ snapping: { datasets: false, guideStepDegrees: 15 } });
draw.options.get().snapping; // the current settings
```

A value of the wrong type, such as a step angle of 0 or less, throws a
`DrawError` with the code `invalid-input` and changes nothing.

### What it snaps to

| Kind | Candidates |
| --- | --- |
| `vertex` | every vertex of points, lines and areas, holes and parts too |
| `intersection` | where edges of two different features cross |
| `edge` | the nearest point on an edge of a line or area |
| `guide` | guide lines from the last placed vertex while drawing |

When several are in reach, the kind decides (vertex, then intersection,
then edge, then guide), and among the same kind the nearest wins.

- `Circle`, `Image` and `Freehand` are not snapped to
- Hidden features are not snapped to, whether the document hides them or
  only this client does
- The shape being drawn is not a feature yet and is not snapped to
- A dragged vertex does not snap to itself or its own edges, but it does
  snap to the other vertices of its feature, so a ring can be closed on its
  first vertex
- The handles of features with many vertices are thinned on screen, but
  snapping still sees every vertex
- Freehand snaps the start and the end of a stroke only, so a hand-drawn
  line is not pulled onto nearby boundaries

### Guide lines

In `draw_line` and `draw_polygon` the last placed vertex casts guide lines:
from true north at every step angle (after one vertex), and along and
perpendicular to the previous segment (after two). A real vertex, crossing
or edge within the tolerance still wins over a guide.

The step angle is `snapping.guideStepDegrees`: 45 degrees gives 8 guides,
and 15 gives 24. A change through `draw.options.update` applies from the
next snap.

### What the user sees

While snapped, a symbol is drawn on the snap target: a ring for a vertex,
a square for an edge, a dot for an intersection, and for a guide a small
ring with the guide line dashed underneath.

`snap.changed` fires whenever the result changes. Its `result` is a
`SnapResult`, or `null` when snapping is lost. `target.kind`,
`target.featureId`, `target.datasetId` (for a row of a dataset) and
`target.description` tell what was hit. The description of a guide or an
intersection comes from the words of the library, which the `messages`
option replaces ([styles](styles.md)).

### Snapping to your own data

A snap provider adds candidates from anywhere, such as a road network
that is not on the map as features.

<!-- docs-check:
declare function queryRoadVertices(
  near: import('geojson').Position,
): import('geojson').Position[];
-->

```ts
import type { SnapProvider } from '@sakuzu/maplibre-gl-draw';

const roads: SnapProvider = {
  name: 'road-vertices',
  candidates: ({ lngLat }) =>
    queryRoadVertices(lngLat).map((position) => ({
      kind: 'vertex',
      position,
      source: 'road',
    })),
};

const removeRoads = draw.extensions.snapProviders.add(roads);
```

- `candidates` receives the pointer (`point` on the screen, `lngLat` on
  the map), the tolerance in pixels, the conversion between the map and
  the screen (`screen`) and the IDs to leave out (`excludeIds`).
  Returning candidates farther than the tolerance is harmless; the
  library keeps the near ones and decides which wins
- A candidate is a point. To snap along a segment of your own data,
  return the nearest point on it (`nearestPointOnLine` of the
  [geometry entry](#the-geometry-entry))
- `priority` decides between candidates at the same distance; the
  higher wins. `source` comes back as the `description` of the snap
  result
- The function that `add` returns removes the provider, and so does
  `draw.extensions.snapProviders.remove('road-vertices')`

A custom feature type offers its own candidates with `snapCandidates` in
its definition ([custom feature types](custom-types.md)). A mode of your
own receives the snapped position of each input in `event.snapped`, and
can snap any point on the screen with `snap(point)` of its context
([plugins](plugins.md)).

## Edge tracing

In `draw_line` and `draw_polygon`, when the previous click and this click
both snapped to the boundary of existing features, the vertices of that
boundary between the two points are inserted. An adjacent parcel can be
drawn by clicking two corners of the shared boundary, without redrawing
it.

- The path is the shortest one along the edges of visible features
  nearby, measured on the ground. Features that share a vertex exactly
  are connected, so the path can run across several of them
- While snapping to datasets is on, the rows of datasets can be traced
  along too
- Only a vertex or an edge can be an end; a guide, an intersection or a
  candidate of a snap provider cannot
- When the two points are not connected, the click is an ordinary vertex
- While the pointer moves, the vertices that would be inserted are shown
  in the preview
- The inserted vertices are ordinary vertices: Backspace removes them one
  by one
- Tracing needs snapping; while snapping is off, it does not trace

Tracing is on by default. To turn it off:

```ts
draw.options.update({ tracing: { enabled: false } });
```

## Moving shared vertices together

With `topology.sharedVertexDrag` on, dragging a vertex also moves the
vertices of other features at exactly the same position, so the boundary
of two adjacent polygons is edited without gaps or overlaps. It is off by
default.

```ts
draw.options.update({ topology: { sharedVertexDrag: true } });
```

- The match is exact (tolerance 0); vertices that are merely close do not
  follow
- Lines, areas, points and their Multi types follow; `Circle`, `Image` and
  `Freehand` do not
- Locked and hidden features do not follow
- Several vertices of one feature at the same position (the closing vertex
  of a ring, a hole touching the outer ring) all move
- The followers are fixed when the drag starts and are highlighted during
  the drag. Holding the snapping `disableKey` at the start moves the
  grabbed vertex alone
- The whole move is one change, and only the grabbed feature is selected

## Combining and splitting features

The collection `draw.features` has the operations that change the
document: each takes the IDs of the features, computes the result and
writes it in one change.

- `union(ids)` merges 2 or more areas into one feature, which replaces
  them
- `difference(id, subtractIds)` cuts areas out of an area. The result
  replaces the area cut from; the areas cut out stay
- `intersection(ids)` keeps where 2 or more areas overlap, as one
  feature that replaces them
- `split(id, lineId)` cuts an area along a line into pieces, which
  replace the area; the line stays
- `buffer(ids, { distanceMeters, segments })` makes the area around each
  point, line and area, one per input; the inputs stay

<!-- docs-check:
declare const back: string;
declare const front: string;
declare const parcelId: string;
declare const cutLineId: string;
declare function toast(message: string): void;
-->

```ts
// Cut the front area out of the back one; the front one stays
const cut = draw.features.difference(back, [front]);
if (cut === null) toast('nothing left');

const pieces = draw.features.split(parcelId, cutLineId);

const { ids } = draw.selection.get();
const zones = draw.features.buffer(ids, { distanceMeters: 100 });
draw.features.buffer([parcelId], { distanceMeters: -5, segments: 32 });
```

To work on the selection, pass `draw.selection.get().ids`. The results
are not selected; select them with `draw.selection.set('feature', ids)`
when the user should keep working on them.

### Rules shared by all of them

- Areas are `Polygon`, `MultiPolygon` and `Circle`. The line of `split` is
  a `LineString`, a `MultiLineString` or a `Freehand`
- A wrong argument throws a `DrawError` and changes nothing: `not-found`
  for an unknown ID, `invalid-input` for a feature of the wrong type (a
  line given to `union`, an `Image` given to `buffer`) or a distance that
  is not a finite number
- A refusal returns `null` and changes nothing: while the document is
  read-only, or when one of the features is locked
- Removing the inputs and creating the results is one change, which
  arrives as one `document.changed`
- An empty result changes nothing. `intersection` of areas that do not
  overlap and `difference` that cuts everything away return `null`; a
  line that does not divide the area makes `split` return `[]`, and so
  does `buffer` with a distance of 0

### The shape of the result

- The result is a `Polygon` when it has one part and a `MultiPolygon`
  otherwise. Separate areas merged give a `MultiPolygon`; cutting out the
  inside gives a hole
- `union` and `intersection` take the style and properties of the
  frontmost input and go where it was (its layer, group and position).
  `difference` takes those of the area it cuts from, and the areas it
  cuts out stay as they are
- A `Circle` input becomes a 64-sided polygon, and loses its radius
- `split` keeps the line, puts the pieces where the area was with its
  style and properties, and leaves a hole on the side that contains it
- `buffer` works in meters on the ground, so the distance holds at any
  latitude. A point gives a disc, a line a band, an area grows. A negative
  distance shrinks areas only, and parts narrower than twice the distance
  vanish. A `Circle` stays a `Circle` with a new radius. Each result goes
  just in front of its input with the input's style

## The geometry entry

`@sakuzu/maplibre-gl-draw/geometry` holds the geometric computation as
plain functions. They need no map, no draw instance and no DOM, so they
can be imported without loading the rest of the package, and they give
the same results in a Worker, in Node and in Bun.

<!-- docs-check:
declare const polygonA: import('geojson').Polygon;
declare const polygonB: import('geojson').Polygon;
declare const road: import('geojson').LineString;
-->

```ts
import {
  area,
  buffer,
  pointOnSurface,
  union,
} from '@sakuzu/maplibre-gl-draw/geometry';

// polygonA and polygonB are GeoJSON Polygons, or GeoJSON features
// that hold one
const merged = union([polygonA, polygonB]);
if (merged !== null) {
  const areaSquareMeters = area(merged);
  const marker = pointOnSurface(merged);
}

const band = buffer(road, 100, { segments: 32 });
```

The functions are grouped by what they do:

- Measure: `distance`, `bearing`, `destination`, `midpoint`, `along`,
  `nearestPointOnLine`, `length`, `area`, `perimeter`, `centroid` and
  `pointOnSurface`
- Create: `circle` and `buffer`
- Combine: `union`, `intersection`, `difference` and `split`
- Test: `pointInPolygon`, `overlaps`, `contains`, `bboxIntersects` and
  `bboxContains`
- Repair: `makeValid`, `rewind` and `simplify`
- Bounds and units: `bbox` and `metersToDegrees`

A feature of the drawing is not GeoJSON input as it is: its `type` is the
type of the feature, not `'Feature'`. Pass its `geometry` after checking
the kind, or take the features from `draw.document.toGeoJSON()`:

```ts
import { area } from '@sakuzu/maplibre-gl-draw/geometry';

const parcel = draw.features.get(featureId);
if (parcel?.geometry.type === 'Polygon') {
  console.log(area(parcel.geometry), 'm²');
}

const total = draw.document
  .toGeoJSON()
  .features.filter((f) => f.geometry?.type === 'Polygon')
  .reduce((sum, f) => sum + area(f), 0);
```

### What holds for every function

- The same input always gives the same output. Arguments are not changed;
  results are new objects
- Inputs are GeoJSON geometries, or GeoJSON features whose geometry is
  used; a point is a position `[lng, lat]` or a `Point`. Results are
  GeoJSON geometries: an area comes back as a `Polygon`, or a
  `MultiPolygon` when it has several parts
- Lengths, distances, radii and tolerances are in meters, areas in square
  meters, bearings and coordinates in degrees
- `null` means the result is empty; an input whose shape the function
  cannot take throws a `GeometryError` with the code `invalid-input`

<!-- docs-check:
declare const polygon: import('geojson').Polygon;
-->

```ts
import { buffer } from '@sakuzu/maplibre-gl-draw/geometry';

const shrunk = buffer(polygon, -50);
if (shrunk === null) {
  // the whole area vanished
}
```

- Broken input is dropped at the entry rather than passed on: a ring with
  fewer than three positions or a coordinate that is not a finite number
  does not reach the computation
- The functions that combine areas throw a `GeometryError` with the code
  `engine-failure` when they cannot compute a result
- Areas that only share a boundary do not overlap
- Crossing the ±180° meridian and the surroundings of the poles are out of
  scope; `buffer` returns `null` there
- The scale in mind is a few features being edited and tens of thousands in
  a dataset. Moving heavy work to a Worker is up to the caller

## Examples

- [snapping-and-geometry](../../examples/snapping-and-geometry/)
  sets the `snapping` option, switches snapping, tracing and shared
  vertices with `draw.options.update`, runs `union`, `difference`,
  `buffer` and `split`, and measures with `area`

## Reference

- [`SnappingOptions`](../api/maplibre-gl-draw/interfaces/SnappingOptions.md),
  [`SnapResult`](../api/maplibre-gl-draw/interfaces/SnapResult.md),
  [`SnapProvider`](../api/maplibre-gl-draw/interfaces/SnapProvider.md)
  and [`SnapCandidate`](../api/maplibre-gl-draw/interfaces/SnapCandidate.md)
- [`TracingOptions`](../api/maplibre-gl-draw/interfaces/TracingOptions.md)
  and
  [`TopologyOptions`](../api/maplibre-gl-draw/interfaces/TopologyOptions.md)
- [`FeaturesCollection`](../api/maplibre-gl-draw/interfaces/FeaturesCollection.md)
  for `union`, `difference`, `intersection`, `split` and `buffer`
- [The geometry entry](../api/geometry/index.md), for
  example [`buffer`](../api/geometry/functions/buffer.md) and
  [`GeometryError`](../api/geometry/classes/GeometryError.md)
