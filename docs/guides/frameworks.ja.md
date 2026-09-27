# フレームワークで使う

このライブラリーには React、Svelte、Vue 向けのバインディングは
ありませんが、無くても問題なく使えます。コンポーネントがマウント
されたときに地図と draw のインスタンスを作り、アンマウントされる
ときに両方を破棄するだけです。この手引きでは、その書き方を
フレームワークごとに示し、サーバーサイドレンダリングから
ライブラリーを外す方法も説明します。

## 守ること

1. draw のインスタンスは、地図ができた後に、マウントのフックの
   中で作ります
2. インスタンスは、リアクティブな状態ではなく、ふつうの変数か
   ref に入れます
3. アンマウントするときは、`draw.destroy()` を呼んでから
   `map.remove()` を呼びます

`destroy()` は、インスタンスが追加したレイヤーとリスナーを
取り除き、プラグインの登録を取り消し、地図に対して変えた設定を
元に戻します。2 回目以降の呼び出しは何もせず、破棄した
インスタンスのメソッドを呼んでも例外にはなりません。`draw.on`
は購読を解除する関数を返すので、コンポーネントより長く生きる
インスタンスを購読するときは、その関数で後始末ができます。

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

開発時は、Strict Mode によってエフェクトが 2 回実行されます。
1 組目の地図とインスタンスは後始末で破棄されるので、問題は
ありません。

## Svelte

この例では Svelte 5 の書き方 (`onclick`) を使っています。

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

`map` と `draw` はふつうの変数にしています。`ref` や `reactive`
に入れると、必要のないプロキシで包まれてしまいます。テンプレート
をこれらの変化に反応させたいときは、`shallowRef` を使って
ください。

## サーバーサイドレンダリング

地図と draw のインスタンスには、ブラウザー (WebGL2、DOM の入れ物、
ポインターイベント) が必要です。そのため、クライアントでだけ
作ります。上の例のマウントのフックはサーバーでは実行されない
ので、そこで作れば十分です。

パッケージを import しただけでは何も作られないので、サーバーでも
レンダリングされるコンポーネントで静的に import してもかまい
ません。maplibre-gl とこのライブラリーをサーバーのバンドルから
完全に外したいときは、マウントのフックの中で動的に import します。
Svelte では次のようになります。

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

型だけの import はコンパイル時に消えるので、先頭に置いたままで
かまいません。非同期のマウントのフックは後始末の関数を返せない
ので、後始末は別のフックに書き、import が終わる前にアンマウント
された場合もそこで扱います。`useEffect` (後始末の中でフラグを
立てます) でも、`onMounted` と `onBeforeUnmount` でも、同じ形で
書けます。フレームワークによっては、クライアントだけで描画する
コンポーネントや、ルートごとにサーバーサイドレンダリングを
止める設定など、専用の手段が用意されていることもあります。

## 関連する例

- [examples/basic/](../../examples/basic/) では、地図と draw
  のインスタンスを作り、イベントを購読します。上の各コンポーネント
  がマウントのフックで行っていることと同じです

## リファレンス

- [createMapLibreGLDraw](../api/maplibre-gl-draw/functions/createMapLibreGLDraw.md)
- `destroy`、`on`、`off` については
  [MapLibreGLDraw](../api/maplibre-gl-draw/interfaces/MapLibreGLDraw.md)
