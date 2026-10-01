---
aside: false
---

# Globe

Drawing on the globe: the shortest way between two places, a great
circle, and an area across the antimeridian.

```example
globe
```

The red line is the great circle from London to Tokyo, over the north of
Siberia. The dashed line joins the same two places with two vertices: an
edge follows the path it takes on the flat map, as the layers of the map
do, so a great circle needs many vertices along it. The yellow area lies
across the antimeridian, east of Fiji. Turn the globe with a drag and
draw on it with the tools at the bottom. The globe button at the bottom
right switches to the flat map and back.

## Code

The projection is the map's own, set with `map.setProjection` once the
style has loaded (1), and the library follows it. The page computes the
great circle itself, as points along it (2), next to the line of two
vertices (3). The area across the antimeridian keeps its longitudes past
180 rather than jumping to -180 (4), as a shape drawn across the line is
kept. The globe button is one of the map controls of the standard UI
(5).

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
