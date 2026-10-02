---
aside: false
---

# Geometry operations

Combining, cutting and measuring features: union, intersection,
difference, split and buffer, each one call, with the length and the
area of the selection.

```example
geometry-operations
```

On a wide screen, the page opens with the two squares that share an
edge selected, so the
panel on the right offers the operations for two areas. Union merges
them into one. Shift + click selects more: select the first square and
the line across it to split the square along the line, or any feature
to make the area around it with Buffer. The result of an operation is
selected. The length and the area of the selection are logged in the
browser console as it changes.

## Code

The squares and the line are created from code (1). Each operation of
the panel is one call of `draw.features` with the IDs of the selection,
which changes the document in one step and returns what it made (2).
The page makes one of them itself, a buffer of 40 m around the line
(4). `length` and `area` come from the geometry entry, plain functions of
GeoJSON geometries in meters and square meters on the ground (3).

::: code-group
<<< @/../examples/geometry-operations/main.ts
<<< @/../examples/geometry-operations/data.ts
<<< @/../examples/geometry-operations/index.html
:::

## Related

- [Combining and splitting features](../guides/snapping-geometry.md#combining-and-splitting-features)
  and [the geometry entry](../guides/snapping-geometry.md#the-geometry-entry)
  in the guide to snapping and geometry
- [`FeaturesCollection`](../api/maplibre-gl-draw/interfaces/FeaturesCollection.md)
  for `union`, `intersection`, `difference`, `split` and `buffer`
- [`length`](../api/geometry/functions/length.md) and
  [`area`](../api/geometry/functions/area.md) of the geometry entry
- [The inspector](../../ui/README.md#inspector) of the standard UI, with
  its operations
