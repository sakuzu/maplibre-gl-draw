---
aside: false
---

# Terrain

Drawing and editing on the 3D terrain of the map, with the standard UI
over it.

```example
terrain
```

The map opens tilted over the Alps, with a line across the valley and an
area on the slope. Both lie on the relief. Draw with the tools at the
bottom: the vertices land on the ground under the pointer. Select a
feature and drag it or its vertices; the handles stand on the ground.
Turn the map with the right button, or with Ctrl and a drag, and press
the compass at the bottom right to make it flat again. The browser
console says whether the last frame was drawn on the terrain.

## Code

The terrain is the map's own: a `raster-dem` source and
`map.setTerrain` (2). The library has no setting for it and follows it,
so the features (3) and the standard UI (4) are created as on a flat
map. `draw.debug.terrain` tells how the last frame was drawn (5).

::: code-group
<<< @/../examples/terrain/main.ts
<<< @/../examples/terrain/index.html
:::

## Related

- [Terrain](../guides/terrain.md): what changes on the terrain, points
  and handles, the exaggeration, the diagnostics and the limits
- [`TerrainDiagnostics`](../api/maplibre-gl-draw/interfaces/TerrainDiagnostics.md),
  what `draw.debug.terrain` returns
- [The map controls](../../ui/README.md#map-controls) of the standard UI
