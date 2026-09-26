# Showing large data

A dataset shows large data fast, in exchange for not being editable:
tens of thousands of parcels, a million points, the answer of a server.
You pass it all at once, or fetch only what is in view each time the map
moves. It is styled by the same style rules as drawn features, and a
click reads its properties.

This guide starts with when to use a dataset and why it is fast, then
shows how to give it data, how to style it and how to read it back.

## When to use a dataset

Use a dataset for data that is shown but not edited. For example:

- The 50,000 parcels of a city behind a drawing, colored by land use.
  The user draws new boundaries over them, and snapping follows their
  edges and vertices
- A million sensor points read from a GeoParquet file
- Administrative boundaries shown as a backdrop
- Points on a server, fetched for the part of the map in view each time
  the map moves

What the user draws and edits belongs in the Store. When the user needs
to edit one feature of a dataset, copy it into the Store with
`addFeature`. The library does not keep the two copies
related.

## How a dataset differs from drawn features

| | Drawn features | A dataset |
| --- | --- | --- |
| Editing | Move, vertices, geometry | None |
| Events | `draw.feature.*` | Its own `click`, `hover`, `change` |
| Selection | A frame and handles | A highlight (`setSelectedIds`) |
| Saving | `export()` | Not saved, only its id in the order |
| Size | 200,000 stay editable | Tens of thousands to millions |

A dataset is fast because it skips everything that editing needs and
is drawn by a path of its own:

- The rows are split into spatial chunks. The chunks are uploaded to the
  GPU a few at a time, within a time budget per frame, so a large
  dataset fills in like tiles arriving and the page does not stall
- Only the chunks in view are drawn
- A table given as columns goes from its typed arrays straight into the
  arrays of the GPU, without an object per row. The work before drawing
  (the bounding boxes, the chunks and the spatial index) can be done in
  a Worker
- With a provider, only the features of the part in view are held, so
  the total size of the source does not matter

## The smallest example

```ts
import { createMapLibreGLDraw } from '@sakuzu/maplibre-gl-draw';

const draw = createMapLibreGLDraw(map);

const parcels = draw.addDataset({
  id: 'parcels',
  features: [
    {
      id: 'p-1',
      type: 'Polygon',
      coordinates: [
        [
          [139.70, 35.68],
          [139.71, 35.68],
          [139.71, 35.69],
          [139.70, 35.68],
        ],
      ],
      properties: { population: 4200 },
    },
  ],
  styleRule: {
    kind: 'graduated',
    property: 'population',
    breaks: [1000, 5000, 10000],
    colors: ['#eff3ff', '#bdd7e7', '#6baed6', '#2171b5'],
    other: '#cccccc',
  },
  interactive: true,
});

parcels.on('click', ({ feature }) => {
  console.log(feature.id, feature.properties);
});
```

The polygon is drawn behind the drawn features, colored by its
`population`. A click on it logs its id and properties.

## Three ways to give the data

Choose by the form your data is in. Give only one of the three; giving
two throws.

| Your data | Option | Replace it with |
| --- | --- | --- |
| An array of features, such as GeoJSON | `features` | `setFeatures` |
| A table from GeoParquet, Arrow or FlatGeobuf | `columnar` | `setColumnar` |
| A server that answers for an extent | `provider` | `invalidateProviderCache` |

### An array of features

A feature has the same shape as a drawn feature (`id`, `type`,
`coordinates`, `properties`, `style`), polygons with holes and the Multi
types included. `layerId`, `locked` and `visible` can be left out.
Positions with a third element (an elevation from GeoJSON) are cut to
longitude and latitude.

`setFeatures` replaces the whole content. There is no partial update:
build the new array and pass it.

<!-- docs-check: with datasets -->

```ts
parcels.setFeatures(nextFeatures);
```

### A table as columns

A table read from GeoParquet, Arrow or FlatGeobuf is already a set of
columns. Turning every row into a feature object only to hand it over
costs more than drawing it: for a million points, most of the time and
most of the memory. `columnar` takes the rows as they are, in the layout
of GeoArrow: the coordinates in one `Float64Array`, the offsets of the
rows, parts and rings in `Int32Array`s, and the attributes as columns.

```ts
const places = draw.addDataset({
  id: 'places',
  columnar: {
    length: 3,
    geometry: {
      type: 'Point',
      coords: new Float64Array([139.70, 35.68, 139.71, 35.69, 139.72, 35.66]),
    },
    columns: {
      kind: { codes: new Uint8Array([0, 1, 0]), dictionary: ['shop', 'school'] },
      visitors: new Float64Array([3.5, 0.7, 3.0]),
    },
  },
  styleRule: {
    kind: 'categorical',
    property: 'kind',
    map: { shop: '#e15759', school: '#59a14f' },
    other: '#cccccc',
  },
});
```

A geometry column holds one geometry type. The offsets say where each
row starts, outermost first:

| Type | `offsets` |
| --- | --- |
| `Point` | none: row `i` is coordinate `i` |
| `LineString`, `MultiPoint` | `[row → coordinate]` |
| `Polygon` | `[row → ring, ring → coordinate]` |
| `MultiLineString` | `[row → part, part → coordinate]` |
| `MultiPolygon` | `[row → polygon, polygon → ring, ring → coordinate]` |

Row `i` behaves as a feature whose `properties` are the values of the
columns at `i`, and whose id is `String(ids[i])`, or `String(i)` without
an `ids` column. So the style rule, the base style, `zoomScale`, the
thinning, the order and the selection work as with features. A row has
no style of its own.

- A column is a typed array of numbers, a dictionary (`codes` and
  `dictionary`, as the dictionary type of Arrow), or a plain array. In a
  floating point column, NaN means no value
- A row without a geometry (an empty run, NaN coordinates for a point,
  or a 0 bit in `validity`) is neither drawn nor hit
- Pass only the columns that the rule and your own code read

The dataset keeps the arrays and reads them; it does not copy them. Do
not change them while it holds them, and replace the table with
`setColumnar`. A row becomes a feature object only when something asks
for one:

- `click` and `hover` carry the feature of the row and its `row`. Read
  the other values of the row from your own columns
- `getFeatures()` builds every row once, which costs what the features
  would have. `collectVisible(bounds)` builds the rows in the extent, and
  `collectDrawnRows(bounds)` builds none (see
  [Reading by row](#reading-by-row)). Snapping to datasets reads
  `getFeatures()`
- `externalPointRender` is called with the feature of each point row
- On a map with terrain, the lines and polygons draped over it are built
  as features

### Rows of different geometry types

A file whose rows mix points, lines and polygons is given as the mixed
geometry column of GeoArrow (a dense union of Arrow). There is no need
to split it by type. Each child is a geometry column of one type, as
above, and the geometry of row `i` is row `offsets[i]` of child
`types[i]`:

```ts
draw.addDataset({
  id: 'network',
  columnar: {
    length: 3,
    geometry: {
      type: 'Mixed',
      types: new Int8Array([1, 0, -1]),
      offsets: new Int32Array([0, 0, 0]),
      children: [
        { type: 'Point', coords: new Float64Array([139.70, 35.68]) },
        {
          type: 'LineString',
          coords: new Float64Array([139.71, 35.69, 139.72, 35.66]),
          offsets: [new Int32Array([0, 2])],
        },
      ],
    },
    columns: { name: ['route', 'station', 'unknown'] },
  },
});
```

- Row `i` behaves exactly as a feature of its child's type
- The rows of a child can be in any order. The rows are drawn in the
  order of the table
- A row with a negative `types[i]` has no geometry. `validity` still
  applies on top
- `prepareDatasetColumnar` and `columnarTransferables` take this form
  too

### Reading the table in a Worker

Before it can draw, the dataset computes the bounding box of every row,
splits the rows into spatial chunks and builds the spatial index for
clicks. For a large table this takes long enough to stop the page, so do
it where the table is read. `prepareDatasetColumnar` from the subpath
`@sakuzu/maplibre-gl-draw/columnar` does this work. The subpath imports
neither maplibre nor WebGL, so a Worker can use it, and
`columnarTransferables` lists the buffers to move without a copy.

<!-- docs-check:
declare function readTable(data: unknown): Promise<import('@sakuzu/maplibre-gl-draw').DatasetColumnarInput>;
-->

```ts
// worker.ts
import {
  columnarTransferables,
  prepareDatasetColumnar,
} from '@sakuzu/maplibre-gl-draw/columnar';

self.onmessage = async (event) => {
  const input = await readTable(event.data); // your reader returns a DatasetColumnarInput
  const prepared = prepareDatasetColumnar(input);
  const transfer = columnarTransferables(input, prepared);
  self.postMessage({ input, prepared }, { transfer });
};
```

<!-- docs-check: with datasets
declare const file: File;
-->

```ts
// main.ts
const worker = new Worker(new URL('./worker.ts', import.meta.url), {
  type: 'module',
});
worker.onmessage = (event) => {
  const { input, prepared } = event.data;
  places.setColumnar(input, prepared);
};
worker.postMessage(file);
```

With `prepared`, the main thread computes none of it again, and the
first click finds the index ready. Without it, `setColumnar` computes
the same arrays itself. `prepared` belongs to its table; one made for a
table of another length throws. `addDataset` takes it too, as the
`prepared` option next to `columnar`.

### Fetching what is in view

A `provider` is called when the part of the map in view changes, with
its extent and the zoom, and returns the features for it.

```ts
draw.addDataset({
  id: 'parcels',
  provider: async (bbox, zoom) => {
    const query = `${bbox.minX},${bbox.minY},${bbox.maxX},${bbox.maxY}`;
    const res = await fetch(`/api/parcels?bbox=${query}&z=${zoom}`);
    return res.json();
  },
});
```

- The calls are debounced (200 ms), so a continuous pan or zoom makes one
  call at the end
- The extent is rounded to an integer zoom and to tile boundaries. A move
  within the same tiles makes no call, and the `bbox` passed is the
  rounded one
- The results are cached per tile extent (the last 32). Coming back to an
  extent restores it without a call
- While a fetch is in flight the previous result stays on screen. The
  library shows no spinner
- Only the answer to the latest request is applied; an older answer that
  arrives late is dropped
- A rejected promise leaves the display as it is and is logged with
  `console.error`

When what the provider returns changes for another reason, such as a new
filter, call `invalidateProviderCache()`. It empties the cache, drops a
request in flight together with its answer, and fetches the current
extent again, so the new content appears without moving the map.

## Style

`styleRule` takes the same rule as a layer (`single`, `categorical`,
`graduated`, `continuous`; see [styles](styles.md)). A rule decides only
the color. The width, the line style, the opacity and the point size come
from `baseStyle`, one partial `FeatureStyle` per channel:

<!-- docs-check: with datasets -->

```ts
parcels.setBaseStyle({
  stroke: { strokeWidth: 1, strokeColor: '#3366cc' },
  fill: { fillOpacity: 0.4 },
  point: { pointRadius: 4 },
});
```

When several of them set the same thing, the first one below wins.

1. The feature's own `style`
2. The color of the rule, for its channel only
3. `baseStyle`
4. The defaults

`setStyleRule(undefined)` and `setBaseStyle(undefined)` remove them.

`zoomScale` multiplies the size and the opacity by factors that depend on
the zoom. It is evaluated every frame and never rebuilds the batches.

<!-- docs-check: with datasets -->

```ts
parcels.setZoomScale((zoom) => ({
  scale: zoom < 12 ? 0.5 : 1,
  opacity: 1,
}));
```

## Order against drawn features

`order` places a dataset against the drawn features:

| order | Position |
| --- | --- |
| `below-store` | Behind every layer of the Store (the default) |
| `above-store` | In front of every layer, behind the selection UI |
| `layer-order` | At the position of its id in `setLayerOrder()` |

Datasets on the same side are drawn in the order they were added, the
later one in front. Inside a dataset, the end of the array (or the last
row of the table) is in front. `getDatasets()` returns every dataset
from the back to the front, and `moveDataset` changes the side, the
position within the side, or both. Moving never rebuilds anything. A
move that changes the order or the side fires `draw.dataset.reorder`
with the ids from the back to the front; a move that leaves everything
where it was fires nothing.

```ts
draw.moveDataset('parcels', { order: 'above-store' });
draw.moveDataset('parcels', { index: 0 }); // backmost of its side
```

A `layer-order` dataset is drawn only while its id is in the layer
order, and it is placed by that order alone:

<!-- docs-check: with datasets -->

```ts
draw.addDataset({ id: 'parcels', features, order: 'layer-order' });
draw.setLayerOrder(['base', 'parcels', 'notes']);
```

Removing the dataset does not edit the layer order; remove the id with
`setLayerOrder` yourself (an id left behind is skipped).

The layer order is part of the document, but a dataset is not: the
native format saves the id at its position and not the features. After a
load, add the dataset again with the same id, and it is drawn at the
saved position ([Layers](layers.md)).

## Thinning points that overlap

Many points drawn at a low zoom cover each other and turn into a solid
patch. `collisionThinning` draws only some of them: where the markers of
two points overlap on screen, the one in front is drawn and the other is
not. Zooming in spreads the points apart, so more of them are drawn.

<!-- docs-check:
declare const features: import('@sakuzu/maplibre-gl-draw').DatasetFeatureInput[];
-->

```ts
const places = draw.addDataset({
  id: 'places',
  features,
  collisionThinning: { enabled: true, fullDisplayZoom: 17, marginPx: 2 },
});

const { total, visible } = places.getThinningStats();
```

- The test uses the drawn size (radius, outline and `marginPx`), so
  larger markers thin more
- Only `Point` is thinned; lines, polygons and `MultiPoint` are always
  drawn
- From `fullDisplayZoom` (17) on, every point is drawn
- A thinned point is neither drawn nor hit
- `getThinningStats()` tells how many points are drawn out of how many,
  for a message such as "showing 1,200 of 50,000"

### Which points are drawn, and when

The points drawn are chosen per integer zoom from all the points, not
from the part in view, so panning never swaps them.

Each frame takes the integer zoom from the zoom it draws with, in the
middle of a zoom or pitch gesture as well, and draws the points chosen
for that zoom. The points for the nearby integer zooms are chosen ahead
while the page is idle, so crossing into them costs nothing. When the
features, the style, the zoom factors or the settings change, the points
are chosen again at once and the next frame draws them.

So there is nothing to call when the camera moves, nor before taking a
picture at a given camera: the frame that draws it decides its points.
To know which rows are drawn, read them by row
([Reading by row](#reading-by-row)); `getDrawnRowsRevision()` tells when
they changed.

## Clicks, hover and selection

`click` and `hover` fire only with `interactive: true`. `hover` fires
when the target changes, and once with `feature: null` when the pointer
leaves it. Both carry the `row` of the feature: its index in the features
given (or in the answer of the provider), or its row in a columnar table.
`on` returns the function that unsubscribes.

<!-- docs-check: with datasets -->

```ts
places.on('hover', ({ feature }) => {
  map.getCanvas().style.cursor = feature ? 'pointer' : '';
});
```

One click has one target: the frontmost visible feature, whether it is
a drawn feature or a feature of a dataset.

- A visible dataset blocks the features under it, whether or not it is
  interactive
- When a dataset takes the click, the Store's selection is cleared, as
  for a click on empty space
- The instance event `draw.dataset.click` reports every click of the
  select mode that did not hit a drawn feature: the dataset and the
  feature, or `null` for both when nothing was hit

`setSelectedIds` highlights features of the dataset. It is a state of
the dataset only, separate from the Store's selection, and it
never rebuilds the batches.

<!-- docs-check: with datasets -->

```ts
places.setSelectedIds(['place-12']);
places.setSelectedIds([]); // clear
```

The `change` event fires, whatever `interactive` is, when the features,
the style, the visibility, the selection or the points kept by the
thinning change. Its `reason` says which. Use it to rebuild what you
derive from the dataset, such as labels. A change you make fires it at
once; a new integer zoom entered by the camera fires it (`thinning`)
right after the frame that drew the new points.

`collectVisible(bounds)` returns the features in an extent, in draw
order and with the styles applied. Its cost follows the number of
features in the extent, not the total.

## Reading by row

Code that walks only what is drawn, such as placing text next to
points, can read a dataset by row number and build features only for
the rows it keeps.

`collectDrawnRows(bounds)` returns the rows that intersect an extent and
are drawn now, in draw order: the rows with a geometry that are not
hidden and that the thinning keeps. It builds no feature, so its cost
follows the number of rows in the extent. "Drawn now" means the rows of
the most recent frame. A frame decides its integer zoom before anything
of it is drawn, so a layer that draws in the same frame reads the rows
that frame draws.

`getDrawnRowsRevision()` is a number that advances whenever the drawn
rows change (the contents replaced, or the points kept by the thinning).
It costs nothing to read, so keep what you derive from the drawn rows
under it and rebuild when it moves. `getVisibleFeatureIds()` returns the
same rows as a set of ids, built on the first request after each change
with one pass over every row; do not use it, or its identity, as the key
of such a cache.

<!-- docs-check: with datasets -->

```ts
// Place the text again only when the drawn rows changed
let placedFor = -1;
function placeText(): void {
  const revision = places.getDrawnRowsRevision();
  if (revision === placedFor) return;
  placedFor = revision;
  // ... walk places.collectDrawnRows(extent) and place the text
}
```

The reads of one row do not build its feature either.

| Method | Returns |
| --- | --- |
| `getRowId(row)` | The id |
| `getRowType(row)` | The geometry type |
| `getRowBounds(row)` | The box the spatial index holds |
| `getRowPoint(row)` | The `[lng, lat]` of a `Point` |
| `getRowFeature(row)` | The feature, styled as `collectVisible` returns it |
| `findRow(id)` | The row of an id, or `null` (the first call indexes) |

A row is the `row` of `click` and `hover`, and the numbers hold until
the contents are replaced.

<!-- docs-check: with datasets -->

```ts
// The first point of each 0.01 degree cell, in draw order
const extent = { minX: 139.6, minY: 35.6, maxX: 139.9, maxY: 35.8 };
const taken = new Set<string>();
const names: string[] = [];
for (const row of places.collectDrawnRows(extent)) {
  const point = places.getRowPoint(row);
  if (!point) continue;
  const cell = `${Math.floor(point[0] / 0.01)}:${Math.floor(point[1] / 0.01)}`;
  if (taken.has(cell)) continue;
  taken.add(cell);
  const feature = places.getRowFeature(row);
  if (feature) names.push(String(feature.properties.name));
}
```

## Showing and hiding

`setVisible(false)` stops drawing and hit testing but keeps the features
and the GPU resources, so `setVisible(true)` shows the dataset in the
next frame. `setFeatures`, `setStyleRule` and a provider keep working
while it is hidden. `remove()` (or `removeDataset(id)`) lets go of
everything.

## Following the datasets that come and go

`draw.dataset.add` fires when a dataset is added and
`draw.dataset.remove` when one is removed. Both carry its `datasetId`.
When the add event arrives, `getDataset` already returns the dataset;
when the remove event arrives, it no longer does. Moving a dataset (that
is `draw.dataset.reorder`) and changing its contents fire neither. The
datasets that exist before you subscribe are not announced, so walk
`getDatasets()` once, then follow the events.

<!-- docs-check:
type Dataset = import('@sakuzu/maplibre-gl-draw').Dataset;
declare function watch(dataset: Dataset): () => void;
-->

```ts
const stops = new Map<string, () => void>();
const follow = (id: string): void => {
  const dataset = draw.getDataset(id);
  if (dataset) stops.set(id, watch(dataset));
};

for (const dataset of draw.getDatasets()) follow(dataset.id);
draw.on('draw.dataset.add', ({ datasetId }) => follow(datasetId));
draw.on('draw.dataset.remove', ({ datasetId }) => {
  stops.get(datasetId)?.();
  stops.delete(datasetId);
});
```

A dataset removed and added again under the same id is a new object, so
it arrives as a remove and then an add.

## Drawing points yourself

`externalPointRender` is a predicate: for a `Point` for which it returns
true, the library draws nothing, and your own renderer draws it. The
point still takes part in thinning, hit testing and selection, so the
behavior stays the same. `setExternalPointRender` replaces it later.

<!-- docs-check: with datasets -->

```ts
draw.addDataset({
  id: 'stations',
  features,
  externalPointRender: (feature) => feature.properties.kind === 'station',
});
```

## Taking a picture

On screen, a large dataset fills in over several frames. A map that
draws a frame to read the picture back, for a print or a thumbnail, sets
`renderingStyle.timeSlicing` to `false`, so that every frame builds all
the chunks in view. Then it waits for the map's `idle` and for
`hasPendingWork()` to be false, which also covers the answer of a
provider:

```ts
async function whenPictureComplete(): Promise<void> {
  map.triggerRepaint();
  await map.once('idle');
  while (draw.hasPendingWork()) await map.once('render');
}
```

The thinning needs nothing: the frame decides which points it draws. See
[performance](performance.md#complete-frames-for-a-picture).

## Read-only and locks

A dataset is outside the three states of [read-only](read-only.md). It
can be added and replaced while the Store is read-only, its `click` and
`hover` fire while the interaction lock is on, and local hiding does not
apply to it. Show and hide it with `setVisible` or by removing it.

## Limits

- A dataset cannot be edited. Copy a feature into the Store with
  `addFeature` to edit it
- Its contents are replaced as a whole; there is no partial update
- It is not saved or exported. Keep the data, or the address it came
  from, yourself, and add the dataset again after a load
- A row of a columnar table has no style of its own
- The thinning applies to `Point` only
- A columnar table is read in place: do not change its arrays while the
  dataset holds them

## Examples

- [Datasets](../../examples/large-data/) adds 50,000 cells colored by a
  property and points fetched for the part of the map in view, with
  thinning, clicks and reordering
- [A million points](../../examples/columnar-worker/) builds 200,000 or
  1,000,000 points as columns in a Worker, prepares them there and hands
  them over without a copy

For the size at which to choose a dataset over drawn features, see
[performance](performance.md).

## Reference

- [addDataset](../reference/api/interfaces/index.MapLibreGLDraw.html)
  and the other dataset methods of `MapLibreGLDraw`
- [Dataset](../reference/api/interfaces/index.Dataset.html)
- [DatasetOptions](../reference/api/interfaces/index.DatasetOptions.html)
- [DatasetColumnarInput](../reference/api/interfaces/index.DatasetColumnarInput.html)
  and [prepareDatasetColumnar](../reference/api/functions/columnar.prepareDatasetColumnar.html)
- [DatasetCollisionThinning](../reference/api/interfaces/index.DatasetCollisionThinning.html)
- [DatasetChangePayload](../reference/api/interfaces/index.DatasetChangePayload.html)
- [events](../reference/events.md) for `draw.dataset.click`,
  `draw.dataset.add`, `draw.dataset.remove` and `draw.dataset.reorder`
