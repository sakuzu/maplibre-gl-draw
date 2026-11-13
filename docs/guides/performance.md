# Performance

This guide helps you decide where to put your data and which settings
matter when the data grows: how much the document and a dataset hold,
how to write many features at once, how dense lines stay editable, and
how to scale the drawing for a preview.
It ends with a measured example, the size of the package and how to
measure on your own data.

## Where to put the data

| Data | Put it in | Why |
| --- | --- | --- |
| What the user draws and edits | The document | Editing, events, export |
| Large reference data | A dataset | No editing cost |
| Data too large to load at once | A dataset with a provider | Per extent |
| A table of a million rows | A table (`table`) | No object per row |

A dataset is built for tens of thousands of features.
A dataset of 50,000 polygons with a graduated style rule, panned and
zoomed on a machine with a GPU, drew within the draw time of a 120 Hz
display. With a provider, only the features of the visible extent are
held, so the total size of the source does not matter.

A table of hundreds of thousands of rows is best given as columns of
typed arrays (`table`), read and prepared in a Worker: the rows are
packed straight into the GPU arrays, and the main thread does not build
an object per row ([showing large data](large-data.md)).

Every feature of the document takes part in editing, hit testing, events
and export. One measured scene is below. If you plan to keep many
thousands of features in the document, measure it with the bench page
(below) on the devices you target.

When the user edits only a few features of large data, keep the data
in a dataset and copy the row being edited into the document with
`tx.features.create`. See [showing large data](large-data.md).

## Minimal settings

```ts
import { createDraw } from '@sakuzu/maplibre-gl-draw';

const draw = createDraw(map, {
  rendering: {
    cacheGeometry: true, // the default
    timeSlicing: true, // the default
  },
});
```

Both defaults are what you want on screen. Change them only for the
cases below, at creation or later with `draw.options.update`.

## Writing many features

Each `draw.write` is one commit, with its events, however many features
it writes. To create, change or delete many features, give them to one
write of `tx`: `create` takes an array of features, and `update`,
`delete`, `translate`, `rotate`, `scale` and `place` take their IDs, a
filter, the selection or `{ all: true }`. The drawing and `change` then
follow once for all of them.

<!-- docs-check:
declare const inputs: import('@sakuzu/maplibre-gl-draw').FeatureInput[];
declare const hiddenIds: string[];
-->

```ts
// Writes of several kinds in one transaction are one commit
await draw.write(async (tx) => {
  await tx.features.create(inputs);
  await tx.features.delete(hiddenIds);
  await tx.layers.update(layerId, { opacity: 0.5 });
});
```

A GeoJSON file is read in one step with `draw.open` or `tx.import`, which
also writes all its features in one commit ([save and load](save-load.md)).

## Keeping the geometry

The geometry of a feature that does not change is kept on the GPU
between drawings, per layer, so it is not built again when the map moves.
A dataset keeps its geometry per area of the map and draws only the
areas in view. `cacheGeometry: false` builds the geometry of the document
again on every drawing. The picture is the same; use it only to rule out
the kept geometry when you look into a drawing problem.

Work that does not fit in one draw of the map is spread over the
following draws, so the page never stalls while the picture fills in,
much like tiles arriving: the geometry of a dataset is built within a
time budget per draw, a polygon of a dataset with a very large number of
vertices (more than 10,000) is filled in over several draws (its outline
appears first and its fill when the work ends), and so is the
preparation of the terrain.

## Complete draws for a picture

A map that draws to read the picture back, for printing, a thumbnail or
an export, sets `timeSlicing: false`. Every draw of the map is then
complete: the work above is done in the draw that needs it, however long
that draw takes. Keep the default on an interactive map.

A complete draw is not yet a complete picture: the tiles and the DEM of
the map arrive asynchronously, and some work cannot be done in one draw
at all (the answer of a provider, an overlay that prepares its data over
several draws). `draw.hasPendingWork()` tells whether
such work remains. The map fires `idle` even when this library asked for
another draw during the last one, so wait for `idle` and then for
`hasPendingWork()` to be false after a draw:

```ts
async function whenPictureComplete(): Promise<void> {
  map.triggerRepaint();
  await map.once('idle');
  while (draw.hasPendingWork()) await map.once('render');
}
```

The collision thinning of a dataset needs nothing: each draw decides
which points it draws from the zoom it draws with.

A picture of the map as it is on the screen needs no second map:
`draw.captureImage` takes it in the next draw of the map, without
the selection, its handles and the shape being drawn, and scales it to
the size asked for (a size of another shape is covered by the map and
cut at its middle). The document is in it as it is written: what a
drag or a sketch moves is in it where it was before. It costs one
draw, so it suits a thumbnail of a document too large to draw a second
time:

```ts
const thumbnail = await draw.captureImage({
  width: 320,
  height: 200,
  type: 'image/webp',
  quality: 0.8,
});
```

## Memory against the limit of the device

A browser stops a page that takes more memory than the device has for
it, and a phone has less than a desktop. `draw.memory.get()` tells what
the documents drawn on the page take, against a limit of the device:
400 MiB on an iPhone, 500 MiB on an iPad, 1 GiB elsewhere, or the one
you set with `draw.memory.setLimit`. Every draw instance of the page is
counted, a second one that prints or a document shown in place of the
document included. `gpuBytes` is what the drawing allocated on the GPU;
`jsBytes` is an estimate from the features and their positions (a
browser does not tell the heap of the page everywhere). The base map and
the rest of the page are not in it.

What the drawing holds on the GPU outside the rows, the part that does
not follow the size of the document, has a limit for the instance:
`rendering.gpuLimitBytes`, 64 MB when it is left out. The library and the
extensions together read it: `draw.debug.gpu()` tells `bytes` and
`rowBytes`, what follows the features (`gpu.rows`) is out of the limit, under
what the device has left, and an extension holds a share of the limit
(`gpuShare`), past which an
allocation is refused ([what a plugin holds on the
GPU](custom-types.md#what-a-plugin-holds-on-the-gpu)). A change through
`draw.options.update` is followed at once: what is held is not released,
and the next allocation is refused. Give the value for the devices of your
users, as the library does not know what they can spare.

`draw.memory.estimate` gives what a document of a size would take, held
as the Store of the instance holds its features, so a page can stop what
would pass the limit before it starts: a map to open, a print, a version
to look at.

```ts
const now = draw.memory.get();
const added = draw.memory.estimate({ features: 120_000, positions: 700_000 });
if (now.bytes + added.bytes > now.limitBytes) {
  // tell the user it is too large for this device, and do not open it
}
```

Nothing is refused by the instance: the page decides what to stop and
what to tell.

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
in device pixels. The ratio is the map's `getPixelRatio()`, or
`rendering.pixelRatio` when you give one. Give it only to draw at another
ratio than the map's.

`rendering.renderScale` multiplies that ratio. Use it when the map is
shown enlarged or reduced, for example with a CSS transform. For a map
shown at 1/k, such as a page preview, the basemap shrinks with the
camera, and a `renderScale` of 1/k shrinks this library's pixel sizes to
match. Positions and sizes in meters do not change.

```ts
// The map is shown at half size
draw.options.update({ rendering: { renderScale: 0.5 } });
// Back to normal
draw.options.update({ rendering: { renderScale: 1 } });
```

A value that is not a positive number throws a `DrawError` with the code
`invalidInput` and changes nothing. The drawing follows at once. Sizes
that already grow and shrink with the zoom (a line drawn at its reference
zoom) are not multiplied again. An overlay or a renderer of your own
reads the ratio in effect, the scale included, from its context:

```ts
draw.extensions.overlays.add({
  name: 'outline',
  draw(ctx) {
    const widthInDevicePixels = 2 * ctx.screen.pixelRatio;
    // draw with that width
  },
});
```

## A measured example

A made-up city of 208,073 editable features was read into the document
in one step: 174,435 polygons (buildings and parks), 24,328 lines
(streets) and 9,310 points (places), colored by the style rules of their
layers. It is the last picture of the README.

The scene was measured on an Apple M3 Max, in headless Chromium 151
drawing on the GPU through ANGLE's Metal backend, with a map of 1280 ×
760 CSS pixels at a pixel ratio of 2. Loading and panning were measured
in four runs.

- Reading the 208,073 features into the document took 0.64 to 0.66 s
- Panning, zooming and turning the map for 10 s took draws of 8.4 ms
  at the median and 13 ms at the 90th percentile, 19 ms at the slowest

Clicks and arrow keys were measured from the input event to the next
draw after the change, in three runs.

- A click on a feature showed it selected about 60 ms after the click
  (medians of 61, 65 and 66 ms over 20 clicks each, 47 to 91 ms in all)
- Moving the selected feature with an arrow key was drawn about 13 ms
  after the key press (6 to 14 ms)

With twice as many features (410,772, one run), reading them took
1.3 s.
Other devices differ; measure yours as below.

## Package size

The package ships unbundled ES modules, and your bundler includes what
you import. Everything in the main entry, minified, is about 600 kB
(about 160 kB gzipped). The geometry subpath alone is about 40 kB (about
13 kB gzipped).

## Measuring on your data

The repository has two measurement pages for contributors: one pans and
zooms over a dataset, the other over a document loaded with
`n` features, and both report the draw times. How to run them and their
URL parameters are in [bench/README.md](../../bench/README.md). Run them
on the devices your users have; the numbers depend on the GPU and the
browser.

## Related examples

- [200,000 features](../examples/200000-features.md) loads a city of
  208,073 editable features in one step
- [Datasets](../examples/datasets.md) shows 10,477 buildings and
  17,558 places in two datasets, not editable, under and over the
  drawing

## Reference

- [RenderingOptions](../api/maplibre-gl-draw/interfaces/RenderingOptions.md)
  for `renderScale`, `pixelRatio`, `cacheGeometry` and `timeSlicing`
- [OptionsResource](../api/maplibre-gl-draw/interfaces/OptionsResource.md)
  for `draw.options.update`
- [Draw](../api/maplibre-gl-draw/interfaces/Draw.md) for `hasPendingWork`,
  `captureImage` and `write`
- [MemoryResource](../api/maplibre-gl-draw/interfaces/MemoryResource.md)
  for `draw.memory`
- [TransactionFeatures](../api/maplibre-gl-draw/interfaces/TransactionFeatures.md)
  for the writes of many features
