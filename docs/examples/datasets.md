---
aside: false
---

# Datasets

The 10,477 buildings and the 17,558 places of central Tokyo from
Overture Maps are drawn from two datasets, data that is only shown,
while the survey area and the planned route are the user's own drawing,
in two layers with the buildings between them; the Legend tab of the
panel on the left shows the colors of the two datasets.

```example
datasets
```

The buildings and the colored points are rows of two datasets, not
features of the drawing: they cannot be selected or edited, and they are
not saved with the drawing. The survey area and the planned route are
features of two layers of the drawing, and the buildings lie between
them: in front of the survey area and behind the route. The places are
in front of everything.

The map is the light grey Positron basemap, so that the colors read.
The buildings are colored by the area of their footprint, from pink to
deep purple, in classes cut at 50, 100, 200 and 500 m². Half the
buildings of the sample are under 70 m², a quarter over 160 m² and one
in twenty over 670 m², so each class holds a good share of them and the
large blocks stand out. The places are small points colored by their
category, the six most common ones, and show from zoom 14.

Draw a line with the tools: it goes into the route layer, and it snaps
to the edges and the corners of the buildings. Click a building or a
place: the row is logged in the browser console with its name and
attributes. The panel on the right shows drawn features only, so it
closes. Open the Legend tab: it lists the rules of the two datasets in
the order of the stack, the places in front and then the buildings.
Move the map: the places are
handed over again for the new view, and those that overlap on the screen
are thinned until zoom 18.

## Code

The page turns on the snapping to datasets (the default, given to show
it) and makes its own layers (1). The survey area and the route are
features of two layers, there from the first frame (2). The page fetches
the two GeoJSON files of the sample data and gives their features to
`draw.datasets.add` as rows. The buildings are given at once, colored by
a graduated rule on `area` (3). With the order `layer-order`, the
dataset has a place in the stacking order of the layers, and
`draw.layers.reorder` puts it between the two (4). A `provider` is
called with the extent in view and the zoom once the map rests (5); a
real one fetches the rows from a server, and this one takes the places in
the extent from the array the page already holds. The categorical rule of
the places is made from the data, the six most common categories and
grey for the others. The Legend tab reads the rule of each dataset
(`getStyleRule`) and turns it into the rows of a legend (6), so the page
has nothing to add for it. `interactive: true` makes the rows take
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
- [`Dataset`](../api/maplibre-gl-draw/interfaces/Dataset.md), with
  `getStyleRule`, and
  [`deriveLegend`](../api/maplibre-gl-draw/functions/deriveLegend.md),
  which the Legend tab uses

Data: [Overture Maps Foundation](https://overturemaps.org), ODbL / CDLA
([the sample data](../../examples/public/data/README.md))
