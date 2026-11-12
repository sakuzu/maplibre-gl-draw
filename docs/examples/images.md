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

The library opens no file dialog. A click in `draw_image` calls the
option `requestImage` with where to place the image (the Image tool gives
the center of the map as soon as it is pressed); the page opens a file
picker and gives the file, and the library places it there, in the
active layer at the zoom of the map, as one commit (1). Code places an
image with `tx.import`, as a GeoJSON feature of the type `Image` that
carries the picture as a data URL under `maplibre-gl-draw:imageData`: it
is centered on its point and drawn at its size in pixels at its
reference zoom (3). The look of an image is `imageOpacity`, which the
slider of the panel writes too (4).

::: code-group
<<< @/../examples/images/main.ts
<<< @/../examples/images/data.ts
<<< @/../examples/images/index.html
:::

## Related

- [Images](../guides/drawing.md#images) in the guide to drawing and
  editing
- [Image](../reference/data-format.md#image) in the data format: the
  stored file, the size and the rotation
- [`RuntimeOptions`](../api/maplibre-gl-draw/interfaces/RuntimeOptions.md),
  with `requestImage`
- [The toolbar](../../ui/README.md#use) of the standard UI
