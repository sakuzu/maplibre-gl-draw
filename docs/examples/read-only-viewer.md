---
aside: false
---

# Read-only viewer

A page that shows a drawing to look at, not to edit: the user selects a
feature and reads its attributes. Four switches, in the card of actions
at the bottom left, switch apart the four ways of stopping edits, and
show what each of them stops.

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
are in the card of actions at the bottom left of the map, each with its
key: a press on the switch and its key both turn it on or off, `?` lists
the keys, and a key is left alone while a field of the panels has the
keyboard. Each logs its new state in the browser console, and the lock
and the eye of the layer panel show in the switches too.

| Action | Key | What it does |
| --- | --- | --- |
| Read-only | `R` | Stops every write, by the user or by code |
| Interaction lock | `K` | Stops the gestures of the user alone |
| Lock Blocks | `B` | Stops every change to the features of Blocks |
| Hide Blocks | `H` | Hides the blocks on this page, and saves nothing |

Under read-only, the tools of the toolbar still start, but what they
draw is not kept, and Lock Blocks is refused, since locking a layer is a
write too: the switch stays off. Turn Read-only off to make the drawing
writable, then turn the interaction lock on: the tools no longer start
and nothing can be moved, while a click still selects and code can still
write. Turn the interaction lock off and Lock Blocks on: the blocks can
be selected but not moved or changed, and the stops can. Hide Blocks
hides the blocks on this page, under read-only too; the layer stays
visible in the document, so the next visit, or another viewer, still
sees them.

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
They are actions of the standard UI (6), added with `ui.actions.add`:
each names its key and a `checked` that the card reads again after each
press, and on `ui.actions.refresh()`, which the page calls on the events
of core.

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
