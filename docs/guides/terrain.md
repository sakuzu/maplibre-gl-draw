# Terrain

When the map has terrain (`map.setTerrain`), the drawing follows the
ground: areas and lines are painted on the relief, points and handles stand
on it, and clicks hit what is seen. There is nothing to turn on in the
library. This guide covers what changes, how symbols behave, the vertical
exaggeration, the diagnostics and the limits.

## Minimal code

```ts
import * as maplibregl from 'maplibre-gl';
import { createDraw } from '@sakuzu/maplibre-gl-draw';

const map = new maplibregl.Map({
  container: 'map',
  style: 'https://demotiles.maplibre.org/style.json',
  center: [138.73, 35.36],
  zoom: 11,
  pitch: 60,
});

map.on('load', () => {
  map.addSource('dem', {
    type: 'raster-dem',
    url: 'https://demotiles.maplibre.org/terrain-tiles/tiles.json',
    tileSize: 256,
  });
  map.setTerrain({ source: 'dem', exaggeration: 1.5 });
});

const draw = createDraw(map);
draw.setMode('draw_polygon');
```

The polygon is drawn on the slopes and stays there while the map is
tilted and rotated. `map.setTerrain(null)` turns the terrain off, and the
drawing goes back to flat without any call to the library.

## What changes

The library follows the map's terrain as it draws. A map without terrain
is drawn as a flat map, and switching the terrain on or off needs no
call.

- Areas and lines are painted as pixels of the ground rather than as
  triangles lifted onto it, so they follow every fold of the relief
  without tearing or sinking. A line keeps the width it has on a flat
  map, however steep the slope
- Area fills are shaded with the same light as the ground's hillshade, so
  the relief stays readable under an opaque fill. Only the lightness
  changes; the colors still match a legend
- Images are laid on the ground in their place in the draw order
- Hit testing, snapping and editing use the same positions as the
  drawing, so a click lands on what is seen
- Drawing, selecting, moving and vertex editing work as on a flat map

The library knows nothing of DEM sources, encodings or catalogues. It
reads whatever DEM the host passed to `setTerrain`.

## Points and handles

Points, vertex handles and the other symbols stand on the ground at their
anchor position and keep their size on screen. They are drawn without
depth testing, so a symbol never half-sinks into a slope.

A symbol hidden behind a hill is drawn faintly instead of disappearing, so
the user does not lose track of what they placed. It can still be clicked
and selected. The handles of the current selection are always drawn in
full.

## Exaggeration

The drawing uses the map's own vertical exaggeration (the `exaggeration`
of `setTerrain`). The library adds none of its own and has no option to
change it separately; for relief at true scale, leave `exaggeration` at 1.

## Diagnostics

`draw.debug.terrain()` reports how the last drawing was made, as plain
numbers. It is meant for debugging and measurement tools. Its fields
follow the drawing, so they carry a weaker promise than the rest of the
API and may change in a minor release.

```ts
const { render, drape } = draw.debug.terrain();
console.log(render.active, render.stepMeters, drape.used, drape.reason);
```

- `render.active` is `false` on a map without terrain, or while the DEM is
  not usable yet
- `drape.used` tells whether areas and lines were painted on the ground in
  that drawing, and `drape.reason` why not. The counters (`featureCount`,
  `edgeCount`, `tileCount` and so on) show the load
- The values are snapshots of this instance: a later drawing does not
  change an object already returned, and several maps on a page each
  report their own

## Limits

- Painting on the ground has a budget. A map zoomed far out with many
  features, and datasets, fall back to subdividing the
  shapes and lifting their vertices, which follows the relief less
  closely. At low zoom such a heavy map draws areas and lines flat, where
  the relief is too small on screen to matter
- Dashed lines always take the subdividing path
- A symbol takes the height of its anchor point only; a large marker on a
  steep slope is not bent to the ground
- There are no 3D shapes: a feature has no height of its own and is always
  on the ground
- The terrain path relies on MapLibre internals, which is why the
  supported MapLibre version range is narrow; see the README

## Examples

- [terrain](../../examples/terrain/) turns on terrain with a public
  DEM, draws and edits on it with the standard UI, and logs
  `draw.debug.terrain()` in the browser console

## Reference

- [`Draw`](../api/maplibre-gl-draw/interfaces/Draw.md) for `debug.terrain`
- [`TerrainDiagnostics`](../api/maplibre-gl-draw/interfaces/TerrainDiagnostics.md)
