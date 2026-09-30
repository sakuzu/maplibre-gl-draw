# Saving and loading

A drawing is a document: its features, layers, groups, embedded files and
metadata. This guide covers writing the document out as GeoJSON or in the
library's own format, loading it back, what a load leaves out, images,
saving after each change, keeping the document in a store of your own,
and what a change carries.

## Minimal code

```ts
// Save: the whole document in the library's format
localStorage.setItem('drawing', JSON.stringify(draw.document.toJSON()));

// Restore: a document of the library replaces what is on the map
const saved = localStorage.getItem('drawing');
if (saved) await draw.document.load(saved);
```

## Two formats

| Format | Written by | `load` by default |
| --- | --- | --- |
| native | `document.toJSON()` | replaces the document |
| GeoJSON | `document.toGeoJSON()` | adds the features |

The native format holds the whole document: the layers and their order,
the groups, the features, the files and the metadata. GeoJSON holds one
`FeatureCollection` of the features.

Use the native format to save and restore a drawing as it was, with its
layers, groups, order, styles and images. Use GeoJSON to exchange features
with other tools. Both formats are specified in
[the data format reference](../reference/data-format.md).

A feature holds GeoJSON: `geometry` is a GeoJSON geometry and
`properties` are the GeoJSON properties. The values the library keeps on
a feature (its reference zoom, the radius of a circle, the size of an
image) are keys of `properties` that start with `maplibre-gl-draw:`;
every other key is an attribute of yours. Both formats write the
`properties` as they are.

## Writing the document out

`toJSON()` returns the document as an object (`DrawDocument`), and
`toGeoJSON()` a GeoJSON `FeatureCollection`. Turn them into text with
`JSON.stringify`, and name the file yourself:

```ts
const geojson = draw.document.toGeoJSON();
const title = draw.metadata.get().title || 'drawing';
const blob = new Blob([JSON.stringify(geojson)], {
  type: 'application/geo+json',
});

const link = document.createElement('a');
link.href = URL.createObjectURL(blob);
link.download = `${title}.geojson`;
link.click();
URL.revokeObjectURL(link.href);
```

- The native document carries the version of its format, `3.0.0`
- The GeoJSON follows RFC 7946: rings follow the right-hand rule,
  positions are rounded to 7 decimal places, and the `FeatureCollection`
  carries a `bbox`
- Hidden features are written too, with their `visible: false` kept in
  their properties, so a round trip keeps them hidden
- The fields of a feature that GeoJSON has no place for (its layer, group,
  style, lock, and a type such as `Circle`) are written as properties with
  the `maplibre-gl-draw:` prefix, so loading the file back restores them
- An image is embedded as a data URL, so the file stands on its own
- Set the title and the description with `draw.metadata.update({ title })`

A reader that wants only your attributes leaves out the keys of the
library:

```ts
import { isDrawProperty } from '@sakuzu/maplibre-gl-draw';

const rows = draw.document.toGeoJSON().features.map((f) =>
  Object.fromEntries(
    Object.entries(f.properties ?? {}).filter(([key]) => !isDrawProperty(key)),
  ),
);
```

## Loading

`draw.document.load(source, options?)` takes a `File` or a `Blob`, a JSON
string, a document of the library, or GeoJSON (a `FeatureCollection`, a
`Feature` or a geometry). It returns a promise of a `LoadResult`, or of
`null` when the document is read-only.

```ts
const input = document.querySelector<HTMLInputElement>('#file');
input?.addEventListener('change', async () => {
  const file = input.files?.[0];
  if (!file) return;
  try {
    const result = await draw.document.load(file);
    if (!result) return; // read-only
    console.log(result.format, result.featureIds.length, result.replaced);
    for (const { index, reason } of result.skipped ?? []) {
      console.warn(`feature ${index} left out: ${reason}`);
    }
  } catch (error) {
    console.error('not loaded', error); // the document is unchanged
  }
});
```

- The format is read from the content: a document of the library, GeoJSON
  or an image file (below). Anything else rejects with a `DrawError` with
  the code `unsupported-format`
- `mode` chooses between replacing the document (`replace`, the default
  for a document of the library) and adding to it (`merge`, the default
  for GeoJSON). A document of the library can only replace; GeoJSON with
  `replace` takes the place of the features and groups and keeps the
  layers
- The data is checked before the document changes, so a load that rejects
  leaves the drawing as it was
- Once the source is read (and an image decoded), every write of the load
  is one transaction with the source `load`, whatever the format: one
  `document.changed`, one step for a listener that records changes
- A document of the library is rejected as a whole, with the code
  `invalid-input`, when something in it is malformed, refers to something
  missing, or has a major version the library cannot read. A document of
  an earlier major version is upgraded as it loads
- A GeoJSON feature whose geometry cannot be used (missing, unsupported,
  a number that is not finite, a line with one position, a ring that is
  not closed and so on) is left out and listed in `skipped` with its index
  and reason; the rest are loaded
- A style value of the wrong type or form (a color that is not a CSS
  color, an opacity outside 0 to 1) is dropped, and the feature is kept
- A GeoJSON feature whose ID is already taken gets a new ID, so a file
  written by `toGeoJSON()` can be loaded back into the same drawing
- GeoJSON features go into the layer of `options.layerId` when it is
  given, otherwise into the layer named by their `maplibre-gl-draw:layerId`
  when it exists, otherwise into the active layer
- `options.layer` (a `LayerInput`) creates a layer in the same
  transaction and puts every feature into it; `LoadResult.layerId` is its
  ID. It cannot be given together with `layerId` (`invalid-input`)
- `options.group` (a `GroupInput` without `featureIds`) puts every
  feature read into one new group, created in the same transaction where
  the features land. The features then all go into one layer (that of
  `layer` or `layerId`, else the active one) and leave any group a
  GeoJSON feature names. `LoadResult.groupId` is its ID; nothing read, no
  group. A document of the library, which brings its own layers and
  groups, takes neither `layer` nor `group`
- Multi geometries are kept as Multi features; `flattenMulti: true` splits
  them into single features. A `GeometryCollection` is folded into at most
  one Multi feature per geometry type

Each load that reads something emits `document.loaded` with the same
result, and each feature it adds emits `feature.created`. To react once
per load, listen to `document.changed` or `document.loaded`
([Events](../reference/events.md)).

### Several sources at once

`draw.document.loadMany(items)` reads every source first and then writes
all of them in one transaction, so that an import of several files is one
`document.changed`: one step to undo and one change to send. The items
are written in order, each as `load` would write it.

```ts
declare const files: File[];

const results = await draw.document.loadMany(
  files.map((file) => ({ source: file, options: { mode: 'merge' as const } })),
);
console.log(results?.length); // null while read-only
```

When one source cannot be read, the promise rejects with its `DrawError`
and nothing is written. `document.loaded` arrives once per item.

With `layer` and `group` in the options of the items, an import of a
folder, one layer per file and one group for the folder, is still one
transaction: the new layers, the features and the groups arrive in one
`document.changed` and one notification of the Store.

```ts
declare const folder: { name: string; files: File[] };

const results = await draw.document.loadMany(
  folder.files.map((file) => ({
    source: file,
    options: { layer: { name: file.name }, group: { name: folder.name } },
  })),
);
for (const result of results ?? []) console.log(result.layerId, result.groupId);
```

An item may name with `layerId` the layer an earlier item creates with
`layer`, so the files of one import can share a new layer, and a file
can put its features in a group of that layer, in the same transaction:

```ts
declare const files: File[];

await draw.document.loadMany([
  { source: files[0], options: { layer: { id: 'survey', name: 'Survey' } } },
  {
    source: files[1],
    options: { layerId: 'survey', group: { name: 'second file' } },
  },
]);
```

## Files dropped on the map

The library does not take files dropped on the map: which files are
accepted, where they go and whether a native file may replace the drawing
are decisions of the application. To load dropped files, listen to the
drop on the map's container, turn the position into a coordinate with
`map.unproject` and pass each file to `draw.document.load`:

```ts
const container = map.getContainer();

// Without this the browser opens the file instead of dropping it
container.addEventListener('dragover', (event) => event.preventDefault());

container.addEventListener('drop', async (event) => {
  event.preventDefault();
  const rect = container.getBoundingClientRect();
  const { lng, lat } = map.unproject([
    event.clientX - rect.left,
    event.clientY - rect.top,
  ]);
  for (const file of event.dataTransfer?.files ?? []) {
    try {
      // The place is used by an image; a data file carries its own positions
      await draw.document.load(file, {
        coordinate: [lng, lat],
        zoom: map.getZoom(),
        layerId: draw.layers.getActive()?.id,
      });
    } catch (error) {
      console.error(`${file.name} was not loaded`, error);
    }
  }
});
```

The application decides the rest in the listener. It can refuse drops
while `draw.isReadOnly()` or `draw.isInteractionLocked()` is true, ask
before a native file replaces the drawing, or read a file itself and hand
the features to a dataset instead
([Showing large data](large-data.md)).

## Images

An image file needs a place:

<!-- docs-check:
declare const imageFile: File;
-->

```ts
await draw.document.load(imageFile, {
  coordinate: [139.767, 35.681],
  zoom: map.getZoom(),
  layerId: draw.layers.getActive()?.id,
});
```

The image is converted to WebP, scaled down when a side exceeds 4096 px,
stored once among the files of the document and referenced by the new
`Image` feature through its property `maplibre-gl-draw:imageFileId`.
Embedded images in a loaded file are accepted only as
`data:image/(png|jpeg|webp|gif);base64,` data URLs that match their
declared type. See [Drawing and editing](drawing.md) for the `draw_image`
mode, which asks the application for a file with `image.requested`.

## Saving as you go

`document.changed` arrives once per transaction that changed the
document, with everything that changed in it, so it is the place to save
after each edit. A change of the selection or of the mode alone does not
fire it:

```ts
let timer: ReturnType<typeof setTimeout> | undefined;

draw.on('document.changed', () => {
  clearTimeout(timer);
  timer = setTimeout(() => {
    localStorage.setItem('drawing', JSON.stringify(draw.document.toJSON()));
  }, 500);
});
```

A drag writes intermediate states while the pointer moves, and each of
them is a change, so debounce the save as above, or wait for the update
without `isIntermediate` that ends the drag.

To make several writes of your own one change, wrap them in
`draw.transact`. They then arrive as one `document.changed`, with the
source you name:

```ts
draw.transact(
  () => {
    draw.features.update(featureId, { visible: false });
    draw.layers.update(layerId, { opacity: 0.5 });
  },
  { source: 'toolbar' },
);
```

## A store of your own

To keep the drawing in a database or on a server, following the changes
of the instance is often enough:

<!-- docs-check:
declare function sendToServer(change: unknown): void;
-->

```ts
draw.on('document.changed', (change) => {
  // change.features, change.layers, change.groups, change.source ...
  sendToServer(change);
});
```

`draw.getStore().subscribe(listener)` delivers the same `DocumentChange`,
and reads the document without going through the collections.

When the document itself has to live elsewhere, give the instance a store
with the option `store`, at creation:

<!-- docs-check:
declare function createServerStore(): Store;
-->

```ts
import { createDraw, type Store } from '@sakuzu/maplibre-gl-draw';

// Your implementation of the Store contract
const store: Store = createServerStore();
const draw = createDraw(map, { store });
```

The store holds the document (the features, the layers and their
stacking order, the groups, the files and the metadata) and the state of
this client (the selection, the features being edited, the selected
vertices, the mode, read-only, the interaction lock and the hidden items).
The instance reads and writes both only through the methods of `Store`,
subscribes to it and groups writes with its `transact`. It does not call
the writes of the document while `isReadOnly()` is true. The shape being
drawn, the box selection and the drag stay in the instance.

A store of your own keeps a few rules: unique IDs, the `items` of the
layers and the `layerId` of the groups kept in step, one notification
per outermost transaction, a document taken from elsewhere delivered as
one `DocumentChange` with `reset: true`, and writes that return whether
they were applied. They are written in full on
[`Store`](../api/maplibre-gl-draw/interfaces/Store.md) and
[`StoreView`](../api/maplibre-gl-draw/interfaces/StoreView.md).

The document it holds is the one `document.toJSON()` writes; its shape is
in [the data format reference](../reference/data-format.md).

## What a change carries

Core keeps no history of changes. What a listener needs to follow the
document, or to put an earlier state of it back, is in every
`DocumentChange`:

- every update carries the `previous` object, and deletions carry the
  deleted object
- one transaction is one change, so a geometry operation, a group or a
  drag of several features comes as one step
- `source` tells where it came from: `'local'` for edits and calls of the
  API, `'load'` for a load of any format, `'remote'` for a store of your
  own, and any value you pass to `transact`
- an update in the middle of a drag carries `isIntermediate: true`; the
  update without it that follows ends the drag

Layers, groups, and the group of a deleted feature come in the same change
as the features. A change you apply from a listener can carry a source of
your own, so that the listener can leave it out by that source.

## Examples

- [save-load](../../examples/save-load/) writes out both formats,
  loads a GeoJSON file and reports `skipped`, loads files dropped on the
  map, and keeps the drawing in `localStorage`

## Reference

- [`DocumentResource`](../api/maplibre-gl-draw/interfaces/DocumentResource.md)
  and [`DrawDocument`](../api/maplibre-gl-draw/interfaces/DrawDocument.md)
- [`LoadOptions`](../api/maplibre-gl-draw/interfaces/LoadOptions.md),
  [`LoadResult`](../api/maplibre-gl-draw/interfaces/LoadResult.md) and
  [`SkippedFeature`](../api/maplibre-gl-draw/interfaces/SkippedFeature.md)
- [`isDrawProperty`](../api/maplibre-gl-draw/functions/isDrawProperty.md)
  and
  [`DrawProperties`](../api/maplibre-gl-draw/type-aliases/DrawProperties.md)
- [`Store`](../api/maplibre-gl-draw/interfaces/Store.md),
  [`StoreView`](../api/maplibre-gl-draw/interfaces/StoreView.md) and
  [`DocumentChange`](../api/maplibre-gl-draw/interfaces/DocumentChange.md)
- [Data format](../reference/data-format.md) and
  [Events](../reference/events.md)
