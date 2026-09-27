# Test Design

## Overview

This document describes how the library is tested: which modules matter
most, what each group of unit tests protects, how the modules are tested
together, and what the browser-based end-to-end tests add on top. It does
not list individual test cases; the test files are the specification, and
this document explains why they exist and where to add new ones.

There are three levels.

- Unit and integration tests (`npm test`) run in node with vitest, on a
  stub map and, where GL is involved, a stub GL context. They are fast and
  run on every change
- The shader compile test runs inside `npm test` but starts headless
  Chromium to compile every shader on real WebGL2
- End-to-end tests (`npm run test:e2e`) drive a real maplibre map in
  headless Chromium with the browser's pointer and keyboard

## Modules Under Test and Their Priority

Priority reflects how far a bug spreads, not how much code a module has.

### P1, most important

- MemoryStore. The base of all state; a bug there spreads everywhere
- Geometry module. Pure, but every edit builds on it, and its errors
  reach saved results

### P2, important

- HitTestService. The base of every user operation
- Vertex editing. References into Multi geometries and rings break easily
- SnapService. The single entry point for the coordinates of every mode
- Dataset. Retained resources and their rebuild triggers
- Store retained rendering. Must give the same picture and z-order as
  immediate mode

### P3, standard

- Distance and CoordinateTransform. Pure functions with a limited blast
  radius
- Style rules. Pure functions, but with many branches

## What Each Group Protects

The groups below follow the source layout. Each names its main files and
the contract it holds down.

### 1. MemoryStore

`src/store/memory.ts`. The Store is the single source of truth, so its
tests pin the invariants every other module assumes: creating, updating
and deleting features, layers and groups keeps the layer order, group
membership, selection and editing state consistent (an empty group is
removed, a deleted feature leaves the selection). Transactions gather
changes into one `StoreChange`, nest, carry their source and clear on an
exception. `listFeaturesInOrder` returns every feature in the drawing
order, hidden ones included.

### 2. HitTestService

`src/dispatcher/hit-test/service.ts`. Hit testing follows the visual
stacking order, not the distance: the front feature that passes its test
wins, holes let clicks through, and hidden features are never hit while
locked ones remain selectable. Multi geometries hit on any part. Custom
strategies and candidate reaches can be registered without changing the
meaning of a hit. See [hit testing](./hit-testing.md).

### 3. Vertex editing

`src/operations/vertex.ts`. The interpretation of a vertex reference
(`{ part?, ring, index }`), the minimum vertex count per part and ring,
and the syncing of the closing vertex of a ring. Shared-vertex dragging
moves only exactly matching vertices, fixes the set when the drag starts,
and skips locked or hidden features.

### 4. SnapService

`src/snapping/service.ts`. Candidate resolution: tolerance, the kind
priority (vertex, intersection, edge, guide), distance as the tie-break,
and the bypass when snapping is off or the release key is held. A
throwing provider does not stop the others. `snap.change` is emitted only
when the result changes.

### 5. Dataset

`src/dataset/`. Chunking by count and vertex weight with the draw order
kept, viewport culling, retained batches that rebuild only on the
triggers that matter, the tile-range provider (no calls for movement
inside the same range, stale responses ignored), hit arbitration against
the Store, and the pitch correction of collision thinning.

### 6. Distance

`src/shared/math/distance.ts`. Euclidean and haversine distance, point to
segment and polyline distance, and the metre to degree conversions,
checked against known values.

### 7. CoordinateTransform

`src/shared/math/transform.ts`. The Mercator conversion at the edges of
the world and the bounding-box margin helper.

### 8. Geometry module

`src/geometry/`. Pure functions checked from inputs and outputs alone:
the boolean operations and buffer, including empty results; robustness
against self-intersection, duplicate vertices and zero area;
determinism; and the dependency rule that the module touches neither
maplibre, the DOM nor the Store.

### 9. Style rules

`src/view/style-rule.ts` and `src/view/cache/style-rule.ts`. Each rule
kind (single, categorical, graduated, continuous), the fallback colour
for missing or mistyped values, OKLab interpolation, the precedence of an
individual colour over the rule, cache invalidation on feature and rule
changes, and legend derivation.

### 10. Retained Store rendering

`src/view/layer/store-retained.ts` and `src/view/layer/render.ts`. The
contract is "the same picture as immediate mode". A stub that records GL
calls checks the classification of features into batch kinds, run
splitting at the same boundaries as immediate mode, z-order between
retained and immediate chunks, which changes rebuild which chunks,
viewport thinning of chunks, and the fallback to immediate mode when a
batch cannot be built. See [rendering](./rendering.md).

### 11. Immediate-mode renderers

`src/view/renderers/`. Reuse of GPU resources across draws (no rebuilt
buffers, sub-image uploads), indexed rendering that keeps fill before
outline in input order, negative line widths for fixed-width lines, and
the single-pass point renderer that keeps overlapping points in input
order.

### 12. AutoNameGenerator

`src/shared/utils/name-generator.ts`. Serial names per type that never
reuse a number, pick up names added from outside, and avoid a full scan
on every call during a bulk import.

### 13. Bulk-import scaling

`src/store/load-scaling.test.ts`. A timing test that guards complexity,
judged by ratios rather than absolute times: four times the data must
not take anywhere near sixteen times as long.

### 14. Handle thinning

`src/view/ui/handle-thinning.ts`. Editing handles of dense features are
thinned by screen spacing. The tests use a linear projection stub and
check that the thinned set is a subset of the full enumeration, that the
cache follows the camera with a debounce, and that hit testing uses the
set currently displayed.

### 15. Many vertices

Indices, caches and incremental updates that keep dense features fast:
the segment grid used by hit testing, the offset model of the shaders,
the bbox-limited snapping candidates, texel patches during vertex drags,
copy-on-write vertex operations and the coordinate bounding-box cache.
Each is checked for exact agreement with the slower full scan it
replaces, with seeded random data.

### 16. Extension points

The contracts of companion rendering and hits, selection-independent
auxiliary handles, plugin removal on `destroy()`, and dash length in
screen pixels. The key property is that when no provider is registered,
the route and the cost are unchanged. See [plugins](../guides/plugins.md)
and [custom types](../guides/custom-types.md).

## Integration Tests

### Store and hit testing

A real Store with the spatial index and HitTestService checks that hit
results follow Store changes (deletion, visibility), that locked features
are still hit by a click, and that box selection leaves out locked and
hidden features.

### The input route

Synthesized input (`createSyntheticInput` of `src/test-utils.ts`) enters
through the same router as real pointer input, so
`src/modes/draw/trace-mode.test.ts` and
`src/dispatcher/input-router.test.ts` can check the whole route from
input through snapping to the mode: vertices confirmed by a click, snapped
drag start and end, a dragged vertex that does not snap to itself, and
modes that decline snapping for some input kinds. The freehand tests
(`src/modes/draw/freehand.test.ts`) send a drag through the real router
and SnapService to check that a stroke snaps only at its ends.

The input normalizer is unit-tested in `src/dispatcher/normalizer.test.ts`
on a stub map: the click and drag thresholds, the click swallowed after a
drag, touch slop, long press, double tap, two-finger gestures and the
compatibility mouse events.

## End-to-End Tests

The tests above run on a stub map that projects longitude and latitude
linearly with neither pitch nor bearing, and `draw.input` enters after the
normalizer. They do not cover what the browser and maplibre do first:
real mouse and keyboard events, maplibre's event system and projection,
the drag threshold, canvas focus, and hit testing against what is really
drawn.

The end-to-end tests in `src/e2e/` cover that route. `harness.ts` bundles
`page-entry.ts` and the sources it imports (not `dist`) with vite in
memory, leaves maplibre-gl external, and serves the bundle next to
maplibre's own build to headless Chromium. The page runs a real maplibre
`Map` with an empty style, so nothing is fetched from the network, and a
`createDraw` instance on it. The tests drive the page with
`page.mouse` and `page.keyboard` and read results through the public API.

The scenarios in `src/e2e/draw.e2e.test.ts` draw every basic shape and
cancel it with Escape, select and move a polygon, move a single vertex,
check that a press within the drag threshold does not move anything,
delete with the Delete key, and check that read-only mode stops editing.
One scenario repeats drawing and moving on a pitched and rotated map, with
snapping off because the constraint snaps are measured on the ground and
would rightly pull vertices away from the pointer.

`src/e2e/terrain-occlusion.e2e.test.ts` looks at a peak of the test
terrain (`dem-fixture.ts`) from below its summit. Which sample points of a
feature are hidden is decided from maplibre's own ground
(`map.queryTerrainElevation` along the line of sight), not from the
engine, and the pixels around them are read from the canvas. It covers
solid and dashed lines, polygons with a solid and a dashed outline in the
Store and in a dataset, points behind the peak (drawn
faintly) and the handles of a selection at a hidden vertex (drawn in
full).

`src/e2e/globe.e2e.test.ts` draws on maplibre's globe and holds the pixels
to `map.project`, maplibre's own position of a coordinate. A line and a
fill of two vertices along a parallel lie on the parallel, and so do the
line being drawn and a large image between two parallels (which a click
just inside its edge selects); the dashes of a long slanted edge and a
click on it follow the path its solid line is drawn along. Each case first
checks that the chord between the vertices passes several pixels away, so
it tells the two apart. A point near the edge of a rotated globe, beyond the bounds
maplibre reports, is drawn where maplibre's own circle layer draws it. The
globe's background layer goes under the layers of the engine
(`map.getLayersOrder()`), which `map.getStyle()` does not list.

All scenarios share one page, because a new page is a new GL context and
compiling the shaders on software WebGL takes seconds. The run takes
about ten seconds, so it has its own configuration
(`src/e2e/vitest.config.ts`) and script, `npm run test:e2e`, and is
excluded from `npm test`. The browser is installed once with
`npx playwright-core install chromium-headless-shell`.

## End-to-End Tests of the Examples

Every example under `examples/NN-*/` (from `basic` to `table-worker`)
is also a test. The intent is that each example is opened in headless
Chromium, must render without errors (the map and the library's layers
appear and nothing is logged to the console as an error), and then
receives one representative interaction, such as drawing a polygon in
`basic` or clicking a display feature in `large-data`. The code
snippets in the README and the guides are cut from these examples, so
this test is what keeps the documentation runnable. There is no script
for it in `package.json` yet; it will be added alongside the examples.

## Guidelines

### Mocking

- Pure functions (distance, change merging, geometry, style rules) need
  no mocks
- HitTestService uses a real Store and spatial index; mock only the
  projection
- SnapService can be built without the Store and the spatial index so
  that only the providers under test are registered; the built-in
  providers join only when both are given
- Dataset falls back to immediate mode when the retained
  renderers are unavailable, so chunking, providers and hit testing can
  be tested without GL
- Retained Store rendering stubs the renderer set and the BatchManager and
  checks the order and number of calls; no real GL context is needed
- Shaders are the exception to stub GL, where a GLSL typo still passes.
  `src/view/shaders/compile.test.ts` compiles and links every program on
  the WebGL2 of headless Chromium with the Mercator and globe preludes
  taken from a real maplibre map, and counts the `createProgram(` call
  sites in `src/view` so that no new program is left out
- Anything that depends on maplibre internals uses fake objects in unit
  tests and is also checked by hand as described in
  [maplibre coupling](./maplibre-coupling.md)

### Test data

There is no shared helper module. Each test file defines the builders it
needs next to its tests (for example `createTestLayer`,
`createTestFeature` and `createTestGroup` in `src/store/memory.test.ts`).
Tests that use random data seed it (mulberry32) so failures reproduce.

### Where a new test goes

- A test sits next to the file it tests, as `name.test.ts`, and is
  picked up by `npm test` (`src/**/*.test.ts`)
- A behavior that involves several modules but no browser goes into an
  integration test on the stub map, like the input-route tests above
- A behavior that depends on real browser events, real projection with
  pitch and bearing, or what is actually drawn goes into `src/e2e/`.
  Keep these few: every scenario adds to the shared page's run time
- A new shader program needs no new test, but it must be created through
  a `createProgram(` call site under `src/view` so the compile test
  finds it
- A new reliance on maplibre internals gets an item in
  [maplibre coupling](./maplibre-coupling.md) with the test that guards
  it

### Running the tests

| Command | What it runs |
| --- | --- |
| `npm test` | Unit, integration and shader compile tests |
| `npm run test:watch` | The same in watch mode |
| `npm run test:e2e` | The end-to-end tests in `src/e2e/` |
| `npm run typecheck` | The TypeScript compiler without output |
| `npm run lint` | Biome, the layer rule check and the terms check |

### Coverage

The targets are 80 % of lines, 70 % of branches and 90 % of functions.
`vitest.config.ts` collects coverage with the v8 provider but does not
enforce thresholds.
