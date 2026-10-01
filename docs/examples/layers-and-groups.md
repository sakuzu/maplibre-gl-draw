---
aside: false
---

# Layers and groups

The layers of a drawing and the groups in them: their order, the layer
that receives what is drawn, visibility, locks and opacity, made from
code and shown in the panel on the left.

```example
layers-and-groups
```

The panel on the left lists the layers from the front, with their groups
and features. Click an eye to hide a layer, a group or a feature, and a
lock to lock it. Drag a row by its grip to reorder, double-click a name
to rename it, and add a layer or a group from the selection with the add
menu. Select a layer to see its opacity in the panel on the right. The
features of the locked group can be selected but not moved, and the
paths fade at 60 percent. A line drawn with the tools goes into Paths,
the active layer.

## Code

The document starts with one empty layer, which the page names; a
second layer is created behind it (1). Features go into the layer their
`layerId` names (2). A group gathers features of one layer,
`features.move` puts another into it, and the group is then locked (3).
`visible: false` hides the draft for everyone who shares the document
(4). `layers.reorder` takes the IDs of every layer from the back, and
`opacity` fades a whole layer (5). `layers.setActive` chooses where the
tools draw (6).

::: code-group
<<< @/../examples/layers-and-groups/main.ts
<<< @/../examples/layers-and-groups/data.ts
<<< @/../examples/layers-and-groups/index.html
:::

## Related

- [Layers and groups](../guides/layers.md): the active layer, the
  stacking order, groups, locking, visibility and opacity
- [`LayersCollection`](../api/maplibre-gl-draw/interfaces/LayersCollection.md)
  and [`GroupsCollection`](../api/maplibre-gl-draw/interfaces/GroupsCollection.md)
- [`features.move`](../api/maplibre-gl-draw/interfaces/FeaturesCollection.md#move)
- [Read-only](../guides/read-only.md): hiding on this page only, and
  stopping every edit at once
- [The layer panel](../../ui/README.md#use) of the standard UI
