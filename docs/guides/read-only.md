# Read-only, interaction lock and local hiding

Three switches control what a user can change and see, without touching
permissions or roles, which stay in the host application:

- read-only stops every write to the document
- the interaction lock lets the user select but not start an edit
- local hiding hides a feature, group or layer on this client only

All three are state of this client. They are not saved or written out,
and they are not part of the document.

## Minimal code

<!-- docs-check:
declare function showInfoPanel(features: unknown[]): void;
-->

```ts
// A viewer: can select and inspect, cannot edit
draw.setInteractionLocked(true);
draw.setReadOnly(true);

draw.on('selection.changed', () => {
  showInfoPanel(draw.selection.features());
});

// Hide a layer for this user only
draw.hidden.add(layerId);
```

The user can click features and see their frame, the map pans from on top
of them, and nothing the user does changes the drawing.

## Read-only

While `setReadOnly(true)` is on, every write to the document is refused:
features, layers, groups, files and metadata.

```ts
draw.setReadOnly(true);
draw.isReadOnly(); // true
draw.features.update(featureId, { visible: false }); // null, nothing changed
draw.features.create({
  type: 'Point',
  geometry: { type: 'Point', coordinates: [139.767, 35.681] },
}); // null
```

- A refused write does not throw: the methods that return what they wrote
  (`create`, `update`, `union` and the rest) return `null`, those that
  return a boolean (`delete`, `move`, `reorder`) return `false`, and
  `document.load` resolves to `null`
- A wrong argument still throws a `DrawError`, read-only or not
- It covers every path: the API, the drawing modes, the keyboard,
  geometry operations, loading and plugins. A drawing mode can still be
  entered, but what is drawn is not kept
- The state of this client still changes: the selection, the mode, the
  vertex selection and local hiding
- Changes that a store of your own applies from elsewhere still arrive and
  are drawn, so a read-only viewer sees the edits made elsewhere
- Datasets are not in the document, and can still be added and removed
  ([Showing large data](large-data.md))

## Interaction lock

While `setInteractionLocked(true)` is on, the user can select but cannot
start an edit. Writes from code are not stopped.

| Still possible | Stopped |
| --- | --- |
| selecting, vertex selection | moving, resizing, rotating |
| the selection frame, without handles | vertex drags, midpoint inserts |
| panning the map from on top of features | Delete key, group, ungroup |
| local hiding | arrow-key moves |
| writes from code and plugins | entering a drawing mode |

- Turning it on during a drawing discards the drawing and returns to
  `select`
- `setMode` returns `false` for any mode other than `select` while it is on
- A drag that starts on a feature pans the map instead
- The cursor does not offer moves or resizes that would not start
- `selection.delete()` and `vertexSelection.delete()` return `false`, as
  the Delete key would do nothing

It is the same "select but do not edit" as a lock on a feature
([Layers and groups](layers.md)), applied to every feature at once. To
ask whether the user can edit a feature right now, whatever the reason,
look at the switches and at the locks of the feature, its group and its
layer:

<!-- docs-check:
declare function showEditButton(): void;
-->

```ts
import type { Feature } from '@sakuzu/maplibre-gl-draw';

function canEdit(target: Feature): boolean {
  if (draw.isReadOnly() || draw.isInteractionLocked() || target.locked) return false;
  if (target.groupId !== undefined && draw.groups.get(target.groupId)?.locked) {
    return false;
  }
  return draw.layers.get(target.layerId)?.locked !== true;
}

const selected = draw.features.get(featureId);
if (selected && canEdit(selected)) showEditButton();
```

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

`draw.hidden` holds the IDs of the features, groups and layers this client
hides. The `visible` flag of the document stays as it is.

```ts
draw.hidden.add(groupId);
draw.hidden.has(groupId); // true
draw.hidden.list(); // the hidden IDs
draw.hidden.remove(groupId); // shown again
draw.hidden.clear(); // show everything this client hid
```

- Hiding a layer or a group also hides everything in it
- A hidden feature is not drawn, clicked, box-selected, snapped to or
  used by geometry operations, and it leaves the selection
- A hidden layer does not take drawn features; see
  [Layers and groups](layers.md)
- It works under read-only, since it does not change the document
- `features.list`, `document.toJSON()` and `document.toGeoJSON()` ignore
  it: it changes what this client sees, not the data
- `hidden.add` takes only IDs of the document, and throws a `DrawError`
  with the code `not-found` for any other
- When a feature, group or layer is deleted, its ID leaves the set

Datasets do not take part; show and hide one with its `setVisible`.

## With a store of your own

These states live in the instance around the store. A store of your own
([Saving and loading](save-load.md)) neither checks read-only nor keeps
any of them: the instance refuses the writes before they reach it, and
keeps the hidden items and the lock itself.

## Examples

- [read-only](../../examples/read-only/) switches read-only, the
  interaction lock and local hiding, locks a layer, and tells whether the
  selected feature can be edited

## Reference

- [`Draw`](../api/maplibre-gl-draw/interfaces/Draw.md) (`setReadOnly`,
  `isReadOnly`, `setInteractionLocked`, `isInteractionLocked`)
- [`HiddenCollection`](../api/maplibre-gl-draw/interfaces/HiddenCollection.md)
- [`Feature`](../api/maplibre-gl-draw/interfaces/Feature.md),
  [`Group`](../api/maplibre-gl-draw/interfaces/Group.md) and
  [`Layer`](../api/maplibre-gl-draw/interfaces/Layer.md) (`locked`)
