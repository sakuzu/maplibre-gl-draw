# 独自の地物の型

draw のインスタンスは、組み込みの型 (`Point`、`LineString`、
`Polygon`、Multi の型、`Circle`、`Freehand`、`Image`) のほかに、自分で
決めた型の地物を持てます。1 つの定義 `FeatureTypeDefinition` で、その
型の描き方と当たり方を決め、必要なら選び方、形の変え方、吸着のさせ方も
決めます。その周りには、自分の型の地物ではないもののための拡張が 3 種類
あります。1 つは地物の上に描く重ね描きです。残りは提供者で、どの型にも
吸着の候補、ハンドル、付き物を足します。

描画器は地図の WebGL の文脈を受け取りますが、たいていはライブラリーの
共有の描画器で描き、シェーダーを書きません。

## 最小のコード

決まった色の破線で描く線、`Route` 型です。

```ts
import type { Feature, FeatureTypeDefinition, Position } from '@sakuzu/maplibre-gl-draw';
import type { LineString } from 'geojson';

function verticesOf(feature: Feature): Position[] {
  return (feature.geometry as LineString).coordinates;
}

const route: FeatureTypeDefinition = {
  type: 'Route',
  geometry: 'LineString',
  renderer: {
    onAdd() {},
    draw(feature, ctx) {
      ctx.line.draw(verticesOf(feature), {
        width: 3,
        color: '#e64d1a',
        opacity: ctx.opacity,
        lineStyle: 'dashed',
      });
    },
    onRemove() {},
  },
};

const removeRoute = draw.extensions.featureTypes.add(route);

draw.features.create({
  type: 'Route',
  geometry: {
    type: 'LineString',
    coordinates: [
      [139.7, 35.68],
      [139.72, 35.69],
      [139.74, 35.68],
    ],
  },
});
```

経路は有効なレイヤーに入り、重なりの順のその位置に、オレンジの破線で
描かれます。クリックすると選べます。自分の `hitTest` を持たない型は、その図形の
とおりに当たるからです。`removeRoute()` を呼ぶと定義が外れます。その型の
地物は文書に残りますが、型をもう一度足すまで描かれず、当たりもしません。

## 独自の型の保存のされ方

独自の型の地物は、`type` が型の名前で、`geometry` が定義の決めた種類の
GeoJSON の図形であるふつうの地物です。ほかの地物と同じように作り、
変え、保存し、読み込めます。

- ライブラリーの形式は型をそのまま保ちます
- GeoJSON にはこの型に当たる種類が無いので、書き出しは図形をそのまま
  書き、型の名前をプロパティー `maplibre-gl-draw:featureType` に書き
  ます。そのファイルを読み込むと、図形の種類にかかわらず型が戻ります
  ([データ形式](../reference/data-format.md))
- 組み込みの型の名前は使われているので、
  `draw.extensions.featureTypes.add` はそれらに `already-exists` を
  投げます。組み込みの型の描き方を変えるには、その型を差し替えます
  ([組み込みの型の差し替え](#組み込みの型の差し替え))

モードが `commitFeature` でこの型の地物を作ると、自動の名前が付きます。
その語は型の名前です。ホストが `autoName.typeNames` の同じ鍵で語を
渡せば、そちらを使います。利用者に見せる型は、ホストが訳せるように、
型の名前を文書に書いておいてください
([自動の名前](drawing.ja.md#ほかの言語の名前))。

描画器は、地物ごとに自分の値を要することがよくあります。印の大きさ
などです。そうした値は、ライブラリーが決めていない鍵で `style` か
`properties` に置きます。値はそのまま保存、書き出し、読み込みされ、
ライブラリーは検査しません。描画器は、値を使う前に確かめてください。
`style` の鍵は、宣言のマージで TypeScript に伝えます。

```ts
declare module '@sakuzu/maplibre-gl-draw' {
  interface FeatureStyle {
    routeEnds?: 'none' | 'dot';
  }
}

const ends = feature.style.routeEnds === 'dot' ? 'dot' : 'none';
```

## 描画器

`FeatureRenderer` は 3 つのメソッドを持ちます。引数の順は MapLibre の
カスタムレイヤーと同じです。

- `onAdd(map, gl)` は、描画器が地図に載るときに呼ばれます。自分の GL の
  オブジェクトを持つ描画器は、ここで作ります
- `draw(feature, ctx)` は、その型の見えている地物ごとに 1 回、重なりの
  順のその地物の位置で呼ばれます。描いたものは、後ろの地物と前の地物の
  間に入ります
- `onRemove(map, gl)` は、`onAdd` で作ったものを解放します

`onAdd` と `onRemove` は 2 回以上来ることがあります。描画は壊されて
作り直されることがあるためです。地図がスタイルを変えたときや、WebGL の
文脈が失われて戻ったときです。`onRemove` の後にもう一度 `onAdd` を受けられるように
してください。

`RenderContext` は、描画器が描くのに要るものを持ちます。

- `line`、`fill`、`point` は、線、面、点の印の共有の描画器です。位置を
  度で、色を CSS の色で、大きさをピクセルで受け取り、投影と地形には
  自分で従います
- `opacity` は、地物のレイヤーの不透明度で、0 から 1 です。共有の描画器
  はこれを自分では掛けません。渡す不透明度に掛けてください。そうすると、
  地物がレイヤーと一緒に薄くなります
- `zoom` と `pixelRatio` です。`window.devicePixelRatio` ではなく
  `pixelRatio` を使ってください
- `terrain` は地面の高さです ([地形](#地形) を参照)
- `gl`、`shader`、`offset`、`projection` は、自分でシェーダーを書く
  描画器のためのものです ([自分のシェーダー](#自分のシェーダー) を参照)

面を塗り、縁を描く型です。

```ts
import type { FeatureRenderer } from '@sakuzu/maplibre-gl-draw';
import type { Polygon } from 'geojson';

const zoneRenderer: FeatureRenderer = {
  onAdd() {},
  draw(feature, ctx) {
    const rings = (feature.geometry as Polygon).coordinates;
    const color = feature.style.fillColor ?? '#2563eb';
    ctx.fill.draw(rings, { color, opacity: 0.2 * ctx.opacity });
    for (const ring of rings) {
      ctx.line.draw(
        ring,
        { width: 2, color, opacity: ctx.opacity, lineStyle: 'dotted' },
        { closed: true },
      );
    }
  },
  onRemove() {},
};

draw.extensions.featureTypes.add({
  type: 'Zone',
  geometry: 'Polygon',
  renderer: zoneRenderer,
});
```

線の描画器は、既定では幅をピクセルで受け取ります。
`widthUnit: 'meters'` にすると地上のメートルになります。`createdZoom`
を渡すと、そのズームでの幅を基準に、線がズームに合わせて太くなったり
細くなったりします。

表示が経度 ±180 度の子午線をまたぐと、描画は世界の写しをそれぞれ
見せ、`draw` は写しごとに 1 回呼ばれます。描くものを地図のカメラから
ではなく、地物と窓口から計算してください。そうすれば正しい写しに
描かれます。

## 当たり判定

`hitTest` が無いと、その型の地物は図形のとおりに当たります。線なら
ポインターの近く、面ならポインターの下です。`hitTest(feature, ctx)` は
それを置き換えます。画面の点、その地図の位置、ピクセルでのクリックの
許容量、位置を投影する `screen` を受け取り、`Hit` か `null` を返します。

<!-- docs-check:
declare function verticesOf(feature: Feature): Position[];
declare const routeRenderer: import('@sakuzu/maplibre-gl-draw').FeatureRenderer;
-->

```ts
import type { FeatureTypeDefinition, ScreenPoint } from '@sakuzu/maplibre-gl-draw';

/** 点から線分までの距離 (ピクセル) */
function segmentDistance(p: ScreenPoint, a: ScreenPoint, b: ScreenPoint) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = dx * dx + dy * dy;
  const dot = (p[0] - a[0]) * dx + (p[1] - a[1]) * dy;
  const t = len === 0 ? 0 : Math.max(0, Math.min(1, dot / len));
  return Math.hypot(a[0] + t * dx - p[0], a[1] + t * dy - p[1]);
}

const hitRoute: FeatureTypeDefinition = {
  type: 'Route',
  geometry: 'LineString',
  renderer: routeRenderer,
  hitTest(feature, ctx) {
    const points = verticesOf(feature).map((v) => ctx.screen.project(v));
    let best = Number.POSITIVE_INFINITY;
    for (let i = 1; i < points.length; i++) {
      const d = segmentDistance(ctx.point, points[i - 1], points[i]);
      best = Math.min(best, d);
    }
    if (best > ctx.tolerancePx) return null;
    const id = feature.id;
    return { kind: 'feature', id, featureId: id, distancePx: best };
  },
};
```

- 当たり判定の候補は、各地物の範囲を許容量だけ広げて集めます。点の
  周りに描く印のように、図形より遠くで当たる型は、その距離を
  `hitPaddingPx` に書きます。そうすると、`hitTest` に届く前にその型の
  地物が外されません
- 点の周りに決まった半径の円を描くように、地面の上の距離で図形より
  広く描く型は、その範囲を `bbox(feature)` から
  `[west, south, east, north]` (度) で返します。空間の索引は、図形の
  範囲の代わりにこれを使います。当たり判定と矩形の選択の候補、
  `features.list({ bbox })`、描くほど画面に近い地物の見極めに
  使われます
- 範囲は文書に従い、地物が変わるたびに測り直されます。範囲が文書の外の
  何かで決まるときは、それが変わったときにプラグインから
  `ctx.invalidate({ type: 'Route' })` を呼びます
- `boxSelect(feature, box, ctx)` は、選択の矩形が地物を取るかを、
  ピクセルの矩形で決めます。無ければ図形で決まります

## 選択とハンドル

定義のほかのメンバーは省けます。

| メンバー | 無いとき |
| --- | --- |
| `bounds` | 枠は図形の範囲に従います |
| `outline` | 枠は `bounds` の箱です |
| `handles` | その型に自分のハンドルはありません |
| `onHandleDrag` | ハンドルをドラッグしても何も変わりません |
| `snapCandidates` | 図形の頂点と辺が候補です |

`bounds` は、画面の上の枠を `{ min, max }` (ピクセル) で返します。
描くものが無い地物には `null` を返します。`Point` の図形を持つ型では、
点の周りの枠の大きさを決めます。

`outline` は、斜めに描く箱のように、形が回る型のためのものです。枠の
4 つの角を、画面の上のピクセルで返します。順は、回す前の形の左上、
右上、右下、左下です。枠は `bounds` の箱の代わりにこの角に沿って
描かれます。`Point` 以外の図形では、大きさを変えるハンドルと回す
ハンドルもこの角と辺に付きます。`Point` の型の枠には、それらの
ハンドルは付きません。`outline` が 4 つの角以外を返したときは、枠は
`bounds` から決まります。

`handles` は、選ばれている地物のハンドルを返します。それぞれ ID、位置、
カーソルを持ちます。ハンドルをドラッグすると、ポインターが動くたびに
`onHandleDrag` が呼ばれ、ドラッグの終わりにもう一度呼ばれます。返した
`FeaturePatch` は地物に当てられます。動いている間の差分は途中の更新
で、終わりの差分が残ります。

<!-- docs-check:
declare function verticesOf(feature: Feature): Position[];
declare const routeRenderer: import('@sakuzu/maplibre-gl-draw').FeatureRenderer;
-->

```ts
import type { FeatureTypeDefinition } from '@sakuzu/maplibre-gl-draw';

const reshapeRoute: FeatureTypeDefinition = {
  type: 'Route',
  geometry: 'LineString',
  renderer: routeRenderer,
  // 頂点ごとに、その頂点を動かすハンドルを置く
  handles(feature) {
    return verticesOf(feature).map((position, index) => ({
      id: String(index),
      position,
      kind: 'vertex',
      cursor: 'move',
    }));
  },
  onHandleDrag(feature, handle, event) {
    const coordinates = [...verticesOf(feature)];
    coordinates[Number(handle.id)] = event.lngLat;
    return { geometry: { type: 'LineString', coordinates } };
  },
};
```

ライブラリーは、選ばれている地物のハンドルを頂点のハンドルと同じ
見た目 (`selectionStyle` の `vertexHandle`) で描き、同じ大きさで当たり
判定をして、ドラッグを渡します。ほかのハンドルをドラッグしている間は
隠れます。描画が読み取り専用のとき、操作ロックの間、地物がロックされて
いる間は、表示もドラッグもしません。

`onHandleDragStart(feature, handle, event)` は、ハンドルのドラッグが
始まる前に問われます。`false` を返すとドラッグを拒み、ポインターは
ハンドルが無いときと同じ動きをします。
`onHandleDragEnd(feature, handle, event)` は、始まったドラッグの最後の
`onHandleDrag` の後に 1 回呼ばれます。地物はそのときの姿で届き、無く
なっていれば `null` です。ドラッグが途中で断たれたときも呼ばれます。
始まりに測った値のように、ドラッグの始めから終わりまで持つものに
使います。

`snapCandidates` は、その型の地物の近くでポインターが吸着する位置を
返します。図形の頂点と辺の代わりになります。

## 組み込みの型の差し替え

`draw.extensions.featureTypes.override(definition)` は、同じ名前の
組み込みの型の代わりに定義を置きます。差し替えられる型は `Point`、
`LineString`、`Polygon`、`Circle`、`Freehand`、`Image` です。定義は、
組み込みの型が持つ `geometry` を持ちます。円と画像は `Point`、
手書きの線は `LineString` です。その型の地物は、以後その描画器で
描かれます。定義の `hitTest`、`boxSelect`、`bounds`、`outline`、
`bbox`、`snapCandidates` は、あれば組み込みの型のものに代わります。
定義が省いたメンバーは、組み込みの型のものが残ります。`handles` は、
組み込みの型のハンドルと一緒に出ます。

<!-- docs-check:
declare const draw: import('@sakuzu/maplibre-gl-draw').Draw;
declare const pointRenderer: import('@sakuzu/maplibre-gl-draw').FeatureRenderer;
-->

```ts
const restore = draw.extensions.featureTypes.override({
  type: 'Point',
  geometry: 'Point',
  renderer: pointRenderer,
});

// 組み込みの点に戻ります
restore();
```

返る関数、`remove('Point')`、差し替えたプラグインの取り外しの
どれでも、組み込みの型が戻ります。`add` は組み込みの型の名前を
これまでどおり拒みます。差し替えている型は、戻すまで重ねて差し替え
られません。

## 地形

地形があるとき、共有の描画器は描くものを自分で地面に載せます。自分の
印のためには、`ctx.terrain` が高さを渡します。

- `elevation(lngLat)` は地面の高さ (メートル) で、地形が無ければ 0 です。
  点の描画器に `elevationMeters` として渡すと、印が地面に載ります
- `project(lngLat)` は、地面まで持ち上げた位置の画面の点です。地形が
  無ければ `null` です
- `ghostOpacity(lngLat)` は、地形がカメラからその位置を隠すところで
  低くなります。印の不透明度に掛けてください
- `generation()` は、高さが変わったかもしれないときに変わります。高さを
  覚えておく描画器は、これで読み直す時を知ります

描画の外では、プラグインが窓口の `ctx.terrain` で同じ地形を読みます。
[地形](terrain.ja.md) を参照してください。

## 重ね描き

重ね描きは、1 つの地物ではないものを描きます。選択の上の印、格子、
自分のプレビューなどです。描画器と同じ `onAdd`、`draw`、`onRemove` を
同じ決まりで持ち、ほかに `name` を持ちます。
`draw.extensions.overlays.add` で足し、返る関数で外します。

選ばれている経路のハンドルに印を付ける重ね描きです。

<!-- docs-check:
declare function verticesOf(feature: Feature): Position[];
-->

```ts
import type { OverlayRenderer } from '@sakuzu/maplibre-gl-draw';

const routeHandleMarks: OverlayRenderer = {
  name: 'route-handles',
  onAdd() {},
  draw(ctx) {
    for (const feature of draw.selection.features()) {
      if (feature.type !== 'Route') continue;
      for (const position of verticesOf(feature)) {
        ctx.point.draw(position, {
          shape: 'circle',
          size: 8,
          fillColor: '#ffffff',
          fillOpacity: 1,
          strokeColor: '#e64d1a',
          strokeWidth: 2,
          strokeOpacity: 1,
        });
      }
    }
  },
  onRemove() {},
};

draw.extensions.overlays.add(routeHandleMarks);
```

- `draw(ctx)` は、地物と選択の上に描きます
- `drawForLayer(layerId, ctx)` は、1 つのレイヤーのすぐ上に描きます。
  レイヤーの間に入るもののためです
- `drawVertices(ctx)` は、すべてのレイヤーの地物と選択の上に描きます。
  前のレイヤーに隠れずに見えている必要のある頂点のためです
- `order` は重ね描きどうしの順です。小さいものが先に、大きいものの下に
  描かれます。同じ順の重ね描きは、足した順に描かれます

Worker で作るデータのように、何回かの描画をかけて何かを用意する重ね
描きは、`hasPendingWork()` を実装し、用意が終わるまで true を返します。
`draw.hasPendingWork()` はすべての重ね描きに尋ねるので、完全な絵を待つ
ホストはこの重ね描きも待ちます ([性能](performance.ja.md))。

## 提供者

提供者は、自分のものではない型の地物に、吸着の候補、ハンドル、付き物を
足します。組み込みの型にも足せます。どれも `name` を持ち、
`draw.extensions` のそれぞれのコレクションに足します。

### 吸着の候補

`SnapProvider` は、ポインターの近くの候補を返します。0.001 度の格子に
吸着させる提供者です。

```ts
import type { SnapProvider } from '@sakuzu/maplibre-gl-draw';

const grid: SnapProvider = {
  name: 'grid',
  candidates(ctx) {
    const step = 0.001;
    const [lng, lat] = ctx.lngLat;
    return [
      {
        position: [Math.round(lng / step) * step, Math.round(lat / step) * step],
        kind: 'guide',
        source: 'grid',
      },
    ];
  },
};

draw.extensions.snapProviders.add(grid);
```

窓口は、画面と地図の上のポインター、ピクセルでの許容量、`screen`、
`excludeIds` を渡します。`excludeIds` は、描いている途中の地物のように
吸着させてはいけない地物です。`priority` は、同じ距離の候補の間の
順を決めます。大きい方が勝ちます。自分で決めた `kind` は頂点として
順位を決め、吸着の結果 (`target.kind`) にそのまま届きます。

### ハンドル

`HandleProvider` は、選ばれている地物に自分のハンドルを出します。
`handles(feature, screen)` がハンドルを返し、
`onDrag(feature, handle, event)` がドラッグで変わる差分を返します。
定義の `onHandleDrag` と同じです。`globalHandles(screen)` は、どの
地物にも属さず、何を選んでいても出るハンドルを返します。そのドラッグ
では `feature` が `null` で届き、変わるものは提供者が自分で書き込み
ます。`onDragStart` と `onDragEnd` は、定義の `onHandleDragStart` と
`onHandleDragEnd` と同じように、ドラッグの前後で呼ばれます。
`onDragStart` は `false` を返してドラッグを拒めます。定義と同じく、
ハンドルはライブラリーが頂点のハンドルと同じ見た目で描きます。

### 付き物

`CompanionProvider` は、地物の 1 段下に何かを描き、重なりの順の同じ
位置でクリックを受けます。`highlight` の印が付いた点の下に光の輪を
描く例です。

```ts
import type { CompanionProvider } from '@sakuzu/maplibre-gl-draw';
import type { Point } from 'geojson';

const halo: CompanionProvider = {
  name: 'halo',
  has: (feature) =>
    feature.type === 'Point' && feature.properties.highlight === true,
  draw(feature, ctx) {
    ctx.point.draw((feature.geometry as Point).coordinates, {
      shape: 'circle',
      size: 28,
      fillColor: '#facc15',
      fillOpacity: 0.4 * ctx.opacity,
      strokeColor: '#facc15',
      strokeWidth: 0,
      strokeOpacity: 0,
    });
  },
  hitTest(feature, ctx) {
    const [x, y] = ctx.screen.project((feature.geometry as Point).coordinates);
    const distancePx = Math.hypot(ctx.point[0] - x, ctx.point[1] - y);
    return distancePx <= 14
      ? { kind: 'companion', id: feature.id, featureId: feature.id, distancePx }
      : null;
  },
  onClick(feature) {
    console.log('the halo of', feature.id);
    return true;
  },
};

draw.extensions.companionProviders.add(halo);
```

- `has(feature)` は、描画と当たり判定のたびにすべての地物について
  尋ねられます。地物そのものか、自分で持つ索引から、すぐに答えて
  ください
- `draw` は、地物そのものの直前に呼ばれます
- `hitTest` は、ポインターが地物そのものに当たらなかったときに、その
  後ろの地物より先に尋ねられます。当たると `onClick` が呼ばれます。
  true を返すとクリックはそこで消費され、選択はそのままです。それ
  以外では、選択モードがそのクリックを地物へのクリックとして扱います

## 自分のシェーダー

共有の描画器は、線、面、点の印を描きます。それ以外のものは、描画器が
`ctx.gl` で自分のシェーダーをコンパイルして描きます。位置は、
`ctx.shader` (地図の投影の関数)、`ctx.offset` (精度を落とさずにカメラの
近くを描くための表示の中心)、`ctx.projection` で決めます。

入口 `@sakuzu/maplibre-gl-draw/webgl` には、ライブラリーのシェーダーの
土台になっている部品があります。投影の GLSL とその uniform のための
`ProjectionUniformManager`、`createProgram`、`QuadShader`、共有の描画器
が破線と地形に使う規則です ([webgl の入口](../api/webgl/index.md))。
主の入口と違い、マイナーリリースで変わることがあります
([版](../reference/README.md))。

地形の上に描く部品は、描画の呼び出しの描画の文脈か、その `terrain` を
受け取ります。描く前に `ProjectionUniformManager` や `QuadShader` の
`setTerrain(ctx)` を呼び、`terrainTessellationStep(ctx)` と
`drawQuadSurfaceOnTerrain(ctx, ...)` にも渡します。描画の文脈はその
呼び出しの間だけ有効なので、呼び出しごとにそのときのものを渡して
ください。`null` や、ライブラリーが渡したものでないオブジェクトを
渡すと、地形なしで描きます。

```ts
import type { RenderContext } from '@sakuzu/maplibre-gl-draw';
import {
  densifyPath,
  type ProjectionUniformManager,
  terrainTessellationStep,
} from '@sakuzu/maplibre-gl-draw/webgl';

function pathOnTerrain(
  ctx: RenderContext,
  program: WebGLProgram,
  uniforms: ProjectionUniformManager,
  coordinates: [number, number][],
): [number, number][] {
  ctx.gl.useProgram(program);
  uniforms.setTerrain(ctx);
  uniforms.setUniforms(ctx.projection, ctx.zoom, ctx.offset);
  const step = terrainTessellationStep(ctx);
  // path を送って描く
  return step ? densifyPath(coordinates, step) : coordinates;
}
```

## 関連する例

- [examples/custom-feature-type/](../../examples/custom-feature-type/)
  では、共有の線の描画器で描き、当たり判定、矩形選択、枠、ハンドルを
  持つ型を足します

## リファレンス

- [FeatureTypeDefinition](../api/maplibre-gl-draw/interfaces/FeatureTypeDefinition.md)
  と [Handle](../api/maplibre-gl-draw/interfaces/Handle.md)
- [FeatureRenderer](../api/maplibre-gl-draw/interfaces/FeatureRenderer.md)
  と [RenderContext](../api/maplibre-gl-draw/interfaces/RenderContext.md)
- [LineRenderer](../api/maplibre-gl-draw/interfaces/LineRenderer.md)、
  [FillRenderer](../api/maplibre-gl-draw/interfaces/FillRenderer.md)、
  [PointRenderer](../api/maplibre-gl-draw/interfaces/PointRenderer.md)
- [HitTestContext](../api/maplibre-gl-draw/interfaces/HitTestContext.md)
  と [Hit](../api/maplibre-gl-draw/interfaces/Hit.md)
- [OverlayRenderer](../api/maplibre-gl-draw/interfaces/OverlayRenderer.md)
- [SnapProvider](../api/maplibre-gl-draw/interfaces/SnapProvider.md)、
  [HandleProvider](../api/maplibre-gl-draw/interfaces/HandleProvider.md)、
  [CompanionProvider](../api/maplibre-gl-draw/interfaces/CompanionProvider.md)
- [TerrainAnchors](../api/maplibre-gl-draw/interfaces/TerrainAnchors.md)
