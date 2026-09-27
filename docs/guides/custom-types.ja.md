# 独自の地物の型

draw のインスタンスには、組み込みの型 (`Point`、`LineString`、
`Polygon`、Multi 型、`Circle`、`Freehand`、`Image`) のほかに、
自分で定義した型の地物も入れられます。その型の描き方と当たり
判定、必要なら選択、拡縮、吸着の扱いを、
`registerFeatureHandler` を 1 回呼んでインスタンスに伝えます。
このほかに、地物ではないもののための拡張点が 3 つあります。
補助ハンドル、随伴、オーバーレイの描画器です。

これらの拡張点では、地図の WebGL の文脈を直接扱います。この
手引きは、WebGL2 と maplibre-gl のカスタムレイヤーを知って
いることを前提にしています。

## 最小のコード

`Route` 型の例です。決まった色の破線で描く線で、クリックの許容
範囲の中なら当たります。

```ts
import {
  createMapLibreGLDraw,
  type CustomFeatureHandler,
  type CustomFeatureRenderer,
  type Feature,
  type HitTestStrategy,
} from '@sakuzu/maplibre-gl-draw';

type Position = [number, number];

const routeRenderer: CustomFeatureRenderer = {
  name: 'route',
  onAdd() {},
  draw(feature, projectionData, zoom, context) {
    context.sdfLineRenderer.draw(
      feature.coordinates as Position[],
      // context.opacity is the opacity of the feature's layer
      {
        width: 3,
        color: [0.9, 0.3, 0.1, 1],
        opacity: context.opacity,
        lineStyle: 'dashed',
      },
      { widthUnit: 'pixels', closed: false },
      zoom,
      projectionData,
    );
  },
  onRemove() {},
};

/** Distance to a segment, in degrees of longitude at the latitude of p */
function segmentDistance(p: Position, a: Position, b: Position): number {
  const k = 1 / Math.cos((p[1] * Math.PI) / 180);
  const ax = a[0] - p[0];
  const ay = (a[1] - p[1]) * k;
  const bx = b[0] - p[0];
  const by = (b[1] - p[1]) * k;
  const dx = bx - ax;
  const dy = by - ay;
  const len = dx * dx + dy * dy;
  const raw = len === 0 ? 0 : -(ax * dx + ay * dy) / len;
  const t = Math.max(0, Math.min(1, raw));
  return Math.hypot(ax + t * dx, ay + t * dy);
}

function routeDistance(feature: Feature, p: Position): number {
  const c = feature.coordinates as Position[];
  let best = Number.POSITIVE_INFINITY;
  for (let i = 1; i < c.length; i++) {
    best = Math.min(best, segmentDistance(p, c[i - 1], c[i]));
  }
  return best;
}

const routeHitTest: HitTestStrategy = {
  geometryType: 'Route',
  distance: routeDistance,
  test: (feature, coordinate, toleranceLngLat) =>
    routeDistance(feature, coordinate) <= toleranceLngLat,
};

const routeHandler: CustomFeatureHandler = {
  type: 'Route',
  renderer: routeRenderer,
  hitTest: routeHitTest,
};

const draw = createMapLibreGLDraw(map);
const unregister = draw.registerFeatureHandler(routeHandler);

draw.addFeature({
  type: 'Route',
  coordinates: [
    [139.70, 35.68],
    [139.72, 35.69],
    [139.74, 35.68],
  ],
});
```

経路は、アクティブなレイヤーの中で、レイヤーの順序どおりの位置
にオレンジの破線で表示され、クリックすると選択されます。
ハンドラーが `getSelectionBoundingBox` を持たないので、選択の枠
は描かれません。`unregister()` を呼ぶと、ハンドラーが登録した
ものがすべて取り消されます。

## 独自の型の保存のされ方

独自の型の地物は、`type` が自分の型名になっている、ふつうの
Store の地物です。`coordinates` は 1 つの位置か、位置の列です。
保存、読み込み、書き出しは、ほかの地物と同じようにできます。
GeoJSON では、座標の形に応じて `Point` か `LineString` として
書き出し、型名を `maplibre-gl-draw:featureType` プロパティーに
入れます。そのため、読み込むと元の型に戻ります
([データ形式](../reference/data-format.md) を参照してください)。

その型の地物を作るモードは、文脈の
`autoNameGenerator.generateName(type)` で名前を付けます。語は型名です。
ただし、ホストが `autoName.typeNames` の同じキーで語を渡したときは
その語になります。利用者に見せる型では、ホストが翻訳できるように、
型名を文書に書いてください
([自動の名前](drawing.ja.md#ほかの言語の名前))。

描画器は、アイコンやラベルを置く側のように、地物ごとに自分の値を
必要とすることがよくあります。そうした値は、core が定めていないキーで
`properties` か `style` に入れます。こうしたキーは、変えずに保存、
書き出し、読み込みされ、core は検査しません。そのため、描画器が値を
使う前に確かめます。style のキーは、TypeScript では宣言のマージで
宣言します。

```ts
declare module '@sakuzu/maplibre-gl-draw' {
  interface FeatureStyle {
    routeArrow?: 'none' | 'end' | 'both';
  }
}

const arrow = feature.style?.routeArrow;
const drawArrow = arrow === 'end' || arrow === 'both';
```

## 描画器

`draw(feature, projectionData, zoom, context)` は、その型の
表示中の地物ごとに、レイヤーの順序の中でその地物がある位置で
1 回ずつ呼ばれます。ライブラリーは呼び出しの前後で自分のバッチ
を描き出すので、描いたものは後ろの地物と前の地物の間に収まり
ます。

`context` には、描画器がそのフレームで必要とするものが入って
います。

- `shaderData`、`centerLngLat`、`mainMatrixArray` は、自前の
  シェーダーで投影するときに使います。高いズームでも精度を保つ
  ため、位置は表示の中心からの相対座標で描きます。
  `calculateOffsetUniforms` で、文脈からその uniform を計算
  できます。後で挙げる共有の描画器はそのフレーム用の準備が済んで
  いるので、それで描く描画器ではこれらは要りません
- `pixelRatio` は、CSS ピクセルから物理ピクセルへの比です。
  `window.devicePixelRatio` ではなく、こちらを使ってください
- `terrain` は、このフレームの地形の状態です (後述)
- `opacity` は、地物が属するレイヤーの不透明度 (0〜1) です。
  ライブラリーは、レイヤーに描くものにこの値を掛けます。地物が
  レイヤーと一緒に薄くなるように、例のとおり自分のアルファにも
  掛けてください。共有の描画器は、この値を自動では掛けません。
  オーバーレイの描画器では 1 です
- `sdfLineRenderer`、`fillShaderManager`、`pointShapeRenderer`
  は、インスタンスが共有する描画器です。例では線の描画器で描く
  ので、自前の GL オブジェクトは作っていません

`onAdd(gl, map)` と `onRemove()` は、何度も届くことがあります。
レイヤーが外されて追加し直されたとき (`setStyle` の後) と、
WebGL の文脈が失われて復元されたときに、描画の仕組みを破棄して
作り直すからです。GL オブジェクトは `onAdd` で (または `draw`
の中で必要になったときに) 作り、`onRemove` で解放し、その後に
また `onAdd` が来ても対応できるようにしてください。

表示範囲が日付変更線をまたぐときは、1 つのフレームで世界の写し
をそれぞれ描きます。`draw` は写しごとに、その写しの投影で呼ばれ
ます。地図のカメラではなく引数からすべてを計算すれば、正しい
写しの上に描けます。

## 当たり判定

`hitTest` は、クリックが地物に当たったかどうかを決めます。
`test` と `distance` では、距離をクリックした地点の緯度における
経度の度で表します。`toleranceLngLat` は、クリックの許容範囲
(既定は 6 CSS ピクセル) をこの単位に換算したものです。緯度の差
と比べるときは、例のように、緯度の差を緯度の cos で割ってくだ
さい。`testDistance` は省略可能で、判定と距離の計算を 1 回で
行い、距離か `null` を返します。

当たり判定では、まず空間索引で候補を絞ります。このとき、各地物
の外接矩形を許容範囲の分だけ広げて使います。アイコンのように、
形から離れた所でも当たる型では、`test` の前に候補から外れない
ように `candidateReachPx` (数か関数) を指定してください。

索引は Store の変化に追随します。作成、更新、削除のたびに、
その地物の範囲を `getBoundingBox` (既定は座標の範囲) で測り
直します。後から読み込まれるフォントのように、範囲が Store の
外のものに左右されるときは、それが変わったときにプラグインから
`ctx.invalidateFeatures(type)` を呼んでください。

`boxSelection` は、地物が選択の矩形の中にあるかどうかを決め
ます。既定では座標で判定します。

## 選択、拡縮、吸着

ハンドラーのそのほかのメンバーは省略できます。

| メンバー | 省略したとき |
| --- | --- |
| `getSelectionBoundingBox` | 選択の UI を描かない |
| `getPointFrameExtent` | 面積 0 の地物に 12 px の枠 |
| `getAdditionalResizeHandles` | 四隅のハンドルだけ |
| `computeCustomResize` | 標準の拡縮 |
| `resizeStrategy` | `scale` プロパティーで決まる |
| `getSnapTargets` | 地物の頂点と辺 |

`getSelectionBoundingBox` は向きのある箱を返し、回転の情報も
含められます。`getPointFrameExtent` は、面積 0 の地物の枠の
大きさ (CSS ピクセルでの幅の半分と高さの半分) を決めます。
そうした地物は点の見た目のままで、拡縮と回転のハンドルを
持ちません。`getSnapTargets` は、標準の候補の代わりに、点と線分
の候補を返します。

## 地形

地形が有効なとき、描画器はライブラリーを通して地面の上に物を
置きます。ライブラリーの内部を直接触ることはありません。`draw`
の中では、自分の `ProjectionUniformManager` か `QuadShader` の
`setTerrain` に `context.terrain` を渡し、地形の関数
(`anchorElevationMeters`、`anchorGhostOpacity`、
`drawQuadSurfaceOnTerrain` など) の最初の引数にも渡します。
この値はその呼び出しの間だけ有効です。描画の外では、プラグイン
から `ctx.projectAnchor`、`ctx.anchorElevationMeters`、
`ctx.getAnchorElevationGeneration` を使います。どれも、その
プラグインのインスタンスの地形を読みます。詳しくは
[地形](terrain.ja.md) を参照してください。

## 補助ハンドル

補助ハンドルは、頂点でも拡縮のハンドルでもない、自前の
ハンドルです。たとえば、曲線の制御点や吹き出しの尻尾です。

<!-- docs-check:
type Position = [number, number];
-->

```ts
draw.registerAuxiliaryHandleProvider({
  id: 'route-midpoint',
  getHandles(feature) {
    if (feature.type !== 'Route') return [];
    const c = feature.coordinates as Position[];
    return [{ id: 'mid', position: c[Math.floor(c.length / 2)] }];
  },
  onHandleDragStart(hit) {
    return hit.handleId === 'mid'; // true takes over the drag
  },
  onHandleDragMove(event) {
    // Move your preview to event.lngLat
  },
  onHandleDragEnd(event) {
    // Commit with draw.updateFeature
  },
});
```

ライブラリーが行うのは、ハンドルの当たり判定とドラッグの受け
渡しだけです。ハンドルを描くのも (たとえばオーバーレイの描画器
で)、結果を書き込むのも自分で行います。

- `getHandles` は、地物が 1 つだけ選択されている間、当たり判定
  のたびに呼ばれるので、軽い処理にしてください。
  `getGlobalHandles` を使うと、選択に関係なく出るハンドルを
  足せます
- ハンドルの判定は、回転と拡縮のハンドルの直後、頂点と中点
  の前に行います
- `onHandleDragStart` が true を返すと、地図のパンが止まり、
  移動と終了が自分のほうに届きます。`onHandleDragEnd` は、
  モードの切り替えや外からの変更でドラッグが中断された
  ときも含めて、必ずちょうど 1 回届きます
- Store が読み取り専用の間、操作ロック中、地物がロックされて
  いる間は、何も受け渡しません
- ドラッグの間、ライブラリーは何も書き込まず、ドラッグのフック
  も実行しません

## 随伴

随伴は、地物と一緒にその 1 つ下に描かれ、重なりの順序の同じ
位置でクリックできるものです。たとえば、引き出し線、影、バッジ
です。`registerFeatureCompanionProvider` で
`FeatureCompanionProvider` を登録します。

- `has(feature)` は、毎フレーム、毎クリックで、すべての地物に
  ついて呼ばれます。自分で持つ索引を使って、定数時間で答えて
  ください
- `draw` は、地物そのものの直前に呼ばれます。`context.opacity`
  に地物のレイヤーの不透明度が入るので、アルファに掛けてくだ
  さい
- `hitTest` は、クリックが地物そのものに当たらなかったときに、
  その後ろの地物より先に呼ばれます。当たるとクリックを消費し、
  選択はそのままにして、`onCompanionClick` を呼びます
- 随伴を持つ地物は、保持型のバッチの外で描かれます。そうした
  地物は少なめにしてください

## オーバーレイの描画器

`addOverlayRenderer` を使うと、地物に結び付かない WebGL の描画
を足せます。描く位置は、地物の後ろ (`order: 'background'`)、
地物の前 (`'foreground'`)、選択 UI の前 (`'overlay'`) のどれか
です。描画器は地物の描画器と同じ `onAdd`、`draw`、`onRemove` を
持ち、文脈の喪失と日付変更線についての決まりも同じです。返って
きた関数を呼ぶと取り除けます。

何フレームかかけて何かを用意する描画器 (Worker で作る資源など) は、
`hasPendingWork()` を実装し、用意が終わるまで true を返してください。
終えるための再描画は、描画器が自分で求めます。`draw.hasPendingWork()`
はすべてのオーバーレイの描画器に尋ねるので、完全な絵を待つホスト
([性能](performance.ja.md#絵を取り出すための完全なフレーム) を参照)
は、この描画器の仕事も待ちます。描画の設定で `timeSlicing: false`
のときは、ふだん何フレームかに分ける仕事を、そのフレームの中で
終えてください。

## 部品

ライブラリーが自分の描画に使っている部品は、組み立て用の部品と
して公開しています。共有の描画器、`ProjectionUniformManager`、
`QuadShader`、地形のアンカー、向きのある箱、投影の計算です。
これらは公開面の 2 層目にあたり、マイナーリリースで変わること
があります。その違いは
[リファレンスの概要](../reference/README.md) で説明しています。
組み込みの型と同じように描く型ではこれらを使い、それ以外は自分
のコードで書いてください。

## 関連する例

- [examples/custom-feature-type/](../../examples/custom-feature-type/)
  では、共有の線の描画器を使った描画器、当たり判定、矩形選択の
  戦略を持つ型を登録します

## リファレンス

- [CustomFeatureHandler](../api/maplibre-gl-draw/interfaces/CustomFeatureHandler.md)
- [CustomFeatureRenderer](../api/maplibre-gl-draw/interfaces/CustomFeatureRenderer.md)
  と [CustomRendererDrawContext](../api/maplibre-gl-draw/interfaces/CustomRendererDrawContext.md)
- [HitTestStrategy](../api/maplibre-gl-draw/interfaces/HitTestStrategy.md)
  と [BoxSelectionStrategy](../api/maplibre-gl-draw/interfaces/BoxSelectionStrategy.md)
- [AuxiliaryHandleProvider](../api/maplibre-gl-draw/interfaces/AuxiliaryHandleProvider.md)
- [FeatureCompanionProvider](../api/maplibre-gl-draw/interfaces/FeatureCompanionProvider.md)
- [CustomOverlayRenderer](../api/maplibre-gl-draw/interfaces/CustomOverlayRenderer.md)
- [SDFLineRenderer](../api/maplibre-gl-draw/interfaces/SDFLineRenderer.md)
