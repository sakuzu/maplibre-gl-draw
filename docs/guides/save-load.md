# Saving and loading

A drawing is a document: its features, layers, groups, embedded files and
metadata. This guide covers writing the document out as GeoJSON or in the
library's own format, opening it again and importing files into it, what
a read leaves out, images, saving after each change, keeping the
document in a store of your own, and what a change carries.

## Minimal code

```ts
// Save: the whole document in the library's format
localStorage.setItem('drawing', JSON.stringify(draw.document.toJSON()));

// Restore: a document of the library replaces what is on the map
const saved = localStorage.getItem('drawing');
if (saved) await draw.open(saved);
```

## Two formats

| Format | Written by | `draw.open` | `tx.import` |
| --- | --- | --- | --- |
| native | `toJSON()` | replaces the document | refuses it |
| GeoJSON | `toGeoJSON()` | replaces the features and groups | adds them |

The native format holds the whole document: the layers and their order,
the groups, the features, the files and the metadata. GeoJSON holds one
`FeatureCollection` of the features.

Use the native format to save and restore a drawing as it was, with its
layers, groups, order, styles and images. Use GeoJSON to exchange features
with other tools. Both formats are specified in
[the data format reference](../reference/data-format.md).

A feature is a GeoJSON Feature: `geometry` is a GeoJSON geometry and
`properties` are the GeoJSON properties. The values the library keeps on
a feature (its layer, group, type, style, visibility and lock, its
reference zoom, the radius of a circle, the size of an image) are keys of
`properties` that start with `maplibre-gl-draw:`; every other key is an
attribute of yours. A key whose value is the default is not written.
Both formats write the features in the shape `draw.features.get` reads
them.

## Writing the document out

`toJSON()` returns the document as an object (`DrawDocument`), and
`toGeoJSON()` a GeoJSON `FeatureCollection`. Turn them into text with
`JSON.stringify`, and name the file yourself:

```ts
const geojson = draw.document.toGeoJSON();
const title = draw.document.title || 'drawing';
const blob = new Blob([JSON.stringify(geojson)], {
  type: 'application/geo+json',
});

const link = document.createElement('a');
link.href = URL.createObjectURL(blob);
link.download = `${title}.geojson`;
link.click();
URL.revokeObjectURL(link.href);
```

- The native document carries the version of its format, `4.0.0`
- The GeoJSON follows RFC 7946: rings follow the right-hand rule (as they
  do in the document), positions are rounded to 7 decimal places,
  longitudes are brought into -180 to 180, and the `FeatureCollection`
  carries a `bbox`
- Hidden features are written too, with their
  `maplibre-gl-draw:visible: false` kept in their properties, so a round
  trip keeps them hidden
- The values of a feature that GeoJSON has no place for (its layer,
  group, style, lock, and a type such as `Circle`) are its properties with
  the `maplibre-gl-draw:` prefix, so reading the file back restores them
- An image is embedded as a data URL, so the file stands on its own
- Set the title and the description with
  `draw.write((tx) => tx.document.update({ title }))`, and read them as
  `draw.document.title` and `draw.document.description`

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

To write only some of the features, write them as they are read: a
feature of `draw.features.get` is a GeoJSON Feature, so
`{ type: 'FeatureCollection', features }` of them is GeoJSON. Unlike
`toGeoJSON()`, it keeps the longitudes as they are, and an image is
written without its pixels.

## Opening and importing

`draw.open(source)` replaces the document with what a source holds, and
`tx.import(source, options?)`, in a `draw.write`, adds it to the
document. Both take a `File` or a `Blob`, a JSON string, a document of the
library or a GeoJSON `FeatureCollection`.

```ts
const input = document.querySelector<HTMLInputElement>('#file');
input?.addEventListener('change', async () => {
  const file = input.files?.[0];
  if (!file) return;
  try {
    const result = await draw.write((tx) => tx.import(file));
    console.log(result.count, result.layerId);
    for (const { index, error } of result.skipped) {
      console.warn(`feature ${index} left out: ${error.message}`);
    }
  } catch (error) {
    console.error('not imported', error); // the document is unchanged
  }
});
```

- The format is read from the content: a document of the library or
  GeoJSON. Anything else rejects with a `DrawError` with the code
  `unsupportedFormat`
- `draw.open` of a document of the library replaces everything; of
  GeoJSON, it takes the place of the features and groups and keeps the
  layers. It is one `change` with the source `'open'`, and the steps of
  undo are dropped. It returns how many features it read (`features`) and
  the ones it left out (`skipped`)
- `tx.import` adds GeoJSON to the document: it is one commit and one
  step of undo with the other writes of its transaction. A document of
  the library is only opened, so `tx.import` refuses it with
  `invalidInput`. It returns how many
  features it added (`count`), their layer (`layerId`) and the ones it
  left out (`skipped`)
- While the document is read-only, both reject with `notEditable`
- The data is checked before the document changes, so a read that rejects
  leaves the drawing as it was
- A document of the library is rejected as a whole, with the code
  `invalidInput`, when something in it is malformed, refers to something
  missing, or has another version than the one the library writes
  (`4.0.0`)
- A GeoJSON feature whose geometry cannot be used (missing, unsupported,
  a number that is not finite, a line with one position, a ring that is
  not closed and so on) is left out and listed in `skipped` with its index
  and a `DrawError`; the rest are read
- A style value of the wrong type or form (a color that is not a CSS
  color, an opacity outside 0 to 1) is dropped, and the feature is kept
- An embedded image that is not a PNG, JPEG, WebP or GIF data URL of its
  declared type, or whose pixels cannot be decoded, rejects the read with
  `invalidInput`. An image that has to be scaled down and that the
  browser cannot encode in one of those types rejects it with
  `unsupportedFormat`
- A feature imported with an ID the document already holds gets a new ID
  (`duplicateIds: 'renew'`, when left out), so a file written by
  `toGeoJSON()` can be imported back into the same drawing. Nothing is
  written over
- Features go into the layer of `options.layer` when it is given (an ID,
  or a `LayerInput` that creates a layer in the same commit), otherwise
  into the layer named by their `maplibre-gl-draw:layerId` when it exists,
  otherwise into the active layer
- `options.group` (a `GroupInput` without `featureIds`) puts every
  feature read into one new group, created in the same commit. The
  features then all go into one layer and leave any group a GeoJSON
  feature names
- Multi geometries are kept as Multi features. A `GeometryCollection` is
  folded into at most one Multi feature per geometry type

What is read arrives in one `change` that lists every feature it adds in
`features.created` ([Events](../reference/events.md)).

### Several sources at once

`tx.import` can be called several times in one `draw.write`: an import
of several files is one commit, one `change` and one step to undo. When
one source cannot be read, the write rejects with its `DrawError` and
nothing is written.

```ts
declare const files: File[];

const results = await draw.write(async (tx) => {
  const out = [];
  for (const file of files) out.push(await tx.import(file));
  return out;
});
console.log(results.length);
```

With `layer` and `group` in the options, an import of a folder, one layer
per file and one group for the folder, is still one commit: the new
layers, the features and the groups arrive in one `change`.

```ts
declare const folder: { name: string; files: File[] };

const results = await draw.write(async (tx) => {
  const out = [];
  for (const file of folder.files) {
    out.push(
      await tx.import(file, {
        layer: { name: file.name },
        group: { name: folder.name },
      }),
    );
  }
  return out;
});
for (const result of results) console.log(result.layerId);
```

An import may name by its ID the layer an earlier import of the same
transaction creates, so the files of one import can share a new layer,
and a file can put its features in a group of that layer:

```ts
declare const files: [File, File];

await draw.write(async (tx) => {
  await tx.import(files[0], { layer: { id: 'survey', name: 'Survey' } });
  await tx.import(files[1], { layer: 'survey', group: { name: 'second file' } });
});
```

### Reading without writing

`parseGeoJSON(input, options?)` and `parseNative(input, options?)` read a
source as `tx.import` reads it and write nothing. They need no drawing,
and give back a `ParsedDocument` (features, groups, files, layers and the
features left out) for the application to write where it chooses: in
parts, into another store, or after it has placed them.

```ts
import { parseGeoJSON } from '@sakuzu/maplibre-gl-draw';

declare const geojson: GeoJSON.FeatureCollection;

const target = draw.layers.getActive()?.id;
const parsed = await parseGeoJSON(geojson, { layerId: target });
for (const { index, reason, detail } of parsed.skipped) {
  console.warn(`feature ${index} left out (${reason}): ${detail}`);
}
await draw.write(async (tx) => {
  // The features first, out of their groups, then the groups that take them in
  await tx.features.create(
    parsed.features.map(({ properties, ...rest }) => {
      const { 'maplibre-gl-draw:groupId': _, ...kept } = properties;
      return { ...rest, properties: kept };
    }),
  );
  for (const group of parsed.groups) await tx.groups.create(group);
});
```

- Every feature, group, layer and file gets a new ID; the IDs of the
  input are never kept. The references between them (the group of a
  feature, the members of a group, the file of an Image) name the new IDs
- A reference the library does not know, such as the ID of another
  feature that the application or an extension keeps in `properties`, is
  left as it is. `idMap` gives the new ID of each ID of the input, one
  map per kind (`features`, `groups`, `files` and `layers`), to rewrite
  it; an ID that was not read is not in it
- `layerId` puts every feature into one layer. Without it, the features
  of GeoJSON name no layer (no `maplibre-gl-draw:layerId`), and those of
  a document of the library the ID of their layer in `layers`, which
  lists the layers of the document from the back, for the application to
  create
- The GeoJSON features that name the same `maplibre-gl-draw:groupId` form
  one new group. `flattenMulti: true` splits Multi geometries into one
  feature per part
- An `Image` feature names its file in `files`, which the document does
  not hold: a source with images is written with `tx.import`
- No feature is given a name, and the features keep the order of the
  input
- A feature that `tx.import` would leave out, and one whose embedded
  image cannot be imported, is left out and listed in `skipped` with its
  index, the code (`invalidInput`, or `unsupportedFormat` for an image
  the browser cannot encode) and the reason. Only an input that is not of
  the format (`unsupportedFormat`) and a document of the library that
  `draw.open` would refuse (`invalidInput`) reject the promise

With `idMap`, an application rewrites its own references before it
writes the features. Here a feature keeps the ID of another one in
`properties.target`:

```ts
import type { ParsedDocument } from '@sakuzu/maplibre-gl-draw';

declare const parsed: ParsedDocument;

const features = parsed.features.map((feature) => {
  const target = feature.properties.target;
  if (typeof target !== 'string') return feature;
  const renamed = parsed.idMap.features[target];
  return { ...feature, properties: { ...feature.properties, target: renamed } };
});
```

### The IDs of the application

By default the library makes a ULID for everything it creates. The
option `generateId` of `createDraw` replaces it: features drawn or
created without an ID, groups, layers, the files of images and the
results of the geometry operations take their IDs from it, and so does
`tx.import` for a feature that has no ID or one that is taken. It is
given only when the instance is created.

```ts
import { createDraw, parseGeoJSON } from '@sakuzu/maplibre-gl-draw';

declare const geojson: GeoJSON.FeatureCollection;

const generateId = () => crypto.randomUUID();
const app = createDraw(map, { generateId });
const parsed = await parseGeoJSON(geojson, { generateId });
console.log(app.features.count(), parsed.features.length);
```

The generator must return a non-empty string that is unique for the
lifetime of the document and never reused, also after the thing it named
was deleted. An ID the code gives, such as `id` of `tx.features.create`,
is used as it is. Give the same generator to `parseGeoJSON` and
`parseNative`, so that every ID of the document comes from one place.

## Files dropped on the map

The library does not take files dropped on the map: which files are
accepted, where they go and whether a native file may replace the drawing
are decisions of the application. To read dropped files, listen to the
drop on the map's container and import each file in one `draw.write`:

```ts
const container = map.getContainer();

// Without this the browser opens the file instead of dropping it
container.addEventListener('dragover', (event) => event.preventDefault());

container.addEventListener('drop', async (event) => {
  event.preventDefault();
  // An image is placed by the image mode (below); a data file carries its own positions
  const files = [...(event.dataTransfer?.files ?? [])].filter(
    (file) => !file.type.startsWith('image/'),
  );
  try {
    await draw.write(async (tx) => {
      for (const file of files) await tx.import(file);
    });
  } catch (error) {
    console.error('the files were not imported', error);
  }
});
```

The application decides the rest in the listener. It can refuse drops
while `draw.isReadOnly()` or `draw.isInteractionLocked()` is true, open a
native file with `draw.open` after asking before it replaces the drawing,
or read a file itself and hand the features to a dataset instead
([Showing large data](large-data.md)).

## Images

An image is placed by the image mode, `drawImage`, which asks the
application for the file through the option `requestImage` and places it
where the map was clicked in it ([Drawing and editing](drawing.md#images)).
Code places an image as the GeoJSON written out carries it: a feature of
the type `Image` with the picture as a data URL in
`maplibre-gl-draw:imageData` and its type in
`maplibre-gl-draw:imageMimeType`, given to `tx.import`
([data format](../reference/data-format.md)).

The image is converted to WebP. When the browser cannot encode WebP, the
image is converted to JPEG if none of its pixels is transparent, and is
otherwise stored in the format the browser returns (such as PNG). It is
scaled down when a side exceeds 4096 px, stored once among the files of the
document and referenced by the new `Image` feature through its property
`maplibre-gl-draw:imageFileId`.
Embedded images in a file read are accepted only as
`data:image/(png|jpeg|webp|gif);base64,` data URLs that match their
declared type.

## Saving as you go

`change` arrives once per commit that changed the document, with the
IDs of everything that changed in it, so it is the place to save after
each edit. A change of the selection or of the mode alone does not fire
it:

```ts
let timer: ReturnType<typeof setTimeout> | undefined;

draw.on('change', () => {
  clearTimeout(timer);
  timer = setTimeout(() => {
    localStorage.setItem('drawing', JSON.stringify(draw.document.toJSON()));
  }, 500);
});
```

A drag writes once, when it is let go: what it shows in its middle is a
sketch, and it is no change.

Several writes in one `draw.write` arrive as one `change`, with the
`label` you name, and are one step of undo:

```ts
await draw.write(
  async (tx) => {
    await tx.features.update(featureId, {
      properties: { 'maplibre-gl-draw:visible': false },
    });
    await tx.layers.update(layerId, { opacity: 0.5 });
  },
  { label: 'toolbar' },
);
```

## A storage

`createDraw(map, { backend })` sends each commit to a storage of your own
(`Backend`, in `@sakuzu/maplibre-gl-draw/extend`), one at a time in their
order, and `draw.open()`, given no source, reads the document from it:

```ts
import { createDraw } from '@sakuzu/maplibre-gl-draw';
import type { Backend } from '@sakuzu/maplibre-gl-draw/extend';

const backend: Backend = {
  load: ({ signal }) =>
    fetch('/api/maps/1', { signal }).then((response) => response.text()),
  async send(batch, { signal }) {
    const response = await fetch('/api/maps/1/batches', {
      method: 'POST',
      body: JSON.stringify(batch),
      signal,
    });
    // Thrown: sent again later. Refused: taken out of the document here
    if (response.status >= 500) throw new Error(`for a while: ${response.status}`);
    if (!response.ok) return { status: 'refused', reason: 'rules' };
    return { status: 'accepted' };
  },
  async connect(context) {
    const events = new EventSource('/api/maps/1/events');
    events.onmessage = (event) => {
      const operations = JSON.parse(event.data);
      void context.receive({ source: 'remote', operations });
    };
    return () => events.close();
  },
};

const mapped = createDraw(map, { backend });
await mapped.open();
```

- While it opens, `status.document` is `opening`, the reads give the
  document before it, `status.editable` is false, and `draw.write` waits.
  The document `load` gives is any source `draw.open(source)` takes; it is
  written as it is, even while the instance is read-only, and not sent
  back. Then the storage is connected (`connect`), and the promise
  resolves. A load that fails leaves the document as it was, and
  `status.document` is `failed`
- A document read from a string, a file or GeoJSON carries no keys of the
  order of its items: the keys here are made from its order
- `context.receive(result)` writes what the storage decided (the commits
  made elsewhere) in their order, as values (`ValueOperation`). A large one
  is written over several tasks: the reads give the document before it
  until it is written, and `change` arrives once, with the source
  `'remote'`. It is written even while the instance is read-only, and not
  sent back. A value received after a commit of this client that the
  storage then refuses stays
- `context.replace(source)` replaces the whole document as the storage
  holds it. `context.report({ connection, editable, transfer })` tells
  `status.connection`, `status.editable` and `status.saving.sending`.
  `context.advance(commit, stage)` brings a commit to a stage told later
  (`durable`), and `context.key(id)` gives the key of the order of an item
  here

### Closing

```ts
const { unsent, refused, kept } = await draw.close({ unsent: 'keep' });
if (unsent + refused > 0 && !kept) console.warn('edits lost');
```

- `draw.close(options)` disconnects the storage and empties the document;
  `draw.write` fails with `invalidState` until `draw.open()` opens it
  again. `unsent` says what becomes of the commits not accepted yet:
  `wait` (the default) waits until they are, `keep` keeps them on the
  device, `discard` drops them. A signal that stops the wait does not
  close. The result tells how many commits were not accepted, how many
  refusals were not dismissed, and whether both are kept
- A storage with an `outbox` (`Outbox`) keeps on the device each commit
  once it is read (the stage `stored`), until it is accepted, and each
  refusal with what it did, until it is dismissed. `keep` needs it. The
  next `draw.open()` writes the commits kept again over the document it
  reads, sends them on, and gives the refusals back
- `draw.open(source)` with commits not sent or refusals not dismissed fails
  with `unsentWrites` and changes nothing, unless `unsent` says what becomes
  of them (`keep` needs an outbox too)
- `draw.remove()` destroys the instance without waiting: the commits not
  sent that the outbox does not hold are lost, which `kept` tells

## A store of your own

To keep the drawing in a database or on a server, following the changes
of the instance is often enough:

<!-- docs-check:
declare function sendToServer(change: unknown): void;
-->

```ts
draw.getStore().subscribe((change) => {
  // change.features, change.layers, change.groups, change.source ...
  sendToServer(change);
});
```

`draw.getStore().subscribe(listener)` delivers each change in full, as a
`DocumentChange`: the items created, updated with the ones before, and
deleted. It also tells a change of the selection, the editing or the mode
in their own categories. `draw.on('change', listener)` tells the same
commit by its IDs, which the collections read.

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

The automatic names ("Point 3", "Layer 2") are numbered from the names
the store lists, and a number is never used twice. A store that holds
only part of the document can also implement the optional
`getMaxNameNumber` and `recordNameNumber`, so that the numbers used in the
part it does not hold are not used again.

A store whose IDs are of a form of its own (the IDs of a writer of a
shared document) implements the optional `acceptsId(id)`, which is given
the ID alone (not whether it names a feature, a group or a layer), and is
given
with a `generateId` that makes IDs of that form. `tx.import` gives a
feature, a group or a layer whose ID the store does not take a new ID,
and a feature, a group or a layer created with such an ID
(`tx.features.create` with `id`, say) is refused with `invalidInput`
before anything is written.

The document it holds is the one `document.toJSON()` writes; its shape is
in [the data format reference](../reference/data-format.md).

## What a change carries

`draw.undo()` and `draw.redo()` take back and make again the commits of
this client, one step per `draw.write` (a write with `undo: false` is no
step). What a listener needs to follow the document is in every
`DocumentChange` the Store delivers (`draw.getStore().subscribe`):

- every update carries the `previous` object, and deletions carry the
  deleted object
- one commit is one change, so a geometry operation, a group or a drag of
  several features comes as one step
- `source` tells where it came from: `'local'` for edits and the writes of
  `draw.write`, `'undo'` and `'redo'` for a step taken back and made
  again, `'open'` for a document opened, and `'remote'` for a store of
  your own

Layers, groups, and the group of a deleted feature come in the same change
as the features.

### A store that holds its features as rows

A store that holds its features as rows of columns
(`createTableStore`, or a store of your own over
`createFeatureTables`) notifies the rows that are not features (not
selected or edited) as rows, by their handles, rather than as features.
The place of an item (its layer, its group and its place among the
others) is in `change.order`, whether it is a feature or a row: a move
with where the item stood (`ItemMove.from`; a row of a Store of rows also
with its keys before, `ItemMove.before`), or many rows with their keys
before (`RowsMove.before`). `draw.undo()` takes back a write of these rows
as it does for features: a row deleted comes back where it was, and a
group deleted at its place.

A store of your own that keeps the items of its layers and groups as
lists, and changes them otherwise than by putting items in a place, makes
the moves of `change.order` from the lists before and after with
`diffItemOrder`.

The writer of the tables of such a store (the writer of `createTableStore`,
in `@sakuzu/maplibre-gl-draw/kasane`) has one more part for a store kept in
step with others: `writer.clear()` takes every row out of the tables, when
the document is replaced from elsewhere (read again from the start), before
its rows come back with `addPages`. The features selected in bulk are let
go of, the work under way is dropped, and the ids keep their handles.

## Another document on the same map

`draw.document.setShown(store)` shows another document in place of the
document, for this client only: a past version of the document, read
into a store that holds its features as rows, to look at on the same map
without a second map nor a feature made of it. While it is shown, the
instance is read-only and the pointer and the keys move the map only;
`setShown(null)` shows the document again.

```ts
import { createTableStore } from '@sakuzu/maplibre-gl-draw/kasane';

const version = createTableStore();
version.store.createLayer({
  id: 'buildings',
  name: 'Buildings',
  visible: true,
  locked: false,
  opacity: 1,
  styleRule: undefined,
  metadata: undefined,
  kind: 'table',
});
// The rows of the version, built in a Worker:
// version.writer.addPages('buildings', pages)
draw.document.setShown(version.store);
// ...
draw.document.setShown(null);
```

`writer.addPages(layerId, pages)` takes the pages in at once
and tells their rows created, as any write of the store does
(`change.rows`). Taking a page in costs little next to building it; a
caller that adds many keeps the draws going by adding a few at a time, as
`copyTableStore` copies a block at a time.

`draw.view.preview(source)` does the same with a source read as
`draw.open` reads it (a document of the library, GeoJSON, a JSON string
or a file): it reads it into a store of rows of its own and shows it;
`draw.view.preview(null)` shows the document again. A source given while
another is read replaces it.

<!-- docs-check:
declare const pastVersion: import('@sakuzu/maplibre-gl-draw').DrawDocument;
-->

```ts
await draw.view.preview(pastVersion); // a document of the library
// ...
await draw.view.preview(null);
```

To draw the document apart, in a map of its own (a print), copy it into a
store of rows with `copyTableStore` of `@sakuzu/maplibre-gl-draw/kasane`:
its layers, groups and order at once, its rows a block at a time, without
making their features.

<!-- docs-check:
declare const printMap: import('maplibre-gl').Map;
-->

```ts
import { createDraw } from '@sakuzu/maplibre-gl-draw';
import { copyTableStore } from '@sakuzu/maplibre-gl-draw/kasane';

const copy = copyTableStore(draw.getStore());
const printed = createDraw(printMap, {
  store: copy.store,
  initDefaultLayer: false,
});
while (copy.copyNext()) await new Promise(requestAnimationFrame);
```

Both count in `draw.memory`, against the limit of the device
([Performance](performance.md#memory-against-the-limit-of-the-device)).

## Examples

- [Save and load](../examples/save-and-load.md) imports a GeoJSON file
  and reports `skipped`, saves the native format in `localStorage` and
  opens it again, downloads both formats as files, opens a file from the
  disk, and reads files dropped on the map

## Reference

- [`DocumentResource`](../api/maplibre-gl-draw/interfaces/DocumentResource.md)
  (`setShown`) and
  [`DrawDocument`](../api/maplibre-gl-draw/interfaces/DrawDocument.md)
- [`OpenResult`](../api/maplibre-gl-draw/interfaces/OpenResult.md),
  [`ImportOptions`](../api/maplibre-gl-draw/interfaces/ImportOptions.md),
  [`ImportResult`](../api/maplibre-gl-draw/interfaces/ImportResult.md) and
  [`SkippedFeature`](../api/maplibre-gl-draw/interfaces/SkippedFeature.md)
- [`isDrawProperty`](../api/maplibre-gl-draw/functions/isDrawProperty.md)
  and
  [`DrawProperties`](../api/maplibre-gl-draw/interfaces/DrawProperties.md)
- [`Store`](../api/maplibre-gl-draw/interfaces/Store.md),
  [`StoreView`](../api/maplibre-gl-draw/interfaces/StoreView.md) and
  [`DocumentChange`](../api/maplibre-gl-draw/interfaces/DocumentChange.md)
- [Data format](../reference/data-format.md) and
  [Events](../reference/events.md)
