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
| `feature.moved` | `{ feature; from: MoveTarget; to: MoveTarget; source }` |

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
| `drag.started` | `{ kind; featureIds }` |
| `drag.ended` | `{ kind; featureIds; cancelled }` |
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

Creating a feature also changes the `items` of its layer (or the
`featureIds` of its group), so it comes with an update of that layer or
group. A change of the order inside a layer arrives as `layer.updated` with
the new `items`, and inside a group as `group.updated` with the new
`featureIds`.

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
| `layerReorder` | The new order of the items of a layer |
| `groupReorder` | The new order of the features of a group |
| `metadata` | The new title and description, and the ones before |
| `files` | The embedded files created and deleted |
| `selection` | The new selection and the one before |
| `editing` | The IDs of the features whose editing started and ended |
| `mode` | The new mode and the one before |
| `reset` | `true` when a Store replaced the whole document at once |

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
2. `feature.updated` for each updated feature, each followed by
   `feature.moved` when the update moved it to another layer or group
3. `feature.deleted` for each deleted feature
4. `layer.created`, `layer.updated`, `layer.deleted`, then
   `layer.reordered`
5. `group.created`, `group.updated`, `group.deleted`
6. `metadata.updated`
7. `selection.changed`
8. `mode.changed`
9. `vertexSelection.changed`
10. `hidden.changed`, `readOnly.changed`, then `interactionLock.changed`
11. `document.changed`

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
`featureIds`.

- `kind` is `feature` for moving features, `vertex` for moving or adding a
  vertex, and `handle` for the handles of the selection (resizing,
  rotating, the radius of a circle)
- `cancelled` is `true` when the drag was cancelled (Escape, a change of
  mode, a change from outside). The features are written back to where
  they were before `drag.ended` fires

## Details per event

### feature.moved

Fires after the `feature.updated` of a feature that changed its layer or
its group: `features.move`, `groups.create`, `selection.group` and the
rest. `from` and `to` are `MoveTarget`s, with the position in the new
place as `index`. `{ groupId: null }` in `to` means the feature left its
group and stayed in its layer.

A move to another position in the same layer or group changes no field of
the feature, so it fires only `layer.updated` or `group.updated`.

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
