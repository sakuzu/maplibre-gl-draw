# Events

Every event that `draw.on()` delivers, what it carries, when it fires and in
which order. The names and payloads are the keys of
[`DrawEvents`](../api/maplibre-gl-draw/interfaces/DrawEvents.md), and a
dataset has events of its own,
[`DatasetEvents`](../api/maplibre-gl-draw/interfaces/DatasetEvents.md). For
the method signatures see the [generated API reference](../api/index.md).

## Subscribing

```ts
import { createDraw } from '@sakuzu/maplibre-gl-draw';

const draw = createDraw(map);

const stop = draw.on('feature.created', ({ feature, source }) => {
  console.log('created', feature.id, source);
});

// Later: call the returned function, or pass the same listener to off()
stop();

// Only the next occurrence
draw.once('document.loaded', ({ result }) => console.log(result.featureIds));
```

`on` and `once` return the function that unsubscribes. `off(event,
listener)` removes a listener given to either of them. A listener that is
not a function throws a `DrawError` with the code `invalid-input`.

An extension subscribes with `on`, `off` and `once` of its context. They
take the same names and payloads, and the subscriptions end by themselves
when the extension is removed (see [Plugins](../guides/plugins.md)).

A plugin adds events of its own to the same list: it declares them in
`DrawEvents` by declaration merging, named `resource.pastParticiple`, and
sends them with `ctx.emit`, so that they are subscribed to with `draw.on`
as the events below are
([events of a plugin](../guides/plugins.md#events-of-a-plugin)). The
events of this page are the library's alone to send.

## Delivery

Listeners run synchronously, inside the call that caused the change. When
`draw.features.create()` returns, its `feature.created` listeners have
already run.

A listener that throws is logged with `console.error`. It stops neither
the other listeners of the same event nor the operation that emitted it.

A listener added or removed while an event is being delivered takes effect
from the next event.

When a listener reads the instance (for example `draw.features.get()`), it
sees the state after the whole transaction, not the state between two
events of it.

No event can refuse or rewrite a change: every event arrives after the
change is made.

`draw.destroy()` drops every listener. No event fires after it.

## Event list

### Features

| Event | Payload |
| --- | --- |
| `feature.created` | `{ feature; source }` |
| `feature.updated` | `{ feature; previous; source; intermediate }` |
| `feature.deleted` | `{ feature; source }` |
| `feature.moved` | `{ feature; from; to; source }` (`ItemPosition`) |

### Layers and groups

| Event | Payload |
| --- | --- |
| `layer.created` | `{ layer; source }` |
| `layer.updated` | `{ layer; previous; source }` |
| `layer.deleted` | `{ layer; source }` |
| `layer.reordered` | `{ order; previous; source }` |
| `group.created` | `{ group; source }` |
| `group.updated` | `{ group; previous; source }` |
| `group.deleted` | `{ group; source }` |
| `group.moved` | `{ group; from; to; source }` (`ItemPosition`) |

### The document

| Event | Payload |
| --- | --- |
| `metadata.updated` | `{ metadata; previous; source }` |
| `document.changed` | `DocumentChange` |
| `document.loaded` | `{ result: LoadResult; source }` |

### The state of this client

| Event | Payload |
| --- | --- |
| `selection.changed` | `{ selection: Selection; previous: Selection }` |
| `vertexSelection.changed` | `{ selection; previous }` |
| `mode.changed` | `{ mode; previous }` |
| `hidden.changed` | `{ ids }` |
| `readOnly.changed` | `{ readOnly }` |
| `interactionLock.changed` | `{ locked }` |
| `options.changed` | `{ options: RuntimeOptions; previous: RuntimeOptions }` |

### Input

| Event | Payload |
| --- | --- |
| `drag.started` | `{ kind; featureIds; bulk? }` |
| `drag.ended` | `{ kind; featureIds; bulk?; cancelled }` |
| `snap.changed` | `{ result: SnapResult \| null }` |
| `preview.changed` | `{ feature; confirmedVertices?; highlightVertex? }` |
| `map.clicked` | `{ lngLat; point; hit: Hit \| null }` |
| `dataset.clicked` | `{ datasetId; rowIndex; row; lngLat; point }` |
| `image.requested` | `{ lngLat; zoom; layerId }` |

### Datasets

| Event | Payload |
| --- | --- |
| `dataset.added` | `{ dataset: Dataset }` |
| `dataset.removed` | `{ datasetId }` |
| `dataset.reordered` | `{ order; previous }` |

### Sketches

| Event | Payload |
| --- | --- |
| `sketch.added` | `{ sketch: Sketch }` |
| `sketch.updated` | `{ sketch: Sketch; dropped }` |
| `sketch.removed` | `{ sketch: Sketch; reason: SketchEndReason; dropped }` |
| `rendered.changed` | `{ ids }` |

### Drawing

| Event | Payload |
| --- | --- |
| `layerStack.changed` | `{ entries: LayerStackEntry[] }` |
| `error` | `{ error: DrawError; source; featureId? }` |

`lngLat` is `[longitude, latitude]` in degrees, and `point` is `[x, y]` in
CSS pixels from the top left of the map.

## Transactions

Every write belongs to a transaction. A method of the API is one
transaction, and so is a method whose name ends in `Many`, a load, a drag
step and `draw.transact(fn)`. A nested `transact` joins the outermost one.

The events of the document fire when the outermost transaction ends, all
together, in the order below.

### One event per item

`feature.*`, `layer.*` and `group.*` fire once for every item that
changed, whatever caused the change. Loading 1,000 features fires
`feature.created` 1,000 times. This is what a listener that keeps another
copy in step (a server, a search index) needs.

Within one transaction, several updates of the same layer or group arrive
as one `layer.updated` or `group.updated`: its `previous` is the state
before the transaction and its `layer` or `group` the state after it.

A feature or a group put in another place of the stacking order fires
`feature.moved` or `group.moved`, wherever it went: in its layer or
group, into another one, or out of its group. A change of the order is
told by these events and by `DocumentChange.order` only, in every kind of
layer: creating, deleting or moving an item changes the `items` of a
layer of objects (or the `featureIds` of its group), but a change of the
list alone fires no `layer.updated` nor `group.updated`. A layer held as
rows (a Store that holds its features as rows) has no list; the items of
any layer are read with `layers.listItems` and `groups.listMembers`.

### One event per transaction

`document.changed` fires once per transaction that changed the document
(features, layers, groups, metadata or files), after every other event of
it, with a [`DocumentChange`](../api/maplibre-gl-draw/interfaces/DocumentChange.md)
that holds every change of the transaction by category. A category is
present only when the transaction changed it.

| Field | What it holds |
| --- | --- |
| `source` | Where the writes came from |
| `features` | The features created, updated and deleted |
| `layers` | The layers created, updated and deleted, and the stacking order |
| `groups` | `created`, `updated` and `deleted` |
| `order` | The items put in another place, each with where it was and is |
| `metadata` | The new title and description, and the ones before |
| `files` | The embedded files created and deleted |
| `selection` | The new selection and the one before |
| `editing` | The IDs of the features whose editing started and ended |
| `mode` | The new mode and the one before |
| `reset` | `true` when a Store replaced the whole document at once |
| `previousValues` | The values the rows had before a write of this client |
| `restoreToken` | What keeps the rows and the groups this client deleted |
| `rows` | The rows written (experimental) |
| `opened` | The rows opened as features for this client (experimental) |

The last four come from a Store that holds its features as rows. Such a
Store tells the rows that are not features (not selected or edited) by
`rows`, by their handles, rather than in `features`, and many rows put in
another place at once by one entry of `order`; `document.changed` is the
only event that tells them. `previousValues` and `restoreToken` are what
an undo writes back with `draw.features.restore` and `draw.groups.restore`
(see [Saving and loading](../guides/save-load.md)). The types of `rows`
and `opened` are in `@sakuzu/maplibre-gl-draw/kasane`.

A listener that rebuilds a view on any change (a feature list, a legend)
listens to `document.changed`, so that a load of 1,000 features costs one
rebuild instead of 1,000.

A change of the selection, of the editing or of the mode alone does not
fire `document.changed`: it has its own event. When the same transaction
also changed the document, `document.changed` carries them along in
`selection`, `editing` and `mode`. A listener that saves the document can
therefore save on every `document.changed`.

Neither the shape being drawn nor the state of a drag fires
`document.changed`. Hiding an item on this client (`draw.hidden`),
read-only, the interaction lock and the options fire `hidden.changed`,
`readOnly.changed`, `interactionLock.changed` and `options.changed`, and
never `document.changed`.

### Order within one transaction

The events of one transaction are emitted in this order.

1. `feature.created` for each created feature
2. `feature.updated` for each updated feature
3. `feature.deleted` for each deleted feature
4. `layer.created`, `layer.updated`, `layer.deleted`, then
   `layer.reordered`
5. `group.created`, `group.updated`, `group.deleted`
6. `feature.moved` and `group.moved` for each item put in another place,
   in the order the items were first moved
7. `metadata.updated`
8. `selection.changed`
9. `mode.changed`
10. `vertexSelection.changed`
11. `hidden.changed`, `readOnly.changed`, then `interactionLock.changed`
12. `document.changed`

## Sources

The events of features, layers, groups and metadata carry `source`, and
so does `document.changed`. It says where the writes of the transaction
came from.

| Source | Writes |
| --- | --- |
| `local` | The user's operations and the calls of the API: the default |
| `load` | A load of any format, with the replacement of `mode: 'replace'` |
| `batch` | A bulk change meant to be one step |
| `silent` | A change a recorder of changes leaves out |
| `remote` | A change a replaced Store applies from outside the instance |
| `import` | Data an application or an extension loads by its own means |
| any other | Given to `transact`, by an extension or by a replaced Store |

The library itself writes `local`, `load` and `silent` (the selection a
drawing mode clears as it is entered). A load of any format is one
transaction with `load`: with `mode: 'replace'`, deleting what was there
before is part of it, so it fires one `document.changed`.
`document.loadMany` writes all its sources in one such transaction.

The library keeps no history of changes. `source` and the transaction
boundary are what a listener that records changes goes by (see
[Saving and loading](../guides/save-load.md)).

## Drags

A drag (moving, resizing or rotating features, moving vertices, dragging a
handle) writes the features on every pointer move, each move a
transaction of its own. The updates of those moves carry
`intermediate: true` in `feature.updated` (`isIntermediate` in
`document.changed`). When the pointer is released, one more update with
`intermediate: false` writes the final state.

A listener that does expensive work on changes skips the updates with
`intermediate: true`, or waits for `drag.ended`.

`drag.started` fires when a drag of the select mode starts, and
`drag.ended` when it ends. They come in pairs with the same `kind` and
`featureIds`. A drag of features selected in bulk (`Selection.bulk`) has
no IDs in `featureIds`: `bulk` tells how many and where, and
`listSelectedRows(bulk)` of `/kasane` reads their rows.

- `kind` is `feature` for moving features, `vertex` for moving or adding a
  vertex, and `handle` for the handles of the selection (resizing,
  rotating, the radius of a circle)
- `cancelled` is `true` when the drag was cancelled (Escape, a change of
  mode, a change from outside). The features are written back to where
  they were before `drag.ended` fires

## Details per event

### feature.moved and group.moved

Fire for a feature or a group put in another place of the stacking order:
`features.move`, `groups.move`, `groups.create`, `selection.group` and the
rest. Each item fires once per transaction, with where it was before its
first move (`from`) and where it is after its last one (`to`). Both are
`ItemPosition`s: the layer, the group (`undefined` for an item of the
layer), and the items just below and above it, `null` at an end, as the
Store tells them in `DocumentChange.order`. A Store tells every move in
`order`; a move it leaves out is not told.

A feature that changed its layer or its group fires `feature.updated`
first, and a group that changed its layer `group.updated`. A move in the
same layer or group changes no field of the item, so it fires no
`feature.updated` nor `group.updated`, nor a `layer.updated` for the
`items` of the layer. An item created or
deleted fires its own event instead. Many rows of a layer held as rows put
in another place at once are told by `document.changed` only (`order`).

### layer.reordered

Fires when the stacking order changed. `order` and `previous` are the whole
stacking order, from the back, including the entries that are not layers.

### document.loaded

Fires after `draw.document.load()` read something, when every event of the
load has fired, and once per item after `draw.document.loadMany()`.
`result` is the `LoadResult` the promise resolves to (the one of the item),
and `source` is the source of its writes, `load`. A load refused because
the document is read-only, and a load that fails, fire nothing. The layer
and the group that `LoadOptions.layer` and `LoadOptions.group` create come
in the same `document.changed` as the features, with `layer.created` and
`group.created` before this event, and `result.layerId` and
`result.groupId` name them.

### selection.changed

`selection` and `previous` are `{ type, ids }`, where `type` is `feature`,
`group`, `layer` or `null` when nothing is selected. The selection holds
only what can be seen, so hiding or deleting a selected item fires it too.

### vertexSelection.changed

Fires when the selected vertices change. `selection` is `null` when no
vertex is selected.

### hidden.changed

Fires when the items this client hides change: `draw.hidden`, or the
deletion of a hidden item. `ids` is the whole set after the change, not the
difference.

### readOnly.changed and interactionLock.changed

Fire when `draw.setReadOnly` or `draw.setInteractionLocked` changes the
value. Setting the value it already has fires nothing.

### options.changed

Fires inside `draw.options.update` once the new options are applied.
`options` and `previous` are what `draw.options.get()` returns after and
before the call, so a listener can compare them to see what changed. An
update that leaves every value as it was, such as `update({})`, fires
nothing, and neither does an update that throws. The options belong to
this client and are not part of the document, so the event is not part of
a transaction and fires no `document.changed`.

```ts
draw.on('options.changed', ({ options, previous }) => {
  if (options.snapping?.enabled !== previous.snapping?.enabled) {
    const pressed = String(options.snapping?.enabled === true);
    snapButton.setAttribute('aria-pressed', pressed);
  }
});
```

### snap.changed

Fires while drawing or editing, when the target of the snapping changes.
When the pointer leaves every target, it fires once with `result: null`.
Use it for a status line such as "snapped to a vertex".

### preview.changed

Fires every time the shape being drawn changes: at each vertex, at each
move of the pointer that moves the shape, and once with `feature: null`
when the shape is created, discarded or left. Nothing is throttled.
`feature` has the type, the geometry and the layer of the shape, the ID it
will be created with, and the radius of a circle. `confirmedVertices` and
`highlightVertex` are the options the shape was shown with
(`ModeContext.preview.set`): how many vertices from the start are placed,
and the vertex drawn highlighted. Each is left out when the mode did not
give it, and both are left out when the shape is cleared. Use it to show
the length while drawing, or to share the shape with other users and
draw it for them as the drawing user sees it.

### map.clicked

Every click on the map in the select mode, whether it hit a feature, a row
of a dataset or nothing. `lngLat` is the position of the pointer before
snapping, and `hit` the frontmost thing under it (`kind` is `feature`,
`dataset` or `companion`), or `null` when the click hit nothing. It does
not change the selection, and it does not fire in the drawing modes nor for
a click that an extension consumed. Use it when you need "a click anywhere
on the map", such as placing a marker of your own.

### dataset.clicked

A click in the select mode on a row of an interactive dataset that is the
frontmost thing under the pointer. It fires just before `map.clicked`, and
the dataset itself fires `clicked` with the same payload. A click on a
feature of the document, or on nothing, does not fire it: listen to
`map.clicked` for those.

### image.requested

Fires when the mode `draw_image` starts. The library does not open a file
dialog: your application picks the file and loads it with
`draw.document.load(file, { coordinate: lngLat, zoom, layerId })`.
`lngLat` is the clicked position when a click led to the mode (a listener
of `map.clicked` entered it), and the center of the map when the mode was
entered otherwise, such as by `draw.setMode('draw_image')` from a button.
`layerId` is the layer the image goes into. The mode returns to `select`
right after, and the mode cannot start while no layer can be written.

### dataset.added and dataset.removed

A dataset was added or removed.

- `dataset.added` fires in `draw.datasets.add`, once the dataset is
  listed: `draw.datasets.get(id)` returns it inside the listener
- `dataset.removed` fires in `draw.datasets.remove`, once the dataset is
  no longer listed
- Neither fires for a move (that is `dataset.reordered`), for a change of
  the rows or the look (that is the `changed` event of the dataset), nor
  when the instance is destroyed

The datasets that exist before you subscribe are not announced, so read
`draw.datasets.list()` once when you start following them (see
[Showing large data](../guides/large-data.md)).

### sketch.added, sketch.updated and sketch.removed

A sketch of `draw.sketches` was added, changed or ended. They fire once the
operation is done: the features read with `draw.rendered.get` inside a
listener already show the change.

- `sketch.added` fires in `draw.sketches.add` and `addMany`, one per sketch
- `sketch.updated` fires in `draw.sketches.update` and `updateMany`
  (`dropped` is 0), and when a write of the document leaves edits of a
  sketch out: a feature it edits was deleted, locked, hidden or put into a
  layer that cannot be written, or a vertex it edits is no longer there.
  `dropped` is the number of edits left out then
- `sketch.removed` fires once a sketch ends, with the reason
  (`SketchEndReason`): `committed` by `draw.sketches.commit`, `cancelled`
  by `draw.sketches.remove`, `withdrawn` for a sketch with an owner removed,
  `deleted`, `locked`, `layer-unavailable` or `vertices-removed` once
  nothing of it is left, `read-only` when the document becomes read-only,
  `document-replaced` when the whole document is replaced, and
  `deselected` for a sketch of the features selected once none is.
  `dropped` counts the edits left out from when it was added to its end,
  the edits of features no longer there when it was written included

A commit writes in one transaction: `document.changed` comes first, then
`sketch.removed`. A second sketch of this client of a feature commits the
first one before it is added: `document.changed`, `sketch.removed`, then
`sketch.added`. Inside `draw.transact`, the events of the sketches come at
once and `document.changed` when the transaction ends.

### rendered.changed

The shapes of the features as this client draws them (`draw.rendered`)
changed: `ids` lists the features a write of the document (of features,
or of the rows of a store that holds its features as rows) or a sketch
changed, those created or deleted, and the rows dragged in bulk while
they move. A change of the shape being drawn alone, which has no ID, is
told with no IDs. It fires once the draw of the map that draws the
change is done, at most once a draw, after the draw: `draw.rendered`
and the screen of the contexts then answer for that view. It does not
fire while the map does not draw.

It tells changes of the shapes only. A change of the look (a layer rule,
the `style` option, a type added or removed) and the selection box that
changes with the view (its margin, laid on the map at the scale of the
view) are not told: read the look and the selection box at each draw.
The rows dragged in bulk can be very many, and `ids` then lists them all
at each draw: what is drawn with them reads where they are in each draw,
with `draw.rendered.getDraggedRows()`.

### dataset.reordered

`draw.datasets.move` changed the order of the datasets. `order` and
`previous` are their IDs from the back to the front, as
`draw.datasets.list()` returns them.

- It fires when a dataset moved within its side of the document, or to
  another side, even when the IDs read in the same sequence
- A move that leaves the dataset where it was fires nothing
- The position of a dataset with `order: 'layer-order'` follows the
  stacking order of the document, which is `layer.reordered`

### layerStack.changed

Fires when the divisions of the stacking order change: one is added or
removed, or the range of layers it draws changes. `entries` is the same
list that `draw.getLayerStack()` returns. An application that places its
own MapLibre layers between the divisions places them again here (see
[Layers](../guides/layers.md)).

### error

The image of an Image feature could not be decoded. `source` is `image`,
`featureId` names the feature, and `error` is a `DrawError` with the code
`unsupported-format` whose `details` holds what was thrown. It fires once
per image, and the feature is drawn without it.

A failure of `draw.document.load()` rejects its promise instead.

## The events of a dataset

A dataset has its own events, subscribed on the dataset with `on` and
`off`.

```ts
const roads = draw.datasets.add({ id: 'roads', rows, interactive: true });

roads.on('clicked', ({ row, lngLat }) => {
  showPopup(row.properties, lngLat);
});
roads.on('hovered', ({ rowIndex }) => setHighlight(rowIndex));
roads.on('changed', ({ reason }) => rebuildLegend(reason));
```

- `clicked` with `{ datasetId, rowIndex, row, lngLat, point }` fires when
  a row of this dataset is the frontmost hit of a click
- `hovered` with the same fields fires when the pointer moves onto another
  row, or off every row
- `changed` with `{ reason }` fires when the rows, the look, the
  visibility, the selection or the thinning changed

`clicked` and `hovered` fire only in the select mode, and only for a
dataset with `interactive: true`. `rowIndex` is the index of the row in
what the dataset was given, and `row` the row as a GeoJSON feature. When
the pointer leaves every row, `hovered` fires once with `rowIndex` and
`row` set to `null`. Moving over the same row fires nothing.

`changed` fires whatever `interactive` is. `reason` is one of these.

- `rows`: `setRows`, `setTable`, or the rows a provider returned
- `style`: `setStyleRule` or `setBaseStyle`
- `visibility`: `setVisible` switched it
- `selection`: `setSelectedRowIds` changed the selected rows
- `thinning`: the rows the thinning of overlapping points draws changed.
  One caused by `setCollisionThinning` or `setZoomScale` fires inside the
  call; one caused by the camera entering another zoom band fires right
  after the map drew the new rows

See [Showing large data](../guides/large-data.md).
