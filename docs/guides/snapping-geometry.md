# Snapping and geometry

This guide covers the tools that make drawn shapes fit together:
snapping to vertices, edges, intersections and guide lines, tracing the
boundary of an existing feature, moving shared vertices together, and the
geometry operations (union, subtract, intersect, split, buffer). It ends
with the geometry module, a set of pure functions that can be used on its
own, also outside the browser.

## Minimal code

<!-- docs-check:
declare const statusBar: HTMLElement;
declare const parcelA: string;
declare const parcelB: string;
-->

```ts
import { createMapLibreGLDraw } from '@sakuzu/maplibre-gl-draw';

const draw = createMapLibreGLDraw(map, {
  snap: { tolerancePx: 12 },
  topology: { sharedVertexDrag: true },
});

draw.on('draw.snap.change', (result) => {
  statusBar.textContent = result.target ? result.target.kind : '';
});

// Merge the selected areas into one feature
draw.select([parcelA, parcelB]);
const merged = draw.geometry.union(); // the new feature's ID, or null
```

## Snapping

While drawing and while dragging a vertex, the pointer snaps to what is
near it. Snapping happens where input enters the library, so it works the
same in every drawing mode, in custom modes and in vertex drags, and for
input sent through `draw.input`.

It is on by default:

| `Options.snap` | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | snapping on or off |
| `tolerancePx` | `10` | how near, in screen pixels |
| `disableKey` | `'alt'` | held, it stops snapping |
| `kinds` | all `true` | on or off per kind |
| `datasets` | `true` | snap to datasets too |
| `guideStepDegrees` | `45` | step angle of the north-based guides |

`disableKey` is `'alt'`, `'shift'`, `'ctrl'`, `'meta'` or `'none'`. While
the key is held nothing snaps, so a single point can be placed at its
plain position. The tolerance is the same distance on screen in every
direction and at every latitude.

The same settings change at runtime through `draw.snapping`:

```ts
draw.snapping.setEnabled(false);
draw.snapping.setKindEnabled('guide', false);
draw.snapping.setDatasetsEnabled(false);
draw.snapping.setGuideStep(15);
draw.snapping.getOptions(); // the current settings
```

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
- Hidden features are not snapped to (hidden for everyone or locally)
- The shape being drawn is not a feature yet and is not snapped to
- A dragged vertex does not snap to itself or its own edges, but it does
  snap to the other vertices of its feature, so a ring can be closed on its
  first vertex
- The handles of many-vertex features are thinned on screen, but snapping
  still sees every vertex
- Freehand snaps the start and the end of a stroke only, so a hand-drawn
  line is not pulled onto nearby boundaries

### Guide lines

In `draw_line` and `draw_polygon` the last placed vertex casts guide lines:
from true north at every step angle (after one vertex), and along and
perpendicular to the previous segment (after two). A real vertex, crossing
or edge within the tolerance still wins over a guide.

The step angle is `Options.snap.guideStepDegrees` (45 degrees by default,
which gives 8 guides; 15 gives 24). `draw.snapping.setGuideStep(degrees)`
changes it at runtime, from the next snap. A value of 0 or less, or one
that is not finite, falls back to 45.

To add guides at a second step angle on top of the built-in ones,
`createGuideSnapProvider` builds a guide provider that a plugin can
register (it reads the drawing in progress from `ctx.getStore()`).

### What the user sees

While snapped, a symbol is drawn on the snap target: a ring for a vertex,
a square for an edge, a dot for an intersection, and for a guide a small
ring with the guide line dashed underneath. The styles are exported as
`DEFAULT_SNAP_INDICATOR_STYLES` and `DEFAULT_SNAP_GUIDE_LINE_STYLE`.

`draw.snap.change` fires whenever the result changes, with a `SnapResult`;
`target` is absent when snapping is lost. `target.kind`,
`target.featureId`, `target.datasetId` (for a feature of a dataset) and
`target.description` tell what was hit. The description of a guide or an
intersection comes from the messages table ([Styles](styles.md#messages)).

### Snapping to your own data

A provider adds candidates from anywhere, such as a road network that is
not on the map as features.

<!-- docs-check:
declare function queryRoadVertices(bbox: unknown): [number, number][];
-->

```ts
import type { SnapProvider } from '@sakuzu/maplibre-gl-draw';

const roads: SnapProvider = {
  name: 'road-vertices',
  candidates: (bbox) =>
    queryRoadVertices(bbox).map((coordinate) => ({
      kind: 'vertex',
      coordinate,
      description: 'road',
    })),
};

const unregister = draw.snapping.register(roads);
```

- `bbox` is the area around the pointer, widened by the tolerance, in
  degrees. Returning candidates outside it is harmless; the library cuts
  by distance and decides the priority
- A candidate is a point (`coordinate`) or a segment (`start`, `end`, for
  `edge` and `guide`); the nearest point of a segment is computed for you
- A segment with `startRef` and `endRef` (the vertex references of its
  ends) is a real edge, and a click snapped to it can start edge tracing
- The second argument carries the pointer, the tolerance in pixels and in
  degrees, the zoom, the modifier keys and what to exclude
  (`excludeFeatureId`, `excludeFeatureIds`, `excludeVertex`)

A custom feature type declares its own candidates with `getSnapTargets`
([Custom feature types](custom-types.md)).

`draw.snapping.resolve(lngLat)` runs a coordinate that did not come from
the pointer (a typed value, say) through snapping and returns the result.

## Edge tracing

In `draw_line` and `draw_polygon`, when the previous click and this click
both snapped to the boundary of existing features, the vertices of that
boundary between the two points are inserted. An adjacent parcel can be
drawn by clicking two corners of the shared boundary, without redrawing
it.

- The path is the shortest one along the edges of visible features
  nearby, measured on the ground. Features that share a vertex exactly
  are connected, so the path can run across several of them
- Only vertices and edges with vertex references can be the ends; a guide
  or an intersection cannot
- When the two points are not connected, the click is an ordinary vertex
- While the pointer moves, the vertices that would be inserted are shown
  in the preview
- The inserted vertices are ordinary vertices: Backspace removes them one
  by one
- Tracing needs snapping; while snapping is off, it does not trace

```ts
draw.tracing.setEnabled(false); // or Options.trace: { enabled: false }
```

## Moving shared vertices together

With `topology.sharedVertexDrag` on, dragging a vertex also moves the
vertices of other features at exactly the same position, so the boundary
of two adjacent polygons is edited without gaps or overlaps. It is off by
default.

```ts
draw.topology.setSharedVertexDrag(true);
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

## Geometry operations

`draw.geometry` edits the features in the store: it takes the targets from
the selection, runs the geometry module and writes the result in one
change.

| Method | Takes | Result |
| --- | --- | --- |
| `union(ids?)` | 2+ areas | one feature; inputs removed |
| `subtract(targetId?, ids?)` | 2+ areas | one feature; inputs removed |
| `intersect(ids?)` | 2+ areas | one feature; inputs removed |
| `split(targetId?, lineId?)` | an area, a line | the pieces; area removed |
| `buffer(ids?, options)` | any geometry | one per input; inputs kept |

<!-- docs-check:
declare const back: string;
declare const front: string;
declare const parcelId: string;
declare const cutLineId: string;
declare function toast(message: string): void;
-->

```ts
draw.select([back, front]);
draw.geometry.subtract(); // the front ones are cut out of the backmost

draw.geometry.split(parcelId, cutLineId);

const zones = draw.geometry.buffer({ distanceMeters: 100 });
draw.geometry.buffer([parcelId], { distanceMeters: -5, segments: 32 });

draw.on('draw.geometry.applied', ({ operation, status, resultIds }) => {
  if (status === 'empty') toast(`${operation}: nothing left`);
});
```

### Rules shared by all of them

- Without IDs the current feature selection is used. Areas are `Polygon`,
  `MultiPolygon` and `Circle`; a line for `split` is `LineString`,
  `MultiLineString` or `Freehand`
- Locked and hidden features are skipped. Nothing happens while
  read-only
- Removing the inputs and creating the results is one change, notified
  as one step
- The results are selected
- An empty result changes nothing: the method returns `null` or `[]`, and
  `draw.geometry.applied` fires with `status: 'empty'`

### The shape of the result

- The result is a `Polygon` when it has one part and a `MultiPolygon`
  otherwise. Separate areas merged give a `MultiPolygon`; cutting out the
  inside gives a hole
- `union`, `subtract` and `intersect` take the style and properties of the
  frontmost input and go where it was (its layer, group and position).
  `subtract` without `targetId` cuts the others out of the backmost
- A `Circle` input becomes a 64-sided polygon, and loses `radiusMeters`
- `split` keeps the line, puts the pieces where the area was with its
  style and properties, and leaves a hole on the side that contains it. A
  line that does not cross the area changes nothing
- `buffer` works in meters on the ground, so the distance holds at any
  latitude. A point gives a disc, a line a band, an area grows. A negative
  distance shrinks areas only, and parts narrower than twice the distance
  vanish. A `Circle` stays a `Circle` with a new radius. Each result goes
  just in front of its input with the input's style

## The geometry module

`@sakuzu/maplibre-gl-draw/geometry` holds the geometric computation as pure
functions. It does not depend on MapLibre, the DOM, the store or events;
its only runtime dependency is `polygon-clipping`. It can be imported
without loading the map-facing part of the package, and gives the same
results in Node and Bun.

<!-- docs-check:
declare const polygonA: import('@sakuzu/maplibre-gl-draw/geometry').PolygonCoordinates;
declare const polygonB: import('@sakuzu/maplibre-gl-draw/geometry').PolygonCoordinates;
declare const road: import('@sakuzu/maplibre-gl-draw/geometry').Coordinate[];
-->

```ts
import {
  buffer,
  pointOnSurface,
  sphericalArea,
  unionAll,
} from '@sakuzu/maplibre-gl-draw/geometry';

// polygonA and polygonB are Polygon coordinates ([ring, ...])
const merged = unionAll([polygonA, polygonB]);
const areaSquareMeters = sphericalArea(merged);
const labelAnchor = pointOnSurface(merged);

const band = buffer({ type: 'LineString', coordinates: road }, 100, {
  segments: 32,
});
```

It contains boolean operations (`union`, `difference`, `intersection`,
`clip` and their `*All` forms), `splitArea`, `buffer`, predicates
(`pointInPolygon`, `intersects`, `contains`, `within`), measurement
(`geodesicLength`, `sphericalArea`, `centroid`, `pointOnSurface`),
`simplify` and ring orientation helpers, distances and bearings on the
sphere, and bounding boxes.

### What holds for every function

- The same input always gives the same output. Arguments are not changed;
  results are new arrays
- Coordinates are GeoJSON arrays, the same shape as a feature's
  `coordinates`. Functions on areas accept `Polygon` or `MultiPolygon`
  coordinates and return `MultiPolygon` coordinates
- `[]` means the result is empty; `null` means the operation is not
  defined for that input

<!-- docs-check:
declare const polygon: import('@sakuzu/maplibre-gl-draw/geometry').PolygonCoordinates;
-->

```ts
const shrunk = buffer({ type: 'Polygon', coordinates: polygon }, -50);
if (shrunk === null) {
  // a negative distance for a point or a line
} else if (shrunk.length === 0) {
  // the whole area vanished
}
```

- Broken input is dropped at the entry rather than passed on: a ring with
  fewer than three positions or a coordinate that is not a finite number
  does not reach the computation
- The boolean `*All` functions throw a `GeometryError` with a reason code
  when they cannot compute a result
- Areas that only share a boundary do not overlap
- Crossing the ±180° meridian and the surroundings of the poles are out of
  scope; `buffer` returns `null` there
- The scale in mind is a few features being edited and tens of thousands in
  a dataset. Moving heavy work to a worker is up to the caller

## Examples

- [snapping-and-geometry](../../examples/snapping-and-geometry/)
  sets `Options.snap`, switches `draw.snapping`, `draw.tracing` and
  `draw.topology`, runs `union`, `subtract`, `buffer` and `split`, and
  measures with `sphericalArea`

## Reference

- [`SnapOptions`](../api/maplibre-gl-draw/interfaces/SnapOptions.md),
  [`SnappingOperations`](../api/maplibre-gl-draw/interfaces/SnappingOperations.md),
  [`SnapProvider`](../api/maplibre-gl-draw/interfaces/SnapProvider.md)
  and [`SnapResult`](../api/maplibre-gl-draw/interfaces/SnapResult.md)
- [`TracingOperations`](../api/maplibre-gl-draw/interfaces/TracingOperations.md)
  and
  [`TopologyOperations`](../api/maplibre-gl-draw/interfaces/TopologyOperations.md)
- [`GeometryOperations`](../api/maplibre-gl-draw/interfaces/GeometryOperations.md)
  and
  [`GeometryAppliedPayload`](../api/maplibre-gl-draw/interfaces/GeometryAppliedPayload.md)
- [The geometry module](../api/geometry/index.md), for
  example [`buffer`](../api/geometry/functions/buffer.md) and
  [`GeometryError`](../api/geometry/classes/GeometryError.md)
