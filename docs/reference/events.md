# Events

Every event that `draw.on()` delivers, what it carries, when it fires and in
which order. The payload types are exported from `@sakuzu/maplibre-gl-draw`
(`EventPayloads` maps each event name to its payload). For the method
signatures see the [generated API reference](./api/index.html).

## Subscribing

```typescript
import { createMapLibreGLDraw } from '@sakuzu/maplibre-gl-draw';

const draw = createMapLibreGLDraw(map);

const off = draw.on('draw.feature.create', ({ feature }) => {
  console.log('created', feature.id);
});

// Later: either call the returned function or pass the same handler to off()
off();
```

`on()` returns a function that removes the handler, which is the same as
calling `draw.off(event, handler)` with the handler you passed.

Handlers run synchronously, inside the call that caused the change. When
`draw.addFeature()` returns, its `draw.feature.create` handlers have already
run. A handler that throws is logged with `console.error` and does not stop
the other handlers of the same event, nor the operation that emitted it. A
handler added or removed while an event is being delivered takes effect from
the next event.

## Event list

### Features

| Event | Payload |
| --- | --- |
| `draw.feature.create` | `{ feature: Feature }` |
| `draw.feature.update` | `{ feature: Feature; previous: Feature }` |
| `draw.feature.delete` | `{ feature: Feature }` |
| `draw.features.change` | `FeaturesChangePayload` |

`FeaturesChangePayload` has this shape.

```typescript
interface FeaturesChangePayload {
  created: Feature[];
  updated: { feature: Feature; previous: Feature }[];
  deleted: Feature[];
  source: UpdateSource;
}
```

### Layers and groups

| Event | Payload |
| --- | --- |
| `draw.layer.create` | `{ layer: Layer }` |
| `draw.layer.update` | `{ layer: Layer; previous: Layer }` |
| `draw.layer.delete` | `{ layer: Layer }` |
| `draw.layer.reorder` | `{ order: string[]; previous: string[] }` |
| `draw.group.create` | `{ group: Group }` |
| `draw.group.update` | `{ group: Group; previous: Group }` |
| `draw.group.delete` | `{ group: Group }` |

`draw.layer.reorder` is the order of the layers themselves (the end is the
foreground). A change of the order of the features or groups inside one
layer arrives as `draw.layer.update` with the new `layer.order`, and a change
of the order inside a group as `draw.group.update` with the new
`group.featureIds`.

### State of this client

| Event | Payload |
| --- | --- |
| `draw.selection.change` | `{ type, ids, previousType, previousIds }` |
| `draw.mode.change` | `{ mode: Mode; previousMode: Mode }` |
| `draw.metadata.change` | `{ metadata: Metadata; previous: Metadata }` |

`type` is `'feature' | 'group' | 'layer' | null` (`null` when nothing is
selected). The selection only holds what can be seen, so hiding or deleting
a selected item also fires `draw.selection.change`.

### Operations and input

| Event | Payload |
| --- | --- |
| `draw.geometry.applied` | `GeometryAppliedPayload` |
| `draw.snap.change` | `SnapResult` |
| `draw.image.request` | `{ coordinate; zoom; layerId }` |
| `draw.map.click` | `{ lngLat: [lng, lat]; point: { x, y } }` |
| `draw.dataset.click` | `{ datasetId; feature; row; lngLat }` |

### Datasets

| Event | Payload |
| --- | --- |
| `draw.dataset.add` | `{ datasetId: string }` |
| `draw.dataset.remove` | `{ datasetId: string }` |
| `draw.dataset.reorder` | `{ order: string[] }` |

### Rendering and loading

| Event | Payload |
| --- | --- |
| `draw.renderslots.change` | `{ slots: RenderSlot[] }` |
| `draw.load.error` | `{ source; featureId; error }` |

## Units of emission

The Store collects changes and notifies them once per flush. A flush is one
transaction (a `load`, a drag commit, a geometry operation, a
`transact()` of your own), or one mutation made outside a transaction.
Nested transactions flush once, when the outermost one ends.

### One event per change

`draw.feature.*`, `draw.layer.*` and `draw.group.*` fire once for every
change, whatever caused it. Loading 1,000 features fires
`draw.feature.create` 1,000 times. This is what a subscriber that keeps
another copy in sync (a server, a search index) needs.

Within one flush, several updates of the same layer or group are folded into
one `draw.layer.update` / `draw.group.update` whose `previous` is the state
before the flush and whose `layer` / `group` is the state after it. Creating
a feature also changes the `order` of its layer (or the `featureIds` of its
group), so it is followed by an update of that container.

### One event per flush

`draw.features.change` fires once per flush that changed any feature, after
the per-feature events of that flush, and carries all of them in the order
they were made. A subscriber that only rebuilds a view on any change (a
feature list, a legend) should use this event, so that a load of 1,000
features costs one rebuild instead of 1,000.

`source` tells where the flush came from.

- `'local'`: operations of the user and calls of the API, including an
  image `load()`
- `'batch'`: a GeoJSON `load()`, a bulk change meant to be one step
- `'silent'`: a native `load()`, which replaces everything, and clearing the
  selection when a drawing mode starts; not meant to be recorded
- `'remote'`: a change that a replaced `DocumentStore` applied from
  outside the instance
- `'import'`: part of the type for hosts and plugins that load data by
  their own means; core itself does not emit it
- any other string: given by a plugin or a custom Store

core keeps no history of changes. `source` and the flush boundary are what
a subscriber that records changes goes by (see
[Saving and loading](../guides/save-load.md)).

### Drags

A drag (moving, scaling, rotating or editing vertices) writes the feature on
every pointer move as an intermediate state, and writes the final state once
when the pointer is released. Each of those writes is its own flush, so
`draw.feature.update` and `draw.features.change` fire on every move. Throttle
your handler, or act on `draw.features.change` only when the drag has ended,
if the work is expensive. A drag cancelled with Esc writes the original
shape back, which is one more update.

A custom Store receives the intermediate flag through `StateChanges`; the
public events do not carry it.

## Order within one flush

The events of one flush are emitted in this order.

1. `draw.feature.create` for each created feature
2. `draw.feature.update` for each updated feature
3. `draw.feature.delete` for each deleted feature
4. `draw.features.change`
5. `draw.layer.create`, `draw.layer.update`, `draw.layer.delete`, then
   `draw.layer.reorder`
6. `draw.group.create`, `draw.group.update`, `draw.group.delete`
7. `draw.layer.update` and `draw.group.update` for an order change inside a
   layer or a group
8. `draw.selection.change`
9. `draw.mode.change`
10. `draw.metadata.change`

When a handler reads the Store (for example `draw.getFeature()`), it sees
the state after the whole flush, not the state between two events.

A geometry operation commits its result in one flush (the result is
created, the inputs are deleted and the result is selected), and then emits
`draw.geometry.applied`.

A click in select mode is handled in this order: the mode updates the
selection (`draw.selection.change`, if it changed), then the
datasets resolve the click (`click` on the dataset and
`draw.dataset.click`), then `draw.map.click` fires.

## Details per event

### draw.geometry.applied

Fires when an operation of `draw.geometry` finishes. `operation` is
`'union' | 'subtract' | 'intersect' | 'buffer' | 'split'` and `inputIds`
lists the inputs in z order (the last is the frontmost).

- `status: 'applied'` means result features were created. Their ids are in
  `resultIds`, in z order
- `status: 'empty'` means the operation ran but the result had no area (an
  intersection of shapes that do not overlap, a subtraction that removed
  everything, a split that did not divide the polygon). The inputs are left
  unchanged and `resultIds` is empty
- When the operation did not run at all (fewer than two targets, for
  example), nothing is emitted

`resultId` is `resultIds[0]` or `null`, a shorthand for operations with one
result. union, subtract and intersect have at most one result. buffer has
one result per input, and `resultIds[i]` belongs to `inputIds[i]`; an input
that buffer skipped is not listed. For split, `inputIds` is
`[polygon, cuttingLine]`, the line stays, and there are two or more
results.

```typescript
draw.on('draw.geometry.applied', (e) => {
  if (e.status === 'empty') return;
  console.log(e.operation, e.inputIds, '->', e.resultIds);
});
```

### draw.snap.change

Fires while drawing or editing, when the snapping target changes. It also
fires when the target is an edge whose coordinates move. When snapping is
lost, it fires once with a `SnapResult` that has no `target`. Use it for a
status line such as "snapped to vertex".

### draw.image.request

Fires when the `draw_image` mode starts. core does not open a file dialog;
your application picks the file and passes it to `load()` with the
`coordinate`, `zoom` and `layerId` from the payload. The mode returns to
`select` right after emitting. It does not fire when no layer can be
written.

### draw.map.click

The click of select mode, emitted for every click whether it hit a feature,
a dataset or nothing. The coordinates are the raw ones,
before snapping. It does not affect selection and does not fire in the
drawing modes. Use it when you need "a click anywhere on the map", such as
placing a marker of your own.

### draw.dataset.click

How a click in select mode was resolved against the
datasets, in one event.

- The frontmost thing under the pointer is a feature of an interactive
  dataset: `datasetId`, `feature` and `row` (the index of the feature
  in what the dataset was given, or its row in a columnar table) are set
- Nothing was hit, or a dataset with `interactive: false` blocked the
  click: all three are `null`
- The frontmost thing is a feature of the Store: not emitted
- No dataset exists: not emitted

The `click` event of a single dataset fires only on a hit, so a click on
empty space, which usually clears a selection that came from a dataset,
can only be seen through this event.

### draw.dataset.add and draw.dataset.remove

A dataset was added or removed.

- `draw.dataset.add` fires in `addDataset`, once the dataset
  is listed: `draw.getDataset(datasetId)` returns it inside
  the handler
- `draw.dataset.remove` fires in `removeDataset` or the
  `remove()` of the dataset, once it is no longer listed. Removing an
  id that does not exist fires nothing
- Neither fires for a move (that is `draw.dataset.reorder`), for a change
  of the contents (that is the `change` event of the dataset), nor when
  the draw instance is destroyed
- A dataset added again under the same id is a new object: a remove
  and then an add

The datasets that exist before you subscribe are not announced, so
read `draw.getDatasets()` once when you start following them
(see [Large data](../guides/large-data.md)).

A plugin subscribes to the same events as `dataset.add` and
`dataset.remove` with `ctx.on` (see [Plugins](../guides/plugins.md)).

### draw.dataset.reorder

`moveDataset` changed the order of the
datasets. `order` is their ids from the back to the front, the same
as `draw.getDatasets()`.

- It fires when a dataset moved within its side, or to another side.
  A change of side fires it even when the ids read in the same sequence
  (the last of `below-store` moved to `above-store`, for example)
- A move that leaves the dataset where it was fires nothing, nor does
  an id that does not exist
- Adding and removing a dataset fire `draw.dataset.add` and
  `draw.dataset.remove` instead
- The position of a `layer-order` dataset follows the layer order of
  the Store, which is `draw.layer.reorder`

A plugin subscribes to it as `dataset.reorder`.

### Display dataset events

A dataset has its own events, subscribed on the dataset.

```typescript
const roads = draw.addDataset({
  id: 'roads',
  features,
  interactive: true,
});

roads.on('click', ({ feature, lngLat }) => {
  showPopup(feature.properties, lngLat);
});
roads.on('hover', ({ feature }) => setHighlight(feature?.id ?? null));
roads.on('change', ({ reason }) => rebuildLabels(reason));
```

- `click` with `{ datasetId, feature, row, lngLat }` fires when a
  feature of this dataset is the frontmost hit. `row` is the index of
  the feature in what the dataset was given, or its row in a columnar
  table
- `hover` with `{ datasetId, feature, row, lngLat }` fires when the
  hovered feature changes. `feature` and `row` are `null` when the pointer
  leaves
- `change` with `{ reason }` fires when the contents, style, visibility,
  selection or thinning winners change

`click` and `hover` fire only with `interactive: true`; `change` fires
regardless. `reason` is `'features'` (`setFeatures`, `setColumnar` or a
provider result),
`'style'` (`setStyleRule` or `setBaseStyle`), `'visibility'` (`setVisible`
actually switched), `'selection'` (`setSelectedIds` actually changed) or
`'thinning'` (the set of features kept by collision thinning changed). A
`'thinning'` caused by `setCollisionThinning` or `setZoomScale` fires
inside the call; one caused by the camera entering another integer zoom
fires right after the frame that drew the new set. See
[Large data](../guides/large-data.md).

### draw.renderslots.change

Fires when a frame (one custom layer that draws one interval of the layer
order) is added or removed, or when an interval changes. `slots` is the same
list that `draw.getRenderSlots()` returns. An application that places its
own maplibre layers between the frames re-places them here (see
[Layers](../guides/layers.md)).

### draw.load.error

An asynchronous load that no call returns has failed.

- `source: 'image'`: the image of an Image feature could not be decoded.
  `featureId` is set. It fires once per failed image (a failed image is not
  retried) and the feature is drawn without its image

`error` is what was thrown. Errors of `draw.load()` itself reject its
promise instead.

## Hooks and events

A plugin can also receive changes through the hooks of `Plugin`
(`feature:afterCreate`, `drag:start`, `drag:end` and so on). Hooks carry a
`MutationContext`, receive the features of one operation together, and
report the start and end of a drag, which the events do not. See
[Plugins](../guides/plugins.md).
