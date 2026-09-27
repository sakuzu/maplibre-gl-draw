# Performance

This guide helps you decide where to put your data and which settings
matter when the data grows: how much the Store and a dataset hold, how
dense lines stay editable, and how to scale the drawing for a preview.
It ends with a measured example, the size of the package and how to
measure on your own data.

## Where to put the data

| Data | Put it in | Why |
| --- | --- | --- |
| What the user draws and edits | The Store | Editing, events, export |
| Large reference data | A dataset | No editing cost |
| Data too large to load at once | A dataset with a provider | Per extent |
| A table of a million rows | Columns (`columnar`) | No object per row |

A dataset is built for tens of thousands of features.
A dataset of 50,000 polygons with a graduated style rule, panned and
zoomed on a machine with a GPU, drew within the frame time of a 120 Hz
display. With a provider, only the features of the visible extent are
held, so the total size of the source does not matter.

A table of hundreds of thousands of rows is best given as columns of
typed arrays (`columnar`), read and prepared in a Worker: the rows are
packed straight into the GPU arrays, and the main thread does not build
an object per row ([large data](large-data.md#a-table-as-columns)).

The Store is drawn from retained batches too, but every feature in it
takes part in editing, hit testing, events and export. One measured
scene is below. If you plan to keep many thousands of features in the
Store, measure it with the bench page (below) on the devices you target.

When the user edits only a few features of large data, keep the data
in a dataset and copy the feature being edited into the Store
with `addFeature`. See [large data](large-data.md).

## Minimal settings

```ts
import { createMapLibreGLDraw } from '@sakuzu/maplibre-gl-draw';

const draw = createMapLibreGLDraw(map, {
  renderingStyle: {
    storeRetained: true, // the default
    timeSlicing: true, // the default
  },
});
```

Both defaults are what you want on screen. Change them only for the
cases below.

## Retained rendering

The features of the Store are drawn from GPU batches kept per layer, so
a feature that does not change is not rebuilt in the next frame. A
dataset keeps its batches per spatial chunk and draws
only the chunks in view. `storeRetained: false` draws the Store again
every frame. The picture is the same; use it only to rule out the
retained path when you look into a rendering problem.

Work that does not fit in one frame is spread over the following
frames, so the page never stalls while the picture fills in, much like
tiles arriving: the batches of a dataset are built within a time budget
per frame, a polygon of a dataset with a very large number of vertices
(more than 10,000) is triangulated over several frames (its outline
appears first and its fill when the triangulation ends), and so is the
index of the terrain drape.

## Complete frames for a picture

A map that draws a frame to read the picture back, for printing, a
thumbnail or an export, sets `timeSlicing: false`. Every frame is then
complete: the work above is done in the frame that needs it, however
long that frame takes. Keep the default on an interactive map.

A complete frame is not yet a complete picture: the tiles and the DEM of
the map arrive asynchronously, and some work cannot be done in a frame
at all (the answer of a provider, an overlay renderer that prepares its
resources over several frames). `hasPendingWork()` tells whether such
work remains. The map fires `idle` even when this library asked for
another frame during the last one, so wait for `idle` and then for
`hasPendingWork()` to be false after a frame:

```ts
async function whenPictureComplete(): Promise<void> {
  map.triggerRepaint();
  await map.once('idle');
  while (draw.hasPendingWork()) await map.once('render');
}
```

The collision thinning of a dataset needs nothing: the frame decides
which points it draws from the zoom it draws with.

## Dense lines

A line with thousands of vertices, such as a GPS track, would be covered
by its vertex handles. When the vertex and midpoint handles of the
selected feature are more than 400, only a subset is shown:

- A vertex is shown when it is at least 14 px on screen from the last
  shown one. The first vertex of each line and ring, and the last one of
  an open line, are always shown
- A midpoint is shown only on an edge whose two ends are shown and that
  is at least 32 px long
- Only the handles that are shown can be grabbed. Grabbing elsewhere on
  the line moves the whole feature
- The set is rebuilt when the camera has rested for 150 ms, and at once
  when a vertex is added or removed. Zooming in shows more vertices,
  until every one is shown
- The coordinates are never changed, and snapping still uses every
  vertex and edge

Features with fewer handles are not affected.

## Scaling the drawing

Line widths, point sizes and outlines are given in CSS pixels and drawn
in device pixels. The ratio is the map's `getPixelRatio()`, or the
`pixelRatio` option when you give one. Give it only to draw at another
ratio than the map's.

`setRenderScale(k)` multiplies that ratio at run time. Use it when the
map is shown enlarged or reduced, for example with a CSS transform. For a
map shown at 1/k, such as a page preview, the basemap shrinks with the
camera, and `setRenderScale(1 / k)` shrinks this library's pixel sizes to
match. Positions and sizes in meters do not change.

```ts
draw.setRenderScale(0.5); // the map is shown at half size
draw.setRenderScale(1); // back to normal
```

A value that is not a finite positive number is ignored. The batches are
rebuilt in the next frame. Sizes that already scale with the zoom (a line
of a feature with a `createdZoom`) are not multiplied again.
`getPixelRatio()` returns the resolved ratio, the scale included, for
your own renderers:

<!-- docs-check:
declare class MyTextRenderer {
  constructor(options: { pixelRatio: () => number });
}
-->

```ts
const textRenderer = new MyTextRenderer({
  pixelRatio: () => draw.getPixelRatio(),
});
```

## A measured example

A made-up city of 208,073 editable features was loaded into the Store with
`draw.load`: 174,435 polygons (buildings and parks), 24,328 lines
(streets) and 9,310 points (places), colored by the style rules of their
layers. It is the last picture of the README.

The scene was measured on an Apple M3 Max, in headless Chromium 151
drawing on the GPU through ANGLE's Metal backend, with a map of 1280 ×
760 CSS pixels at a pixel ratio of 2. Loading and panning were measured
in four runs.

- `draw.load` of the 208,073 features took 0.64 to 0.66 s
- Panning, zooming and turning the map for 10 s drew frames of 8.4 ms
  at the median and 13 ms at the 90th percentile, 19 ms at the slowest

Clicks and arrow keys were measured from the input event to the next
frame after the change was drawn, in three runs.

- A click on a feature showed it selected about 60 ms after the click
  (medians of 61, 65 and 66 ms over 20 clicks each, 47 to 91 ms in all)
- Moving the selected feature with an arrow key was drawn about 13 ms
  after the key press (6 to 14 ms)

With twice as many features (410,772, one run), `draw.load` took 1.3 s.
Other devices differ; measure yours as below.

## Package size

The package ships unbundled ES modules, and your bundler includes what
you import. Everything in the main entry, minified, is about 600 kB
(about 160 kB gzipped). The geometry subpath alone is about 40 kB (about
13 kB gzipped).

## Measuring on your data

The repository has two measurement pages for contributors: one pans and
zooms over a dataset, the other over a Store loaded with
`n` features, and both report the frame times. How to run them and their
URL parameters are in [bench/README.md](../../bench/README.md). Run them
on the devices your users have; the numbers depend on the GPU and the
browser.

## Related example

- [examples/large-data/](../../examples/large-data/) shows 50,000
  static polygons in a dataset with collision thinning

## Reference

- [Options](../api/maplibre-gl-draw/interfaces/Options.md) for
  `pixelRatio` and `renderingStyle`
- [RenderingConfig](../api/maplibre-gl-draw/interfaces/RenderingConfig.md)
- [MapLibreGLDraw](../api/maplibre-gl-draw/interfaces/MapLibreGLDraw.md)
  for `setRenderScale`, `getRenderScale` and `getPixelRatio`
