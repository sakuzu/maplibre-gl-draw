# Layers and groups

Every feature lives in a layer, and features of one layer can be gathered
into groups. This guide covers the layers, the active layer that receives
new features, groups, locking, the stacking order, and how to put the
layers of the map between the layers of the drawing.

## Minimal code

```ts
import { createDraw, readFeature } from '@sakuzu/maplibre-gl-draw';

const draw = createDraw(map);

// The document starts with one empty layer; add a second one and draw
// into it (the write rejects while the instance is read-only)
const notes = await draw.write((tx) => tx.layers.create({ name: 'Notes' }));
draw.layers.setActive(notes.id);
draw.setMode('draw_point');

// Later: lock it, so that its features can be selected but not edited
await draw.write((tx) => tx.layers.update(notes.id, { locked: true }));
```

## Layers

A `Layer` has a `name`, `visible`, `locked`, an `opacity`, the `items` it
holds (the IDs of its features and groups, from the back), an optional
`styleRule` ([Styles](styles.md)) and optional `metadata` of your own,
under keys of your own prefix (`app:key`).

| Method | Does |
| --- | --- |
| `tx.layers.create(input)` | adds a layer, in front unless `index` |
| `tx.layers.update(id, patch)` | changes the keys given |
| `tx.layers.delete(target)` | deletes layers with their items |
| `tx.layers.place(id, { below })` | puts a layer next to another |
| `draw.layers.get(id)`, `list()`, `count()` | read |

The writes are made in a `draw.write` ([Getting started](../getting-started.md)):
`create` and `update` give the layer as it was written, and `delete` the
number of layers deleted, given one ID, several or `{ all: true }`. While
the instance is read-only the write rejects with a `DrawError` with the
code `not-editable` ([Read-only](read-only.md)), and an ID that does not
exist with `not-found`; nothing of the transaction is committed then.

```ts
const roads = await draw.write((tx) =>
  tx.layers.create({ name: 'Roads', opacity: 0.8, index: 0 }),
);
const hidden = draw.layers.list({ visible: false });
```

A layer or a group created without a name is named by the automatic naming
(`Layer 2`, `Group 1`), in the words of the `autoName` option
([Automatic names](drawing.md#automatic-names)).

When the instance is created, the document starts with one empty layer.
With `initDefaultLayer: false` no layer is created, and the application
creates the layers itself, for example when it restores them from its own
data.

`tx.layers.delete` deletes whatever the layer holds, and rejects with
`locked` for a layer that is locked. Deleting the selection with the
Delete key with layers selected keeps at least one layer.

A change of the layers is told by `change`, in `layers.created`,
`layers.updated` and `layers.deleted`, and a change of their stacking
order in `layers.placed`.

## The active layer

New features go into the active layer. `layers.setActive(id)` sets it and
`layers.getActive()` returns it. A locked layer cannot become active:
`setActive` returns `false` for it. When the active layer is deleted, the
first layer becomes active.

User drawing writes only into a layer that exists, is not locked and is
visible (neither hidden for everyone nor hidden on this client). When the
active layer is not writable, a drawing goes into the first writable layer,
and the active layer comes back once it is writable again. While no layer
is writable, `setMode` refuses the drawing modes. This rule is for user
drawing only: `tx.features.create`, `tx.import` and `draw.open` accept any
existing layer.

## Stacking order

The front is at the end of every list:

1. between layers, the order of `layers.list()`
2. inside a layer, `layer.items` (features and groups)
3. inside a group, `group.featureIds`

`features.list()` returns every feature in this order, from the back.
`layers.listItems(id, { offset, limit })` and
`groups.listMembers(id, { offset, limit })` read the items of a layer
and the features of a group by position, from the back, and
`layers.countItems(id)` counts the items. They read every kind of layer:
a layer held as rows (a store that holds its features as rows,
`kind: 'table'`) has no `items`, and a group of it no `featureIds`.
`tx.layers.place(id, { below })` puts a layer just in front of another
(`below` is the layer just below it), and `{ above }` just behind another.
`tx.features.place` and `tx.groups.place` put features and groups
elsewhere: next to another item, or into a layer or a group. Without a
neighbor they go to the front of where they go.

<!-- docs-check:
declare const notes: import('@sakuzu/maplibre-gl-draw').Layer;
-->

```ts
await draw.write(async (tx) => {
  // Put the notes layer behind every other layer
  const [back] = draw.layers.list();
  if (back !== undefined && back.id !== notes.id) {
    await tx.layers.place(notes.id, { above: back.id });
  }

  // Bring one feature to the front of its layer
  const target = draw.features.get(featureId);
  const layer = target ? readFeature(target).layerId : null;
  if (layer !== null) await tx.features.place(featureId, { layerId: layer });

  // Move a group to the front of another layer
  await tx.groups.place(groupId, { layerId: notes.id });
});
```

- A feature put into a layer leaves its group; `{ groupId }` puts it into
  a group of any layer, and `{ layerId, below: groupId }` takes it out of
  its group and puts it just in front of the group
- Given several features (their IDs, a filter or the selection),
  `tx.features.place` keeps their order among them
- A place is named by the item just below it (`{ below }`), or by the item
  just above it (`{ above }`), with the layer or the group it is in when
  the item goes into another (`{ layerId, groupId?, below }`)
- A place of a locked item, or into a locked layer or group, rejects with
  `locked` and changes nothing
- `change` lists each feature and group that moved in `features.placed`
  and `groups.placed`, alone when nothing else of it changed

The stacking order is part of the document: `document.toJSON()` writes it
in `layerOrder`, and `draw.open` of a document replaces it.

## Groups

A group gathers features of one layer so that they are selected, moved,
hidden and locked together.

<!-- docs-check:
declare const idA: string;
declare const idB: string;
-->

```ts
const site = await draw.write((tx) =>
  tx.groups.create({ featureIds: [idA, idB], name: 'Site' }),
);

// Or from the current selection, as Cmd/Ctrl+G does
const { type, ids } = draw.selection.value;
if (type === 'feature' && ids !== null && ids.length > 1) {
  await draw.write((tx) => tx.groups.create({ featureIds: ids }));
}
```

`tx.groups.create` rejects with a `DrawError` when the features are not
all in the same layer. The group takes the place of the frontmost of its
features in the layer.

- `tx.features.place(id, { groupId })` puts a feature into a group
- `tx.features.place(id, { layerId, below: groupId })` takes it out of
  its group, just in front of the group
- `tx.features.place(id, { below })` reorders it next to another member
- `tx.groups.delete(id, { members: 'keep' })` dissolves a group and
  keeps the features
- `tx.groups.delete(id, { members: 'delete' })` deletes a group with its
  features

- Dissolving a group puts its features where the group was, in their order
- Shift+Cmd/Ctrl+G dissolves the selected groups, or takes the selected
  features out of their group
- A group left empty (its last feature moved out or deleted) is deleted
  as well
- A feature is always listed in exactly one place: in the `featureIds` of
  its group when it has a `groupId`, otherwise in the `items` of its layer

In a layer held as rows (a store that holds its features as rows), a
group needs features as well. A group this client deleted (with its
features, left by its last feature, or dissolved) comes back at the place
it had, with its features, when `draw.undo()` takes the deletion back.

A change of the groups is told by `change`, in `groups.created`,
`groups.updated` and `groups.deleted`.

## Locking

`locked` on a feature, a group or a layer allows selecting and showing it
and refuses every other edit.

```ts
await draw.write(async (tx) => {
  await tx.features.update(featureId, {
    properties: { 'maplibre-gl-draw:locked': true },
  });
  await tx.groups.update(groupId, { locked: true });
  await tx.layers.update(layerId, { locked: true });
});
```

A feature keeps its lock in `properties['maplibre-gl-draw:locked']`, which
is there only while it is locked: to unlock it, name the key in `unset`
(`{ unset: { properties: ['maplibre-gl-draw:locked'] } }`).

- The lock is inherited: a feature is locked when it, its group or its
  layer is locked
- A locked feature can be selected, and `selection.features()` includes it
- It cannot be moved, resized, rotated, vertex-edited or deleted, it shows
  no handles, and box selection skips it
- Selected with others, it stays where it is while they are dragged or
  moved with the arrow keys; a press on it moves nothing
- A write that names a locked item by its ID rejects with `locked`: an
  `update` whose patch changes anything other than the lock and the
  visibility, a `delete` and a `place`
- A write given `draw.selection.target` or a filter leaves the locked
  features as they are and changes the others
- The Delete key keeps locked features: a selected group loses only its
  unlocked features, and a layer that holds a locked item is not deleted
- The geometry operations refuse locked features

The inherited lock is read from the three items:

```ts
function isLocked(id: string): boolean {
  const f = draw.features.get(id);
  if (!f) return false;
  const { groupId, layerId, locked } = readFeature(f);
  const group = groupId !== null ? draw.groups.get(groupId) : undefined;
  const layer = layerId !== null ? draw.layers.get(layerId) : undefined;
  return locked || group?.locked === true || layer?.locked === true;
}
```

To stop every edit at once without touching the data, use read-only or the
interaction lock ([Read-only](read-only.md)).

## Visibility

`visible: false` on a group or a layer, and
`properties['maplibre-gl-draw:visible']: false` on a feature, hide it for
everyone who shares the document; it is saved and written out. To hide
something on this client only, use `draw.hidden.add(id)` ([Read-only](read-only.md)).
Hidden features are not drawn, hit-tested, snapped to or used by the
geometry operations, and they cannot be selected.

A feature's visibility is its own flag: a feature can be visible itself and
still not be drawn because its group or its layer is hidden. The filter
`shown` answers for the three together (local hiding is not consulted):

```ts
const own = draw.features.list({ visible: true }); // their own flag
const shown = draw.features.list({ shown: true }); // group and layer too
```

## Opacity

`opacity` (0 to 1) fades a whole layer. It is multiplied into the opacity
of everything drawn for the layer: fills, lines, points, images, and what
custom feature types draw.

```ts
await draw.write((tx) => tx.layers.update(layerId, { opacity: 0.4 }));
```

- It is applied as the map is drawn, so changing it (with a slider, say)
  is cheap
- It is only a look: a feature in a layer at opacity 0 is still
  hit-tested and can be selected. To take a layer out of the way, hide it
- A custom renderer receives the value as `opacity` of its
  `RenderContext` and multiplies it into its own ([Custom types](custom-types.md))

## Map layers between the layers

The drawing is drawn by one layer of the map, so a layer of the map
(vector tiles, raster) is either below or above all of it. To put such a
layer between the layers of the drawing, add an entry of your own to the
stacking order and tell the instance, with `isExternalEntry`, that it
comes from outside the document. The drawing is then divided at those
entries, one map layer per run of layers between them, and the application
moves its map layer between the runs. A single feature cannot be placed
between layers of the map; a whole run of the drawing moves as one.

```ts
const SEPARATOR = 'sep:';

const draw = createDraw(map, {
  isExternalEntry: (id) => id.startsWith(SEPARATOR),
});

function placeMapLayers(): void {
  const order = draw.getStore().getLayerOrder();
  const stack = draw.getLayerStack();
  order.forEach((entry, index) => {
    if (!entry.startsWith(SEPARATOR)) return;
    // Just below the run above the entry, or at the top
    const above = stack.find((run) => run.from > index);
    map.moveLayer(entry.slice(SEPARATOR.length), above?.layerId);
  });
}

placeMapLayers();
draw.on('layerStack.changed', placeMapLayers);
```

- The entries of your own go into the stacking order through the
  document: the `layerOrder` of a document you open, which holds the IDs
  `isExternalEntry` recognizes besides the IDs of the layers, or the Store
  you give the instance. `tx.layers.place` moves an entry that is in the
  order as it moves a layer, and takes it as the neighbor of a layer
- `draw.getStore().getLayerOrder()` returns the whole stacking order, the
  entries of your own included, and `draw.layers.getOrder()` the same
  without an entry that is no longer a layer, a dataset of the order or
  an entry `isExternalEntry` recognizes
- `draw.getLayerStack()` returns the runs from the back, each with its
  range `[from, to)` on the stacking order and the ID of the map layer
  that draws it
- Without entries of your own there is one run, `maplibre-gl-draw-layer`
- `layerStack.changed` fires when runs are added or removed or a range
  changes; place the map layers again then
- A dataset with `order: 'layer-order'` is drawn at the position of its ID
  in the same order ([Showing large data](large-data.md))

## Examples

- [Layers and groups](../examples/layers-and-groups.md) stacks, fades
  and activates layers, groups and locks features and hides one from
  code, and shows it all in the layer panel of the standard UI
- [Style rules and legend](../examples/style-rules-and-legend.md) gives
  a layer a style rule

## Reference

- [`LayersCollection`](../api/maplibre-gl-draw/interfaces/LayersCollection.md)
  and [`GroupsCollection`](../api/maplibre-gl-draw/interfaces/GroupsCollection.md),
  [`TransactionLayers`](../api/maplibre-gl-draw/interfaces/TransactionLayers.md)
  and [`TransactionGroups`](../api/maplibre-gl-draw/interfaces/TransactionGroups.md)
- [`Layer`](../api/maplibre-gl-draw/type-aliases/Layer.md),
  [`LayerInput`](../api/maplibre-gl-draw/interfaces/LayerInput.md) and
  [`Group`](../api/maplibre-gl-draw/type-aliases/Group.md)
- [`Placement`](../api/maplibre-gl-draw/type-aliases/Placement.md)
- [`Draw`](../api/maplibre-gl-draw/interfaces/Draw.md) (`getLayerStack`)
  and [`LayerStackEntry`](../api/maplibre-gl-draw/interfaces/LayerStackEntry.md)
- [Events](../reference/events.md)
