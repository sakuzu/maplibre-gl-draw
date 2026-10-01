---
aside: false
---

# Read-only viewer

A page that shows a drawing to look at, not to edit: the user selects a
feature and reads its attributes. Four keys switch apart the four ways
of stopping edits, and show what each of them stops.

```example
read-only-viewer
```

Click a block or a stop. The panel on the right shows its name, its
measurements and its attributes, as text: nothing in it can be changed
while the drawing is read-only, and its Delete and Lock buttons are
disabled. Hide stays, since hiding is local to this page and writes
nothing. The legend tab on the left shows the colors of the uses of the
blocks.

The page opens read-only, with the three other states off. The switches
are keys, listed in the browser console as the page opens and left alone
while a field of the panels has the keyboard; each logs its new state.

| Keys | Switch | What it stops |
| --- | --- | --- |
| `R` | Read-only | Every write, by the user or by code |
| `K` | The interaction lock | The gestures of the user alone |
| `B` | The lock of the Blocks layer | Every change to its features |
| `H` | Hiding the blocks on this page | Nothing, and it saves nothing |

Under read-only, the tools of the toolbar still start, but what they
draw is not kept, and `B` is refused, since locking a layer is a write
too. Press `R` to make the drawing writable, then `K`: the tools no
longer start and nothing can be moved, while a click still selects and
code can still write. Press `K` again and `B`: the blocks can be
selected but not moved or changed, and the stops can. `H` hides the
blocks on this page, under read-only too; the layer stays visible in the
document, so the next visit, or another viewer, still sees them.

## Code

The drawing is loaded first, into two layers (3), while it can still be
written. Then `setReadOnly(true)` refuses every write, from the user and
from code (4). The standard UI is set for a viewer through its options
(2): a layer panel that adds and reorders nothing, and an inspector with
the Attributes tab alone and without the operations; while the drawing
is read-only, the inspector disables every field it shows. The four
switches (5) are `setReadOnly`, `setInteractionLocked`,
`layers.update` with `locked`, which returns `null` when it is refused,
and `draw.hidden`, which takes the ID of a layer, a group or a feature.
The keys (6) belong to the page.

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
