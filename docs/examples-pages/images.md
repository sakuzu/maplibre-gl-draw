---
aside: false
---

# Images

Pictures placed on the map: an image file the user picks with the Image
tool, and an image placed from code.

```example
images
```

The page opens with a sketch map selected over the station, so the
panel on the right shows its opacity. Drag a corner to scale it, or the
handle above it to rotate it. Pick the Image tool (or press `I`) and
choose a file: the image is placed at the center of the map and
selected.

## Code

The library opens no file dialog. Entering `draw_image` emits
`image.requested` with where to place the image, the zoom and the layer;
the page opens a file picker and passes the file to
`draw.document.load` with them (1). Code places an image the same way,
from any image `Blob` or `File`: it is centered on `coordinate` and drawn
at its size in pixels at `zoom` (3). The look of an image is
`imageOpacity`, which the slider of the panel writes too (4).

::: code-group
<<< @/../examples/images/main.ts
<<< @/../examples/images/index.html
:::

## Related

- [Images](../guides/drawing.md#images) in the guide to drawing and
  editing
- [Image](../reference/data-format.md#image) in the data format: the
  stored file, the size and the rotation
- [`LoadOptions`](../api/maplibre-gl-draw/interfaces/LoadOptions.md),
  with `coordinate` and `zoom`
- [The input events](../reference/events.md#input),
  `image.requested` among them
- [The toolbar](../../ui/README.md#use) of the standard UI
