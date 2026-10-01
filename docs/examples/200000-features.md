---
aside: false
---

# 200,000 features

A made-up town of 200,000 buildings, loaded into the drawing in one step,
every one of them a feature that can be edited.

```example
200000-features
```

The buildings are features like those drawn by hand. Click one to select
it: the panel on the right shows its name, and its number of floors in
the attributes; a change there applies at once. Drag it, drag its
vertices, or delete it with the Delete key. Zoom out to see the whole
town. The time the load took is logged in the browser console.

## Code

The layer panel of the standard UI lists the layers without their
features (1), since its list makes a row for each feature. The town is
made in code (`data.ts`) with a seeded random number generator, so it is
the same on every visit (2). `draw.document.load` writes the 200,000
features in one transaction (3): one change, one event and one redraw.
`draw.features.createMany` is one transaction too.

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
