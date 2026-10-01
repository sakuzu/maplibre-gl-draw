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
browser console says why. The page has no buttons of its own: its
switches are keys, listed in the console as it opens and left alone while
a field of the panels has the keyboard.

| Keys | Does |
| --- | --- |
| `S` | Save the whole document in this browser, in the format of the library |
| `O` | Load the saved document in place of the drawing |
| `D` | Download the document in the format of the library |
| `G` | Download the features as GeoJSON |
| `B` | Open a file from the disk |

Change the drawing and press `S`; then press `O` to load it back, or
reload the page, which opens with it. `D` and `G` save the same drawing
as files, named after its title. `B` opens the file chooser of the
browser; a GeoJSON file, a saved document or an image chosen there is
loaded as a dropped one would be. Drop such a file on the map to load it
there; an image is placed where it is dropped.

## Code

`draw.document.load` reads the format from the content (2) and returns a
`LoadResult` with the format, the features read and those left out (1).
`draw.document.toJSON` writes the whole document, with its layers, its
groups and their order, and `draw.document.toGeoJSON` the features alone
(3). A document of the library replaces the drawing as it loads (4). A
download is a `Blob` of the text and a link that names the file (5), and
a file from the disk comes through an input made when `B` is pressed (6).
The keys (7) and the drop (8) belong to the page: the library leaves them
to the application.

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
