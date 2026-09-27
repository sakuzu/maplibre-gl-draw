# Architecture

This document describes how the core library is put together: the layers and
the rules between them, the Store that holds all state, the path an input
takes from the browser to a mode, the modes, the events, snapping, the
geometry module, where locking and read-only are enforced, the plugin
machinery and the public surface.

It is written for contributors who know maplibre-gl but not the internals of
this library. Three topics have their own documents:

- [rendering.md](./rendering.md): the WebGL2 pipeline, the renderers, the
  retained batches, terrain, display order and render slots
- [hit-testing.md](./hit-testing.md): the two-stage hit test, the spatial
  index, the unified z traversal and the per-type strategies
- [coordinate-precision.md](./coordinate-precision.md): coordinate systems,
  the offset mode, globe and the antimeridian

For using the library rather than changing it, start with the
[guides](../guides/drawing.md) and the
[generated API reference](../api/index.md).

## Overview

`@sakuzu/maplibre-gl-draw` draws and edits features on top of the
`CustomLayerInterface` of MapLibre GL JS. It provides:

- Rendering with WebGL2 inside one custom layer
- Hit testing backed by an rbush spatial index
- State management with a single source of truth (the Store)
- Extensibility through plugins and registration functions
- First-class Multi geometries and polygons with holes
- Datasets: a path for large data that bypasses the editing Store
- Snapping at the single place where input is distributed (SnapService)
- A geometry module of pure functions, independent of rendering and editing

### Glossary

| Term | Meaning |
| --- | --- |
| Feature | A shape drawn on the map |
| Tentative | The shape being drawn, before it is committed |
| Mode | The current tool (`select`, `draw_line` and so on) |
| Layer | Holds features and groups; order and visibility |
| Group | Bundles features inside one layer |
| Store | The single source of truth for all state |
| VertexRef | A vertex address: part, ring and index |
| StyleRule | A declarative per-layer style from attributes |
| Display dataset | Store-independent data for mass display |
| Snap | Moving an input onto a nearby vertex or edge |

## Responsibilities

Core owns the logic of drawing and editing. It does not own the user
interface around the map.

### What core does and does not do

Core renders and edits every geometry type (Point, LineString, Polygon,
their Multi forms, Image, Circle and Freehand, with holes and parts
first-class everywhere), hit tests and selects, runs the modes, keeps the
Store and emits events, and provides pure geometry, snapping and mass
display of data that is not edited.

The host application owns toolbars, panels and the import and export UI.
When the image mode needs a file, core emits `image.request` and the host
answers. Keeping the UI out lets core run entirely under MapLibre's
control and stay independent of frameworks.

### DOM policy

| Operation | Policy |
| --- | --- |
| Append to `map.getContainer()` | Allowed; MapLibre owns it |
| Append to `document.body` | Not allowed; pollutes the page |
| `document.createElement('canvas')` | Allowed; never attached |

## Layers

The design follows Flux: input goes through a dispatcher, the dispatcher
changes the Store, and the view renders from the Store.

```text
User input --> Dispatcher --> Store --> View
     ^                                   |
     +-----------------------------------+
            (the user sees the result)
```

Three rules follow from it.

1. Data flows in one direction only
2. The Store is the single source of truth
3. The view never writes the Store; changes go through the dispatcher and
   the modes

Each Flux role maps onto a directory of `src/`.

| Flux role | Directory | Holds |
| --- | --- | --- |
| Store | `store/` | Features, layers, selection, mode |
| Dispatcher | `dispatcher/` | Input normalization and routing |
| Handlers | `modes/` | The tools shown in a toolbar |
| View | `view/` | Watches the Store, renders with WebGL |

A mode is something the user switches to on purpose and that a toolbar
shows: select, point, line, polygon, image, circle and freehand. Actions
that happen inside a mode (move, resize, rotate, vertex editing, shared
vertex drag, edge tracing) are not modes; they live in `operations/`.

### Wiring

The entry `createMapLibreGLDraw` (`src/maplibre-gl-draw.ts`) wires the
pieces: it builds the context (`createContext` in `src/api/context.ts`,
which creates the Store, the spatial index, the ModeManager, SnapService and
the hit test services), then the EventBridge, the CustomLayer, the
RenderCoordinator, the InputNormalizer and the InputRouter, and finally
composes the public API.

## Dependency rules

```text
               api/            public API and initialization
                 |
               plugins/
                 |
               dispatcher/     input
                 |
               modes/
                 |
       +---------+---------+
       |                   |
   snapping/          operations/
       |                   |
       +---------+---------+
                 |
   dataset/ --> view/          rendering (dataset/ borrows renderers)
                 |  reads and subscribes
               store/          state
                 |
               extension/      contracts for extensions (types only)
                 |
               table/          tables of rows as columns (a sub-entry)
                 |
               shared/         types, math, config, utils
                 |
               geometry/       pure geometry, no dependencies
```

1. Only dependencies from top to bottom are allowed.
2. `shared/` may depend only on `geometry/`. Geodesic distance and angle
   conversion are implemented in `geometry/` and re-exported by
   `shared/math`, so the same computation exists once. `shared/types` holds
   the types every layer reads: the data model (`Coordinate`, `Feature`,
   `Layer`, `Group`, `UpdateSource` and the rest, re-exported by
   `store/types.ts`), the style types, the corners of a selection box and
   the payloads of the public events.
3. `plugins/` reaches core only through `PluginContext`.
4. `operations/` is called from `modes/` and `api/`. `dispatcher/` never
   calls `operations/`.
5. `snapping/` is called from `dispatcher/`. To enumerate candidates it
   reads `store/` and the vertex handle computation of `view/ui/handles`,
   and nothing else of `view/`. It does not depend on `modes/`.
6. `dataset/` does not depend on `store/`. It only borrows the renderers of
   `view/`.
7. `geometry/` is a set of pure functions that depends on nothing inside the
   library. It is also published as `@sakuzu/maplibre-gl-draw/geometry`.
   Its only runtime dependency is polygon-clipping, and it refers to neither
   maplibre, the DOM, the Store nor events.
8. `store/` knows neither `view/` nor `dataset/`. `view/` reads the Store
   and subscribes to it (the RenderCoordinator for repaints, the CustomLayer
   for its caches), so a change reaches the screen through the subscription
   and never through a call from `store/` to `view/`.
9. `extension/` holds the contracts an extension implements: the feature
   handler, the feature and overlay renderers and their draw context. It is
   types only and sits at the level of `shared/`, so `view/`, `snapping/`
   and `operations/` can read these types without importing `api/`. Its
   declarations may refer to types of the areas that consume them with
   type-only imports, and nothing in it imports `api/`. The registration
   functions stay on the instance (`api/extension-api.ts`).

### Checking the rules

`npm run check:layers` (`scripts/check-layers.mjs`, part of `npm run lint`)
reads the import statements of `src/` and checks them against the rules.
Tests, `src/e2e/` and `src/test-utils.ts` are left out.

Every area has a height. From the bottom: `geometry/`; `shared/` together
with `src/messages.ts`; `extension/`; `store/`; `view/`; `dataset/`;
`operations/` and `snapping/` at the same height; `modes/`; `dispatcher/`;
`plugins/`; `api/`; and the entry files `src/index.ts` and
`src/maplibre-gl-draw.ts`. An import may point to a lower area or stay
inside its own area, with the exceptions of rules 4, 5, 6 and 9.

- A runtime import against the rules fails the check.
- A runtime import cycle between files fails the check.
- A type-only import against the rules (`import type`, `export type`, an
  import whose specifiers are all `type X`, or `import('...')` in a type
  position) is listed but does not fail. Types are erased at build time,
  so it adds no edge to the running code.

When you add an area, add it to `RANK` in the script; when you add a file at
the root of `src/`, add it to `ROOT_FILES`. The script refuses to run
otherwise.

### Known type-only deviations

There are no runtime violations and no runtime cycles. The type-only
imports that point upward are few and deliberate: `modes/`, `snapping/`,
`dataset/` and `view/ui/` read the normalized event and hit test types of
`dispatcher/`; `modes/` and the router read the type `PluginManager`;
`plugins/` reads the type `MapLibreGLDraw` for `PluginContext.draw`;
`view/layer/` reads `DatasetManager` to draw datasets in the
same pass; and the snap marker reads the line renderer's style type.
`npm run check:layers` prints the current list.

## The Store

All state lives in the Store. Everything else either writes it through its
methods or derives from it through a subscription.

The principles: all state is gathered in the Store; data flows one way
(operation, Store, notification, subscribers); the public API is the
boundary with the host; and a change reaches every subscriber by itself.

### The split: document and local state

The state is split along one line. The contracts are in
`src/store/store.ts`.

- `DocumentStore` holds features, layers, groups, the stacking order,
  files and metadata. A host replaces it through `Options.store` to keep
  the document elsewhere. It knows nothing
  about the user interface and nothing about read-only.
- `UiState` holds selection, the ids being edited, the tentative geometry,
  box selection, drag state, vertex selection, the vertices that follow a
  shared vertex drag, the mode, read-only, the interaction lock and the
  locally hidden ids. Core owns it and it is never part of the document.
- `Store` is what core works with. Its document writes return `true` when
  applied and `false` when read-only refused them. It delivers both kinds
  of change in one notification.
- `StoreView` is reads, `subscribe` and `transact`, with no writes, so a
  host cannot reach past the checks that the public methods make.

The implementation is `DrawStore` (`src/store/draw-store.ts`), a `Store`
over any `DocumentStore`. `MemoryStore` is a `DrawStore` over the in-memory
`MemoryDocumentStore` (`src/store/memory.ts`), and it is the default when no
store is given. When `Options.store` is a `DocumentStore`, `toStore` wraps
it in a `DrawStore`.

`DrawStore` is the one place that keeps these invariants:

- Read-only is enforced at its write methods and nowhere else.
- The notifications of the document are forwarded into the change bus of
  the local state, so a listener gets one `StateChanges` per transaction
  with both kinds of change.
- When a feature, group or layer is deleted, by anything, its id leaves the
  selection, the ids being edited and the locally hidden set.
- The selection holds only what can be seen. A change that hides a selected
  item (its own visible flag, that of its group or layer, or local hiding)
  takes it out of the selection. The vertex selection ends when its feature
  is deleted or its coordinates change other than by a local drag.

### The document contract

A few rules bind every `DocumentStore` implementation.

- Containment: every feature is listed in exactly one container,
  `group.featureIds` of its group when it has `groupId`, otherwise
  `layer.order` of its layer. Every mutation keeps this.
- The stacking order is part of the document, saved and held by a replaced
  store with the rest, and it may hold entries of the host that are not layers
  (dataset ids, separators). The document keeps their
  positions and gives them no meaning. Its entries are distinct non-empty
  strings. `createLayer` appends the layer unless its id is already
  there, `deleteLayer` takes out that id only, and nothing else adds or
  removes an entry.
- Returned objects are read-only for the caller, and an implementation never
  changes an object after it has returned or notified it. A change stores a
  new object. `MemoryDocumentStore` freezes what it returns, so a write into
  it throws.
- A write whose arguments cannot apply (an unknown id, a `layerId` that
  names nothing, a duplicate id) throws and stores nothing. An
  implementation that receives changes from elsewhere may ignore an update
  to an id that a change from outside already removed.
- `subscribe` delivers the document categories of `StateChanges` with their
  source; other categories are ignored by core.

The full list of methods and their contracts is in the
[generated reference](../api/index.md) under `DocumentStore`.

### StateChanges

Subscribers receive `StateChanges`, one object per flush. It has an
optional category per kind of change:

- `features`, `layers` and `groups`: `created`, `updated` (with `previous`)
  and `deleted`; `layers` also has `orderChanged`
- `layerReorder` and `groupReorder`: the order inside one layer or group,
  separate from `layers.updated` so a consumer can handle them apart
- `selection`, `editing`, `tentative`, `mode` and `metadata`
- `uiStateChanged`: drag state or box selection changed
- `source`: where the change came from

`UpdateSource` is `'local'`, `'silent'`, `'batch'`, `'remote'`, `'import'`
or any other string an extension chooses. `silent` marks a bulk change that
should not be recorded (clearing the selection when a drawing mode starts);
`batch` labels a bulk change recorded as one unit (a GeoJSON import, which is
one transaction); `remote` marks a change a replaced `DocumentStore`
applied from outside the instance. The source is only a label: it never changes
which events are emitted or how they are grouped; the transaction does.

An entry of `features.updated` may carry `isIntermediate: true`. It marks an
intermediate state of an edit in progress, such as each step of a drag. The
memory store applies it like any update; a replacement `DocumentStore` can
use the flag to choose between a persistence path and a transient path.
When a drag ends without committing (a mode switch, an external reset), the
optional `abortIntermediateUpdates(ids)` tells the store to discard the
uncommitted part.

### Transactions, accumulation and folding

`transact(fn, source)` groups writes: listeners get one notification per
outermost transaction, or per write made outside one. The accumulation is
done by `ChangeBus` (`src/store/memory/change-bus.ts`) by appending in
place. Array categories are concatenated; single-value categories
(`orderChanged`, `selection`, `mode` and so on) are overwritten by the later
value.

`layers.updated` and `groups.updated` are folded to one entry per id.
Creating one feature changes `layer.order`, and each entry carries a full
snapshot of the order, so without folding a bulk import would retain
quadratic memory. A folded entry keeps the first state in `previous` and the
last in `layer` or `group`, so as the difference of one flush it means the
same thing.

## Data flow

```text
host --> public API --> Store
                          |
                          | store.subscribe()
       +------------------+------------------+
       |                  |                  |
       v                  v                  v
RenderCoordinator    EventBridge       spatial index,
       |                  |            mutation hooks,
       v                  v            view caches
map.triggerRepaint() EventEmitter --> draw.on() listeners
```

The internal consumers (the spatial index, the RenderCoordinator, the view
caches, the plugin mutation hooks) subscribe to the Store directly. The
EventBridge converts `StateChanges` into events for the outside. Anything
derived from the Store is derived by its subscriber alone; no write path
updates a derived structure by hand.

### Clicking a feature

```text
1. The user clicks the map
2. InputNormalizer: mousedown, mouseup -> click (MouseNormalizedEvent)
3. InputRouter: snaps the coordinate, calls handler.onClick(event)
4. SelectMode: finds the topmost hit
5. SelectMode: store.setSelection('feature', [id])
6. Store: notifies { selection: {...} }
7. RenderCoordinator: map.triggerRepaint()
8. EventBridge: emits 'selection.change'
```

### Dragging a feature

```text
1. InputNormalizer: mousedown, mousemove past the threshold -> dragstart
2. SelectMode.onDragStart:
     store.startEditing(ids); store.setDragState({ operation: 'move' })
     pluginManager.runHook('drag:start', { featureIds })
3. During the drag:
     store.updateFeature(id, changes, { isIntermediate: true })
4. On dragend:
     the last difference is committed in one store.transact()
     (features following a shared vertex commit in the same step)
     store.endEditing(ids); runHook('drag:end', { featureIds })
5. On an abort that does not go through dragend:
     store.abortIntermediateUpdates?(ids)
```

Dragging an auxiliary handle fires neither `drag:start` nor `drag:end`.
Core writes nothing to the Store for such a drag; the provider commits in
its own transaction. A hook that opened an editing scope on `drag:start`
would otherwise fold the provider's commit into the scope and lose it.

These flows keep the Flux rules: input always passes the InputRouter, state
changes always pass the Store, and the view updates from its subscription.

## Input: normalization and dispatch

Browser events reach the modes in two steps.

```text
maplibre map events: mouse, touch, click, dblclick, contextmenu
canvas events: keydown, keyup
        |
        v
InputNormalizer   one event model for mouse, one finger and pen;
        |         drag, long press and double tap detection;
        |         modifier keys; screen and geographic coordinates
        v NormalizedEvent
InputRouter       longitude onto the stored world copy; snapping;
        |         plugins first; interception by datasets
        v
ModeHandler       onClick, onDragStart, onKeyDown, ...
```

### InputNormalizer

`createInputNormalizer` (`src/dispatcher/normalizer.ts`) turns the events of
maplibre and the canvas into `NormalizedEvent`s:

| Type | Meaning |
| --- | --- |
| `click` | Press and release with no drag |
| `dblclick` | Double click or double tap |
| `mousedown`, `mouseup` | Press, release |
| `mousemove` | Pointer moved (hover or before the threshold) |
| `contextmenu` | Right click or long press |
| `dragstart`, `dragmove`, `dragend` | A press that moved past the threshold |
| `dragcancel` | A press that ended without a release |
| `keydown`, `keyup` | Key events on the canvas |

Mouse and drag events carry `point` (screen), `lngLat` (geographic),
`modifiers` and `pointerType`; drag events also carry `dragStartPoint` and
`dragStartLngLat`, the press position before the threshold was passed.

Drag detection: a press marks a candidate; a move beyond the threshold of
the pointer starts the drag, which lasts until release; on release the
normalizer emits `dragend` then `mouseup` for a drag, or `mouseup` then
`click` otherwise.

One finger and a pen are written onto the same events as the mouse, with
`pointerType: 'touch'` or `'pen'`, so a mode handles all three with the same
code. The pointer-dependent thresholds (drag distance, click time limit,
long press, double tap) are closed inside the normalizer. Further rules:

- A touchstart emits `mousemove` then `mousedown`, since touch has no hover.
  Browser compatibility mouse events after a tap are ignored.
- Gestures of two or more fingers are left to maplibre. A second finger,
  `touchcancel`, losing window focus, or Escape during a drag all end the
  press with `dragcancel` and nothing else; that Escape is not delivered.
- The normalizer never calls `preventDefault` on a touch event, so maplibre
  keeps its pan and pinch; a mode that takes over a press disables
  `dragPan`.
- A mouse press whose button is found up on a `mousemove` is released at its
  last position, without a `click`.
- The canvas is focused on a mouse press, because a mode that consumes
  `mousedown` also prevents the browser's focus change. Keys are read on
  the canvas.
- A mode consumes a `dblclick` or a key with
  `originalEvent.preventDefault()`; the normalizer then also keeps
  maplibre's double click zoom or keyboard handler from acting on it.

How maplibre's own handlers are kept intact is described in
[maplibre-coupling.md](./maplibre-coupling.md).

### InputRouter

`createInputRouter` (`src/dispatcher/input-router.ts`) is the single
entrance for coordinates. For each event it:

1. Drops `click`, `dblclick` and `mousemove` from the real pointer while the
   pointer hold is on (`setPointerHold`, used while the keyboard is placing
   coordinates). Press and drag events still pass so the map can pan.
2. Brings the longitude onto the copy of the world the features are stored
   in. A drag shifts every coordinate by the shift decided at its start, and
   while a shape is being drawn the pointer goes to the copy nearest its
   first vertex. See [coordinate-precision.md](./coordinate-precision.md).
3. For `click`, `mousemove`, `dragstart`, `dragmove` and `dragend`, asks the
   mode `isSnapEnabledFor(type)` and, unless declined or the event carries
   `snap: false`, replaces `lngLat` with `SnapService.resolve()`.
4. Delivers the event to the current handler. `keydown` goes to the plugins
   first (`PluginManager.handleKeyDown`), and the mode sees it only when no
   plugin consumed it. `mousemove` and `dragmove` are also handed to the
   plugins, which cannot consume them.
5. In select mode only, hands `click` and `mousemove` to the
   interception by datasets and reports every click once as `map.click`.
   A hit on a Store feature always wins over a dataset, and that rule lives
   on the interception side.

`dragcancel` never goes through snapping and is never held, so the mode
always gets the chance to abort.

`dispatch(event)` feeds a synthesized event into the same path; `draw.input`
uses it, so numeric entry, automation and tests get snapping, plugin
delivery and interception exactly as a real pointer does. Synthetic input is
exempt from the pointer hold and is treated as `'mouse'`.

Because snapping happens here, every mode, including a mode a plugin
registers and the vertex drag of select mode, snaps without any code of its
own.

## Modes

### Mode handlers

A mode is a `ModeHandler` (`src/modes/handler.ts`) created by a
`ModeFactory`. Core registers seven: `select`, `draw_point`, `draw_line`,
`draw_polygon`, `draw_image`, `draw_circle` and `draw_freehand`. The `Mode`
type accepts any other string for custom modes.

A handler receives its `ModeContext` once, in `onStart(context)`, and keeps
it; the event methods take only the event. The methods are all optional:

- Lifecycle: `onStart`, `onStop`, `onExternalStateChange` (state changed
  under the mode, for example by a change applied from outside) and
  `onSelectionChange`
- Pointer: `onClick`, `onDoubleClick`, `onMouseMove`, `onMouseDown`,
  `onMouseUp`, `onDragStart`, `onDragMove`, `onDragEnd`, `onDragCancel`.
  `onMouseDown` returns `true` to consume the press, which stops it from
  reaching maplibre
- Keyboard: `onKeyDown`, `onKeyUp`
- Vertices while drawing: `undoVertex`, `redoVertex`
- Snapping: `isSnapEnabledFor(type)` declines snapping per input kind;
  `getSnapPreference()` names the feature to prefer when candidates tie
- `writesFeatures`: the mode creates features, so it may be entered only
  while a layer can be written

`ModeContext` hands a mode what it needs: the map, the Store, the spatial
index queries, the hit test services and `hitTestTopmost`, the selection
scope, the event emitter, the configuration, the plugin manager,
`getCurrentLayerId` (the writable layer, or an empty string),
`getSnapResult` and the ports to datasets. A mode never
triggers a repaint; the RenderCoordinator does that from the Store.

Freehand is the reason `isSnapEnabledFor` exists. The snap tolerance
assumes one decision per click; a stroke passes hundreds of points, and
snapping each would bend a straight stroke. Freehand declines `dragmove`
and snaps `dragstart` and `dragend`, so a stroke can still start and end on
a corner.

### ModeManager

`ModeManagerImpl` (`src/modes/manager.ts`) holds the factories and runs one
handler at a time. The mode itself lives in the Store; the manager switches
the handler only in its Store subscription, so the Store, the `mode.change`
event and the running handler always agree.

`setMode(mode)` checks the request before touching the Store. Every refusal
looks the same: the Store does not change, no event is emitted, the current
handler keeps running, and `false` is returned. A request is refused when:

- no factory is registered for the name (a warning is logged),
- the interaction lock is on and the mode is not `select`, or
- the `canEnter` predicate rejects the new handler. `createContext` sets it
  to refuse a mode that declares `writesFeatures` while no layer can be
  written.

Asking for the current mode changes nothing and returns `true`.
`registerMode` returns a function that removes the registration;
`unregisterMode` enters `select` first when the removed mode is current.

`writesFeatures` does not remove the check at commit time: a layer can stop
being writable while the mode is active, and the mode then discards the
drawing and returns to select.

## Operations

`operations/` holds the logic that runs inside a mode but is not a mode:
resize, rotate, vertex editing (insert, move, delete, including rings and
parts), the simultaneous move of shared vertices, selection operations
(delete, group, ungroup) and the edge graph for tracing. Modes and the api
layer call them; the dispatcher does not (rule 4). They read and write only
the Store and the pure math below them.

## Events

`EventEmitter` (`src/shared/utils/event-emitter.ts`) is a typed emitter over
`EventMap`. There are two names for each event:

- Internal names without a prefix, such as `feature.create`. The
  EventBridge and SnapService emit these, and plugins subscribe with them
  through `PluginContext`.
- Public names with the `draw.` prefix, such as `draw.feature.create`.
  `draw.on()` and `draw.off()` strip the prefix and delegate to the internal
  emitter.

The EventBridge (`src/store/event-bridge.ts`) emits the per-item events
(create, update, delete of features, layers and groups) once per change,
whatever the source. A `draw.load` of N features emits N `feature.create`,
so a subscriber that mirrors the document sees every change.

For every flush that changes features, it then emits `features.change` once,
after the per-feature events, with every created, updated and deleted
feature of the flush in order and the flush's `source`. A subscriber that
rebuilds a view on any change listens to that instead, so a bulk change
costs one rebuild rather than N.

Some events come from elsewhere: `snap.change` from SnapService,
`dataset.click` and `map.click` from the InputRouter, `geometry.applied`
from `draw.geometry`, `renderslots.change` from the CustomLayer,
`image.request` from the image mode and `load.error` when the image of an
Image feature fails to decode.

The full list of events, their payloads and their order is in
[events.md](../reference/events.md).

## Snapping

SnapService (`createSnapService` in `src/snapping/service.ts`) moves an
input coordinate onto a nearby vertex, intersection or edge, or onto a guide
line while drawing. It runs only from the InputRouter, for the five input
kinds above.

- Candidates come from providers: the built-in ones for the Store's
  vertices, edges and intersections, the guide lines and the
  datasets, plus those a host adds with `draw.snapping.register()` and
  those a custom type returns from `getSnapTargets`.
- SnapService, not the providers, chooses. It discards disabled kinds
  (`options.snap.kinds`, `draw.snapping.setKindEnabled`) and candidates
  outside the pixel tolerance, ranks vertex over intersection over edge over
  guide, and prefers the nearer within a rank. It also computes the nearest
  point on a segment, so a provider only puts candidates forward.
- Guides exist only while drawing lines and polygons, derived from the
  committed vertices of the tentative shape.
- Vertex enumeration shares the handle computation of the selection UI
  (`view/ui/handles.ts`), so holes and Multi parts are targets as they are.
- The InputRouter excludes, from the Store's drag state, the grabbed vertex
  during a vertex drag and the moving features during a move. Select mode
  drags start from `dragStartLngLat`, which is never snapped, so snapping
  `dragstart` and `dragend` does not shift them.
- The marker is a built-in overlay renderer (`snapping/indicator.ts`).
  Snapping does not change the Store, so it repaints on `snap.change`. The
  result carries the geometric reference of its target for edge tracing.
- Only visible candidates take part: the shared visible flag over three
  levels and local hiding.

How to use snapping and write a provider is in
[snapping-geometry.md](../guides/snapping-geometry.md).

## Geometry module

`src/geometry/` is a set of pure functions independent of rendering and
editing: measurement, predicates, bounding boxes, boolean operations,
buffer, split, simplification and coordinate helpers. It depends on neither
maplibre, the DOM, the Store nor events; its only runtime dependency is
polygon-clipping. The same inputs give the same results in Node, Bun, a
worker or the browser, which is why it is published as the sub-entry
`@sakuzu/maplibre-gl-draw/geometry`.
`src/geometry/dependency.test.ts` checks that its imports stay closed.

`draw.geometry` (`src/api/geometry-operations.ts` and `src/api/geometry/`)
is the layer that ties these functions to the selection, transactions and
the `geometry.applied` event. It holds no geometric computation of its own.
Crossing longitude 180 and the neighborhood of the poles are out of scope.
The functions are documented in
[snapping-geometry.md](../guides/snapping-geometry.md) and the generated
reference.

### Why there is no GEOS

The boolean operations and buffers use polygon-clipping, not GEOS compiled
to WebAssembly. Two suites decide this: a robustness suite
(`src/geometry/robustness.test.ts`) that runs the operations on synthetic
data with the features of real boundaries (exclaves, holes, long jagged
outlines, adjacent parcels) and on pathological input (self-intersections,
slivers, duplicate and nearly collinear vertices), checking topology and
area conservation; and a performance suite
(`src/geometry/performance.test.ts`) at the scale of ten thousand features.
Both pass with the pure implementation. The one failure mode found, a
single union of many circles and bands that polygon-clipping cannot close,
is avoided by folding the inputs of `unionAll` as a binary tree, which stays
deterministic. If the suites stop passing, limited measures such as snap
rounding come first, and GEOS is reconsidered only with the failing case in
hand.

## Locking, read-only and local visibility

Four mechanisms restrict what can be done. They are separate on purpose;
the user-facing meaning and the contract with a host are in
[read-only.md](../guides/read-only.md). This section is about where each one
is enforced.

| Mechanism | Scope | What it stops |
| --- | --- | --- |
| Lock | One item | Editing that item |
| Read-only | Instance | Local writes to the document |
| Interaction lock | Instance | Starting edits from user input |
| Local visibility | One item | Display on this client |

The shared predicates are pure functions next to each other in `store/`:

- `isFeatureLocked`, `isGroupLocked` and `isInteractionBlocked` in
  `store/lock.ts`
- `isLocallyHidden` and `getDisplayFeatures` in
  `store/local-visibility.ts`
- `isWritableLayer` and `resolveWritableLayerId` in
  `store/writable-layer.ts`

Each takes a minimal store interface (`FeatureLockStore` and the like), so
`PluginContext` satisfies it and an extension can use the same judgement.
`isFeatureLocked`, `isGroupLocked` and `isInteractionBlocked` are public;
`isLocallyHidden` and `getDisplayFeatures` are internal.

### Lock

Feature, Group and Layer each have a `locked` flag. A lock allows selection
and display and forbids every other edit.

Selecting and toggling `visible` or `locked` stay allowed; moving,
transforming, deleting and changing attributes are forbidden. The lock is
inherited downward: a feature is effectively locked when it, its group or
its layer is locked, and a group when it or its layer is locked.

- `updateFeature`, `updateGroup` and `updateLayer` reject an update of an
  effectively locked item that contains a key other than `locked` and
  `visible`.
- Drags and the delete shortcut check the lock at their start, and box
  selection skips locked items.
- The selection box of a locked item is drawn without handles.
- Editing that an extension starts on a feature must check the lock too.

### Read-only: one gate at the Store's writes

The only gate is in `DrawStore`'s write methods. While read-only is on,
`createFeature`, `updateFeature`, `deleteFeature`, `createLayer`,
`updateLayer`, `deleteLayer`, `setLayerOrder`, `reorderInLayer`,
`createGroup`, `updateGroup`, `deleteGroup`, `reorderInGroup`,
`createFile`, `deleteFile` and `setMetadata` do nothing and return `false`.
They do not throw, even for an unknown id, so no caller breaks. The public
methods that map onto one of these writes return the same boolean.

Drawing modes, operations, the api layer, `PluginContext`, import, the
shortcuts and everything built on top all end in these methods. A gate spread over
the callers would miss one; a gate at the single layer they share leaks
nothing.

Read-only leaves three things alone.

- The local-state setters (selection, mode, editing, tentative, drag,
  vertex selection, local hiding). A viewer can still select, inspect and
  hide things locally.
- Changes applied to the `DocumentStore` directly. A replacement store
  applies changes from outside below the gate, so a read-only client still
  follows the document. Do not put read-only checks into the path that
  applies such changes or into anything that derives rendering state.
- Datasets, which never enter the Store.

The spatial index cannot drift under read-only: it is derived by a Store
subscriber, and a refused write notifies nothing.

### Interaction lock: where edits are stopped

The interaction lock allows selection and stops the start of any edit that
comes from user input, for every feature. It gates no Store write: writes
from plugin initialization and from the system still pass (stopping writes
is read-only's job). The two are independent and can be on in any
combination.

`isInteractionBlocked(feature, store)` is true when read-only, the
interaction lock or the feature's effective lock holds. It is checked at the
start of each interaction:

- Drag start. `startDrag` in `modes/select/drag-handler.ts` refuses every
  kind of drag when any selected feature is blocked. A handle not tied to a
  selection passes only the instance-wide checks.
- Shortcuts. `handleGroupShortcut` and `handleUngroupShortcut` in
  `modes/select/shortcut-handler.ts`, and `deleteSelection` in
  `operations/selection-operations.ts` (which the delete shortcut calls),
  return early while read-only or the interaction lock is on. Deleting a
  group or a layer does not pass the per-feature lock check, so the gate at
  the start is required. Inside, a group deletion skips its locked members
  and a layer holding a locked item is not deleted.
- Arrow keys. `handleNudgeShortcut` moves the selection only when no
  selected feature is blocked; otherwise the key is left to the map.
- Selection UI. For a blocked selection, `view/layer/frame-render.ts`
  draws the selection box without handles, the same look as locked, so a
  viewer still sees what is selected without a hint of editing.
- Map panning. While the lock is on, select mode does not disable `dragPan`
  on a hit, since no drag can start and the map must still pan.
- Cursor. `modes/select/cursor-handler.ts` shows no operation cursor for a
  blocked selection, so the cursor never promises a drag.
- Mode changes. `ModeManager.setMode` refuses any mode but `select` while
  the lock is on. `draw.setInteractionLock(true)` during drawing switches to
  `select`, and the drawing handler's `onStop` clears the tentative shape.

### Local visibility: where hiding applies

The locally hidden set in `UiState` holds feature, group and layer ids. It
is never part of the document and never changes it.

`isLocallyHidden(feature, store)` looks at three levels: the feature, its
group and its layer. A plain id filter would leave the features of a hidden
layer on screen, so the judgement is always made over the three levels.
`getDisplayFeatures(store)` is `getOrderedFeatures()` without the locally
hidden ones. Since `getOrderedFeatures()` already applies the shared
`visible` flag over the same three levels, the result is "visible in the
document and not hidden here".

Local hiding is applied in six places.

- Rendering. The immediate path (`view/layer/display-list.ts`) and the
  retained batches cut their runs from the display features. The Store
  updates the hidden `Set` in place, so the retained batches compare it
  against a snapshot of the previous frame, not by reference.
- Hit testing. Click, cursor and selection pass the display features to the
  hit test.
- Box selection. `queryFeaturesInBox` in `modes/select/box-selection.ts`
  works from the spatial index, not from the ordered list, so it checks the
  shared flags and local hiding itself.
- Snapping. The built-in providers check the shared flags over three levels
  and local hiding.
- Shared vertex moves. Following vertices are rejected when locked, shared
  hidden or locally hidden.
- Selection. `DrawStore` takes a hidden item out of the selection, as
  described under the Store.

`getOrderedFeatures()` itself is not changed: export and the public
`getVisibleFeatures()` keep using the document's view of visibility. Local
hiding exists only in the separate derivation for display.

### The writable layer

User drawing writes new features only into a writable layer: one that
exists, is not locked, is visible in the document and is not locally hidden
(`isWritableLayer`). `resolveWritableLayerId` returns the active layer when
it is writable, otherwise the first writable layer, otherwise an empty
string; it never changes the active layer. `ModeContext.getCurrentLayerId`
exposes it. This is a rule for user drawing, not a write gate: the Store's
write methods and the public API still accept any existing layer.

## Plugins

`PluginManager` (`createPluginManager` in `src/plugins/plugin-manager.ts`)
holds the plugins of one instance. The contracts are in
`src/plugins/plugin.ts`; how to write a plugin is in
[plugins.md](../guides/plugins.md).

A `Plugin` has a unique `name` and, optionally, `onInstall(context)` and
`onUninstall()`; `hooks`; `modes` (custom mode factories registered on
install); `api` (reached by the host with `draw.getPluginApi(name)`); global
input handlers (`onKeyDown`, which runs before the mode and consumes the
key by returning `true`, `onMouseMove`, `onDragMove`, `onMouseLeave`);
`filterSelection`; and interaction hooks through which select mode
delegates clicks and in-place editing to a plugin (`onFeatureClick`,
`onFeatureDoubleClick`, `isInteracting`, `finishInteraction`,
`cancelInteraction`, `getInteractionContainer`, `onFeatureCreated`).

`PluginContext` is the only way a plugin reaches core (rule 3). It offers
the instance itself (`draw`, for the registration functions), the Store
(`getStore()`, with its writes behind the same read-only gate), reads,
mutations that take an optional `source`, layer and group operations, the
internal event names, `batch`, mode control, vertex undo and redo,
`invalidateFeatures(type)` for a custom type whose extent changed for a
reason the Store cannot see, the terrain anchors of this instance and
`computeBoundingBox`.

### Lifecycle and hooks

1. `draw.addPlugin(plugin)` registers it and returns a function that
   unregisters it. A second plugin with the same name is skipped.
2. Its modes are registered and `onInstall` runs.
3. Hooks fire as the Store changes and as drags start and end.
4. Unregistering removes its modes and runs `onUninstall`.
   `draw.destroy()` unregisters every plugin, so each can release timers
   and subscriptions it holds outside the instance.

The mutation hooks (`feature:afterCreate`, `feature:afterUpdate`,
`feature:afterDelete`, the same three for groups and layers, and
`selection:afterChange`) are fired by one Store subscriber that the api
layer sets up (`subscribeMutationHooks` in `plugins/mutation-hooks.ts`).
They therefore see every write, whatever made it: the public API, a mode, a
drag, a shortcut, import, a plugin or a change applied to a replaced store.
The hooks of one notification share its `source` and a `batchId`.
Intermediate updates are not reported, only the commit that follows them,
and a write refused by read-only fires nothing.

There are no "before" hooks. Firing them would require the Store to call up
into the plugins, against the layers, and a hook cannot veto or rewrite a
mutation. `drag:start` and `drag:end` are fired by the drag of select mode.

`PluginContext.batch(fn)` wraps `fn` in `store.transact`, so several writes
become one notification, one set of hooks with one `batchId`, and one step
for anything that records the notifications. A shared `batchId`
alone does not open a transaction. Wrap an operation that spans several
features in `batch`.

### Extension points

Besides plugins, the instance has registration functions:
`registerMode`, `registerFeatureHandler`, `addOverlayRenderer`,
`registerAuxiliaryHandleProvider` and `registerFeatureCompanionProvider`,
plus `draw.snapping.register` for snap providers. Each returns a function
that cancels the registration. Their use is described in
[custom-types.md](../guides/custom-types.md).

Two of them have their core side here:

- Auxiliary handles (`view/ui/auxiliary-handles.ts`). A provider returns
  handles for the single selected feature, or selection-independent handles
  through `getGlobalHandles()`. Core only hit tests them and delegates the
  drag: `onHandleDragStart` must return `true` before core stops the map's
  pan and sends the move and end to the same provider. Read-only, the
  interaction lock and (for a handle tied to a feature) the effective lock
  are checked first. The provider draws the handles; the selection UI does
  not.
- Companions (`view/feature-companion.ts`). A provider draws something just
  below a feature in the render loop and hit tests it just after the
  feature misses in the z traversal, so what is seen and what can be
  grabbed stay at the same place in the stacking order. Core consumes the
  click and returns it with `onCompanionClick` without touching the
  selection.

The positions in the render loop and in the z traversal are described in
[rendering.md](./rendering.md) and [hit-testing.md](./hit-testing.md).

### Every registry belongs to one instance

There is no module-level registry. Two instances on one page (an editor and
a print preview, a thumbnail or a comparison view) never see each other's
registrations, and destroying one clears only its own. This is the rule
that core holds no global state, applied to the extension points.

The registries of custom type selection hooks, auxiliary handles and
thinned handle sets live in the selection scope; the snap targets of custom
types, the hit test and box selection strategies in their services (all
built by `createContext`); renderers and overlays in the CustomLayer; and
companions in the companion registry built by `createMapLibreGLDraw`.

The selection scope (`view/ui/selection-scope.ts`) is created once per
instance and handed both to the CustomLayer, which draws the selection UI,
and to the modes (`ModeContext.selectionScope`), which hit test the
handles, so what is drawn and what can be grabbed come from one source.

The render state is owned the same way. The CustomLayer creates a render
scope (`view/layer/render-scope.ts`) holding the terrain state and the
per-feature caches, and each renderer receives the parts it needs when it is
built. A plugin reads the terrain of its own instance through
`PluginContext.projectAnchor` and related methods; an extension renderer
through `CustomRendererDrawContext.terrain`.

## The public surface

The package has two module entries: `.` and `./geometry`. The second
collects only pure functions that also run outside the browser; no other
subpath is exported, because it would freeze the internal structure for the
outside. `./package.json` is exported as metadata.

`src/index.ts` names every public symbol one by one, with no `export *`,
in two sections.

- Layer 1, the public API. The factory `createMapLibreGLDraw`, the
  `MapLibreGLDraw` instance and its `Options` with every type they refer
  to, the data model, the event payloads, the extension points (`Plugin`,
  `PluginContext`, `ModeHandler`, `ModeContext`, the normalized events,
  `CustomFeatureHandler`, the overlay renderer, the snapping provider, the
  hit test and box selection strategies, the auxiliary handle and companion
  contracts), the store contracts and `MemoryStore`, and the pure functions.
  It follows semver.
- Layer 2, building blocks for extension authors. Parts that let an
  extension draw and hit test the way core does: the WebGL helpers
  (`createProgram`, `QuadShader`, `ProjectionUniformManager`, the blend and
  depth helpers), the terrain anchoring functions, the OBB and projection
  math, the selection helpers, and the types of the core services that
  `ModeContext` and `CustomRendererDrawContext` hand over. It may change in
  a minor release.

The rules for deciding which layer a new symbol belongs to, and the steps
for publishing it, are in "The public surface" of `CONTRIBUTING.md`.

Everything else (renderer classes, managers, sub-API factories, built-in
modes and strategies) is internal. A class that an extension context hands
over, such as a shared renderer or the terrain context, is exported as a
type only, and its members outside the contract carry the internal JSDoc
tag, which `stripInternal` removes from the declarations.

`src/index.test.ts` pins both lists (`LAYER_1` and `LAYER_2`), checks that
the runtime exports match, and emits the declarations to check that they
type-check on their own and that every type a public declaration refers to
is exported.

## Dependencies

The runtime dependencies are `earcut` (triangulation), `rbush` (the
spatial index of the Store), `polygon-clipping` (boolean operations in
`geometry/`, and the only dependency of that sub-entry), `ulid` (ids; the
random bytes are drawn in batches, `shared/utils/id.ts`) and
`@types/geojson`. The `table` sub-entry (`table/index.ts`) has no runtime
dependency.

- `@types/geojson` is a runtime dependency because the emitted declarations
  refer to the `geojson` types.
- There is no matrix library: the matrices come from maplibre and are
  multiplied in GLSL.
- `maplibre-gl` is a peer dependency declared as `~6.11.1` (the patch
  releases of 6.11; a new minor is added after it is checked). v6 is ESM-only,
  has no default export and no UMD global, and requires WebGL2, so types
  are imported explicitly
  (`import type { Map as MapLibreMap } from 'maplibre-gl'`). The coupling
  points checked against that range are listed in
  [maplibre-coupling.md](./maplibre-coupling.md), and how the range moves is
  in [releasing.md](./releasing.md).

Setting up the maplibre worker in a bundler is covered in
[getting-started.md](../getting-started.md).

## Directory structure

The directories follow the layers. The files inside change too often to be
listed here; read the barrel `index.ts` of each directory for its public
part.

| Directory | Contents |
| --- | --- |
| `index.ts` | Public entry; names every export |
| `maplibre-gl-draw.ts` | `createMapLibreGLDraw`; wiring |
| `messages.ts` | Default message table |
| `api/` | Public API, sub-namespaces, context |
| `store/` | Store contracts, DrawStore, index |
| `dispatcher/` | Normalizer, router, hit testing |
| `modes/` | ModeManager, select and draw modes |
| `operations/` | Resize, rotate, vertex, tracing |
| `snapping/` | SnapService, providers, marker |
| `view/` | CustomLayer, renderers, shaders, UI |
| `dataset/` | Datasets |
| `table/` | Tables of rows as columns (sub-entry) |
| `plugins/` | PluginManager, context, hooks |
| `extension/` | Contracts for extensions (types) |
| `shared/` | Types, math, config, utils |
| `geometry/` | Pure geometry (sub-entry) |
| `e2e/` | Browser end-to-end tests |

Unit tests sit next to the file they test as `*.test.ts`. What each layer's
tests protect is in [test-design.md](./test-design.md).
