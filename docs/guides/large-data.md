# Showing large data

A dataset shows many features that the user does not edit:
tens of thousands of parcels, a table of places, the result of a query. It
draws them with the same renderers and the same style rules as the drawn
features, but it is a separate path from the Store, so it carries none of
the cost of editing.

A dataset is not in the Store. That has four consequences:

- It cannot be edited. There is no move, no vertex editing and no geometry
  operation on it
- It fires no `draw.feature.*` event, so a subscriber of the Store's
  changes does not see it
- It is never selected by the Store's selection, and it gets no handles or
  bounding box
- `getAllFeatures()`, `export()` and saving do not see it

To edit one of its features, copy it into the Store with `addFeature`. The
library does not keep the two copies related.

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
`population`, and a click on it logs the feature. A feature has the same
shape as a Store feature (`id`, `type`, `coordinates`, `properties`,
`style`), including polygons with holes and the Multi types. `layerId`,
`locked` and `visible` can be left out. Positions with a third element (an
elevation from GeoJSON) are cut to longitude and latitude.

## Static features and a provider

Give the features either once, with `features`, or on demand, with
`provider`. Giving both throws. A large table can also be given as
columns of typed arrays; see [Columns of typed arrays](#columns-of-typed-arrays).

`setFeatures` replaces the whole content of a static dataset. There is
no partial update: build the new array and pass it.

<!-- docs-check: with datasets -->

```ts
parcels.setFeatures(nextFeatures);
```

A `provider` is called when the visible extent changes, with the extent
and the zoom, and returns the features for it.

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

## Columns of typed arrays

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

A geometry column holds one geometry type (a table whose rows have
different types is described below). The offsets say where each row
starts, outermost first:

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
no individual style. A column is a typed array of numbers, a dictionary
(`codes` and `dictionary`, as the dictionary type of Arrow), or a plain
array; in a floating point column, NaN means no value. A row without a
geometry (an empty run, NaN coordinates for a point, or a 0 bit in
`validity`) is neither drawn nor hit. Pass only the columns that the rule
and your own code read.

The dataset keeps the arrays and reads them; it does not copy them.
Do not change them while it holds them, and replace the table with
`setColumnar`. The rows are packed straight into the arrays of the GPU,
and a row becomes a feature only when one is asked for:

- `click` and `hover` carry the feature of the row and its `row`. Read
  the other values of the row from your own columns
- `getFeatures()` builds every row once, which costs what the features
  would have. `collectVisible(bounds)` builds the rows in the extent, and
  `collectDrawnRows(bounds)` builds none (see
  [Reading by row](#reading-by-row)). The snapping to display data reads
  `getFeatures()`
- `externalPointRender` is called with the feature of each point row
- On a map with terrain, the lines and polygons handed to the drape are
  built as features

### Rows of different types

A table whose rows have different geometry types, such as a file of
points, lines and polygons, is given as the mixed geometry column of
GeoArrow (a dense union of Arrow). Each child is a geometry column of one
type, as above. The geometry of row `i` is row `offsets[i]` of child
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

Row `i` behaves exactly as the feature of its child's type. The rows of
a child can be in any order; the rows are drawn in the order of the
table. A row with a negative `types[i]` has no geometry, and `validity`
still applies on top. `prepareDatasetColumnar` and
`columnarTransferables` take this form too.

### Reading in a Worker

Before it can draw, the dataset computes the bounding box of every
row, splits the rows into spatial chunks and builds the spatial index of
the hit testing. `prepareDatasetColumnar` from the subpath
`@sakuzu/maplibre-gl-draw/columnar` does that work where the table is
read. The subpath imports neither maplibre nor WebGL, so a Worker can use
it, and `columnarTransferables` lists the buffers to move without a copy.

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
first hit test finds the index ready. Without it, `setColumnar` computes
the same arrays itself. `prepared` belongs to its table; one made for a
table of another length throws.

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

The order of precedence is: the feature's own `style`, then the rule
color (for the matching channel only), then `baseStyle`, then the
defaults. `setStyleRule(undefined)` and `setBaseStyle(undefined)` remove
them.

`zoomScale` multiplies the size and the opacity by factors that depend on
the zoom. It is evaluated every frame and never rebuilds the batches.

<!-- docs-check: with datasets -->

```ts
parcels.setZoomScale((zoom) => ({
  scale: zoom < 12 ? 0.5 : 1,
  opacity: 1,
}));
```

## Order

`order` places a dataset against the Store:

| order | Position |
| --- | --- |
| `below-store` | Behind every layer of the Store (the default) |
| `above-store` | In front of every layer, behind the selection UI |
| `layer-order` | At the position of its id in `setLayerOrder()` |

Datasets on the same side are drawn in the order they were added, the
later one in front. Inside a dataset, the end of the array is in front.
`getDatasets()` returns every dataset from the back to the
front, and `moveDataset` changes the side, the position within
the side, or both. Moving never rebuilds anything. A move that changes
the order or the side fires `draw.dataset.reorder` with the ids from the
back to the front; a move that leaves everything where it was fires
nothing.

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

## Collision thinning of points

Many points drawn at a low zoom cover each other. `collisionThinning`
stops drawing the point markers that overlap on screen:

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

- The test uses the drawn size (radius, outline and margin), so larger
  markers thin more
- The winners are decided per integer zoom from all the features, not
  from the view, so panning never swaps them. The front one wins
- Only `Point` is thinned; lines, polygons and `MultiPoint` are always
  drawn
- From `fullDisplayZoom` (17) on, every point is drawn
- The winners are chosen again when the features or the style change, and
  each time the integer zoom changes, in the middle of a zoom or pitch
  gesture as well. The winners of the nearby integer zooms are chosen
  ahead while the page is idle, so crossing into them costs no selection

A thinned point is neither drawn nor hit. `getVisibleFeatureIds` tells
which points are drawn, for a host that labels only those, and
`getThinningStats` how many. When one picture is taken at a given zoom,
such as a snapshot of the view, call `refreshThinning(zoom)` first.

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

A visible dataset blocks the features under it whether or not it is
interactive. One target receives a click: the frontmost visible feature,
whether it belongs to the Store or to a dataset. When a dataset
wins, the Store's selection is cleared, as for a click on empty space.
The instance event `draw.dataset.click` reports every click of the select
mode that did not hit the Store: the dataset and the feature, or
`null` for both when nothing was hit.

`setSelectedIds` highlights features of the dataset. It is a state of
the dataset only, separate from the Store's selection, and it never
rebuilds the batches.

<!-- docs-check: with datasets -->

```ts
places.setSelectedIds(['place-12']);
places.setSelectedIds([]); // clear
```

The `change` event fires, whatever `interactive` is, when the features,
the style, the visibility, the selection or the winners of the thinning
change. Its `reason` says which. Use it to rebuild what you derive from
the dataset, such as labels. `collectVisible(bounds)` returns the
features in an extent, in draw order and with the styles applied; its
cost follows the number of features in the extent, not the total.

## Reading by row

Code that walks only what is drawn, such as placing text next to
points, can read a dataset by row number and build features only for
the rows it keeps. `collectDrawnRows(bounds)` returns the rows that
intersect an extent and are drawn now, in draw order: the rows with a
geometry that are not hidden and that the collision thinning keeps. It
is `collectVisible(bounds)` narrowed with `getVisibleFeatureIds()`, but
it builds no feature, so its cost follows the number of rows in the
extent.

The reads of one row do not build its feature either: `getRowId`,
`getRowType`, `getRowBounds` (the box the spatial index holds) and
`getRowPoint` (the `[lng, lat]` of a `Point`). `getRowFeature` builds
the feature of a row with the styles applied, as `collectVisible`
returns it. A row is the `row` of `click` and `hover`, and the numbers
hold until the contents are replaced.

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
while it is hidden. `remove()` (or `removeDataset(id)`) lets go
of everything.

## Following the datasets that come and go

`draw.dataset.add` fires when a dataset is added and
`draw.dataset.remove` when one is removed. Both carry its
`datasetId`. When the add event arrives, `getDataset`
already returns the dataset; when the remove event arrives, it no
longer does. Moving a dataset (that is `draw.dataset.reorder`) and changing its
contents fire neither.
The datasets that exist before you subscribe are not announced, so
walk `getDatasets()` once, then follow the events.

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

A dataset removed and added again under the same id is a new object,
so it arrives as a remove and then an add.

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

## Read-only, locks and local visibility

A dataset is outside the three states of
[read-only](read-only.md). It can be added and replaced while the Store
is read-only, its `click` and `hover` fire while the interaction lock is
on, and local hiding does not apply to it. Show and hide it with
`setVisible` or by removing it.

## Related example

- [examples/large-data/](../../examples/large-data/) adds 50,000
  static polygons and a provider-backed dataset, with a style rule,
  thinning, clicks and reordering
- [examples/columnar-worker/](../../examples/columnar-worker/)
  builds 200,000 or 1,000,000 points as columns in a Worker, prepares
  them there and hands them over without a copy

For the size at which to choose a dataset over the Store, see
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
