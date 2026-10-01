---
layout: home
title: maplibre-gl-draw
hero:
  name: maplibre-gl-draw
  text: Draw and edit shapes on a MapLibre map
  tagline: Its own WebGL2 renderer keeps a drawing of 200,000 features editable, on a flat map, on 3D terrain and on the globe.
  actions:
    - theme: brand
      text: Get started
      link: /getting-started
    - theme: alt
      text: Try the playground
      link: /playground/
      target: _self
    - theme: alt
      text: Examples
      link: /examples/
features:
  - title: Draw and edit
    details: Points, lines, polygons, circles and freehand lines. Select, move, resize, rotate and edit vertices, with snapping and tracing.
    link: /guides/drawing
  - title: 200,000 editable features
    details: The renderer draws the whole drawing on the GPU, so a large drawing stays editable.
    link: /guides/performance
  - title: Terrain and the globe
    details: Drawing works the same on a tilted map, on 3D terrain and on the globe, across the antimeridian too.
    link: /guides/terrain
  - title: Datasets
    details: Show tens of thousands of parcels or a million points fast beside the drawing, from GeoJSON features or straight from GeoParquet and Arrow columns.
    link: /guides/large-data
  - title: Geometry anywhere
    details: Union, subtract, intersect, split, buffer, length and area are plain functions that also run in Node and in workers.
    link: /guides/snapping-geometry
  - title: Extend it
    details: Plugins, modes, feature types, overlays and providers are all added the same way, through the contract the built-in drawing modes use too.
    link: /guides/plugins
---

## Install

```sh
npm install @sakuzu/maplibre-gl-draw
```

maplibre-gl is a peer dependency: the library uses the maplibre-gl your
application already has, and npm 7 and later install it along if it is
not there yet.

Then follow [Getting started](getting-started.md) to draw your first
polygon.

## See it

The drawing of the playground over central Tokyo, the same drawing on a
tilted map, the globe, and 3D terrain.

![The playground over central Tokyo: circles, lines, areas with a solid, a dashed and a dotted outline, a polygon with a hole selected with its vertex handles, markers, an image, parcels colored by a style rule, a hexagon grid colored by another, and the Layers panel with the layers, the groups and the dataset, whose rules its Legend tab lists](images/overview.jpg)

![The globe with great-circle routes between continents, a box between two meridians and two parallels, and city markers](images/globe.jpg)

![Mountains above Innsbruck in 3D: areas draped over the slopes, a trail up to a summit, and a dashed line disappearing over a ridge](images/terrain.jpg)

## License

AGPL-3.0-only. If the AGPL does not fit your product, a commercial
license is available from Kasika, Inc.
([kasika.xyz](https://www.kasika.xyz/)).
