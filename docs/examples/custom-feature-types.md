---
aside: false
---

# Custom feature types

Feature types the library does not have: a route, a line with style
keys of its own, which its definition draws, hits and takes into a
selection box, with a section of the panel on the right for its keys;
and a card, a paper card laid on the map around a point, which the
library turns and scales, and whose paper the rule of its layer
colors.

```example
custom-feature-types
```

On a wide screen, the page opens with the river route selected. The
Route section of the
panel on the right has its color, its width and whether it is dashed,
and a change there redraws it at once. Click the other route, or drag a
selection box over a vertex of it with Shift held, to select it; drag a
vertex to move it.

The page has one action of its own, a switch in the card of actions at
the bottom left of the map. Its key is listed with `?` and left alone
while a field of the panels has the keyboard:

| Action | Key | What it does |
| --- | --- | --- |
| Route type | `U` | Unregisters the type Route, or registers it again |

Turn the switch off: the two routes stay in the drawing, with their
geometry and their style keys, but nothing draws them any more, and a
click passes through them. A selection box over a vertex still selects
one, as the library takes a feature of an unknown type into a box by its
positions. Turn it on again: the routes are drawn and hit as before,
with the looks they had.

The two cards stand in a layer of their own, Cards, whose rule colors
their paper by their topic. Select one: the resize handles on the
corners of its selection box scale it and keep its shape, the handle
above it turns it, and the handle in the middle of its east edge widens
it alone. It grows and shrinks with the map from the zoom it was made at.

## Code

The definition (`route.ts`) gives the type its renderer, which draws the
line with the shared line renderer of the library, its hit test, its box
selection, its selection box and the handles on its vertices. The
library draws the resize and rotate handles of its box; the handles on
the vertices are `custom` handles, whose marks the type draws itself
(`drawHandles`), as wide as they are hit. `featureTypes.add` registers it
(1), and `featureTypes.remove` takes it out again, from a switch the page
adds with `ui.actions.add` (6). The style keys of a route (`routeColor`,
`routeWidth`, `routeDashed`) are declared by declaration merging on
`FeatureStyle`: core keeps a key it
does not define with the feature, and the renderer checks the value
before using it.

The inspector of the standard UI has style fields only for the types of
the library, so the page adds a section for the route's keys with
`ui.inspector.sections.add` (4). Its `fields` are drawn by the UI, a
color, a slider and a toggle, and `onchange` writes the key that changed
into the style of the selected routes.

The card (`card.ts`) is drawn on a Point. Its width and height are
pixels at the zoom it was made at, which its footprint turns into meters
with `pixelsToMeters` and lays on the map with `metersToDegrees` of
`/geometry`, turned by its angle (`cardFootprint`). Its `transformFields`
name the keys the handles of the selection box write, its rotation and
its scale, which the footprint reads. Its `handles` give a `resize`
handle in the middle of the east edge of the selection box
(`eastMiddleOf`), whose drag writes its width (`widthFromCenter`). It
declares its look in `defaultStyle` and that the rule colors its fill
(`styleRuleChannel: 'fill'`), and its renderer draws with
`ctx.appliedStyle(feature)`, the paper colored by the rule (7).

::: code-group
<<< @/../examples/custom-feature-types/main.ts
<<< @/../examples/custom-feature-types/route.ts
<<< @/../examples/custom-feature-types/card.ts
<<< @/../examples/custom-feature-types/data.ts
<<< @/../examples/custom-feature-types/index.html
:::

## Related

- [Custom feature types](../guides/custom-types.md): the definition of a
  type, its renderer and its hit test
- [`FeatureTypeDefinition`](../api/maplibre-gl-draw/interfaces/FeatureTypeDefinition.md)
  and [`FeatureStyle`](../api/maplibre-gl-draw/interfaces/FeatureStyle.md)
- [A section of the inspector](../../ui/README.md#inspector) of the
  standard UI
