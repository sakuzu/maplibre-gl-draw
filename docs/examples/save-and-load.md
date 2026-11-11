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
browser console says why. Its buttons are in the card of actions at the
bottom left of the map, each with its key: `?` lists the keys, and a key
is left alone while a field of the panels has the keyboard.

| Action | Key | What it does |
| --- | --- | --- |
| Save | `S` | Saves the document in this browser, in the library's format |
| Load | `O` | Loads the saved document in place of the drawing |
| Download | `D` | Downloads the document in the format of the library |
| Download GeoJSON | `G` | Downloads the features as GeoJSON |
| Open a file | `B` | Opens a file from the disk |

Change the drawing and press Save; then press Load to load it back, or
reload the page, which opens with it. Download and Download GeoJSON save
the same drawing as files, named after its title. Open a file opens the
file chooser of the browser; a GeoJSON file, a saved document or an
image chosen there is loaded as a dropped one would be. Drop such a file
on the map to load it there; an image is placed where it is dropped.

## Code

`draw.open` replaces the drawing with the document saved on the last
visit, and `tx.import` adds the features of a GeoJSON file to it; both
read the format from the content (2), and tell the features read and those
left out (1). `draw.document.toJSON` writes the whole document, with its
layers, its groups and their order, and `draw.document.toGeoJSON` the
features alone (3). `draw.open` drops the steps of undo as it replaces the
drawing (4). A download is a `Blob` of the text and a link that names the
file (5), and a file from the disk comes through an input made when Open a
file is pressed (6); an image is imported as a GeoJSON feature of the type
`Image` that carries the picture (`image-feature.ts`). The buttons are
actions of the standard UI, added with `ui.actions.add` with their keys
(7). The drop (8) belongs to the page: the library leaves it to the
application.

::: code-group
<<< @/../examples/save-and-load/main.ts
<<< @/../examples/save-and-load/data.ts
<<< @/../examples/save-and-load/image-feature.ts
<<< @/../examples/save-and-load/index.html
:::

## Related

- [Saving and loading](../guides/save-load.md): the two formats, what a
  load leaves out, files dropped on the map and saving after each change
- [`draw.document`](../api/maplibre-gl-draw/interfaces/DocumentResource.md),
  [`draw.open`](../api/maplibre-gl-draw/interfaces/Draw.md#open) and
  [`tx.import`](../api/maplibre-gl-draw/interfaces/Transaction.md#import)
- [The data format](../reference/data-format.md) of both formats
