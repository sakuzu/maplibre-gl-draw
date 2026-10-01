---
aside: false
---

# Datasets

Data that is only shown: 50,000 cells given at once, and points fetched
for the part of the map in view.

```example
datasets
```

The blue cells and the colored points are rows of two datasets, not
features of the drawing: they cannot be selected or edited, they are not
listed in the layer panel, and they are not saved with the drawing.
Click a cell or a point: the row is logged in the browser console. The
panel on the right shows drawn features only, so it stays closed. Move
the map: the points are fetched again for the new view, and those that
overlap on the screen are thinned until zoom 17. Draw an area with the
tools: it goes in front of the cells and behind the points.

## Code

The cells are made in code (1) and given to `draw.datasets.add` at once,
colored by a style rule (2). A `provider` is called with the extent in
view and the zoom once the map rests (3); a real one fetches the rows
from a server. `order` places each dataset behind or in front of the
drawing (2, 4). `interactive: true` makes the rows take clicks, which
`dataset.clicked` reports (5).

::: code-group
<<< @/../examples/datasets/main.ts
<<< @/../examples/datasets/index.html
:::

## Related

- [Showing large data](../guides/large-data.md): when to use a dataset,
  the ways to give the rows, fetching what is in view, the order against
  the drawing, thinning and clicks
- [`draw.datasets`](../api/maplibre-gl-draw/interfaces/DatasetsCollection.md),
  [`DatasetOptions`](../api/maplibre-gl-draw/type-aliases/DatasetOptions.md)
  and [`DatasetProvider`](../api/maplibre-gl-draw/type-aliases/DatasetProvider.md)
- [The events](../reference/events.md), `dataset.clicked` among them
