---
aside: false
---

# Read-only viewer

A page that shows a drawing to look at, not to edit: the user selects a
feature and reads its attributes, and nothing the user does changes the
drawing.

```example
read-only-viewer
```

Click a block or a stop. The panel on the right shows its name, its
measurements and its attributes, as text: nothing in it can be changed,
and its Delete and Lock buttons are disabled. Hide stays, since hiding is
local to this page and writes nothing. The legend tab on the left shows
the colors of the uses of the blocks.

## Code

The drawing is loaded first, into two layers (3), while it can still be
written. Then `setReadOnly(true)` refuses every write, from the user and
from code, and `setInteractionLocked(true)` keeps the user from even
starting an edit: no handles on the selection, and no moving (4). The
standard UI is set for a viewer through its options (2): no toolbar, a
layer panel that adds and reorders nothing, and an inspector with the
Attributes tab alone and without the operations. While the drawing is
read-only, the inspector disables every field it shows.

::: code-group
<<< @/../examples/read-only-viewer/main.ts
<<< @/../examples/read-only-viewer/data.ts
<<< @/../examples/read-only-viewer/index.html
:::

## Related

- [Read-only](../guides/read-only.md): read-only, the interaction lock and
  local hiding, and what each of them stops
- [`setReadOnly`](../api/maplibre-gl-draw/interfaces/Draw.md#setreadonly)
  and
  [`setInteractionLocked`](../api/maplibre-gl-draw/interfaces/Draw.md#setinteractionlocked)
- [Save and load](../guides/save-load.md): `document.load` and its
  `layer` option
- [The options of the standard UI](../../ui/README.md#use), the toolbar,
  the layer panel and the inspector among them
