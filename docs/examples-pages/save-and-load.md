---
aside: false
---

# Save and load

Getting the drawing out and back in: GeoJSON and the format of the
library, files dropped on the map, and the features a load leaves out.

```example
save-and-load
```

The page opens with a GeoJSON file of five features. Four are added to
the drawing; the fifth, a line of a single position, is left out, and the
browser console says why. Change the drawing and press `S`: the whole
document is saved in the browser in the format of the library, and its
GeoJSON is logged. Press `O` to load the saved document back in place of
the drawing, or reload the page, which opens with it. Drop a GeoJSON
file, a saved document or an image on the map to load it; an image is
placed where it is dropped.

## Code

`draw.document.load` reads the format from the content (2) and returns a
`LoadResult` with the format, the features read and those left out (1).
`draw.document.toJSON` writes the whole document, with its layers, its
groups and their order, and `draw.document.toGeoJSON` the features alone
(3). A document of the library replaces the drawing as it loads (4). The
keys (5) and the drop (6) belong to the page: the library leaves them to
the application.

::: code-group
<<< @/../examples/save-and-load/main.ts
<<< @/../examples/save-and-load/data.ts
<<< @/../examples/save-and-load/index.html
:::

## Related

- [Saving and loading](../guides/save-load.md): the two formats, what a
  load leaves out, files dropped on the map and saving after each change
- [`draw.document`](../api/maplibre-gl-draw/interfaces/DocumentResource.md),
  [`LoadOptions`](../api/maplibre-gl-draw/interfaces/LoadOptions.md) and
  [`LoadResult`](../api/maplibre-gl-draw/interfaces/LoadResult.md)
- [The data format](../reference/data-format.md) of both formats
