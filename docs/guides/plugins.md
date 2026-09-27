# Plugins

An extension adds behavior to a draw instance: a plugin, a mode, a
feature type, an overlay or a provider. This guide covers the plugin,
which bundles the others with its own state, and the mode, which
receives the input while it is active. Feature types, overlays and
providers are in [custom types](custom-types.md).

## The smallest example

A plugin that logs every feature created, changed and deleted:

```ts
import type { Plugin } from '@sakuzu/maplibre-gl-draw';

const logger: Plugin = {
  name: 'logger',
  onAdd(ctx) {
    ctx.on('feature.created', ({ feature, source }) => {
      console.log('created', feature.id, feature.type, source);
    });
    ctx.on('feature.updated', ({ feature, intermediate }) => {
      if (!intermediate) console.log('changed', feature.id);
    });
    ctx.on('feature.deleted', ({ feature }) => {
      console.log('deleted', feature.id);
    });
  },
};

const removeLogger = draw.extensions.plugins.add(logger);
```

Draw a feature and the console shows `created`. `removeLogger()` takes
the plugin back, and the log stops: the subscriptions made through
`ctx.on` end with the plugin.

## Kinds of extension

Every kind of extension has a collection under `draw.extensions`:

| Collection | What it holds |
| --- | --- |
| `plugins` | Bundles of other extensions and state |
| `modes` | Ways of receiving the input, entered with `draw.setMode` |
| `featureTypes` | Feature types with their own drawing and hit testing |
| `overlays` | Drawing above the features or between the layers |
| `snapProviders` | Snapping candidates of your own |
| `handleProviders` | Handles of your own on the selected features |
| `companionProviders` | Things drawn and clicked one step below a feature |

The collections share the same methods: `add` and `addMany` register,
`remove(name)` and `removeMany(names)` take back, and `get`, `list`,
`count` and `has` look up by name. `add` returns the function that
removes what it added.

A name that is taken throws a `DrawError` with the code
`already-exists`, and `remove` with a name that is not there throws
`not-found`. `addMany` and `removeMany` do all of it or none.

## The Plugin object

A plugin is a plain object. `name` and `onAdd` are required, and the
name must be unique in the instance.

| Member | Use |
| --- | --- |
| `onAdd(ctx)` | Receives the context; subscribe and add extensions here |
| `onRemove()` | Releases what the plugin holds outside the context |
| `api` | What other code reads with `draw.extensions.plugins.getApi(name)` |
| `input` | Receivers of the input, called before those of the mode |
| `interaction` | Hooks of the select mode and an exclusive interaction |

### Offering an API

`api` is how a plugin offers functions to the page or to another
plugin. The type parameter of `Plugin` names its shape:

```ts
import type { Plugin } from '@sakuzu/maplibre-gl-draw';

interface CounterApi {
  count(): number;
}

function createCounter(): Plugin<CounterApi> {
  let created = 0;
  return {
    name: 'counter',
    api: { count: () => created },
    onAdd(ctx) {
      ctx.on('feature.created', () => {
        created += 1;
      });
    },
  };
}

draw.extensions.plugins.add(createCounter());
const counter = draw.extensions.plugins.getApi<CounterApi>('counter');
console.log(counter?.count());
```

Passing one plugin to another through its factory is simpler when you
build both; `getApi` is for code that only knows the name.

## What the context gives

`onAdd` receives a `PluginContext`, the only way a plugin reaches the
instance:

- `draw`, the whole public API. A plugin reads and writes the document
  through it, as an application does
- `store`, a read-only view of the document and of the state of this
  client, with `subscribe` for every change
- `on`, `off` and `once` for the events. What a plugin subscribes to
  here ends when the plugin is removed
- `extensions`, the same collections as `draw.extensions`. What a
  plugin adds here is removed with the plugin
- `names`, the automatic names of the instance. `names.next('Layer')`
  gives the next name the way the `autoName` option says
  ([automatic names](drawing.md#automatic-names))
- `screen`, the conversion between positions and points on the screen,
  the zoom and the pixel ratio
- `terrain`, the positions and heights on the terrain of this instance
  ([terrain](terrain.md))
- `invalidate`, which asks for features to be drawn again when
  something outside the document changed their look
- `drawing`, which removes the last vertex of the shape being drawn
  and puts it back (`undoVertex`, `redoVertex`, `isDrawing`)

### Writing to the document

A plugin writes with the same methods as an application. Wrap several
writes in `transact` to make them one change, and give it a `source`
so that listeners can tell where the change came from:

<!-- docs-check:
declare const ctx: import('@sakuzu/maplibre-gl-draw').PluginContext;
-->

```ts
ctx.draw.transact(
  () => {
    const layer = ctx.draw.layers.create({ name: ctx.names.next('Layer') });
    if (layer) {
      ctx.draw.features.create({
        type: 'Point',
        geometry: { type: 'Point', coordinates: [139.767, 35.681] },
        layerId: layer.id,
      });
    }
  },
  { source: 'my-plugin' },
);
```

The rules are those of the instance. A wrong argument, such as an ID
that no longer exists, throws a `DrawError`. A write refused because
the drawing is read-only or locked returns `null` or `false`. Either
way nothing changes. A plugin that reacts to a change after it
happened checks with `has` first, because the target may be gone.

### Events

A plugin reacts to changes through the events, with the same names as
`draw.on` ([events](../reference/events.md)). They arrive after the
change, for every write whatever made it: the API, a drawing mode, a
drag, the Delete key, a load, another plugin, or a Store you supplied.

- `document.changed` arrives once per transaction with everything it
  changed, and its `source`
- `feature.updated` carries `intermediate: true` while a drag goes on;
  a final update always follows
- `drag.started` and `drag.ended` surround a move, a resize, a
  rotation or a vertex drag of the select mode
- A listener cannot stop or rewrite a change. To keep a change from
  happening, lock the feature or the layer, or make the drawing
  read-only ([read-only](read-only.md))

A plugin that works on every dataset follows them with
`dataset.added` and `dataset.removed`. Datasets can already be there
when the plugin is added, so it also reads `draw.datasets.list()` in
`onAdd`:

<!-- docs-check:
declare const ctx: import('@sakuzu/maplibre-gl-draw').PluginContext;
declare function follow(datasetId: string): void;
declare function forget(datasetId: string): void;
-->

```ts
for (const dataset of ctx.draw.datasets.list()) follow(dataset.id);
ctx.on('dataset.added', ({ dataset }) => follow(dataset.id));
ctx.on('dataset.removed', ({ datasetId }) => forget(datasetId));
```

## Input

`input` receives the pointer and the keys before the mode does, in
whatever mode is active. The receivers are those of a mode
(`onPointerDown`, `onPointerMove`, `onClick`, `onDragStart`,
`onKeyDown` and the rest), and returning true consumes the event: the
plugins added later and the mode do not get it.

A plugin that turns keys into modes:

```ts
import type { Plugin, PluginContext } from '@sakuzu/maplibre-gl-draw';

function createShortcuts(): Plugin {
  let ctx: PluginContext | null = null;
  return {
    name: 'shortcuts',
    onAdd(context) {
      ctx = context;
    },
    onRemove() {
      ctx = null;
    },
    input: {
      onKeyDown(event) {
        if (!ctx || event.modifiers.ctrl || event.modifiers.meta) return false;
        if (event.key === 'p') return ctx.draw.setMode('draw_point');
        if (event.key === 'l') return ctx.draw.setMode('draw_line');
        return false;
      },
    },
  };
}

draw.extensions.plugins.add(createShortcuts());
```

- The plugins receive the input in the order they were added
- A consumed press does not reach the map, so the map does not pan. A
  consumed double click does not zoom the map
- A consumed key still reaches the map. To stop the map from also
  using it (the arrows, `+`, `-`), call `event.original.preventDefault()`
- `onPointerLeave` arrives when the pointer leaves the map

## Hooks of the select mode

`interaction` lets a plugin take part in what the select mode does:

- `filterSelection(candidateIds)` is asked before a click or a box
  selects, and returns the IDs that may be selected
- `onFeatureClick(feature, event)` is called when a selected feature
  is clicked again; returning true means the plugin handled the click
- `onFeatureDoubleClick(feature, event)` is called when a feature is
  double-clicked, after it is selected
- `onDrawCommit(feature)` is called when a drawing mode created a
  feature: each commit of `ctx.commitFeature` (the built-in drawing modes
  use it too), and the image the load after an `image.requested` places

A filter keeps some features out of the selection:

```ts
import type { Plugin, PluginContext } from '@sakuzu/maplibre-gl-draw';

function createBackgroundFilter(): Plugin {
  let ctx: PluginContext | null = null;
  return {
    name: 'background',
    onAdd(context) {
      ctx = context;
    },
    interaction: {
      filterSelection(candidateIds) {
        return candidateIds.filter(
          (id) => ctx?.draw.features.get(id)?.properties.background !== true,
        );
      },
    },
  };
}
```

### An exclusive interaction

A plugin can hold an interaction of its own on a feature, such as a
form it shows over the map. While `isBusy()` returns true, the select
mode stays still: it does not drag or select, and it ignores the keys
but Escape.

- A press inside the element that `container()` returns is left to the
  plugin, and the map does not pan
- A click outside that element calls `finish()`
- Escape calls `cancel()`
- Leaving the select mode calls `finish()`

## Modes

A mode receives the input while it is active. Add one with
`draw.extensions.modes.add(name, factory)`, or with
`ctx.extensions.modes.add` from a plugin so it goes with the plugin,
and enter it with `draw.setMode(name)`.

The factory receives a `ModeContext` and returns a `ModeHandler`. It
runs each time the mode is entered, so the state it keeps in its
closure starts fresh, and what the mode subscribes to through its
context ends when the mode is left.

A mode that draws a rectangle from two clicks:

```ts
import type { FeatureInput, ModeFactory, Position } from '@sakuzu/maplibre-gl-draw';

function rectangle(a: Position, b: Position): FeatureInput {
  return {
    type: 'Polygon',
    geometry: {
      type: 'Polygon',
      coordinates: [[a, [b[0], a[1]], b, [a[0], b[1]], a]],
    },
  };
}

const drawRectangle: ModeFactory = (ctx) => {
  let first: Position | null = null;
  const reset = () => {
    first = null;
    ctx.preview.clear();
  };

  return {
    writes: true,
    onEnter: () => ctx.cursor.set('crosshair'),
    onExit() {
      ctx.cursor.reset();
      reset();
    },
    onCancel: reset,
    onPointerMove(event) {
      if (first) ctx.preview.set(rectangle(first, event.snapped.lngLat));
    },
    onClick(event) {
      if (!first) {
        first = event.snapped.lngLat;
        return true;
      }
      const feature = ctx.commitFeature(rectangle(first, event.snapped.lngLat));
      reset();
      if (feature) ctx.draw.selection.set('feature', [feature.id]);
      return true;
    },
    // Two quick clicks are two corners; the map does not zoom
    onDoubleClick: () => true,
    onKeyDown(event) {
      if (event.key !== 'Escape') return false;
      if (first) reset();
      else ctx.setMode('select');
      return true;
    },
  };
};

draw.extensions.modes.add('draw_rectangle', drawRectangle);
draw.setMode('draw_rectangle');
```

The first click places a corner, the pointer shows the rectangle, and
the second click creates it. Escape drops the rectangle being drawn,
and a second Escape returns to `select`.

### The handler

Every member of a `ModeHandler` is optional:

| Member | Use |
| --- | --- |
| `onEnter`, `onExit` | The mode is entered and left |
| `onCancel` | Drop what is being drawn and stay in the mode |
| The input receivers | As in `input`; true consumes the event |
| `writes` | Enter only while a layer can take new features |
| `snapPreference` | Which inputs snap, and what to prefer |
| `onUndoVertex`, `onRedoVertex` | Remove the last vertex, put it back |

`onCancel` arrives on an Escape that neither a plugin nor the mode
consumed, and when the Store replaces its whole document (a notification
with `reset: true`). The mode drops what it was drawing and stays the
current mode.

### What the context adds

A `ModeContext` has everything of the context of a plugin but
`extensions`, and adds what a mode needs:

- `commitFeature(input)` creates a feature the way the built-in modes
  do: in the layer that can take it, with a new ID, the automatic name
  and the reference zoom. It returns `null` when the write is refused
- `preview.set(feature, options)` shows the shape being drawn, and
  `preview.clear()` hides it. `confirmedVertices` draws the line up to
  that vertex solid and the rest dashed, and `highlightVertex` marks a
  vertex, such as the first one that closes an area
- `hitTest(point)` returns the topmost feature or dataset row at a
  point on the screen, and `snap(point)` where that point snaps to
- `cursor.set(cursor)` and `cursor.reset()` change the cursor of the
  map
- `writableLayer()` returns the layer a new feature goes into, or
  `null` when no layer can take one
- `listTraceRows(bbox)` returns the rows of datasets that a shape can
  trace along
- `setMode(mode)` changes the mode, and `selectionStyle` gives the look
  of the selection

A layer can stop taking features while the mode is active: it is
deleted, locked or hidden. `commitFeature` then drops the shape being
drawn, returns to `select` and returns `null`.

### Snapping

The pointer events carry `lngLat`, where the pointer is, and
`snapped.lngLat`, where it snaps to. Use `snapped` for positions that
become vertices. `snapPreference` narrows the snapping:

- `unsnapped` names the receivers whose positions are not snapped. A
  stroke drawn by dragging leaves out `onDrag`, so that its inner
  points follow the pointer while its ends still snap
- `prefer` names the feature to prefer when candidates are at the same
  distance, such as the boundary a trace started along

A mode whose preference changes while it draws declares
`snapPreference` as a getter; it is read before every input.

### Drags

A mode that draws by dragging turns off the pan of the map when the
pointer goes down, and turns it on again when the drag ends:

- Call `ctx.draw.getMap().dragPan.disable()` in `onPointerDown`, and
  draw in `onDragStart`, `onDrag` and `onDragEnd`
- `onDragCancel` arrives when a press ends without a release (a second
  finger, a cancelled touch). Create nothing and drop what the press
  started
- Turn the pan on again in `onDragEnd`, `onDragCancel` and `onExit`

## Taking extensions back

The function that `add` returns removes what it added, and calling it
again does nothing. `remove(name)` does the same by name.

- Removing a plugin calls its `onRemove`, then removes what it added
  through `ctx.extensions` and ends its subscriptions
- Removing the active mode enters `select` first
- The names of the built-in modes and feature types are taken, so
  `add` throws `already-exists` for them
- Extensions belong to the instance they are added to. Another draw
  instance on the page never sees them
- `draw.destroy()` removes the plugins first, then every other
  extension

## Related example

- [examples/plugin/](../../examples/plugin/) adds a plugin with a
  mode of its own, an event and an API, and removes it again

## Reference

- [Plugin](../api/maplibre-gl-draw/interfaces/Plugin.md) and
  [PluginContext](../api/maplibre-gl-draw/interfaces/PluginContext.md)
- [ExtensionContext](../api/maplibre-gl-draw/interfaces/ExtensionContext.md)
- [ExtensionsCollections](../api/maplibre-gl-draw/interfaces/ExtensionsCollections.md)
  and [PluginsCollection](../api/maplibre-gl-draw/interfaces/PluginsCollection.md)
- [ModeFactory](../api/maplibre-gl-draw/type-aliases/ModeFactory.md),
  [ModeHandler](../api/maplibre-gl-draw/interfaces/ModeHandler.md) and
  [ModeContext](../api/maplibre-gl-draw/interfaces/ModeContext.md)
- [InputHandlers](../api/maplibre-gl-draw/interfaces/InputHandlers.md),
  [DrawPointerEvent](../api/maplibre-gl-draw/interfaces/DrawPointerEvent.md)
  and [DrawKeyEvent](../api/maplibre-gl-draw/interfaces/DrawKeyEvent.md)
- [SnapPreference](../api/maplibre-gl-draw/interfaces/SnapPreference.md)
- [DrawEvents](../api/maplibre-gl-draw/interfaces/DrawEvents.md) for
  the names of the events
