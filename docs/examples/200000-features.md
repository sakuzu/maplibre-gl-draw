---
aside: false
---

# 200,000 features

A city of 208,073 features, loaded into the drawing in one step, every
one of them editable.

```example
200000-features
```

The city is made up, on a bent grid of streets west of central Tokyo,
and seen from a tilted camera: near at hand in front, where the features
can be told apart, and far into the distance behind. It holds 174,435
polygons (buildings, and parks in green), 24,328 lines (streets, the
avenues in red) and 9,310 points (cafes, clinics and bakeries). On a
wide screen, the park in front opens selected, with its vertex handles.

The features are like those drawn by hand. Click a building to select
it: the panel on the right shows its use in the attributes. Drag it,
drag one of its vertices, or delete it with the Delete key. Zoom in to
the buildings in front, or out to see the whole city. The numbers and
the time the load took are logged in the browser console.

## Code

The layer panel of the standard UI lists up to 1,000 features in a layer
(3). Each layer of the city holds more, so the panel shows the number of
its features in a row under the layer instead of a row for each, and a
building is selected on the map. The city is made in code (`data.ts`)
with a seeded random number generator, so it is the same on every visit
(4). `draw.document.load` writes the 208,073 features in one transaction
(5): one change, one event and one redraw. `draw.features.createMany` is
one transaction too. The park is selected from the code once the load is
done, on a wide screen (from 48rem) only.

::: code-group
<<< @/../examples/200000-features/main.ts
<<< @/../examples/200000-features/data.ts
<<< @/../examples/200000-features/index.html
:::

## Related

- [Performance](../guides/performance.md): writing many features, a
  measured example of 208,073 features, and where to put the data
- [Showing large data](../guides/large-data.md), for data that is only
  shown, not edited
- [`draw.document.load`](../api/maplibre-gl-draw/interfaces/DocumentResource.md)
  and
  [`features.createMany`](../api/maplibre-gl-draw/interfaces/FeaturesCollection.md#createmany)
- [The layer panel](../../ui/README.md#use) of the standard UI and its
  `features` option
