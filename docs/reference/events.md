# Events

Every event that `draw.on()` delivers, what it carries, when it fires and in
which order, and the values that change over time, which are read and
followed on their resources rather than as events. The names and payloads
are the keys of
[`DrawEvents`](../api/maplibre-gl-draw/interfaces/DrawEvents.md), and a
dataset has events of its own,
[`DatasetEvents`](../api/maplibre-gl-draw/interfaces/DatasetEvents.md). For
the method signatures see the [generated API reference](../api/index.md).

## Subscribing

```ts
import { createDraw } from '@sakuzu/maplibre-gl-draw';

const draw = createDraw(map);

const stop = draw.on('change', ({ features, source }) => {
  for (const id of features.created) console.log('created', id, source);
});

// Later: call the returned function, or pass the same listener to off()
stop();

// Only the next occurrence
draw.once('change', ({ commit, label }) => console.log(commit, label));
```

`on` and `once` return the function that unsubscribes. `off(event,
listener)` removes a listener given to either of them. A name that is not
one of the events below, and a listener that is not a function, throw a
`DrawError` with the code `invalidInput`.

An extension subscribes with `on`, `off` and `once` of its context. They
take the same names and payloads, and the subscriptions end by themselves
when the extension is removed (see [Plugins](../guides/plugins.md)).

The events are the library's alone to send. A plugin gives a value of its
own that changes over time to the application as an `Observable` of the
API it returns
([values of a plugin](../guides/plugins.md#values-of-a-plugin)).

## Delivery

Listeners run synchronously, when the change is made. A write of the
document is committed after `draw.write` returns, and its `change`
listeners have run when its promise settles. The other events run inside
the call that caused them.

A listener that throws is logged with `console.error`. It stops neither
the other listeners of the same event nor the operation that emitted it.

A listener added or removed while an event is being delivered takes effect
from the next event.

When a listener reads the instance (for example `draw.features.get()`), it
sees the state after the whole commit, not the state between two writes
of it.

No event can refuse or rewrite a change: every event arrives after the
change is made.

`draw.destroy()` drops every listener. No event fires after it.

## Event list

### The document

| Event | Payload |
| --- | --- |
| `change` | [`Change`](../api/maplibre-gl-draw/interfaces/Change.md) |

### The state of this client

| Event | Payload |
| --- | --- |
| `readOnly.changed` | `{ readOnly }` |
| `interactionLock.changed` | `{ locked }` |

### Input

| Event | Payload |
| --- | --- |
| `drag.started` | `{ kind; featureIds; bulk? }` |
| `drag.ended` | `{ kind; featureIds; bulk?; cancelled }` |
| `snap.changed` | `{ result: SnapResult \| null }` |
| `map.clicked` | `{ lngLat; point; hit: Hit \| null }` |
| `dataset.clicked` | `{ datasetId; rowIndex; row; lngLat; point }` |

### Drawing

| Event | Payload |
| --- | --- |
| `layerStack.changed` | `{ entries: LayerStackEntry[] }` |
| `error` | `{ error: DrawError; source; featureId? }` |

`lngLat` is `[longitude, latitude]` in degrees, and `point` is `[x, y]` in
CSS pixels from the top left of the map.

## Values that change over time

A value that changes over time is not an event. It is an
[`Observable`](../api/maplibre-gl-draw/interfaces/Observable.md) on its
resource: `value` reads it now (the same object while it does not change),
and `subscribe(run)` calls `run` with the value now at once, and again each
time it changes. `subscribe` returns the
function that stops calling it.

| Value | Observable | Its value |
| --- | --- | --- |
| The selection | `draw.selection` | `SelectionValue` |
| The selected vertices | `draw.vertexSelection` | `VertexSelection \| null` |
| The mode | `draw.mode` | `Mode` |
| What this client hides | `draw.hidden.hiddenIds` | `ReadonlySet<string>` |
| The options | `draw.options` | `Readonly<RuntimeOptions>` |
| The sketches | `draw.sketches` | `readonly Sketch[]` |
| The datasets | `draw.datasets` | `readonly Dataset[]` |
| The shapes as they are drawn | `draw.rendered.changed` | `readonly string[]` |

```ts
const stop = draw.selection.subscribe((selection) => {
  console.log(selection.type, selection.count);
});

// Later
stop();
```

`subscribe` does not depend on `this`, so it can be passed on as it is. An
observable keeps the contract of a Svelte store: with
`const selection = draw.selection`, `$selection` works as it is. In React,
`useSyncExternalStore(draw.selection.subscribe, () => draw.selection.value)`
reads it ([Using it with a framework](../guides/frameworks.md)).

A subscriber that throws is logged with `console.error`, and stops neither
the other subscribers nor the operation that changed the value. A `run`
that is not a function throws a `DrawError` with the code `invalidInput`.
`draw.destroy()` drops every subscriber.

## Transactions

Every write of the document belongs to a commit. A `draw.write` is one
commit, whatever its function writes, and so is `draw.open`, a step of
`draw.undo` and `draw.redo`, an image the image mode places and what a
drag writes when it is let go.

What a commit changed is told when it is made, all together, in the order
below.

### One change per commit

`change` fires once per commit that changed the document (its features,
layers, groups, metadata or files), whatever it changed and however many
features, from this client or from elsewhere. Importing 1,000 features
fires one `change`, with the 1,000 IDs in `features.created`. A
listener that rebuilds a view on any change (a feature list, a legend) and a
listener that keeps another copy in step (a server, a search index) both
listen to it.

Its payload, a [`Change`](../api/maplibre-gl-draw/interfaces/Change.md),
lists the IDs of what changed and where the writes came from.

| Field | What it holds |
| --- | --- |
| `commit` | The ID of the commit: the `id` of the `draw.write` that made it |
| `source` | Where the writes came from: `local` for a write of this client |
| `label` | The `label` of the `draw.write` that made it |
| `features` | The IDs of the features, as `ChangedIds` |
| `layers` | The IDs of the layers, as `ChangedIds` |
| `groups` | The IDs of the groups, as `ChangedIds` |
| `document` | Whether the document itself changed (see below) |
| `previous(id)` | The feature as it was before the commit |
| `rows` | The rows written of the layers held as rows (experimental) |

[`ChangedIds`](../api/maplibre-gl-draw/interfaces/ChangedIds.md) holds four
lists of IDs.

- `created`: the items created (written after in the commit included)
- `updated`: the items changed otherwise than by their place
- `deleted`: the items deleted (written before in the commit included)
- `placed`: the items put in another place of the stacking order, in their
  layer or group or into another one. For the layers, those whose place
  among the layers changed

The lists tell the commit as a whole. An item is in each list once at most,
in one of `created`, `updated` and `deleted` at most, and not at all when
it was created and deleted in the commit, or written back to what it was.
An item that changed nothing but its place, in its layer or group or into
another one, is in `placed` alone; one that also changed otherwise is in
`updated` and `placed`. `previous(id)` gives what the feature was before
its first write in the commit, its layer and group included.

`document` is true when the metadata or the files changed, when the whole
document was replaced, and when an entry of the stacking order of the
layers that is not a layer (a dataset of the order of the layers, an entry
of the application) was put in or out of it, or in another place of it.

The IDs are all `change` gives: what the items are now is read from the
resources (`draw.features.get(id)`, `draw.layers.get(id)`,
`draw.groups.get(id)`). There is no event per feature.

```ts
draw.on('change', (change) => {
  for (const id of change.features.updated) {
    const before = change.previous(id);
    const after = draw.features.get(id);
    console.log(id, before?.properties, '->', after?.properties);
  }
});
```

`previous(id)` gives a feature updated or deleted as it was before the
commit. It is read in the listener, while the change is delivered; after,
its answer is not kept. It returns `undefined` for a feature created, for
one the commit did not change, and for a feature written by a commit from
elsewhere to a layer held as rows of columns, which keeps no value before.

A Store that holds its features as rows lists the rows written in
`features` by their IDs, and in `rows` by their handles, by layer. The type
of `rows` is in `@sakuzu/maplibre-gl-draw/kasane`.

A change of the state of this client alone (the selection, the mode, what
is hidden here) fires no `change`: it is read from the observable of its
resource. Neither the shape being drawn nor the state of a drag fires
`change`. Read-only, the interaction lock and the options are not part of
the document either: they fire `readOnly.changed` and
`interactionLock.changed`, or tell the observable `draw.options`, and never
`change`. A listener that saves the document can therefore save on every
`change`.

### The notifications of the Store

`draw.getStore().subscribe(listener)` delivers every change of one
commit in full, once per commit, as a
[`DocumentChange`](../api/maplibre-gl-draw/interfaces/DocumentChange.md).
It tells the same commit as `change`, by category, with the items
themselves. A category is present only when the commit changed it.

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

The last three come from a Store that holds its features as rows. Such a
Store tells the rows written by `rows`, by their handles, rather than in
`features`, and many rows put in another place at once by one entry of
`order`. `previousValues` and `restoreToken` are what `draw.undo` writes
back. `selection` is the selection
as the Store keeps it, without the IDs of the features selected past 2,000:
`draw.selection.value` gives it with their number, layers and extent.

### Order within one commit

When a commit is made, its observables and events are told in this order:
the commit first, so that a subscriber of a value reads what the commit
wrote as already told.

1. `change`
2. `draw.selection`
3. `draw.mode`
4. `draw.vertexSelection`
5. `draw.hidden.hiddenIds`
6. `readOnly.changed`, then `interactionLock.changed`

## Sources

`change` carries `source`, and so does `DocumentChange`. It says where the
writes of the commit came from.

| Source | Writes |
| --- | --- |
| `local` | The user's operations and the writes of `draw.write` |
| `undo` | A step of undo of this client taken back by `draw.undo` |
| `redo` | A step made again by `draw.redo` |
| `open` | A document opened with `draw.open`, which replaces the document |
| `remote` | A change a replaced Store applies from outside the instance |

A write of `draw.write` is told with `local` and its `label`, and is one
step of undo unless it is given `undo: false`. `draw.open` drops the steps
of undo. A commit with `remote` is no step of undo of this client.

## Drags

A drag (of features, of a vertex, a midpoint, the radius of a Circle or a
handle) is shown by a sketch of this client, which `draw.sketches` lists:
the document does not change while it goes on, `draw.rendered` reads the
features where they are drawn, and one commit writes them when the
pointer is released. A drag cancelled writes nothing. A drag whose sketch
ends by itself, its features deleted, locked, hidden or no longer
selected, writes nothing either, and `drag.ended` says it was cancelled.

`drag.started` fires when a drag of the select mode starts, and
`drag.ended` when it ends. They come in pairs with the same `kind` and
`featureIds`, among them the features a shared vertex takes along. A drag of
features selected without their IDs listed (past 2,000) has no IDs in
`featureIds`: `bulk`, the value of their selection (`SelectionValue`), tells
how many and where, and `listSelectedRows(bulk)` of `/kasane` reads their
rows.

- `kind` is `feature` for moving features, `vertex` for moving or adding a
  vertex, and `handle` for the handles of the selection (resizing,
  rotating, the radius of a circle)
- `cancelled` is `true` when the drag was cancelled (Escape, a change of
  mode, a change from outside). The features are written back to where
  they were before `drag.ended` fires

## Details per event

### change

Fires once per commit that changed the document, after the observables of
the state of this client the commit changed. See
[one change per commit](#one-change-per-commit). The layer and the group
that the `layer` and `group` options of `tx.import` create come in the
same `change` as the features imported, in `layers.created` and
`groups.created`.

### readOnly.changed and interactionLock.changed

Fire when `draw.setReadOnly` or `draw.setInteractionLocked` changes the
value. Setting the value it already has fires nothing.

### snap.changed

Fires while drawing or editing, when the target of the snapping changes.
When the pointer leaves every target, it fires once with `result: null`.
Use it for a status line such as "snapped to a vertex".

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

### layerStack.changed

Fires when the divisions of the stacking order change: one is added or
removed, or the range of layers it draws changes. `entries` is the same
list that `draw.getLayerStack()` returns. An application that places its
own MapLibre layers between the divisions places them again here (see
[Layers](../guides/layers.md)).

### error

The image of an Image feature could not be decoded, or the image the image
mode asked for with `requestImage` could not be placed. `source` is
`image`, `featureId` names the feature of an image that could not be
decoded, and `error` is a `DrawError` (with the code `unsupportedFormat`
when what failed was not one) whose `cause` holds what was thrown. It fires
once per image, and a feature is drawn without it.

A failure of a write, of `draw.open` and of the other calls rejects their
promise instead.

## Details per value

### draw.selection

Its value is `draw.selection.value` (`SelectionValue`): the type (`feature`,
`group` or `layer`; `feature` with the number 0 when nothing is selected),
the number of the features, their layers and extent, and the IDs (`null`
past 2,000 features of a Store that holds its features as rows). It is told
again each time the selection changes, once a commit, after it. The
selection holds only what can be seen, so hiding or deleting a selected item
changes it too.

### draw.vertexSelection

Its value is what `draw.vertexSelection.get()` returns, told again each time
the selected vertices change. It is `null` when no vertex is selected.

### draw.mode

Its value is what `draw.getMode()` returns, told again each time the mode
changes, whoever changed it: `draw.setMode`, a key, or the end of a drawing.

### draw.hidden.hiddenIds

Its value is the set of the IDs of the features, groups and layers this
client hides, what `draw.hidden.list()` lists. It is told again when they
change, once a commit, after it: by `draw.hidden`, or by the deletion
of a hidden item. The value is the whole set after the change, not the
difference.

### draw.options

Its value is what `draw.options.get()` returns. It is told again inside
`draw.options.update`, once the new options are applied. An update that
leaves every value as it was, such as `update({})`, tells nothing, and
neither does an update that throws. The options belong to this client and
are not part of the document, so a change of them is not part of a
commit and fires no `change`.

```ts
draw.options.subscribe((options) => {
  const pressed = String(options.snapping?.enabled === true);
  snapButton.setAttribute('aria-pressed', pressed);
});
```

### draw.sketches

Its value is the sketches, what `draw.sketches.list()` returns. It is told
again once the operation is done: the features read with
`draw.rendered.get` inside a subscriber already show the change.

- A sketch is added by `draw.sketches.add` and `addMany`
- A sketch changes by `draw.sketches.update` and `updateMany`, and when a
  write of the document leaves edits of it out: a feature it edits was
  deleted, locked, hidden or put into a layer that cannot be written, or a
  vertex it edits is no longer there
- A sketch ends, and is no longer listed, when it is committed by
  `draw.sketches.commit`, removed by `draw.sketches.remove`, or once nothing
  of it is left

A commit of a sketch is one commit: `change` comes first, then the sketch is
no longer listed. A second sketch of this client of a feature commits the
first one before it is added.

### draw.datasets

Its value is the datasets in stacking order, what `draw.datasets.list()`
returns. It is told again when one is added or removed, and when their order
changes.

- `draw.datasets.add` tells it once the dataset is listed, and
  `draw.datasets.remove` once it is no longer listed
- `draw.datasets.move` tells it when a dataset moved within its side of the
  document, or to another side; a move that leaves the dataset where it was
  tells nothing
- A change of the rows or the look of a dataset is the `changed` event of
  the dataset, and does not tell it

`subscribe` calls the function with the datasets there at once, so the
datasets that exist before you subscribe are read with the others (see
[Showing large data](../guides/large-data.md)).

### draw.rendered.changed

The shapes of the features as this client draws them (`draw.rendered`)
changed. Its value is the IDs told last (none at first): the features a
write of the document (of features, or of the rows of a store that holds
its features as rows) or a sketch changed, those created or deleted, and
the rows dragged in bulk while they move. A change of the shape being drawn
alone, which has no ID, is told with no IDs. It is told once the draw of
the map that draws the change is done, at most once a draw, after the
draw: `draw.rendered` and the screen of the contexts then answer for that
view. It is not told while the map does not draw.

It tells changes of the shapes only. A change of the look (a layer rule,
the `style` option, a type added or removed) and the selection box that
changes with the view (its margin, laid on the map at the scale of the
view) are not told: read the look and the selection box at each draw.
The rows dragged in bulk can be very many, and the IDs then list them all
at each draw: what is drawn with them reads where they are in each draw,
with `draw.rendered.getDraggedRows()`.

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
