# フレームワークで使う

このライブラリーには React、Svelte、Vue 向けのバインディングは
ありませんが、無くても問題なく使えます。コンポーネントがマウント
されたときに地図と draw のインスタンスを作り、アンマウントされる
ときに両方を破棄するだけです。この手引きでは、その書き方を
フレームワークごとに示します。描いたものをコンポーネントの状態に
表す方法、サーバーサイドレンダリングからライブラリーを外す方法も
説明します。

標準の UI (`@sakuzu/maplibre-gl-draw-ui`) も同じ書き方で使えます。
draw のインスタンスの後に作り、インスタンスより先に破棄します。
UI を含めた書き方は、React、Vue、バンドラーを使わないページの
それぞれについて、標準の UI の [README](../../ui/README.md#install)
(英語) に載っています。

## 守ること

1. draw のインスタンスは、地図ができた後に、マウントのフックの
   中で作ります
2. インスタンスは、リアクティブな状態ではなく、ふつうの変数か
   ref に入れます
3. アンマウントするときは、`draw.destroy()` を呼んでから
   `map.remove()` を呼びます

`destroy()` は、インスタンスが追加したレイヤーとリスナーを
取り除き、プラグインとほかの拡張を外し、地図に対して変えた設定を
元に戻します。2 回目以降の呼び出しは何もしません。ほかのメソッドを
その後に呼ぶと、コード `invalid-state` の `DrawError` が投げられる
ので、遅れて届いたコールバックは片付いた地図に触れる前に分かります。
`draw.on` は購読を解除する関数を返すので、コンポーネントより長く生きる
インスタンスを購読するときは、その関数で後始末ができます。

## React

```tsx
import { useEffect, useRef } from 'react';
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { createDraw, type Draw } from '@sakuzu/maplibre-gl-draw';

export function DrawMap() {
  const container = useRef<HTMLDivElement>(null);
  const drawRef = useRef<Draw | null>(null);

  useEffect(() => {
    if (!container.current) return;
    const map = new maplibregl.Map({
      container: container.current,
      style: 'https://demotiles.maplibre.org/style.json',
    });
    const draw = createDraw(map);
    drawRef.current = draw;

    const off = draw.on('feature.created', ({ feature }) => {
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

標準の UI を使うときは、エフェクトの中で `createDraw(map)` の後に
`createDrawUI(draw)` を呼び、後始末では `draw.destroy()` の前に
`ui.destroy()` を呼びます
([From React](../../ui/README.md#from-react)、英語)。

## Svelte

この例では Svelte 5 の書き方 (`onclick`) を使っています。

```svelte
<script lang="ts">
  import { onMount } from 'svelte';
  import * as maplibregl from 'maplibre-gl';
  import 'maplibre-gl/dist/maplibre-gl.css';
  import { createDraw, type Draw } from '@sakuzu/maplibre-gl-draw';

  let container: HTMLDivElement;
  let draw: Draw | undefined;

  onMount(() => {
    const map = new maplibregl.Map({
      container,
      style: 'https://demotiles.maplibre.org/style.json',
    });
    draw = createDraw(map);

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

標準の UI を使うときは、`onMount` の中で `createDraw(map)` の後に
`createDrawUI(draw)` を呼び、`onMount` が返す関数では
`draw.destroy()` の前に `ui.destroy()` を呼びます。

## Vue

```vue
<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { createDraw, type Draw } from '@sakuzu/maplibre-gl-draw';

const container = ref<HTMLDivElement>();
let map: maplibregl.Map | undefined;
let draw: Draw | undefined;

onMounted(() => {
  map = new maplibregl.Map({
    container: container.value as HTMLDivElement,
    style: 'https://demotiles.maplibre.org/style.json',
  });
  draw = createDraw(map);
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

標準の UI を使うときは、`onMounted` の中で `createDraw(map)` の後に
`createDrawUI(draw)` を呼び、`onBeforeUnmount` では `draw.destroy()`
の前に `ui.destroy()` を呼びます
([From Vue](../../ui/README.md#from-vue)、英語)。

## 描いたものを状態に表す

地物の数や選んでいるものなど、描いたものの何かを表示する
コンポーネントは、イベントからそれを自分の状態に写します。状態には
インスタンスや地物ではなく、数や ID の一覧のようなふつうの値を
入れます。

```ts
let featureCount = 0;
let selectedIds: readonly string[] = [];

const stops = [
  draw.on('document.changed', () => {
    featureCount = draw.features.count();
  }),
  draw.on('selection.changed', ({ selection }) => {
    selectedIds = selection.ids;
  }),
];

// コンポーネントの後始末で
for (const stop of stops) stop();
```

`document.changed` は取引ごとに 1 回届くので、数千の地物を持つ
ファイルを読み込んでも、状態の更新は 1 回で済みます。React では
代入が `useState` の setter の呼び出しに、Svelte では `$state` の
変数への代入に、Vue では `ref` への代入になります。

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
import type { Draw } from '@sakuzu/maplibre-gl-draw';

let map: Map | undefined;
let draw: Draw | undefined;
let destroyed = false;

onMount(async () => {
  const maplibregl = await import('maplibre-gl');
  const { createDraw } = await import('@sakuzu/maplibre-gl-draw');
  if (destroyed) return; // unmounted while importing

  map = new maplibregl.Map({ container, style });
  draw = createDraw(map);
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

- [Get started](../examples/get-started.ja.md) では、地図、draw の
  インスタンス、標準の UI を作り、イベントを購読します。上の各コンポーネント
  がマウントのフックで行っていることと同じです

## リファレンス

- [createDraw](../api/maplibre-gl-draw/functions/createDraw.md)
- `destroy`、`on`、`off` については
  [Draw](../api/maplibre-gl-draw/interfaces/Draw.md)
- イベントとその中身については
  [DrawEvents](../api/maplibre-gl-draw/interfaces/DrawEvents.md)
