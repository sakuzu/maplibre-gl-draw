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
      link: https://sakuzu.github.io/maplibre-gl-draw/
    - theme: alt
      text: Examples
      link: https://sakuzu.github.io/maplibre-gl-draw/examples/
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
  - title: Large data
    details: Datasets show tens of thousands of parcels or a million points fast, from features or straight from GeoParquet and Arrow columns.
    link: /guides/large-data
  - title: Geometry anywhere
    details: Union, subtract, intersect, split, buffer, length and area are plain functions that also run in Node and in workers.
    link: /guides/snapping-geometry
  - title: Extend it
    details: Plugins, custom modes and custom feature types build on the same extension points the library uses itself.
    link: /guides/plugins
---

## Install

```sh
npm install @sakuzu/maplibre-gl-draw maplibre-gl
```

Then follow [Getting started](getting-started.md) to draw your first
polygon.

## See it

The drawing of the playground over central Tokyo, the same drawing on a
tilted map, the globe, and 3D terrain.

![The playground over central Tokyo: circles, lines, a polygon with a hole selected with its vertex handles, markers, an image, parcels colored by a style rule, a legend and the Layers panel](images/overview.jpg)

![The globe with great-circle routes between continents, a box between two meridians and two parallels, and city markers](images/globe.jpg)

![Mountains above Innsbruck in 3D: areas draped over the slopes, a trail up to a summit, and a dashed line disappearing over a ridge](images/terrain.jpg)

## License

AGPL-3.0-only. If the AGPL does not fit your product, a commercial
license is available from Kasika, Inc.
([kasika.xyz](https://www.kasika.xyz/)).
