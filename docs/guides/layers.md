# Layers and groups

Every feature lives in a layer, and features of one layer can be gathered
into groups. This guide covers the layers, the active layer that receives
new features, groups, locking, the draw order, and how to put MapLibre's
own layers between the layers of the drawing.

## Minimal code

```ts
import { createMapLibreGLDraw } from '@sakuzu/maplibre-gl-draw';

const draw = createMapLibreGLDraw(map);

// A default layer ("Layer 1") exists; add a second one and draw into it
// (addLayer returns null when the instance is read-only)
const notes = draw.addLayer('Notes');
if (notes !== null) {
  draw.setActiveLayer(notes);
  draw.setMode('draw_point');

  // Later: lock it, so that its features can be selected but not edited
  draw.updateLayer(notes, { locked: true });
}
```

## Layers

A `Layer` has a `name`, `visible`, `locked`, an `opacity`, an `order` of
the items it holds (feature and group IDs, the end is the front) and an
optional `styleRule` ([Styles](styles.md)).

| Method | Does |
| --- | --- |
| `addLayer(name?)` | adds a layer at the front and returns its ID |
| `updateLayer(id, updates)` | changes fields of a layer |
| `deleteLayer(id)` | deletes a layer with its features and groups |
| `getAllLayers()`, `getLayer(id)` | reads |

While the instance is read-only, `addLayer` adds nothing and returns
`null`, as `addFeature` and `addGroup` do ([Read-only](read-only.md)).

A layer or a group added without a name is named by the automatic naming
(`Layer 2`, `Group 1`), in the words of the `autoName` option
([Automatic names](drawing.md#automatic-names)).

On creation a default layer with the ID `default-layer` is created. With
`initDefaultLayer: false` no layer is created, and the host creates the
layers itself, for example when it restores a structure from its own data.

`deleteLayer` deletes whatever the layer holds. `draw.deleteSelection()`
and the Delete key, when a layer is selected, keep at least one layer and
do not delete a layer that holds a locked feature or group.

Changes emit `draw.layer.create`, `draw.layer.update`, `draw.layer.delete`
and `draw.layer.reorder`.

## The active layer

New features go into the active layer. `setActiveLayer(id)` sets it and
`getActiveLayer()` reads it. When the active layer is deleted, the first
layer becomes active.

User drawing writes only into a layer that exists, is not locked and is
visible (neither hidden for everyone nor locally hidden). When the active
layer is not writable, a drawing goes into the first writable layer, and
the active layer comes back once it is writable again. While no layer is
writable, `setMode` refuses the drawing modes. This rule is for user
drawing only: `addFeature` and `load` accept any existing layer.

## Draw order

The end of an array is the front at every level:

1. between layers, the layer order (`getLayerOrder()`)
2. inside a layer, `layer.order` (features and groups)
3. inside a group, `group.featureIds`

`getAllFeatures()` returns every feature in this order, from the back.

<!-- docs-check:
declare const notes: string;
-->

```ts
// Put the notes layer behind the default layer
draw.setLayerOrder([notes, 'default-layer']);

// Bring one feature to the front of its layer
const layer = draw.getLayer('default-layer');
if (layer) draw.reorderInLayer(featureId, layer.id, layer.order.length - 1);

// Move a feature or a group to another layer
draw.moveToLayer(featureId, notes);
```

The layer order is part of the document: `export('native')` saves it and
`load()` replaces it as a whole, and a replaced store holds it. It
can also hold entries of your own that are not layers: the ID of a
dataset ([Large data](large-data.md)) and separators
(below). Their meaning is yours; the library keeps each at its position.

- `setLayerOrder` keeps an ID that is not a layer. It drops empty strings
  and keeps a repeated ID at its first position
- `addLayer` puts the new layer at the front, and `deleteLayer` takes only
  that layer's ID out. Nothing else removes an entry, so an entry of yours
  stays until you set an order without it
- An ID that names nothing is skipped when drawing

## Groups

A group gathers features of one layer so that they are selected, moved,
hidden and locked together.

<!-- docs-check:
declare const idA: string;
declare const idB: string;
-->

```ts
// null while read-only
const groupId = draw.addGroup([idA, idB], draw.getActiveLayer(), 'Site');

// Or from the current selection, like Cmd/Ctrl+G
draw.select([idA, idB]);
const created = draw.groupSelection(); // null when it cannot group
```

`groupSelection` groups when two or more features are selected, all in the
same layer, and none of them already in a group. The group takes the place
of the frontmost selected feature in the layer's order.

| Method | Does |
| --- | --- |
| `addFeatureToGroup(featureId, groupId, index?)` | moves a feature in |
| `removeFeatureFromGroup(featureId)` | puts it right after the group |
| `reorderInGroup(featureId, groupId, index)` | reorders inside |
| `ungroupSelection()` | dissolves or takes members out |
| `ungroupGroup(groupId)` | dissolves one group |
| `deleteGroup(groupId)` | deletes the group, keeps the features |

- `ungroupSelection` dissolves a selected group, or takes the selected
  members out of their group; it is what Shift+Cmd/Ctrl+G does
- Dissolving or deleting a group puts its features where the group was, in
  their order
- A group left empty (its last member removed or deleted) is deleted
  automatically
- A feature is always listed in exactly one place: in its group's
  `featureIds` when it has a `groupId`, otherwise in its layer's `order`.
  Changing `layerId` or `groupId` with `updateFeature` moves it

## Locking

`locked` on a feature, a group or a layer allows selecting and showing it
and refuses every other edit.

```ts
draw.updateFeature(featureId, { locked: true });
draw.updateGroup(groupId, { locked: true });
draw.updateLayer(layerId, { locked: true });
```

- The lock is inherited: a feature is locked when it, its group or its
  layer is locked. `isFeatureLocked(feature, draw.getStore())` answers
  that
- A locked feature can be selected, and `getSelectedFeatures()` includes
  it
- It cannot be moved, resized, rotated, vertex-edited or deleted, it shows
  no handles, and box selection skips it
- `updateFeature`, `updateGroup` and `updateLayer` return `false` for an
  update of a locked item that changes anything other than `locked` and
  `visible`
- The Delete key keeps locked features: a selected group loses only its
  unlocked members, and a layer that holds a locked item is not deleted
- The geometry operations skip locked features

To stop every edit at once without touching the data, use read-only or the
interaction lock ([Read-only](read-only.md)).

## Visibility

`visible: false` on a feature, a group or a layer hides it for everyone
who shares the document; it is saved and exported. To hide something on
this client only, use `setLocallyHidden` ([Read-only](read-only.md)).
Hidden features are not drawn, hit-tested, snapped to or used by the
geometry operations.

## Opacity

`opacity` (0 to 1) fades a whole layer. It is multiplied into the alpha of
everything drawn for the layer: fills, lines, points, images, and what the
renderers of custom types and feature companions draw.

```ts
draw.updateLayer(layerId, { opacity: 0.4 });
```

- It is applied at draw time, so changing it (a slider, say) rebuilds
  nothing
- It is only a look: a feature in a layer at opacity 0 is still
  hit-tested and can be selected. To take a layer out of the way, hide it
- A custom renderer receives the value as `context.opacity` and
  multiplies it into its own alpha ([Custom types](custom-types.md))

## Separators and frames

The drawing is one MapLibre custom layer, so a MapLibre layer (vector
tiles, raster) is either below or above all of it. To put such a layer
between the layers of the drawing, mark an entry of the layer order as a
separator. The drawing is then split into frames, one custom layer per
interval between separators, and the host moves its MapLibre layer between
them. A single feature cannot be placed between MapLibre layers with
`beforeId`; a whole interval of the drawing moves as one.

<!-- docs-check:
declare const parcels: string;
declare const notes: string;
-->

```ts
const SEPARATOR = 'sep:';

const draw = createMapLibreGLDraw(map, {
  isExternalEntry: (id) => id.startsWith(SEPARATOR),
});

// Roads (a MapLibre layer) between the parcels and the notes
draw.setLayerOrder([parcels, `${SEPARATOR}roads`, notes]);

function placeNativeLayers(): void {
  const order = draw.getLayerOrder();
  const slots = draw.getRenderSlots();
  order.forEach((entry, index) => {
    if (!entry.startsWith(SEPARATOR)) return;
    // Just below the frame above the separator, or at the top
    const above = slots.find((slot) => slot.from > index);
    map.moveLayer(entry.slice(SEPARATOR.length), above?.layerId);
  });
}

placeNativeLayers();
draw.on('draw.renderslots.change', placeNativeLayers);
```

- `getRenderSlots()` returns the frames from the back, each with its
  interval `[from, to)` on the layer order and the ID of its custom layer
- Without separators there is one frame, `maplibre-gl-draw-layer`
- `draw.renderslots.change` fires when frames are added or removed or an
  interval changes; place the MapLibre layers again then

## Examples

- [style-rules](../../examples/style-rules/) adds layers and gives
  them style rules
- [read-only](../../examples/read-only/) locks a layer and checks
  `isFeatureLocked`

## Reference

- [`MapLibreGLDraw`](../reference/api/interfaces/index.MapLibreGLDraw.html)
  (the layer, group and order methods, `getRenderSlots`)
- [`Layer`](../reference/api/interfaces/index.Layer.html) and
  [`Group`](../reference/api/interfaces/index.Group.html)
- [`RenderSlot`](../reference/api/interfaces/index.RenderSlot.html)
- [`isFeatureLocked`](../reference/api/functions/index.isFeatureLocked.html)
- [Events](../reference/events.md)
