---
aside: false
---

# Get started

The smallest page: a map with the standard UI over it, where the user
draws, selects and changes features.

```example
get-started
```

Draw with the tools at the bottom of the map, or with their keys (`V`,
`P`, `L`, `A`, `C`, `F` and `I`). Click a feature to select it: the panel
on the right shows its name, its measurements, its style and its
attributes, and a change there applies at once. The panel on the left
lists the layers and their features. Each change is logged in the
browser console.

## Code

The script makes four calls: the map, `createDraw`, `createDrawUI` and
one listener of the changes. The page around it holds the element of the
map alone.

::: code-group
<<< @/../examples/get-started/main.ts
<<< @/../examples/get-started/index.html
:::

The standard UI is a package of its own, installed beside the library:

```sh
npm install @sakuzu/maplibre-gl-draw @sakuzu/maplibre-gl-draw-ui maplibre-gl
```

## Related

- [Getting started](../getting-started.md): the same steps one by one,
  with buttons of your own instead of the standard UI
- [`createDraw`](../api/maplibre-gl-draw/functions/createDraw.md) and its
  options
- [`createDrawUI`](../../ui/README.md#use) and the options of the
  standard UI
- [The events of the document](../reference/events.md#the-document),
  `document.changed` among them
