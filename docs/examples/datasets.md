---
aside: false
---

# Datasets

Over a million rows shown beside an editable drawing: 1,000,000 points
fetched for the view and thinned, 250,000 cells given at once, and the
real buildings and places of central Tokyo. A GeoJSON source of the map
would make an object of every feature, parse and keep the whole file,
draw every point however they overlap, and tell nothing of a feature
under a click until the page queries the rendered features; a dataset
holds only the points of the view, thins them on the screen, and gives
the row under a click with its attributes.

```example
datasets
```

Four datasets lie under and over the user's own drawing, a survey area
and a planned route in two layers. Their rows are not features of the
drawing: they cannot be selected or edited, and they are not saved with
the drawing. From the back:

- 250,000 hexagonal cells of 12 m a side over 12 km of the city, made in
  the page and given at once as rows, without outlines, colored by a
  value that varies smoothly over the city, in classes cut at 20, 40, 60
  and 80. They stand behind the survey area
- The 10,477 buildings of central Tokyo from Overture Maps, colored by
  the area of their footprint, from pink to deep purple, in classes cut
  at 50, 100, 200 and 500 m² (half of them are under 70 m²). They lie
  between the survey area and the route
- 1,000,000 points over about 100 km of the Kanto area, made in typed
  arrays when the page opens and held by a stand-in for a server, which
  hands over those of the part in view: every one from zoom 14, and a
  sample of them below, a quarter at zoom 13, a sixteenth at 12 and so
  on. Each is a trip that starts there, colored by how it is made: on
  foot, by bicycle, by car or by train. Points that overlap on the
  screen are thinned until zoom 17
- The 17,558 places of the same area from Overture Maps, small points
  colored by their six most common categories, from zoom 14, in front of
  everything

The map is the light grey Positron basemap, so that the colors read. The
browser console says how long the points took to make (about 150 ms on
a laptop), and how long the cells took to make (70 ms), to give to the
dataset (about 360 ms) and to reach the first frame that draws them. It
also says how many of the points handed over for the view are drawn, for
example 10,760 of 41,441 at the opening view.

Draw a line with the tools: it goes into the route layer, and it snaps
to the edges and the corners of the buildings. Click a building, a place
or a point: the row is logged in the browser console with its
attributes. The panel on the right shows drawn features only, so it
closes. Open the Legend tab: it lists the rules of the four datasets in
the order of the stack, the places, the points, the buildings and the
cells. Move the map: the points and the places are handed over again for
the new view.

## Actions

The switch is in the card of actions at the bottom left of the map, with
its key, which `?` lists:

| Action | Key | What it does |
| --- | --- | --- |
| Thin the points | `T` | Turns thinning off and on, and logs the count drawn |

## Code

The page turns on the snapping to datasets (the default, given to show
it) and makes its own layers (1). The survey area and the route are
features of two layers, there from the first frame (2). The cells are
made in data.ts and given to `draw.datasets.add` as rows once the map
has loaded, with a graduated rule on `value` and a base style without
outlines. With the order `layer-order`, the dataset has a place in the
stacking order of the layers, and `draw.layers.reorder` puts it at the
back (3). They take no clicks, so the lines drawn snap to the buildings
rather than to the cells. The points are made in typed arrays, with no
object per point, and sorted into a grid by the stand-in for the server.
A `provider` is called with the extent in view and the zoom once the map
rests, and returns the rows of that extent, built there; a real one
fetches them from a server. `collisionThinning` draws only the points in
front where their markers overlap, and a categorical rule on `kind`
colors them (4). `getThinningStats` says how many are drawn, and
`setCollisionThinning` turns the thinning off with `null`, from a switch
the page adds to the standard UI with `ui.actions.add` (5). The page
fetches the two GeoJSON files of the sample data and gives their
features to datasets as rows: the buildings at once, colored by a
graduated rule on `area` (6), placed between the two layers (7), and the
places through a provider that takes those in the extent from the array
the page already holds, with a categorical rule made from the data (8).
The Legend tab reads the rule of each dataset (`getStyleRule`) and turns
it into the rows of a legend (9), so the page has nothing to add for it.
`interactive: true` makes the rows take clicks, which `dataset.clicked`
reports (10), and makes them candidates for the snapping.

::: code-group
<<< @/../examples/datasets/main.ts
<<< @/../examples/datasets/data.ts
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
