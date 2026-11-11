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
    ctx.on('change', ({ features, source }) => {
      for (const id of features.created) {
        console.log('created', id, ctx.draw.features.get(id)?.geometry.type, source);
      }
      for (const id of features.updated) console.log('changed', id);
      for (const id of features.deleted) console.log('deleted', id);
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
| `onFeatureCommit(feature)` | A drawing mode created a feature |
| `selectMode` | Hooks of the clicks of the select mode on a feature |
| `exclusive` | An exclusive interaction; the select mode waits meanwhile |

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
      ctx.on('change', ({ features }) => {
        created += features.created.length;
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
  the zoom, the pixel ratio and the meters of a pixel, in the view drawn
  last
- `terrain`, the positions and heights on the terrain of this instance
  ([terrain](terrain.md))
- `invalidate`, which asks for features to be drawn again when
  something outside the document changed their look
- `webgl`, for drawing with WebGL of its own. What the plugin holds on
  the GPU goes with it ([your own shaders](custom-types.md#your-own-shaders))

The shape being drawn is `ctx.draw.drawing`, as for an application: it
places a vertex, moves the preview and finishes the shape as the input of
the map would (`addVertex`, `moveTo`, `finish`), removes the last vertex
and puts it back (`undoVertex`, `redoVertex`), cancels the shape as an
Escape does, without leaving the mode (`cancel`), and tells whether a
drawing mode is drawing (`isActive`, `isDrawing`)
([Drawing and editing](drawing.md#driving-a-drawing-mode-from-code)).

### Writing to the document

A plugin writes with the same `draw.write` as an application. The writes
of one `draw.write` are one commit and one `change`; give it a `label`
so that listeners can tell what made the change:

<!-- docs-check:
declare const ctx: import('@sakuzu/maplibre-gl-draw').PluginContext;
-->

```ts
await ctx.draw.write(
  async (tx) => {
    const layer = await tx.layers.create({ name: ctx.names.next('Layer') });
    await tx.features.create({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [139.767, 35.681] },
      properties: { 'maplibre-gl-draw:layerId': layer.id },
    });
  },
  { label: 'my-plugin' },
);
```

The rules are those of the instance. A wrong argument, such as an ID
that no longer exists, rejects with a `DrawError`. A write refused
because the drawing is read-only or locked rejects with `not-editable`
or `locked`. Either way nothing of the transaction is committed. A
plugin that reacts to a change after it happened checks with `has` first,
because the target may be gone.

### Events

A plugin reacts to changes through the events, with the same names as
`draw.on` ([events](../reference/events.md)). They arrive after the
change, for every write whatever made it: the API, a drawing mode, a
drag, the Delete key, an import, another plugin, or a Store you supplied.

- `change` arrives once per commit that changed the document, with the
  IDs of everything it changed, its `source` and its `label`
- A value of this client that changes over time (the selection, the mode,
  the sketches, the datasets and the others) is an observable of its
  resource, followed with `subscribe`
  ([values that change over time](../reference/events.md#values-that-change-over-time))
- A drag writes once, when it is let go, whatever it edits: what is
  seen in its middle is a sketch (`draw.rendered`)
- `drag.started` and `drag.ended` surround a move, a resize, a
  rotation or a vertex drag of the select mode
- A listener cannot stop or rewrite a change. To keep a change from
  happening, lock the feature or the layer, or make the drawing
  read-only ([read-only](read-only.md))

A plugin that works on every dataset follows them with
`draw.datasets`. Its `subscribe` calls the function with the datasets
already there when the plugin is added, and again when one is added or
removed and when their order changes. A subscription of an observable is
not one of the context: the plugin stops it in `onRemove`.

<!-- docs-check:
declare const ctx: import('@sakuzu/maplibre-gl-draw').PluginContext;
declare function follow(datasetIds: ReadonlySet<string>): void;
-->

```ts
const stop = ctx.draw.datasets.subscribe((datasets) => {
  follow(new Set(datasets.map((dataset) => dataset.id)));
});
// In onRemove
stop();
```

### What is drawn

A plugin that draws something around a feature, or reads where it is,
reads the feature as it is drawn from `ctx.draw.rendered`: with the
sketches (`draw.sketches`) applied over the document and the rows dragged
in bulk moved where they are drawn, while it is edited and not written
yet. `rendered.getSelectionBox(id)` gives
its selection box, the footprint with the margin, as the library draws
and hits it in the view drawn last, and `rendered.getFootprint(id)` its
footprint without the margin, the box the library makes it from (the
four corners of an image as it is drawn, say). `rendered.changed` tells
the features whose shapes changed, once the draw of the map that draws
them is done: its value is the IDs told last, and `subscribe` calls the
function with them at once, as every observable does (none at first). It
tells no change of the
look nor of the selection box with the view: read those at each draw.
What writes reads the document, `ctx.draw.features`.

<!-- docs-check:
declare const ctx: import('@sakuzu/maplibre-gl-draw').PluginContext;
declare function follow(feature: import('@sakuzu/maplibre-gl-draw').Feature): void;
-->

```ts
ctx.draw.rendered.changed.subscribe((ids) => {
  for (const feature of ctx.draw.rendered.getMany(ids)) {
    if (feature) follow(feature);
  }
});
```

### Messages of a plugin

A plugin that shows words of its own puts them in the one table of
messages of the library, so that an application translates them with the
same option `messages`. It declares its keys in `Messages` by
declaration merging and gives their English defaults to
`defineMessages`, before the instance whose option names them is
created (when it makes its plugin, say). It reads them from
`ctx.messages`, the table of the instance, when it shows them, as the
option can change them. A key nothing defines is refused by the option,
as before.

<!-- docs-check:
declare const map: import('maplibre-gl').Map;
-->

```ts
import { createDraw, defineMessages, type Plugin } from '@sakuzu/maplibre-gl-draw';

declare module '@sakuzu/maplibre-gl-draw' {
  interface Messages {
    pinLabel: string;
  }
}

defineMessages({ pinLabel: 'Pin' });

const pins: Plugin = {
  name: 'pins',
  onAdd(ctx) {
    console.log(ctx.messages.pinLabel);
  },
};

const draw = createDraw(map, { messages: { pinLabel: 'Épingle' } });
draw.extensions.plugins.add(pins);
```

### Values of a plugin

The events are the library's alone to send. A value of a plugin that
changes over time is given to the application as an `Observable` of the
API the plugin returns: `value` reads it, and `subscribe` calls the
function with the value now at once and again each time it changes. An
application and other plugins follow it as they follow the values of the
library.

```ts
import type { Observable, Plugin } from '@sakuzu/maplibre-gl-draw';

interface CounterApi {
  /** The number of features the counter has seen changed */
  readonly count: Observable<number>;
}

function createCounter(): Plugin<CounterApi> {
  let count = 0;
  const runs = new Set<(value: number) => void>();
  const observable: Observable<number> = {
    get value() {
      return count;
    },
    subscribe(run) {
      runs.add(run);
      run(count);
      return () => {
        runs.delete(run);
      };
    },
  };
  return {
    name: 'counter',
    api: { count: observable },
    onAdd(ctx) {
      ctx.on('change', ({ features }) => {
        if (features.updated.length === 0) return;
        count += features.updated.length;
        for (const run of [...runs]) run(count);
      });
    },
  };
}

draw.extensions.plugins.add(createCounter());
draw.extensions.plugins
  .getApi<CounterApi>('counter')
  ?.count.subscribe((count) => console.log(count));
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
  consumed double click does not zoom the map, and while a mode with
  `writes: true` is the current mode no double click does
- A consumed key has its default action prevented, so the map does not
  also use it (the arrows, `+`, `-`), and a page listening for the same
  keys outside the canvas can tell it from `defaultPrevented`. Return
  true from `onKeyDown` only when the key did something; a key not
  consumed is left to the map and the page
- `onPointerLeave` arrives when the pointer leaves the map
- In `select` only the drags snap. A click or a move there carries
  `snapped.lngLat` equal to `lngLat`

## Hooks of the select mode

`selectMode` lets a plugin take part in the clicks of the select mode:

- `onSelectedFeatureClick(feature, event)` is called when a selected feature
  is clicked again; returning true means the plugin handled the click
- `onFeatureDoubleClick(feature, event)` is called when a feature is
  double-clicked, after it is selected

`onFeatureCommit(feature)` is called when a drawing mode created a
feature: each commit of `ctx.commitFeature` (the built-in drawing modes
use it too), and the image the image mode places after `requestImage`.

### An exclusive interaction

A plugin can hold an interaction of its own on a feature, such as a
form it shows over the map, in `exclusive`. While `exclusive.isActive()`
returns true, the select mode stays still: it does not drag or select,
and it ignores the keys but Escape.

- A press inside the element that `container()` returns is left to the
  plugin, and the map does not pan
- A click outside that element calls `finish()`, and then goes on as
  an ordinary click: it selects the feature under it, or clears the
  selection on the empty map. A click on the feature that is already
  selected does not call `onSelectedFeatureClick`, so the click that finishes
  an interaction does not start another
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
    type: 'Feature',
    geometry: {
      type: 'Polygon',
      coordinates: [[a, [b[0], a[1]], b, [a[0], b[1]], a]],
    },
    properties: {},
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
current mode. That Escape counts as used: its default action is
prevented, as that of a key the mode consumes.

A mode answers its keys as the modes of the library do: `onKeyDown`
returns true when the key did something (Enter finished the shape,
Backspace removed a vertex, Escape dropped the shape or left the mode)
and false otherwise (Enter with too few vertices, Backspace with none),
so that the page gets the keys the mode had no use for.

### What the context adds

A `ModeContext` has everything of the context of a plugin but
`extensions`, and adds what a mode needs:

- `commitFeature(input)` creates a feature the way the built-in modes
  do: in the layer that can take it, with a new ID, the automatic name
  and the reference zoom. It returns `null` when the write is refused
- `preview.set(feature, options)` shows the shape being drawn, and
  `preview.clear()` hides it. `confirmedVertices` draws the line up to
  that vertex solid and the rest dashed, and `highlightVertex` marks a
  vertex, such as the first one that closes an area. The shape is a
  sketch of this client of an edit `create` (`draw.sketches`), which
  `commitFeature` ends with the feature it writes
- `hitTest(point)` returns the topmost feature or dataset row at a
  point on the screen, and `snap(point)` where that point snaps to
- `cursor.set(cursor)` and `cursor.reset()` change the cursor of the
  map; `reset` goes back to the cursor the mode set in `onEnter`, and
  the cursor the mode set is taken back when it is left
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

The snap belongs to the input of the mode. The engine takes it back
when the mode is left or receives `onCancel`, and for an input that
`unsnapped` leaves out, so no symbol stays on the map and `snap.changed`
fires with `null`.

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
  through `ctx.extensions` and `ctx.webgl`, gives back what it holds on
  the GPU and ends its subscriptions
- Removing the active mode enters `select` first
- The names of the built-in modes and feature types are taken, so
  `add` throws `already-exists` for them
- Extensions belong to the instance they are added to. Another draw
  instance on the page never sees them
- `draw.destroy()` removes the plugins first, then every other
  extension

## Related example

- [Plugins](../examples/plugins.md) adds a plugin with a mode of its
  own, an event it listens to and an API, and a tool and a section of
  the standard UI for it; a key removes them all and adds them again

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
