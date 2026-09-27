# Plugins

A plugin packages behavior you add to a draw instance: reacting to
changes, adding a mode, adding a feature type, drawing an overlay. It is a
plain object with a name, registered with `draw.addPlugin`, and it reaches
the instance through the `PluginContext` it receives on install.

## The smallest example

A plugin that logs every created, updated and deleted feature:

```ts
import {
  createMapLibreGLDraw,
  type Plugin,
  type PluginContext,
} from '@sakuzu/maplibre-gl-draw';

function createLoggerPlugin(): Plugin {
  let unsubscribe: Array<() => void> = [];

  return {
    name: 'logger',

    onInstall(ctx: PluginContext) {
      unsubscribe = [
        ctx.on('feature.create', ({ feature }) => {
          console.log('created', feature.id, feature.type);
        }),
        ctx.on('feature.update', ({ feature }) => {
          console.log('updated', feature.id);
        }),
        ctx.on('feature.delete', ({ feature }) => {
          console.log('deleted', feature.id);
        }),
      ];
    },

    onUninstall() {
      for (const off of unsubscribe) off();
      unsubscribe = [];
    },
  };
}

const draw = createMapLibreGLDraw(map);
const removeLogger = draw.addPlugin(createLoggerPlugin());
```

Draw a feature and the console shows `created`. `removeLogger()` takes
the plugin back: `onUninstall` runs and the log stops.

## The Plugin object

Only `name` is required, and it must be unique in the instance. A second
plugin with a name that is already registered is skipped with a warning,
and the function returned for it does nothing.

| Member | Use |
| --- | --- |
| `onInstall(ctx)` | Receives the context; subscribe and register here |
| `onUninstall()` | Releases what `onInstall` acquired |
| `hooks` | Reacts to changes after they happen (below) |
| `modes` | Modes registered and removed with the plugin |
| `api` | An object other code gets with `draw.getPluginApi(name)` |

A plugin can also take part in input: `onKeyDown` (return true to consume
the key before the mode sees it), `onMouseMove`, `onDragMove`,
`onMouseLeave`, `filterSelection` (narrow the candidates of a
selection), `onFeatureClick` and `onFeatureDoubleClick` (return true when
handled), `onFeatureCreated`, and the four members through which a plugin
holds an exclusive interaction such as inline editing: `isInteracting`,
`finishInteraction`, `cancelInteraction` and `getInteractionContainer`.

`api` exposes functions to the host or to another plugin:

```ts
const counter: Plugin = {
  name: 'counter',
  api: { count: () => draw.getAllFeatures().length },
};
draw.addPlugin(counter);

const api = draw.getPluginApi<{ count(): number }>('counter');
api?.count();
```

Prefer passing one plugin to another through its constructor;
`getPluginApi` is the fallback.

## What the context gives

`onInstall` receives a `PluginContext`, the only way a plugin reaches
the instance.

- `draw` is the instance itself, for the public API and the extension
  points (`registerMode`, `registerFeatureHandler`,
  `addOverlayRenderer`, and so on)
- The read API: `getFeature`, `getAllFeatures`, `getLayer`,
  `getSelection`, `getMode`, and more
- The write API: `addFeatures`, `updateFeature`, `deleteFeatures`,
  `createLayer`, `createGroup`, `setSelection`, and more. Each call is
  one Store transaction. `batch(fn)` puts several writes in one
- The events: `on`, `off` and `emit`
- `setMode`, which returns false when the mode was refused
- `getStore()`, the Store itself with its write methods, for a plugin
  that works on the document directly
- `autoNameGenerator`, the automatic naming of the instance. A plugin
  that creates a feature, a layer or a group without a name the user typed
  names it here (`generateName(type)`, `generateLayerName()`,
  `generateGroupName()`), so the name takes its words from the host's
  `autoName` option ([automatic names](drawing.md#automatic-names))
- `invalidateFeatures(type)`, `computeBoundingBox(feature)` and the
  terrain anchors, used by custom feature types (see
  [custom types](custom-types.md))

The events of the context use the names without the `draw.` prefix:
`ctx.on('feature.create', ...)` is the same event as
`draw.on('draw.feature.create', ...)`. Both return the function that
unsubscribes.

A plugin that works on every dataset (drawing something
of its own for their features, for example) follows them with
`dataset.add` and `dataset.remove`. Datasets can already exist when
the plugin is installed, so it reads `ctx.draw.getDatasets()`
once in `onInstall` as well. A plugin that draws the datasets in
their order also listens to `dataset.reorder`, which carries the ids from
the back to the front.

<!-- docs-check:
declare const ctx: PluginContext;
declare function follow(datasetId: string): void;
declare function forget(datasetId: string): void;
-->

```ts
for (const dataset of ctx.draw.getDatasets()) follow(dataset.id);
ctx.on('dataset.add', ({ datasetId }) => follow(datasetId));
ctx.on('dataset.remove', ({ datasetId }) => forget(datasetId));
```

Every write takes an optional `source` as its last argument. It becomes
the source of the change notification (`'local'` when left out), so the
hooks and `draw.features.change` can tell who made the change.

<!-- docs-check:
declare const ctx: PluginContext;
declare const id: string;
-->

```ts
ctx.deleteFeatures([id], 'remote');
```

A write that names an id that no longer exists is ignored: a plugin often
reacts after a change, when the target may already be gone. While the
Store is read-only, the writes change nothing, and `addFeatures` returns
an empty list.

## Hooks

`hooks` reacts to changes without subscribing to the Store:

```ts
const audit: Plugin = {
  name: 'audit',
  hooks: {
    'feature:afterCreate': (features, ctx) => {
      console.log('created', features.map((f) => f.id), ctx.source);
    },
    'feature:afterUpdate': (updated, original) => {
      console.log('updated', updated.length, 'of', original.length);
    },
  },
};
```

| Hook | Arguments |
| --- | --- |
| `feature:afterCreate`, `feature:afterDelete` | features, ctx |
| `feature:afterUpdate` | updated, original, ctx |
| `group:` and `layer:` with the same three | one item (and the original) |
| `selection:afterChange` | new ids, previous ids, ctx |
| `drag:start`, `drag:end` | `{ featureIds }`, ctx |

- The change hooks run after the change, for every write whatever made
  it: the public API, a drawing mode, a drag, the Delete key, a load, a
  plugin, or a change applied to a Store you supplied
- The hooks of one transaction share `ctx.source` and `ctx.batchId`
- The intermediate updates of a drag are not reported; the update that
  ends it is
- A write the Store refuses (read-only) runs no hook
- `drag:start` and `drag:end` surround a move, resize, rotation, vertex
  or radius drag of the select mode
- There are no before hooks. A hook cannot stop or rewrite a change

## Custom modes

A mode receives the input while it is active. Register one with
`draw.registerMode(name, factory)`, or declare it in the plugin's `modes`
so it lives and dies with the plugin. The factory returns a
`ModeHandler`; `onStart` receives the `ModeContext`.

```ts
import type { ModeContext, ModeHandler } from '@sakuzu/maplibre-gl-draw';

function createStampMode(): ModeHandler {
  let ctx: ModeContext;
  return {
    modeName: 'stamp',
    writesFeatures: true,
    onStart(context) {
      ctx = context;
    },
    onClick(event) {
      const layerId = ctx.getCurrentLayerId();
      if (layerId === '') {
        ctx.setMode('select');
        return;
      }
      ctx.store.createFeature({
        id: ctx.generateFeatureId(),
        type: 'Point',
        coordinates: [event.lngLat.lng, event.lngLat.lat],
        layerId,
        properties: {},
        locked: false,
        visible: true,
      });
    },
    onKeyDown(event) {
      if (event.key === 'Escape') ctx.setMode('select');
    },
  };
}

draw.registerMode('stamp', createStampMode);
draw.setMode('stamp');
```

Each click adds a point to the current layer until Escape.

- `writesFeatures: true` makes `setMode` refuse the mode while no layer
  can be written, like the built-in drawing modes
- The layer can stop being writable while the mode is active (deleted,
  locked or hidden). Read `getCurrentLayerId()` again when committing. On
  an empty string, do not create the feature: discard what is being
  drawn (`store.setTentative(null)`) and return to `select`
- `onDragCancel` arrives when a press ends without a release (a second
  finger, a cancelled touch). Commit nothing, undo what the press
  changed, and enable `map.dragPan` again if you disabled it
- To stop the map from also using a double click or a key (arrows, `+`,
  `-`), call `event.originalEvent.preventDefault()` in `onDoubleClick` or
  `onKeyDown`

## Taking registrations back

Every registration returns the function that cancels it: `addPlugin`,
`registerMode`, `registerFeatureHandler`, `addOverlayRenderer`,
`registerAuxiliaryHandleProvider`, `registerFeatureCompanionProvider` and
`snapping.register`. There are no `remove...` methods.

- Unregistering a plugin removes the modes in its `modes` (entering
  `select` first when one of them is active) and runs `onUninstall`
- Removing a mode that is active enters `select` first
- When the same name or type was registered again since, an earlier
  cancel function leaves the later registration in place
- Registrations belong to the instance they are made on. Another draw
  instance on the page never sees them
- `destroy()` unregisters every plugin (running `onUninstall`) and clears
  every registration of the instance. On a destroyed instance a
  registration is ignored and returns a function that does nothing

## Related example

- [examples/plugin/](../../examples/plugin/) registers a logger
  plugin with hooks and a custom mode, and removes them again

## Reference

- [Plugin](../api/maplibre-gl-draw/interfaces/Plugin.md)
- [PluginContext](../api/maplibre-gl-draw/interfaces/PluginContext.md)
- [Hooks](../api/maplibre-gl-draw/interfaces/Hooks.md) and
  [MutationContext](../api/maplibre-gl-draw/interfaces/MutationContext.md)
- [ModeHandler](../api/maplibre-gl-draw/interfaces/ModeHandler.md) and
  [ModeContext](../api/maplibre-gl-draw/interfaces/ModeContext.md)
- [EventMap](../api/maplibre-gl-draw/interfaces/EventMap.md) for the
  event names of the context
