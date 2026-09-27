# Read-only, interaction lock and local hiding

Three switches control what a user can change and see, without touching
permissions or roles, which stay in the host application:

- read-only stops every write to the document
- the interaction lock lets the user select but not start an edit
- local hiding hides a feature, group or layer on this client only

All three are local state of the instance. They are not saved or
exported, and they are not part of the document.

## Minimal code

<!-- docs-check:
declare function showInfoPanel(features: unknown[]): void;
-->

```ts
// A viewer: can select and inspect, cannot edit
draw.setInteractionLock(true);
draw.setReadOnly(true);

draw.on('draw.selection.change', ({ ids }) => {
  showInfoPanel(ids.map((id) => draw.getFeature(id)));
});

// Hide a layer for this user only
draw.setLocallyHidden(layerId, true);
```

The user can click features and see their frame, the map pans from on top
of them, and nothing the user does changes the drawing.

## Read-only

While `setReadOnly(true)` is on, every write to the document is refused:
features, layers, groups, files and metadata.

```ts
draw.setReadOnly(true);
draw.isReadOnly(); // true
draw.updateFeature(featureId, { visible: false }); // false, nothing changed
draw.addFeature({ type: 'Point', coordinates: [139.767, 35.681] }); // null
```

- A refused write returns `false` from the methods that return a boolean,
  `null` from `addFeature`, `addLayer` and `addGroup` (which return the new
  ID otherwise), and does nothing otherwise; it does not throw
- It covers every path: the API, the drawing modes, the keyboard,
  geometry operations, `load` and plugins
- Local state still changes: selection, mode, vertex selection, local
  hiding
- Changes that a store of your own applies from elsewhere still arrive and
  are drawn, so a read-only viewer sees other users' edits
- Datasets are not in the document, and can still be added
  and removed ([Large data](large-data.md))

## Interaction lock

While `setInteractionLock(true)` is on, the user can select but cannot
start an edit. Writes from code are not stopped.

| Still possible | Stopped |
| --- | --- |
| selecting, vertex selection | moving, resizing, rotating |
| the selection frame, without handles | vertex drags, midpoint inserts |
| panning the map from on top of features | Delete, group, ungroup keys |
| local hiding | arrow-key moves |
| writes from code and plugins | entering a drawing mode |

- Turning it on during a drawing discards the drawing and returns to
  `select`
- `setMode` refuses any mode other than `select` while it is on
- A drag that starts on a feature pans the map instead
- The cursor does not offer moves or resizes that would not start

It is the same "select but do not edit" as a lock on a feature
([Layers and groups](layers.md#locking)), applied to every feature at
once. To ask whether a feature can be edited right now, whatever the
reason:

<!-- docs-check:
declare function showEditButton(): void;
-->

```ts
import { isInteractionBlocked } from '@sakuzu/maplibre-gl-draw';

const feature = draw.getFeature(featureId);
if (feature && !isInteractionBlocked(feature, draw.getStore())) {
  showEditButton();
}
```

`isInteractionBlocked` is true while read-only, under the interaction lock,
or when the feature, its group or its layer is locked.

### Which one to use

Read-only and the interaction lock are independent; either, both or
neither can be on.

- Use read-only when the document must not change at all, for example
  for a user without the right to edit
- Use the interaction lock for a view mode of a user who may edit: the
  host and its plugins can still write (create a default layer, apply
  settings), while the user cannot start an edit on the map
- For a viewer, turn on both

## Local hiding

`setLocallyHidden(id, hidden)` hides a feature, a group or a layer on this
client. The shared `visible` flag stays as it is.

```ts
draw.setLocallyHidden(groupId, true);
draw.isLocallyHidden(groupId); // true
draw.getLocallyHidden(); // ReadonlySet of the hidden IDs
```

- Hiding a layer or a group also hides everything in it
- A hidden feature is not drawn, clicked, box-selected, snapped to or
  used by geometry operations, and it leaves the selection
- A locally hidden layer is not written by drawing; see
  [Layers and groups](layers.md#the-active-layer)
- It works under read-only, since it does not change the document
- `export`, `getAllFeatures` and `getVisibleFeatures` ignore it: it
  changes what this client sees, not the data
- When a feature, group or layer is deleted, its ID leaves the set

Datasets do not take part; show and hide them by adding
and removing them.

## With a store of your own

These states live in the instance around the document store. A
`DocumentStore` of your own ([Saving and loading](save-load.md)) neither
checks read-only nor keeps any of them: the instance refuses the writes
before they reach it and keeps the hidden set and the lock itself.

## Examples

- [read-only](../../examples/read-only/) switches read-only, the
  interaction lock and local hiding, locks a layer, and checks
  `isFeatureLocked`

## Reference

- [`MapLibreGLDraw`](../api/maplibre-gl-draw/interfaces/MapLibreGLDraw.md)
  (`setReadOnly`, `setInteractionLock`, `setLocallyHidden` and their
  readers)
- [`isInteractionBlocked`](../api/maplibre-gl-draw/functions/isInteractionBlocked.md)
  and
  [`isFeatureLocked`](../api/maplibre-gl-draw/functions/isFeatureLocked.md)
