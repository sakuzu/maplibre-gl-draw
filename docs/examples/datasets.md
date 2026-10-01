---
aside: false
---

# Datasets

Data that is only shown, under and over the user's own drawing: the
10,477 buildings and the 17,558 places of central Tokyo from Overture
Maps, between and in front of two layers of the drawing.

```example
datasets
```

The buildings and the colored points are rows of two datasets, not
features of the drawing: they cannot be selected or edited, and they are
not saved with the drawing. The survey area and the planned route are
features of two layers of the drawing, and the buildings lie between
them: in front of the survey area and behind the route. The places are
in front of everything.

The buildings are colored by their height, in classes cut at 10, 20, 40
and 80 m. Overture gives a height to few buildings of this area (695,
most of them from their number of floors), so the others take the grey
the rule gives to a value it cannot read. The places are colored by
their category, the six most common ones, and show from zoom 14.

Draw a line with the tools: it goes into the route layer, and it snaps
to the edges and the corners of the buildings. Click a building or a
place: the row is logged in the browser console with its name and
attributes. The panel on the right shows drawn features only, so it
closes. The Legend tab lists the rules of layers only, so the page logs
the legends of the two rules there too. Move the map: the places are
handed over again for the new view, and those that overlap on the screen
are thinned until zoom 18.

## Code

The page turns on the snapping to datasets (the default, given to show
it) and makes its own layers (1). The survey area and the route are
features of two layers, there from the first frame (2). The page fetches
the two GeoJSON files of the sample data and gives their features to
`draw.datasets.add` as rows. The buildings are given at once, colored by
a graduated rule on `height` (3). With the order `layer-order`, the
dataset has a place in the stacking order of the layers, and
`draw.layers.reorder` puts it between the two (4). A `provider` is
called with the extent in view and the zoom once the map rests (5); a
real one fetches the rows from a server, and this one takes the places in
the extent from the array the page already holds. The categorical rule of
the places is made from the data, the six most common categories and
grey for the others. `deriveLegend` turns each rule into the rows of a
legend, which the page logs (6). `interactive: true` makes the rows take
clicks, which `dataset.clicked` reports (7), and makes them candidates
for the snapping.

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
- [`layers.reorder`](../api/maplibre-gl-draw/interfaces/LayersCollection.md#reorder)
  and [`SnappingOptions`](../api/maplibre-gl-draw/interfaces/SnappingOptions.md)
- [The events](../reference/events.md), `dataset.clicked` among them
- [`deriveLegend`](../api/maplibre-gl-draw/functions/deriveLegend.md)

Data: [Overture Maps Foundation](https://overturemaps.org), ODbL / CDLA
([the sample data](../../examples/public/data/README.md))
