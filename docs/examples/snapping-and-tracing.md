---
aside: false
---

# Snapping and tracing

Drawing that fits what is already there: the pointer snaps to vertices,
edges and guide lines, and a click on two points of a boundary traces
the boundary between them.

```example
snapping-and-tracing
```

Pick the Polygon tool and move the pointer near the parcel: a mark shows
what it snaps to. Click the south end of the winding east side of the
parcel, then its north end: the vertices between them are inserted, so
the neighbor shares the boundary without redrawing it. Close the area to
the east. After the first vertex, guide lines every 15 degrees from
north help to draw straight. Hold Alt to place a vertex without
snapping, and use the switch at the end of the toolbar to turn snapping
off and on.

## Code

The parcel and a road are the features to snap to (1).
`draw.options.update` changes only the keys given: here the reach in
pixels, the step of the guide lines and the kinds of target, with
tracing on (2). Tracing needs snapping. `snap.changed` reports what the
pointer snaps to as it moves (3). The switch of the toolbar writes
`snapping.enabled` with the same call (4).

::: code-group
<<< @/../examples/snapping-and-tracing/main.ts
<<< @/../examples/snapping-and-tracing/data.ts
<<< @/../examples/snapping-and-tracing/index.html
:::

## Related

- [Snapping](../guides/snapping-geometry.md#snapping),
  [guide lines](../guides/snapping-geometry.md#guide-lines) and
  [edge tracing](../guides/snapping-geometry.md#edge-tracing) in the
  guide to snapping and geometry
- [`SnappingOptions`](../api/maplibre-gl-draw/interfaces/SnappingOptions.md)
  and [`TracingOptions`](../api/maplibre-gl-draw/interfaces/TracingOptions.md)
- [`options.update`](../api/maplibre-gl-draw/interfaces/OptionsResource.md#update)
- [The input events](../reference/events.md#input), `snap.changed`
  among them
- [The toolbar](../../ui/README.md#use) of the standard UI
