# Showing large data

A dataset shows many rows fast, in exchange for not being editable:
tens of thousands of parcels, a million points, the answer of a server.
You pass it all at once, or fetch only what is in view each time the map
moves. It is styled by the same style rules as drawn features, and a
click reads its properties.

This guide starts with when to use a dataset and why it is fast, then
shows how to give it rows, how to style them and how to read them back.

## When to use a dataset

Use a dataset for data that is shown but not edited. For example:

- The 50,000 parcels of a city behind a drawing, colored by land use.
  The user draws new boundaries over them, and snapping follows their
  edges and vertices
- A million sensor points read from a GeoParquet file
- Administrative boundaries shown as a backdrop
- Points on a server, fetched for the part of the map in view each time
  the map moves

What the user draws and edits belongs in the document. A dataset is
drawn but is not part of the document. When the user needs to edit one
row, copy it into the document with `draw.features.create`. The library
does not keep the two copies related.

<!-- docs-check: with datasets -->

```ts
const row = places.getRow(0);
if (row?.geometry) {
  draw.features.create({
    type: row.geometry.type,
    geometry: row.geometry,
    properties: { ...row.properties },
  });
}
```

## How a dataset differs from drawn features

| | Drawn features | A dataset |
| --- | --- | --- |
| Editing | Move, vertices, geometry | None |
| Events | `feature.created` and others | `clicked`, `hovered`, `changed` |
| Selection | A frame and handles | A highlight (`setSelectedRowIds`) |
| Saving | `document.toJSON()` | Not saved, only its ID in the order |
| Size | 200,000 stay editable | Tens of thousands to millions |

A dataset is fast because it skips everything that editing needs and
is drawn its own way:

- The rows are split into pieces by area. The pieces are sent to the GPU
  a few at a time, so a large dataset fills in like tiles arriving and
  the page does not stop
- Only the pieces in view are drawn
- A table goes from its typed arrays straight to the GPU, without an
  object per row. The work before drawing (the extents of the rows, the
  pieces and the index for clicks) can be done in a Worker
- With a provider, only the rows of the part in view are held, so the
  total size of the source does not matter

## The smallest example

```ts
import { createDraw } from '@sakuzu/maplibre-gl-draw';

const draw = createDraw(map);

const parcels = draw.datasets.add({
  id: 'parcels',
  rows: [
    {
      type: 'Feature',
      id: 'p-1',
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [139.70, 35.68],
            [139.71, 35.68],
            [139.71, 35.69],
            [139.70, 35.68],
          ],
        ],
      },
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

parcels.on('clicked', ({ row }) => {
  console.log(row.id, row.properties);
});
```

The polygon is drawn behind the drawn features, colored by its
`population`. A click on it logs its ID and properties.

## Three ways to give the rows

Choose by the form your data is in. Give only one of the three; giving
two throws a `DrawError` with the code `invalid-input`. With none of them
the dataset starts empty: it can be placed at once, and its rows come
later with `setRows` or `setTable`.

| Your data | Option | Replace it with |
| --- | --- | --- |
| An array of GeoJSON features | `rows` | `setRows` |
| A table from GeoParquet, Arrow or FlatGeobuf | `table` | `setTable` |
| A server that answers for an extent | `provider` | `refresh` |

### An array of features

A row is a GeoJSON feature (`id`, `geometry`, `properties`), polygons
with holes and the Multi types included. A row without a geometry keeps
its place but is neither drawn nor hit. Positions with a third element
(an elevation) are cut to longitude and latitude.

`setRows` replaces every row. There is no partial update: build the new
array and pass it.

<!-- docs-check: with datasets -->

```ts
parcels.setRows(nextRows);
```

### A table

A table read from GeoParquet, Arrow or FlatGeobuf is already a set of
columns. Turning every row into a feature object only to hand it over
costs more than drawing it: for a million points, most of the time and
most of the memory. `table` takes the rows as they are, in the layout
of GeoArrow: the coordinates in one `Float64Array`, the offsets of the
rows, parts and rings in `Int32Array`s, and the attributes as columns.

```ts
const places = draw.datasets.add({
  id: 'places',
  table: {
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

Row `i` behaves as a GeoJSON feature whose `properties` are the values
of the columns at `i`, and whose ID is `String(ids[i])`, or `String(i)`
without an `ids` column. So the style rule, the base style, `zoomScale`,
the thinning, the order and the selection work as with features. A row
of a table has no style of its own.

- A column is a typed array of numbers, a dictionary (`codes` and
  `dictionary`, as the dictionary type of Arrow), or a plain array. In a
  floating point column, NaN means no value
- A row without a geometry (an empty run, NaN coordinates for a point,
  or a 0 bit in `validity`) is neither drawn nor hit
- Pass only the columns that the rule and your own code read

The dataset keeps the arrays and reads them; it does not copy them. Do
not change them while it holds them, and replace the table with
`setTable`. A row becomes a feature object only when something asks
for one:

- `clicked` and `hovered` carry the row and its `rowIndex`. Read the
  other values of the row from your own columns
- `listRows()` builds every row once, which costs what the features
  would have. `listVisibleRows(bbox)` builds the rows in the extent, and
  `listDrawnRows(bbox)` builds none (see
  [reading by row](#reading-by-row)). Snapping to datasets builds the
  rows too
- `externalPointRender` is called with each point row
- On a map with terrain, the lines and polygons draped over it are built
  as features

### Building a table from GeoJSON

When the rows come as GeoJSON features but are too many to hand over as
objects, the subpath `@sakuzu/maplibre-gl-draw/table` builds the table:
`tableFromFeatures` takes an array of features, and
`createTableBuilder` takes one row at a time.

<!-- docs-check:
declare const features: import('geojson').Feature[];
-->

```ts
import { createTableBuilder, tableFromFeatures } from '@sakuzu/maplibre-gl-draw/table';

draw.datasets.add({ id: 'shops', table: tableFromFeatures(features) });

const builder = createTableBuilder({ geometryType: 'Point' });
builder.add({ type: 'Point', coordinates: [139.70, 35.68] }, { name: 'A' });
builder.add({ type: 'Point', coordinates: [139.71, 35.69] }, { name: 'B' });
draw.datasets.add({ id: 'stations', table: builder.finish() });
```

A builder given a `geometryType` throws for a row of another type.
Without one, the builder makes the mixed column of the next section when
the rows have different types.

### Rows of different geometry types

A file whose rows mix points, lines and polygons is given as the mixed
geometry column of GeoArrow (a dense union of Arrow). There is no need
to split it by type. Each child is a geometry column of one type, as
above, and the geometry of row `i` is row `offsets[i]` of child
`types[i]`:

```ts
draw.datasets.add({
  id: 'network',
  table: {
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
- `prepareTable` and `transferList` take this form too

### Reading the table in a Worker

Before it can draw, the dataset computes the extent of every row, splits
the rows into pieces by area and builds the index for clicks. For a
large table this takes long enough to stop the page, so do it where the
table is read. `prepareTable` from the subpath
`@sakuzu/maplibre-gl-draw/table` does this work and returns the table
with it. The subpath imports neither maplibre nor WebGL, so a Worker can
use it, and `transferList` lists the buffers to move without a copy.

<!-- docs-check:
declare function readTable(data: unknown): Promise<import('@sakuzu/maplibre-gl-draw/table').Table>;
-->

```ts
// worker.ts
import { prepareTable, transferList } from '@sakuzu/maplibre-gl-draw/table';

self.onmessage = async (event) => {
  const table = await readTable(event.data); // your reader returns a Table
  const prepared = prepareTable(table);
  self.postMessage(prepared, { transfer: transferList(prepared) });
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
  places.setTable(event.data);
};
worker.postMessage(file);
```

With a prepared table, the main thread computes none of it again, and
the first click finds the index ready. Given a bare table, `setTable`
computes the same arrays itself. `draw.datasets.add` takes either as
the `table` option.

A prepared table also tells its number of rows (`length`) and its
extent (`bounds`, `[west, south, east, north]`, or `null` when no row has
a geometry), for example to fit the map to what was read:

<!-- docs-check:
declare const prepared: import('@sakuzu/maplibre-gl-draw/table').PreparedTable;
-->

```ts
if (prepared.bounds) map.fitBounds(prepared.bounds, { padding: 20 });
console.log(`${prepared.length} rows`);
```

### Fetching what is in view

A `provider` is called when the part of the map in view changes, with
its extent as `[west, south, east, north]` in degrees and the zoom, and
returns the rows for it.

```ts
draw.datasets.add({
  id: 'parcels',
  provider: async ([west, south, east, north], zoom) => {
    const query = `${west},${south},${east},${north}`;
    const res = await fetch(`/api/parcels?bbox=${query}&z=${zoom}`);
    return (await res.json()).features;
  },
});
```

- The calls wait for the map to rest (200 ms), so a continuous pan or
  zoom makes one call at the end
- The extent is rounded to an integer zoom and to tile boundaries. A move
  within the same tiles makes no call, and the extent passed is the
  rounded one
- The answers are kept per extent (the last 32). Coming back to an
  extent shows it again without a call
- While a fetch is in flight the previous rows stay on screen. The
  library shows no spinner
- Only the answer to the latest request is used; an older answer that
  arrives late is dropped
- A rejected promise leaves the rows as they are and is logged with
  `console.error`

When what the provider returns changes for another reason, such as a new
filter, call `refresh()`. It forgets the kept answers, drops a request
in flight together with its answer, and fetches the current extent
again, so the new rows appear without moving the map.

## Style

`styleRule` takes the same rule as a layer (`single`, `categorical`,
`graduated`, `continuous`; see [styles](styles.md)). A rule decides only
the color. The width, the line style, the opacity and the point size come
from `baseStyle`, one partial `FeatureStyle` for each part a rule colors:

<!-- docs-check: with datasets -->

```ts
parcels.setBaseStyle({
  stroke: { strokeWidth: 1, strokeColor: '#3366cc' },
  fill: { fillOpacity: 0.4 },
  point: { pointRadius: 4 },
});
```

When several of them set the same thing, the first one below wins.

1. The row's own `style`, for rows given as features
2. The color of the rule, for its part only
3. `baseStyle`
4. The defaults

`style` is a member of `DatasetRow`, a `FeatureStyle`. A row read back
with `getRow`, `listRows` or `listVisibleRows` carries its own `style`
merged over `baseStyle`.

`setStyleRule(undefined)` and `setBaseStyle(undefined)` remove them;
`getStyleRule()` and `getBaseStyle()` read them back, as a legend does.

`zoomScale` multiplies the size and the opacity by factors that depend on
the zoom. It is called each time the map is drawn, and changing what it
returns rebuilds nothing.

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
| `below-store` | Behind every layer of the document (the default) |
| `above-store` | In front of every layer, behind the selection handles |
| `layer-order` | At its ID in the stacking order of the layers |

Datasets on the same side are drawn in the order they were added, the
later one in front. Inside a dataset, the end of the array (or the last
row of the table) is in front. `draw.datasets.list()` returns every
dataset from the back to the front, and `draw.datasets.move` changes the
side, the position within the side, or both. Moving never rebuilds
anything. A move that changes the order or the side fires
`dataset.reordered` with the IDs from the back to the front; a move that
leaves everything where it was fires nothing.

```ts
draw.datasets.move('parcels', { order: 'above-store' });
draw.datasets.move('parcels', { index: 0 }); // backmost of its side
```

A `layer-order` dataset is drawn only while its ID is in the stacking
order of the document (`draw.getStore().getLayerOrder()`), and it is
placed by that order alone. Put the ID there with `draw.layers.reorder`,
which takes the IDs of `layer-order` datasets besides the IDs of the
layers; an entry it is not given keeps its position. The entry also comes
with a loaded document, whose stacking order keeps the ID at its
position, or from a Store of your own passed as the `store` option.

<!-- docs-check:
declare const notes: import('@sakuzu/maplibre-gl-draw').Layer;
declare const roads: import('@sakuzu/maplibre-gl-draw').Layer;
-->

```ts
// Empty until its rows are given with setRows or setTable
draw.datasets.add({ id: 'parcels', order: 'layer-order' });
draw.layers.reorder([roads.id, 'parcels', notes.id]); // between the two layers
```

Removing the dataset does not edit the stacking order. An ID left there
without a dataset is skipped.

The stacking order is part of the document, but a dataset is not: the
native format saves the ID at its position and not the rows. After a
load, add the dataset again with the same ID, and it is drawn at the
saved position ([layers](layers.md)).

## Thinning points that overlap

Many points drawn at a low zoom cover each other and turn into a solid
patch. `collisionThinning` draws only some of them: where the markers of
two points overlap on screen, the one in front is drawn and the other is
not. Zooming in spreads the points apart, so more of them are drawn.

<!-- docs-check:
declare const rows: import('@sakuzu/maplibre-gl-draw').DatasetRow[];
-->

```ts
const places = draw.datasets.add({
  id: 'places',
  rows,
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
- `setCollisionThinning` changes the thinning later, and `null` turns it
  off

### Which points are drawn, and when

The points drawn are chosen for each integer zoom from all the points,
not from the part in view, so panning never swaps them.

Each drawing of the map takes the integer zoom it draws at, in the middle
of a zoom or pitch gesture as well, and draws the points chosen for that
zoom. The points for the nearby integer zooms are chosen ahead while the
page is idle, so crossing into them costs nothing. When the rows, the
style, the zoom factors or the settings change, the points are chosen
again at once and the next drawing shows them.

So there is nothing to call when the camera moves, nor before taking a
picture at a given camera: the drawing decides its points. To know which
rows are drawn, read them by row ([reading by row](#reading-by-row));
`getDrawnRowsRevision()` tells when they changed.

## Clicks, hover and selection

`clicked` and `hovered` fire only with `interactive: true`, which also
makes the rows candidates for snapping. `hovered` fires when the target
changes, and once with `row` and `rowIndex` set to `null` when the
pointer leaves it. Both carry the `rowIndex` of the row: its index in
the rows given (or in the answer of the provider), or its row in a
table. `on` returns the function that unsubscribes.

<!-- docs-check: with datasets -->

```ts
places.on('hovered', ({ row }) => {
  map.getCanvas().style.cursor = row ? 'pointer' : '';
});
```

One click has one target: the frontmost visible thing, whether it is a
drawn feature or a row of a dataset.

- A visible dataset blocks the features under it, whether or not it is
  interactive
- When a dataset takes the click, the selection of the document is
  cleared, as for a click on empty space
- The instance event `dataset.clicked` reports the click on a row of
  any dataset, with the `datasetId`, and `map.clicked` every click, with
  what it hit in `hit` (`null` for empty space)

```ts
draw.on('dataset.clicked', ({ datasetId, row }) => {
  console.log(datasetId, row.id);
});
```

`setSelectedRowIds` highlights rows of the dataset. It belongs to the
dataset only, apart from the selection of the document, and it rebuilds
nothing.

<!-- docs-check: with datasets -->

```ts
places.setSelectedRowIds(['place-12']);
places.setSelectedRowIds([]); // clear
```

The `changed` event fires, whatever `interactive` is, when the rows,
the style, the visibility, the selection or the points kept by the
thinning change. Its `reason` says which. Use it to rebuild what you
derive from the dataset, such as a list next to the map. A change you
make fires it at once; a new integer zoom entered by the camera fires it
(`thinning`) right after the drawing that shows the new points.

`listVisibleRows(bbox)` returns the rows in an extent, in drawing order
and with the style applied. Its cost follows the number of rows in the
extent, not the total.

## Reading by row

Code that walks only what is drawn, such as placing text next to
points, can read a dataset by row index and build features only for the
rows it keeps.

`listDrawnRows(bbox)` returns the indexes of the rows that meet an
extent and are drawn now, in ascending order: the rows with a geometry
that are not hidden and that the thinning keeps. It builds no feature,
so its cost follows the number of rows in the extent. "Drawn now" means
the rows of the latest drawing of the map. A drawing decides its integer
zoom before anything of it is drawn, so an overlay that draws at the same
time reads the rows that drawing shows.

`getDrawnRowsRevision()` is a number that changes whenever the drawn
rows change (the rows replaced, or the points kept by the thinning). It
costs nothing to read, so keep what you derive from the drawn rows under
it and rebuild when it moves. `listVisibleRowIds()` returns the same
rows as a set of IDs (or `null` when the thinning hides nothing), built
on the first request after each change with one pass over every row; do
not use it, or its identity, as the key of such a cache.

<!-- docs-check: with datasets -->

```ts
// Place the text again only when the drawn rows changed
let placedFor = -1;
function placeText(): void {
  const revision = places.getDrawnRowsRevision();
  if (revision === placedFor) return;
  placedFor = revision;
  // ... walk places.listDrawnRows(extent) and place the text
}
```

The reads of one row do not build its feature either, except `getRow`.

| Method | Returns |
| --- | --- |
| `getRowId(index)` | The ID |
| `getRowType(index)` | The geometry type |
| `getRowBounds(index)` | The extent, as `[west, south, east, north]` |
| `getRowPoint(index)` | The position of a `Point` |
| `getRow(index)` | The row as a GeoJSON feature |
| `findRow(id)` | The index of an ID, or `null` |

The first call of `findRow` builds an index of the IDs. A row index is
the `rowIndex` of `clicked` and `hovered`, and the indexes hold until
the rows are replaced.

<!-- docs-check: with datasets -->

```ts
// The first point of each 0.01 degree cell, in drawing order
const extent: [number, number, number, number] = [139.6, 35.6, 139.9, 35.8];
const taken = new Set<string>();
const names: string[] = [];
for (const index of places.listDrawnRows(extent)) {
  const point = places.getRowPoint(index);
  if (!point) continue;
  const cell = `${Math.floor(point[0] / 0.01)}:${Math.floor(point[1] / 0.01)}`;
  if (taken.has(cell)) continue;
  taken.add(cell);
  const row = places.getRow(index);
  if (row) names.push(String(row.properties?.name));
}
```

## Showing and hiding

`setVisible(false)` stops drawing and hit testing but keeps the rows and
what was sent to the GPU, so `setVisible(true)` shows the dataset at the
next drawing. `setRows`, `setStyleRule` and a provider keep working
while it is hidden. `draw.datasets.remove(id)` lets go of everything.

## Following the datasets that come and go

`dataset.added` fires when a dataset is added, with the `dataset`, and
`dataset.removed` when one is removed, with its `datasetId`. When the
remove event arrives, `draw.datasets.get` no longer returns it. Moving a
dataset (that is `dataset.reordered`) and changing its rows fire
neither. The datasets that exist before you subscribe are not announced,
so walk `draw.datasets.list()` once, then follow the events.

<!-- docs-check:
type Dataset = import('@sakuzu/maplibre-gl-draw').Dataset;
declare function watch(dataset: Dataset): () => void;
-->

```ts
const stops = new Map<string, () => void>();
const follow = (dataset: Dataset): void => {
  stops.set(dataset.id, watch(dataset));
};

for (const dataset of draw.datasets.list()) follow(dataset);
draw.on('dataset.added', ({ dataset }) => follow(dataset));
draw.on('dataset.removed', ({ datasetId }) => {
  stops.get(datasetId)?.();
  stops.delete(datasetId);
});
```

A dataset removed and added again under the same ID is a new object, so
it arrives as a remove and then an add.

## Drawing points yourself

`externalPointRender` picks point rows: for a `Point` for which it
returns true, the library draws nothing, and your own renderer draws it.
The point still takes part in thinning, hit testing and selection, so the
behavior stays the same. `setExternalPointRender` replaces it later.

<!-- docs-check: with datasets -->

```ts
draw.datasets.add({
  id: 'stations',
  rows,
  externalPointRender: (row) => row.properties?.kind === 'station',
});
```

## Taking a picture

On screen, a large dataset fills in over several drawings. A map that is
drawn once to read the picture back, for a print or a thumbnail, sets
`rendering.timeSlicing` to `false`, so that each drawing prepares
everything in view. Then it waits for the map's `idle` and for
`hasPendingWork()` to be false, which also covers the answer of a
provider:

```ts
draw.options.update({ rendering: { timeSlicing: false } });

async function whenPictureComplete(): Promise<void> {
  map.triggerRepaint();
  await map.once('idle');
  while (draw.hasPendingWork()) await map.once('render');
}
```

The thinning needs nothing: the drawing decides which points it shows.
See [performance](performance.md).

## Read-only and locks

A dataset is outside the three states of [read-only](read-only.md). It
can be added and replaced while the document is read-only, its `clicked`
and `hovered` fire while the interaction lock is on, and `draw.hidden`
does not apply to it. Show and hide it with `setVisible` or by removing
it.

## Limits

- A dataset cannot be edited. Copy a row into the document with
  `draw.features.create` to edit it
- Its rows are replaced as a whole; there is no partial update
- It is not saved with the document. Keep the data, or the address it
  came from, yourself, and add the dataset again after a load
- A row of a table has no style of its own
- The thinning applies to `Point` only
- A table is read in place: do not change its arrays while the
  dataset holds them

## Examples

- [Datasets](../examples/datasets.md) shows the buildings and the places
  of central Tokyo from Overture Maps under and over the user's drawing:
  the buildings, given at once and colored by their height, are
  `layer-order` between two layers of the drawing; the places, handed
  over by a provider for the part in view and thinned, are in front of
  everything. A click on a row is reported, and the lines drawn snap to
  the buildings
- [Columnar data in a Worker](../examples/columnar-data-in-a-worker.md)
  reads the same buildings from a GeoParquet file in a Worker, straight
  into a table, prepares it there with `prepareTable` and hands it over
  without a copy
- [200,000 features](../examples/200000-features.md) loads a city of
  208,073 features (buildings, parks, streets and places) as features of
  the document instead, every one editable, for comparison with a
  dataset

For the size at which to choose a dataset over drawn features, see
[performance](performance.md).

## Reference

- [draw.datasets](../api/maplibre-gl-draw/interfaces/DatasetsCollection.md)
- [Dataset](../api/maplibre-gl-draw/interfaces/Dataset.md)
- [DatasetOptions](../api/maplibre-gl-draw/type-aliases/DatasetOptions.md)
- [DatasetEvents](../api/maplibre-gl-draw/interfaces/DatasetEvents.md)
- [DatasetCollisionThinning](../api/maplibre-gl-draw/interfaces/DatasetCollisionThinning.md)
- [Table](../api/table/interfaces/Table.md),
  [tableFromFeatures](../api/table/functions/tableFromFeatures.md),
  [createTableBuilder](../api/table/functions/createTableBuilder.md)
  and [prepareTable](../api/table/functions/prepareTable.md)
- [events](../reference/events.md) for `dataset.clicked`,
  `dataset.added`, `dataset.removed` and `dataset.reordered`
