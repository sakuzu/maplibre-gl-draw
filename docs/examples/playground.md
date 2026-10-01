---
aside: false
---

# Playground

Every feature of the library on one page: the standard UI with all its
parts, a plugin and a custom feature type with their tools and sections,
terrain, the globe, a dataset, read-only and the interaction lock, saving
in the browser, and 200,000 features.

```example
playground
```

The page opens on a drawing east of Tokyo Station in five layers, from
the back:

- Land use colors nine parcels by a categorical style rule
- Draft (50%) is drawn at half opacity
- Zones has an area with a hole, selected so that its vertex handles
  show; a MultiPolygon; and three groups: three overlapping circles with
  a radius in meters, five squares from a full to a faint fill, and three
  areas with a solid, a dashed and a dotted outline 1, 3 and 6 px wide
- Routes has five lines from 1.5 to 12 px wide and a group of a dashed
  and a dotted trail
- Notes has an image, a freehand stroke around it and a group of points
  of the four shapes

Under the layers, a dataset of fine hexagonal cells is colored by a
graduated rule. The Legend tab lists the rules of Land use and of the
dataset.

The address of the page chooses what it opens:

| Address | Opens |
| --- | --- |
| (nothing) | The drawing above |
| `?plain` | An empty drawing with one layer |
| `?showcase=<scene>` | Another scene of the README images |
| `?locale=ja` | The standard UI in Japanese, with any of the above |

The scenes are `tilted`, `terrain`, `globe` and `large-data`.

The tools at the bottom draw points, lines, areas, circles, freehand
strokes and images (the image tool asks for a file). The star stamps a
point with the mode of a plugin (`S`), and the route tool places a
feature of a custom type (`R`); each has a section of its own in the
panel on the right. The globe button at the bottom right switches the
projection. A file dropped on the map is loaded there.

The switches that are not tools are keys with Shift, also listed in the
browser console when the page opens:

| Keys | Switch |
| --- | --- |
| Shift+T | Terrain on and off |
| Shift+D | A dataset of 10,000 cells on and off |
| Shift+R | Read-only on and off |
| Shift+K | The interaction lock on and off |
| Shift+S | Save the drawing in this browser (localStorage) |
| Shift+O | Open the drawing saved in this browser |
| Shift+B | Load 200,000 points as features, or remove them |

The layer of the 200,000 points lists no features in the layer panel,
only their number, as any layer of more than 1,000 features does.

## Code

The page is in `playground/` and runs on its own with
`npm run dev:playground` (on port 3300). It takes the plugin from the
[Plugins](plugins.md) example and the type from the
[Custom feature types](custom-feature-types.md) example, and adds their
tools and sections through `ui.tools.add` and
`ui.inspector.sections.add`.

::: code-group
<<< @/../playground/main.ts
<<< @/../playground/switches.ts
<<< @/../playground/index.html
:::

## Related

- [The standard UI](../../ui/README.md) and its options
- The guides of [read-only](../guides/read-only.md),
  [terrain](../guides/terrain.md), [large data](../guides/large-data.md),
  [plugins](../guides/plugins.md) and
  [custom feature types](../guides/custom-types.md)
