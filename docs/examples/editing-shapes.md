---
aside: false
---

# Editing shapes

The handles of a selected feature: the frame that resizes and rotates
it, its vertices and midpoints, an area with a hole, an area of two
parts, and two parcels whose shared vertices move together.

```example
editing-shapes
```

The page opens with the west parcel selected. The squares at the
corners of its frame resize it from the opposite corner, and the dot
above the frame rotates it around the center. A round handle sits on
each vertex and a smaller one halfway along each edge: drag a vertex to
move it, or a midpoint to add a vertex there. Click a vertex to select
it, Shift + click to add another, and Delete removes them. The two
parcels share an edge: drag one of its ends and the vertex of the east
parcel follows. Press `T` to switch that off and drag again, and the
west parcel moves alone; the browser console logs the state. Below,
select the courtyard, an area with a hole, and the islands, one feature
of two parts, to see handles on every ring and every part.

## Code

The option `topology.sharedVertexDrag` turns the shared vertices on
when the instance is created (1), and `draw.options.update` switches it
while it runs (5). The parcels list the very same positions for the ends
of their edge, as a shared vertex is an exact match (2). A hole is the
second ring of a `Polygon`, and the parts of a `MultiPolygon` are
polygons of their own, each created with its geometry (2).
`draw.selection.set` opens the page with a parcel selected (4).

::: code-group
<<< @/../examples/editing-shapes/main.ts
<<< @/../examples/editing-shapes/data.ts
<<< @/../examples/editing-shapes/index.html
:::

## Related

- [Selecting and editing](../guides/drawing.md#selecting-and-editing),
  [vertices](../guides/drawing.md#vertices) and
  [multi geometries and holes](../guides/drawing.md#multi-geometries-and-holes)
  in the guide to drawing and editing
- [Moving shared vertices together](../guides/snapping-geometry.md#moving-shared-vertices-together)
  in the guide to snapping and geometry
- [`TopologyOptions`](../api/maplibre-gl-draw/interfaces/TopologyOptions.md)
  for `sharedVertexDrag`, and
  [`SelectionStyleOptions`](../api/maplibre-gl-draw/interfaces/SelectionStyleOptions.md)
  for the look of the frame and the handles
- [`VertexSelectionResource`](../api/maplibre-gl-draw/interfaces/VertexSelectionResource.md),
  the selected vertices from code
