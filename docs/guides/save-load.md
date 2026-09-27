# Saving and loading

A drawing is kept in a store inside the instance. This guide covers
exporting it as GeoJSON or in the library's own format, loading it back,
what a load leaves out, images, keeping the drawing in a store of your own,
and what a change notification carries.

## Minimal code

```ts
// Save: the whole drawing as a string
const { data } = draw.export('native');
localStorage.setItem('drawing', data);

// Restore: a native document replaces what is on the map
const saved = localStorage.getItem('drawing');
if (saved) await draw.load(JSON.parse(saved));
```

## Two formats

| Format | `export(...)` gives | `load(...)` does |
| --- | --- | --- |
| `native` | layers, order, groups, features, files, metadata | replaces all |
| `geojson` | one `FeatureCollection` of the features | adds features |

Use `native` to save and restore a drawing as it was, with its layers,
groups, order, styles and images. Use `geojson` to exchange features with
other tools. Both formats are specified in
[the data format reference](../reference/data-format.md).

A feature in the store is the library's own record
(`{ id, type, coordinates, layerId, properties, style, locked, visible }`),
not a GeoJSON Feature. `export` and `load` convert at the boundary, and
`draw.getAllFeatures()` returns the records themselves.

## Exporting

```ts
const result = draw.export('geojson');
// result.data: the JSON text
// result.mimeType: 'application/geo+json'
// result.fileName: a name built from the metadata title

// Only some features, or only some layers
draw.export('geojson', { featureIds: ['a', 'b'] });
draw.export('native', { layerIds: [layerId], fileName: 'site.json' });
```

- `data` is a string; wrap it in a `Blob` to offer a download
- The GeoJSON follows RFC 7946: rings follow the right-hand rule,
  positions are rounded to 7 decimal places, and the FeatureCollection carries a
  `bbox`
- Hidden features are exported too, with `visible: false` kept in their
  properties, so a round trip keeps them hidden
- `name` and `description` are plain properties; the rest of the library's
  fields are properties with the `maplibre-gl-draw:` prefix
- An image is embedded as a data URL, so the file stands on its own
- `draw.getSuggestedFileName()` gives the native file name without
  exporting. Set the title with `draw.setMetadata({ title })`

## Loading

`draw.load(source, options?)` takes a `File` or a parsed object and returns
a promise of a `LoadResult`.

```ts
const input = document.querySelector<HTMLInputElement>('#file');
input?.addEventListener('change', async () => {
  const file = input.files?.[0];
  if (!file) return;
  try {
    const result = await draw.load(file);
    console.log(result.format, result.featureIds.length);
    for (const { index, reason } of result.skipped ?? []) {
      console.warn(`feature ${index} left out: ${reason}`);
    }
  } catch (error) {
    console.error('not loaded', error); // the drawing is unchanged
  }
});
```

- A `File` ending in `.json` or `.geojson` (or with a JSON MIME type) is
  parsed; an image file becomes an Image feature (below)
- An object is detected as the native format or as a GeoJSON
  `FeatureCollection`. Anything else throws
- The data is validated before the store is changed, so a load that throws
  leaves the drawing as it was
- A native document is rejected as a whole when something in it is
  malformed, refers to something missing, or has another major `version`
- A GeoJSON feature whose geometry cannot be used (missing, unsupported,
  a number that is not finite, a line with one position, a ring that is
  not closed and so on) is left out and listed in `skipped` with its index
  and reason; the rest are loaded
- A style value of the wrong type or form (a color that is not `#rgb` or
  `#rrggbb`, an opacity outside 0 to 1) is dropped, and the feature is kept
- A GeoJSON feature whose ID is already taken gets a new ID, so an export
  can be loaded back into the same drawing
- GeoJSON features go into their `maplibre-gl-draw:layerId` layer when it
  exists, otherwise into the active layer
- Multi geometries are kept as Multi features; `flattenMulti: true` splits
  them into single features. A `GeometryCollection` is folded into at most
  one Multi feature per geometry type

## Files dropped on the map

The library does not take files dropped on the map: which files are
accepted, where they go and whether a native file may replace the drawing
are decisions of the application. To load dropped files, listen to the
drop on the map's container, turn the position into a coordinate with
`map.unproject` and pass each file to `draw.load`:

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
      await draw.load(file, {
        coordinate: [lng, lat],
        zoom: map.getZoom(),
        layerId: draw.getActiveLayer(),
      });
    } catch (error) {
      console.error(`${file.name} was not loaded`, error);
    }
  }
});
```

The application decides the rest in the handler. It can refuse drops
while `draw.isReadOnly()` or `draw.isInteractionLocked()` is true, ask
before a native file replaces the drawing, or read a file itself and hand
the features to a dataset instead
([Large data](large-data.md)).

## Images

An image file needs a place:

<!-- docs-check:
declare const imageFile: File;
-->

```ts
await draw.load(imageFile, {
  coordinate: [139.767, 35.681],
  zoom: map.getZoom(),
  layerId: draw.getActiveLayer(),
});
```

The image is converted to WebP, scaled down when a side exceeds 4096 px,
stored once in the document's files and referenced by the new Image
feature through `imageFileId`. Embedded images in a loaded document are
accepted only as `data:image/(png|jpeg|webp|gif);base64,` data URLs that
match their declared type. See [Drawing and editing](drawing.md#images)
for the `draw_image` mode.

## Saving as you go

`draw.features.change` fires once per change with everything that changed
in it, so it is the place to save after each edit:

```ts
let timer: ReturnType<typeof setTimeout> | undefined;

draw.on('draw.features.change', () => {
  clearTimeout(timer);
  timer = setTimeout(() => {
    localStorage.setItem('drawing', draw.export('native').data);
  }, 500);
});
```

A drag writes intermediate states while the pointer moves, and each of them
is a change, so debounce the save as above. Changes to layers and groups
have their own events (`draw.layer.update` and so on;
see [Events](../reference/events.md)).

## A store of your own

To keep the drawing in a database or a server, subscribing to the changes
of the built-in store is often enough:

<!-- docs-check:
declare function sendToServer(changes: unknown): void;
-->

```ts
draw.getStore().subscribe((changes) => {
  // changes.features, changes.layers, changes.groups, changes.source ...
  sendToServer(changes);
});
```

When the document itself has to live elsewhere, give the instance a store
with `Options.store`:

<!-- docs-check:
declare function createDocumentStore(): DocumentStore;
-->

```ts
import {
  createMapLibreGLDraw,
  type DocumentStore,
} from '@sakuzu/maplibre-gl-draw';

// Your implementation of the DocumentStore contract
const store: DocumentStore = createDocumentStore();
const draw = createMapLibreGLDraw(map, { store });
```

The state is split along one line:

| Type | What it is |
| --- | --- |
| `DocumentStore` | the document: features, layers, groups, files, metadata |
| `Store` | a document with the local state of core, behind one gate |
| `StoreView` | reads, `subscribe` and `transact`, from `draw.getStore()` |
| `MemoryStore` | the in-memory `Store`, the default |

A `DocumentStore` of your own holds only the document; core keeps the
selection, the mode, read-only and the rest of the local state around it.
Its contract (every feature listed in exactly one container, no change to
an object after the notification that carries it, `transact` grouping one
notification, and so on) is written on
[`DocumentStore`](../api/maplibre-gl-draw/interfaces/DocumentStore.md).
A change that your store applies from outside the instance is drawn and
notified like a local one, and is never stopped by read-only. Give its
notification the source `'remote'`, so that core keeps the vertex
selection consistent with it and subscribers can tell it from a local
edit.

Writes go through the instance (`addFeature`, `updateLayer` and so on);
`draw.getStore()` has no write methods. To make several writes one change,
wrap them in `draw.getStore().transact(() => { ... })`.

## What a change notification carries

Core keeps no history of changes. What a subscriber of
`draw.getStore().subscribe` needs to follow the document, or to restore
an earlier state of it, is in every notification:

- every update carries the `previous` object, and deletions carry the
  deleted object
- one transaction is one notification, so a geometry operation, a group
  or a multi-feature drag comes as one step
- `source` tells where it came from: `'local'` for edits, `'batch'` for a
  GeoJSON load, `'silent'` for a native load and selection resets, and
  any value you pass to `transact`
- an update in the middle of a drag carries `isIntermediate: true`; the
  update without it that follows commits the drag

Layers, groups, and the group membership of a deleted feature come in the
same notification as the features. A change you apply from a subscriber
can carry a source of your own (any string passed to `transact`), so that
the subscriber can leave it out by that source.

## Examples

- [save-load](../../examples/save-load/) exports both formats,
  loads a GeoJSON file and reports `skipped`, loads files dropped on the
  map, and keeps the drawing in `localStorage`

## Reference

- [`LoadOptions`](../api/maplibre-gl-draw/interfaces/LoadOptions.md),
  [`LoadResult`](../api/maplibre-gl-draw/interfaces/LoadResult.md) and
  [`SkippedFeature`](../api/maplibre-gl-draw/interfaces/SkippedFeature.md)
- [`ExportOptions`](../api/maplibre-gl-draw/interfaces/ExportOptions.md)
  and [`ExportResult`](../api/maplibre-gl-draw/interfaces/ExportResult.md)
- [`DocumentStore`](../api/maplibre-gl-draw/interfaces/DocumentStore.md),
  [`StoreView`](../api/maplibre-gl-draw/interfaces/StoreView.md) and
  [`StateChanges`](../api/maplibre-gl-draw/interfaces/StateChanges.md)
- [Data format](../reference/data-format.md) and
  [Events](../reference/events.md)
