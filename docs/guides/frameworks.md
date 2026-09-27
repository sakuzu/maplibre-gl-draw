# Using it with a framework

The library has no bindings for React, Svelte or Vue, and needs none. A
component creates the map and the draw instance when it mounts and
destroys both when it unmounts. This guide shows that in each framework,
and how to keep the library out of server-side rendering.

## The rule

1. Create the draw instance after the map exists, in the mount hook
2. Keep it in a plain variable or a ref, not in reactive state
3. When the component unmounts, call `draw.destroy()` and then
   `map.remove()`

`destroy()` removes the layers and listeners the instance added,
unregisters its plugins, and gives the map back the settings it changed.
A second call does nothing, and calls on a destroyed instance do not
throw. `draw.on` returns the function that unsubscribes, so a component
that subscribes to a longer-lived instance can clean up with it.

## React

```tsx
import { useEffect, useRef } from 'react';
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import {
  createMapLibreGLDraw,
  type MapLibreGLDraw,
} from '@sakuzu/maplibre-gl-draw';

export function DrawMap() {
  const container = useRef<HTMLDivElement>(null);
  const drawRef = useRef<MapLibreGLDraw | null>(null);

  useEffect(() => {
    if (!container.current) return;
    const map = new maplibregl.Map({
      container: container.current,
      style: 'https://demotiles.maplibre.org/style.json',
    });
    const draw = createMapLibreGLDraw(map);
    drawRef.current = draw;

    const off = draw.on('draw.feature.create', ({ feature }) => {
      console.log(feature.id);
    });

    return () => {
      off();
      draw.destroy();
      map.remove();
      drawRef.current = null;
    };
  }, []);

  return (
    <>
      <button onClick={() => drawRef.current?.setMode('draw_polygon')}>
        Polygon
      </button>
      <div ref={container} style={{ height: 400 }} />
    </>
  );
}
```

In development, Strict Mode runs the effect twice. The cleanup destroys
the first pair, so this is safe.

## Svelte

The example uses the Svelte 5 syntax (`onclick`).

```svelte
<script lang="ts">
  import { onMount } from 'svelte';
  import * as maplibregl from 'maplibre-gl';
  import 'maplibre-gl/dist/maplibre-gl.css';
  import {
    createMapLibreGLDraw,
    type MapLibreGLDraw,
  } from '@sakuzu/maplibre-gl-draw';

  let container: HTMLDivElement;
  let draw: MapLibreGLDraw | undefined;

  onMount(() => {
    const map = new maplibregl.Map({
      container,
      style: 'https://demotiles.maplibre.org/style.json',
    });
    draw = createMapLibreGLDraw(map);

    return () => {
      draw?.destroy();
      map.remove();
      draw = undefined;
    };
  });
</script>

<button onclick={() => draw?.setMode('draw_polygon')}>Polygon</button>
<div bind:this={container} style="height: 400px"></div>
```

## Vue

```vue
<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import {
  createMapLibreGLDraw,
  type MapLibreGLDraw,
} from '@sakuzu/maplibre-gl-draw';

const container = ref<HTMLDivElement>();
let map: maplibregl.Map | undefined;
let draw: MapLibreGLDraw | undefined;

onMounted(() => {
  map = new maplibregl.Map({
    container: container.value as HTMLDivElement,
    style: 'https://demotiles.maplibre.org/style.json',
  });
  draw = createMapLibreGLDraw(map);
});

onBeforeUnmount(() => {
  draw?.destroy();
  map?.remove();
});
</script>

<template>
  <button @click="draw?.setMode('draw_polygon')">Polygon</button>
  <div ref="container" style="height: 400px"></div>
</template>
```

`map` and `draw` are plain variables. Putting them in `ref` or
`reactive` would wrap them in proxies, which they do not need; use
`shallowRef` if the template must react to them.

## Server-side rendering

A map and a draw instance need a browser: WebGL2, a DOM container and
pointer events. Create them only on the client, in the mount hooks
above, which do not run on the server.

Importing the package does not create anything, so a static import in a
component that is also rendered on the server is fine. To keep maplibre-gl
and this library out of the server bundle altogether, import them
dynamically inside the mount hook. In Svelte:

<!-- docs-check:
declare const container: HTMLElement;
declare const style: string;
-->

```ts
import { onDestroy, onMount } from 'svelte';
import type { Map } from 'maplibre-gl';
import type { MapLibreGLDraw } from '@sakuzu/maplibre-gl-draw';

let map: Map | undefined;
let draw: MapLibreGLDraw | undefined;
let destroyed = false;

onMount(async () => {
  const maplibregl = await import('maplibre-gl');
  const { createMapLibreGLDraw } = await import('@sakuzu/maplibre-gl-draw');
  if (destroyed) return; // unmounted while importing

  map = new maplibregl.Map({ container, style });
  draw = createMapLibreGLDraw(map);
});

onDestroy(() => {
  destroyed = true;
  draw?.destroy();
  map?.remove();
});
```

Type-only imports are erased, so they stay at the top. An async mount
hook cannot return a cleanup function, so the cleanup is a separate hook
that also covers an unmount before the imports finish. The same shape
works with `useEffect` (a flag set in the cleanup) and with `onMounted`
and `onBeforeUnmount`. The framework may also offer a switch for this,
such as a client-only component or turning off server rendering for a
route.

## Related example

- [examples/basic/](../../examples/basic/) creates the map and the
  draw instance and subscribes to events, which is what each component
  above does in its mount hook

## Reference

- [createMapLibreGLDraw](../api/maplibre-gl-draw/functions/createMapLibreGLDraw.md)
- [MapLibreGLDraw](../api/maplibre-gl-draw/interfaces/MapLibreGLDraw.md)
  for `destroy`, `on` and `off`
