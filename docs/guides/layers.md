# Layers and groups

Every feature lives in a layer, and features of one layer can be gathered
into groups. This guide covers the layers, the active layer that receives
new features, groups, locking, the stacking order, and how to put the
layers of the map between the layers of the drawing.

## Minimal code

```ts
import { createDraw } from '@sakuzu/maplibre-gl-draw';

const draw = createDraw(map);

// The document starts with one empty layer; add a second one and draw
// into it (create returns null while the instance is read-only)
const notes = draw.layers.create({ name: 'Notes' });
if (notes) {
  draw.layers.setActive(notes.id);
  draw.setMode('draw_point');

  // Later: lock it, so that its features can be selected but not edited
  draw.layers.update(notes.id, { locked: true });
}
```

## Layers

A `Layer` has a `name`, `visible`, `locked`, an `opacity`, the `items` it
holds (the IDs of its features and groups, from the back), an optional
`styleRule` ([Styles](styles.md)) and optional `metadata` of your own.

| Method | Does |
| --- | --- |
| `layers.create(input)` | adds a layer, at the front unless `index` is given |
| `layers.update(id, patch)` | changes the keys given |
| `layers.delete(id)` | deletes a layer with its features and groups |
| `layers.get(id)`, `list()`, `count()`, `has(id)` | read |

`create` and `update` return the layer as it was stored. While the
instance is read-only they change nothing and return `null`, and `delete`
returns `false` ([Read-only](read-only.md)). An ID that does not exist
throws a `DrawError` with the code `not-found`. The methods whose name ends
in `Many` do the same for several layers in one transaction.

```ts
const roads = draw.layers.create({ name: 'Roads', opacity: 0.8, index: 0 });
const hidden = draw.layers.list({ visible: false });
```

A layer or a group created without a name is named by the automatic naming
(`Layer 2`, `Group 1`), in the words of the `autoName` option
([Automatic names](drawing.md#automatic-names)).

When the instance is created, the document starts with one empty layer.
With `initDefaultLayer: false` no layer is created, and the application
creates the layers itself, for example when it restores them from its own
data.

`layers.delete` deletes whatever the layer holds, and returns `false` for a
layer that is locked or holds a locked feature or group. Deleting the
selection (`selection.delete()` and the Delete key) with layers selected
keeps at least one layer.

Changes emit `layer.created`, `layer.updated`, `layer.deleted` and
`layer.reordered`.

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
drawing only: `features.create` and `document.load` accept any existing
layer.

## Stacking order

The front is at the end of every list:

1. between layers, the order of `layers.list()`
2. inside a layer, `layer.items` (features and groups)
3. inside a group, `group.featureIds`

`features.list()` returns every feature in this order, from the back.
`layers.reorder` takes the IDs of every layer from the back (and may
place other entries of the stacking order, below), and
`features.move` and `groups.move` place features and groups. Without an
`index` a move goes to the front of its destination; `index: 0` is the
back. `layers.getOrder()` returns the stacking order as `reorder` takes
it, the other entries placed on it included, so it can be changed and
given back:

```ts
const order = [...draw.layers.getOrder()];
const front = order.pop() as string;
draw.layers.reorder([front, ...order]); // the front goes to the back
```

<!-- docs-check:
declare const notes: import('@sakuzu/maplibre-gl-draw').Layer;
-->

```ts
// Put the notes layer behind every other layer
const others = draw.layers.list().filter((layer) => layer.id !== notes.id);
draw.layers.reorder([notes.id, ...others.map((layer) => layer.id)]);

// Bring one feature to the front of its layer
const target = draw.features.get(featureId);
if (target) draw.features.move(target.id, { layerId: target.layerId });

// Move a feature or a group to another layer
draw.features.move(featureId, { layerId: notes.id });
draw.groups.move(groupId, { layerId: notes.id, index: 0 });
```

- A feature moved to a layer leaves its group; `{ groupId }` moves it into
  a group of any layer, and `{ groupId: null }` takes it out of its group
  and puts it just in front of the group
- `moveMany` moves several features or groups and keeps their order among
  them
- A move of a locked item, or into a locked layer or group, returns
  `false` and changes nothing
- `feature.moved` reports each feature that moved, with where it came from
  and where it went

The stacking order is part of the document: `document.toJSON()` writes it
in `layerOrder`, and `document.load` of a document replaces it.

## Groups

A group gathers features of one layer so that they are selected, moved,
hidden and locked together.

<!-- docs-check:
declare const idA: string;
declare const idB: string;
-->

```ts
// null while read-only
const site = draw.groups.create({ featureIds: [idA, idB], name: 'Site' });

// Or from the current selection, like Cmd/Ctrl+G
draw.selection.set('feature', [idA, idB]);
const created = draw.selection.group(); // null when it cannot group
```

`groups.create` throws a `DrawError` when the features are not all in the
same layer. `selection.group()` groups when two or more features are
selected, all in the same layer, and none of them already in a group. The
group takes the place of the frontmost of its features in the layer.

| Method | Does |
| --- | --- |
| `features.move(id, { groupId })` | moves a feature into a group |
| `features.move(id, { groupId: null })` | takes it out, in front of the group |
| `features.move(id, { groupId, index })` | reorders inside the group |
| `groups.delete(id)` | dissolves a group, keeps the features |
| `selection.ungroup()` | as Shift+Cmd/Ctrl+G, below |

- Dissolving a group puts its features where the group was, in their order
- Shift+Cmd/Ctrl+G and `selection.ungroup()` dissolve the selected
  groups, or take the selected features out of their group
- A group left empty (its last feature moved out or deleted) is deleted
  as well
- A feature is always listed in exactly one place: in the `featureIds` of
  its group when it has a `groupId`, otherwise in the `items` of its layer

Changes emit `group.created`, `group.updated` and `group.deleted`.

## Locking

`locked` on a feature, a group or a layer allows selecting and showing it
and refuses every other edit.

```ts
draw.features.update(featureId, { locked: true });
draw.groups.update(groupId, { locked: true });
draw.layers.update(layerId, { locked: true });
```

- The lock is inherited: a feature is locked when it, its group or its
  layer is locked
- A locked feature can be selected, and `selection.features()` includes it
- It cannot be moved, resized, rotated, vertex-edited or deleted, it shows
  no handles, and box selection skips it
- `update` returns `null` for a locked item when the patch changes anything
  other than `locked` and `visible`, and `delete` and `move` return `false`
- The Delete key keeps locked features: a selected group loses only its
  unlocked features, and a layer that holds a locked item is not deleted
- The geometry operations refuse locked features

The inherited lock is read from the three items:

```ts
function isLocked(id: string): boolean {
  const f = draw.features.get(id);
  if (!f) return false;
  const group = f.groupId ? draw.groups.get(f.groupId) : undefined;
  const layer = draw.layers.get(f.layerId);
  return f.locked || group?.locked === true || layer?.locked === true;
}
```

To stop every edit at once without touching the data, use read-only or the
interaction lock ([Read-only](read-only.md)).

## Visibility

`visible: false` on a feature, a group or a layer hides it for everyone
who shares the document; it is saved and written out. To hide something on
this client only, use `draw.hidden.add(id)` ([Read-only](read-only.md)).
Hidden features are not drawn, hit-tested, snapped to or used by the
geometry operations, and they cannot be selected.

A feature's `visible` is its own flag: a feature can be visible itself and
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
draw.layers.update(layerId, { opacity: 0.4 });
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

<!-- docs-check:
declare const parcels: string;
-->

```ts
const SEPARATOR = 'sep:';

const draw = createDraw(map, {
  isExternalEntry: (id) => id.startsWith(SEPARATOR),
});

// The roads of the map go just in front of the parcels layer
const ids = draw.layers.list().map((layer) => layer.id);
ids.splice(ids.indexOf(parcels) + 1, 0, `${SEPARATOR}roads`);
draw.layers.reorder(ids);

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

- The entries of your own go into the stacking order with
  `layers.reorder`, which takes the IDs `isExternalEntry` recognizes
  besides the IDs of the layers, or through the document: the
  `layerOrder` of a document you load, or the Store you give the
  instance. An entry that `layers.reorder` is not given keeps its
  position
- `draw.getStore().getLayerOrder()` returns the whole stacking order, the
  entries of your own included, and `draw.layers.getOrder()` the same
  without the entries `layers.reorder` would refuse
- `draw.getLayerStack()` returns the runs from the back, each with its
  range `[from, to)` on the stacking order and the ID of the map layer
  that draws it
- Without entries of your own there is one run, `maplibre-gl-draw-layer`
- `layerStack.changed` fires when runs are added or removed or a range
  changes; place the map layers again then
- A dataset with `order: 'layer-order'` is drawn at the position of its ID
  in the same order ([Showing large data](large-data.md))

## Examples

- [style-rules](../../examples/style-rules/) adds layers and gives
  them style rules
- [read-only](../../examples/read-only/) locks a layer

## Reference

- [`LayersCollection`](../api/maplibre-gl-draw/interfaces/LayersCollection.md)
  and [`GroupsCollection`](../api/maplibre-gl-draw/interfaces/GroupsCollection.md)
- [`Layer`](../api/maplibre-gl-draw/interfaces/Layer.md),
  [`LayerInput`](../api/maplibre-gl-draw/interfaces/LayerInput.md) and
  [`Group`](../api/maplibre-gl-draw/interfaces/Group.md)
- [`MoveTarget`](../api/maplibre-gl-draw/type-aliases/MoveTarget.md)
- [`Draw`](../api/maplibre-gl-draw/interfaces/Draw.md) (`getLayerStack`)
  and [`LayerStackEntry`](../api/maplibre-gl-draw/interfaces/LayerStackEntry.md)
- [Events](../reference/events.md)
