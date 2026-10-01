---
aside: false
---

# Globe

Drawing on the globe: routes between the continents along great
circles, a box between two meridians and two parallels, a circle of
2,500 km, a picture and six cities, all lying on the sphere, and an
area across the antimeridian.

```example
globe
```

The pink and purple lines are routes along great circles, the shortest
ways between the cities: Tokyo to London over the north of Siberia,
Tokyo to Perth, Dubai to Perth, and Singapore to New York by way of
Dubai and London, which runs on behind the globe. The orange box lies
between 50°E and 100°E and between 5°N and 38°N, given by its four
corners: an edge between two vertices follows the path it takes on the
flat map, as the layers of the map do, so the edges of the box run along
the meridians and the parallels, and a great circle needs many vertices
along it. The dashed blue line joins London and Tokyo with two vertices
only, and its one edge takes the straight line of the flat map instead
of the great circle. The blue circle reaches 2,500 km from Tokyo, the
picture of a storm floats over the Pacific, and the yellow area lies
across the antimeridian, east of Fiji. Turn the globe with a drag and
draw on it with the tools at the bottom. The globe button at the bottom
right switches to the flat map and back, where the routes show their
curves.

## Code

The projection is the map's own, set with `map.setProjection` once the
style has loaded (1), and the library follows it. The page makes three
layers, the areas, the routes and the cities, and creates the features
of data.ts in them in one call (2). The routes are computed there as
points along the great circles, one every 2 degrees of arc at most. The
area across the antimeridian keeps its longitudes past 180 rather than
jumping to -180, as a shape drawn across the line is kept. The globe
button is one of the map controls of the standard UI (3). The storm is
a picture made in a canvas, placed with `document.load` at its size in
pixels at zoom 3 (4).

::: code-group
<<< @/../examples/globe/main.ts
<<< @/../examples/globe/data.ts
<<< @/../examples/globe/index.html
:::

## Related

- [Selecting and editing](../guides/drawing.md#selecting-and-editing), on
  the path of an edge on the globe, and
  [near the antimeridian](../guides/drawing.md#near-the-antimeridian)
- [The data format](../reference/data-format.md), on how GeoJSON writes a
  shape across the antimeridian
- [The map controls](../../ui/README.md#map-controls) of the standard UI
