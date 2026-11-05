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
- `screen` は、描いている画面での位置と画面の点の変換 (`project`、
  `unproject`、`metersPerPixel`) と、そのズーム `zoom` とピクセル比
  `pixelRatio` です。プラグインの `ctx.screen` と同じもので、描き
  終えると最後に描いた画面について答えます。`window.devicePixelRatio`
  ではなく `screen.pixelRatio` を使い、ほかから持ち込んだ画面ではなく、
  この欄の画面を読んでください
- `appliedStyle(feature)` は、地物を描く見た目で、
  `draw.features.getAppliedStyle` の答えと同じです
  ([型の見た目](#型の見た目) を参照)
- `terrain` は地面の高さです ([地形](#地形) を参照)
- `gl` は WebGL の文脈で、自分でシェーダーを書く描画器のためのもの
  です。そうした描画器は、描いている画面の GPU の値を `/webgl` で読みます
  ([自分のシェーダー](#自分のシェーダー) を参照)

面を塗り、縁を描く型です。

```ts
import type { FeatureRenderer } from '@sakuzu/maplibre-gl-draw';
import type { Polygon } from 'geojson';

const zoneRenderer: FeatureRenderer = {
  onAdd() {},
  draw(feature, ctx) {
    const rings = (feature.geometry as Polygon).coordinates;
    const look = ctx.appliedStyle(feature);
    // The zoom the feature was drawn at, from which its width follows the map
    const referenceZoom = feature.properties['maplibre-gl-draw:createdZoom'];
    ctx.fill.draw(rings, {
      color: look.fillColor,
      opacity: look.fillOpacity * ctx.opacity,
    });
    for (const ring of rings) {
      ctx.line.draw(
        ring,
        {
          width: look.strokeWidth,
          color: look.strokeColor,
          opacity: look.strokeOpacity * ctx.opacity,
          lineStyle: look.lineStyle,
        },
        { closed: true, referenceZoom },
      );
    }
  },
  onRemove() {},
};

draw.extensions.featureTypes.add({
  type: 'Zone',
  geometry: 'Polygon',
  // 自分のスタイルを持たない区域の見た目
  defaultStyle: {
    fillColor: '#2563eb',
    fillOpacity: 0.2,
    strokeColor: '#2563eb',
    strokeWidth: 2,
    lineStyle: 'dotted',
  },
  renderer: zoneRenderer,
});
```

線の描画器は、既定では幅をピクセルで受け取ります。
`widthUnit: 'meters'` にすると地上のメートルになり、線のズームと緯度で
その長さが覆うピクセルで描くので、自然に地図に合わせて太さが変わります。
`referenceZoom` を渡すと、ピクセルの幅の線が、そのズームでの幅を基準に
ズームに合わせて太くなったり細くなったりします。メートルの幅は
`referenceZoom` を受けません。点の描画器も、印の大きさと縁の太さに
`referenceZoom` を受け取ります。地図の上で大きさを保つ地物の印には、
地物が持つズーム (`maplibre-gl-draw:createdZoom`) を渡します。描画器は、
上の区域のように、そのズームを地物の鍵から読みます。その鍵の無い地物は、
画面の上で大きさを保ちます。

点の型は、点の描画器と地物の見た目で印を描きます。見た目は印の半径
(`pointRadius`) を持ち、描画器は直径 (`size`) を受け取ります。

<!-- docs-check:
declare const feature: import('@sakuzu/maplibre-gl-draw').Feature;
declare const ctx: import('@sakuzu/maplibre-gl-draw').RenderContext;
-->

```ts
import type { Point } from 'geojson';

const look = ctx.appliedStyle(feature);
ctx.point.draw(
  (feature.geometry as Point).coordinates,
  {
    shape: look.pointShape,
    size: 2 * look.pointRadius,
    fillColor: look.pointColor,
    fillOpacity: look.pointOpacity * ctx.opacity,
    strokeColor: look.pointStrokeColor,
    strokeWidth: look.pointStrokeWidth,
    strokeOpacity: look.pointOpacity * ctx.opacity,
  },
  { referenceZoom: feature.properties['maplibre-gl-draw:createdZoom'] },
);
```

表示が経度 ±180 度の子午線をまたぐと、描画は世界の写しをそれぞれ
見せ、`draw` は写しごとに 1 回呼ばれます。描くものを地図のカメラから
ではなく、地物と窓口から計算してください。そうすれば正しい写しに
描かれます。

### 型の見た目

型は、その地物の見た目を `defaultStyle` (`FeatureStyle`) で宣言し、
描画器は `feature.style` と自分の既定ではなく
`ctx.appliedStyle(feature)` で描きます。見た目はライブラリーが組み立て、
描画器にも `draw.features.getAppliedStyle(id)` にも同じ組み立て方で
答えます。そのため、インスペクターのパネルは描かれているものを見せます。
`getAppliedStyle` は下書きを当てない文書の値について答え、描く文脈は
下書きを当てた描く地物について答えます。

1. 地物のスタイル
2. レイヤーのスタイルの規則の色
3. 型が宣言した見た目
4. 型が書かなかった鍵には、その幾何の `style` の設定の既定

- スタイルの規則は、見た目の鍵の 1 つを塗ります
  ([どの色が使われるか](styles.ja.md#どの色が使われるか))。型が
  `styleRuleChannel` で宣言した鍵 (`'fill'` は `fillColor`、`'stroke'` は
  `strokeColor`、`'point'` は `pointColor`) か、宣言が無ければ組み込みの型と
  同じく定義の幾何の鍵です。Point は `pointColor`、LineString は
  `strokeColor`、Polygon は `fillColor` です。上の区域は Polygon なので、
  規則の色を塗りにとり、縁はそのままです。Point の上に `fillColor` で塗った
  箱を描く型は、`styleRuleChannel: 'fill'` を宣言します。スタイルに
  その鍵を持つ地物は自分の色のままです
- `defaultStyle` は地物のスタイルと同じように確かめられ、正しくないものは
  `invalid-input` で拒まれます。型を足したときに写されるので、変えるには
  型を足し直します
- `defaultStyle` を宣言しない型は、これまでどおり `style` の設定の既定から
  始まります
- 地物の見た目は 1 度だけ組み立てられ、地物と一緒に取っておかれます。
  同じ描く 1 回でも次の 1 回でも、地物、そのレイヤーの規則、`style` の設定の
  どれかが変わるまでは、読み直すと同じオブジェクトが返ります。描く地物
  ごとに読み、オブジェクトは変えないでください

## 当たり判定

`hitTest` が無いと、その型の地物は図形のとおりに当たります。線なら
ポインターの近く、面ならポインターの下です。`hitTest(feature, ctx)` は
それを置き換えます。画面の点、その地図の位置、ピクセルでのクリックの
許容量、位置を投影する `screen` を受け取り、点から地物までのピクセルの
距離 `{ distancePx }` を返します。点が当たらないときは `null` を返します。
ライブラリーは、そこから外に渡す `Hit` (種類 `feature` と地物の ID) を
作ります。

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
    return { distancePx: best };
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
- `boxSelect(feature, boxPx, ctx)` は、選択の矩形が地物を取るかを、
  ピクセルの矩形で決めます。無ければ図形で決まります

## 選択とハンドル

定義のほかのメンバーは省けます。

| メンバー | 無いとき |
| --- | --- |
| `footprint` | 図形の外形です |
| `transformFields` | どの大きさ変えと回転も図形だけを変えます |
| `handles` | その型に自分のハンドルはありません |
| `drawHandles` | `custom` のハンドルは当たりますが描かれません |
| `onHandleDrag` | ハンドルをドラッグしても何も変わりません |
| `snapCandidates` | 図形の頂点と辺が候補です |

`footprint(feature, ctx)` は、地物が覆う外形を答えます。文脈は画面だけを
持つ `FootprintContext` (`ctx.screen`) です。ライブラリーは
そこから選択の枠を作ります。枠を描き、当て、大きさを変えるハンドルと
回すハンドルを枠に置きます。返す外形は次の 2 種類で、枠をどう描いて
当てるかは、図形ではなくこの種類が決めます。

- `{ kind: 'ground', corners: { topLeft, topRight, bottomRight,
  bottomLeft } }` は地図の上の 4 つの位置で、順は回す前の形の左上、
  右上、右下、左下です。斜めに描く箱のように、地図の上に描く形のための
  ものです。選択の枠は地図の上で描いて当て、大きさを変えるハンドルが
  その角に、回すハンドルがその上に付き、地図と一緒に傾いて回ります。ここでの
  `ground` は地図の面のことで、地形の面のことではありません
- `{ kind: 'screen', position, halfWidthPx, halfHeightPx }` は、地図の
  上の位置の周りの、画面の上で大きさの決まった箱です。画面の上で大きさを
  保つ印のためのものです。選択の枠は、点の印と同じように、画面の上で
  その位置の周りに描いて当てるので、傾けた地図でも大きさが変わらず、
  地球儀の裏では印と一緒に隠れます。大きさを変えるハンドルと回す
  ハンドルは付きません

描くものが無い地物には `null` を返します。その地物に選択の枠はありません。
`footprint` が無いとき、または 2 種類のどちらでもないものを返したときは、
図形の外形になります。位置の範囲か、1 つの位置の周りの点の印の大きさの
箱です。作ったときのズームで描く箱のように、ズームとともに決めた
大きさは、`/geometry` の `pixelsToMeters` と `metersToDegrees` で地図の
上に置きます。ライブラリーがその大きさを描くのと同じ式です。

外形は選択の枠の余白 (`selectionStyle.box.margin`。既定は 10 ピクセル)
を含みません。余白はライブラリーが足します。点も含めてどの型でも、枠の
各辺は外形から余白の分だけ外に立ちます。画面の上の枠は画面の上で余白を
取ります。地図の上の枠は地図の上で余白を取ります。余白は
`ctx.screen.metersPerPixel` で地物の所のメートルに直されて地面に
置かれるので、枠は地図と一緒に傾いて回ります。今の表示のために地物の
周りに描くもの (枠の外のハンドルなど) も、そのピクセルを同じように
地面に置けば、ライブラリーが置くのと同じ所に立ち、自分の当たり判定も
描いた所でそれを見つけます。

地図の上の外形の、大きさを変えるハンドルと回すハンドルは、組み込みの
形のものと同じです。選択の枠の角の四角と、枠の上にあって線で枠と
つながる丸で、見た目と離れ方は `selectionStyle` に従い、描いた所で
当たります。そのドラッグは、1 つの地物でも複数でも、ライブラリーの
大きさ変えと回転です。図形を動かし、型が `transformFields` で宣言した
欄を書きます。宣言するのは、地物が回転 (反時計回りの度) と大きさの
倍率を持つ `properties` の鍵と、大きさ変えで形を保つかどうかです。

<!-- docs-check:
declare function boardFootprint(
  feature: Feature,
): import('@sakuzu/maplibre-gl-draw').Footprint;
declare const boardRenderer: import('@sakuzu/maplibre-gl-draw').FeatureRenderer;
-->

```ts
import type { FeatureTypeDefinition } from '@sakuzu/maplibre-gl-draw';

// 看板。位置の周りに地図の上に置く箱で、`boardAngle` で回り、
// `boardScale` で大きくなる。外形と描画器はこの 2 つを読む
const signboard: FeatureTypeDefinition = {
  type: 'Signboard',
  geometry: 'Point',
  renderer: boardRenderer,
  footprint: (feature) => boardFootprint(feature),
  transformFields: {
    angleDegreesKey: 'boardAngle',
    scaleKey: 'boardScale',
    uniformScale: true,
  },
};
```

`boardFootprint` は、作ったときのズームでのピクセルの大きさと角度と倍率
から、箱を地図の上に置きます。例
[Custom feature types](../examples/custom-feature-types.ja.md) の看板
(`board.ts`) の `boardFootprint` と同じです。下の `eastMiddleOf` と
`widthFromCenter` も、そこに書いてあります。

回転は `boardAngle` に角度を足して 0 以上 360 未満に収め、大きさ変えは
`boardScale` に倍率を掛けます。鍵の無い地物は 0 と 1 から始まります。
同じ欄は、ハンドルだけでなく、地物への `rotate` と `scale` の編集の
全部が書きます。

| 地物を回し、大きさを変えるもの | 宣言した欄を書くか |
| --- | --- |
| 選択の枠のハンドル | 書きます。地物が 1 つでも複数でも |
| まとめて選んだ地物のドラッグ | 書きます |
| `rotate` と `scale` の編集 (`Store.applyEdits`) | 書きます |
| 下書き (`draw.sketches`) が持つ同じ編集 | 書きます |
| 型の `onHandleDrag` | 書きません。差分に書いたものだけが変わります |

`angleDegreesKey` を宣言した型
の、`Point` の図形を持つ地物 1 つの回転は、その位置の周りに回し、位置
は動きません。複数の地物は、その枠の中心の周りに回ります。
`transformFields` の無い型は、地物がどんな鍵を持っていても図形だけが
変わり、`override` に渡す定義はこれを持てません。自前の Store は、地物
の値を計算 (`Store.transforms`) に渡すために、宣言を
`draw.extensions.featureTypes.get(type)` で読みます。鍵には
`maplibre-gl-draw:` の前置きを付けません。前置きはライブラリーが自分の
値に使います ([データの形式](../reference/data-format.md#properties))。

`handles(feature, ctx)` は、型が選ばれている地物に足すハンドルを返し
ます。それぞれ ID、位置、カーソルと、見せ方を決める `kind` を持ちます。

- `{ kind: 'resize', id, position }` は、ライブラリーが大きさを変える
  ハンドルと同じように (`selectionStyle.resizeHandle`) 描き、その
  大きさで当てます。箱の幅を変える辺の中ほどのハンドルなどに使います。
  同じなのは見た目だけで、ドラッグはライブラリーの大きさ変えでなく
  `onHandleDrag` に届きます
- `{ kind: 'custom', id, position, sizePx }` は、型が `drawHandles` で
  自分で描き、位置の周りの `sizePx` ピクセルの四角で当てます。描く印の
  直径を渡します。線の端の印などに使います

ハンドルは、地物が 1 つだけ選ばれているときにだけ出ます。いつ見せ、
当て、ドラッグさせるかは、どの型でも同じくライブラリーだけが決めます。
地物が 1 つだけ選ばれていて、文書が読み取り専用でも操作ロックの間でも
なく、地物がロックされておらず、選択のほかのハンドル (大きさ、回転、
頂点) をドラッグしていない間です。地物そのものを丸ごとドラッグしている
間は、ライブラリーのハンドルと型のハンドル (`drawHandles` を含む) が、
選択の枠と一緒に、動いて描かれている所に出ます。ドラッグが終わるまで、
どれも掴めません。型はこれを確かめません。ほかの種類の
ハンドルと、`sizePx` が 0 より大きい有限の数でない `custom` のハンドルは
除かれ、種類ごとに 1 回コンソールに警告が出ます。

文脈は、画面 (`ctx.screen`)、ライブラリーが描く選択の枠
(`ctx.selectionBox`。`draw.rendered.getSelectionBox` の答えで、外形に
余白を足したもの。無ければ `null`)、選択の見た目 (`ctx.selectionStyle`)
を持ちます。枠の上のハンドルは `ctx.selectionBox` から置くと、
ライブラリーが描く枠の所に立ちます。

ハンドルをドラッグすると、ポインターが動くたびに `onHandleDrag` が
呼ばれ、ドラッグの終わりにもう一度呼ばれます。返した `FeaturePatch` は
地物に当てられます。動いている間の差分は途中の更新で、終わりの差分が
残ります。型のハンドルは ID で見分けます。看板の東の辺の中ほどに置き、
幅だけを変える `resize` のハンドルです。

<!-- docs-check: continue
declare function eastMiddleOf(
  box: import('@sakuzu/maplibre-gl-draw').Footprint,
): Position;
declare function widthFromCenter(feature: Feature, pointer: Position): number;
-->

```ts
const signboardWithWidth: FeatureTypeDefinition = {
  ...signboard,
  handles(_feature, ctx) {
    if (!ctx.selectionBox) return [];
    const position = eastMiddleOf(ctx.selectionBox);
    return [{ kind: 'resize', id: 'east', position, cursor: 'ew-resize' }];
  },
  // 倍率を掛ける前の幅で、外形はこれに `boardScale` を掛ける。辺は幅
  // だけを変え、角は看板の全体を一様に大きくし続ける
  onHandleDrag(feature, _handle, event) {
    const boardWidth = widthFromCenter(feature, event.lngLat);
    return { properties: { boardWidth } };
  },
};
```

辺は型の自分の鍵 (`boardWidth`) を書き、ライブラリーはそれに触れません。
`uniformScale` があるので、角の大きさを変えるハンドルは形を保ち、
`boardScale` だけを掛けます。2 つは重なって効きます。

頂点ごとにその頂点を動かすハンドルを置き、ハンドルの印を描く経路です。

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
  handles(feature) {
    return verticesOf(feature).map((position, index) => ({
      kind: 'custom',
      id: String(index),
      position,
      sizePx: 8,
      cursor: 'move',
    }));
  },
  // 印はそれぞれ、ハンドルが当たる幅で描く
  drawHandles(_feature, handles, ctx) {
    for (const handle of handles) {
      ctx.point.draw(handle.position, {
        shape: 'circle',
        size: handle.sizePx,
        fillColor: '#ffffff',
        fillOpacity: 1,
        strokeColor: '#e64d1a',
        strokeWidth: 2,
        strokeOpacity: 1,
      });
    }
  },
  onHandleDrag(feature, handle, event) {
    const coordinates = [...verticesOf(feature)];
    coordinates[Number(handle.id)] = event.lngLat;
    return { geometry: { type: 'LineString', coordinates } };
  },
};
```

`drawHandles(feature, handles, ctx)` は、`handles` が返した `custom` の
ハンドルと、描く 1 回の描画の文脈 (共有の描画器と `ctx.screen`) を受けます。
ライブラリーは選択を描いた後、その地物のハンドルを見せるときにだけ呼び、
見せるものが無いときは呼びません。型を外すと、描くものも一緒に消えます。

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
描かれます。定義の `hitTest`、`boxSelect`、`footprint`、`bbox`、
`snapCandidates` は、あれば組み込みの型のものに代わります。
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

`appliesTo(feature)` は、絵を持つ点のように、差し替えを型の
一部の地物に絞ります。これが false を返す地物は、組み込みの型を
そのまま使います。ほかの組み込みの地物とまとめて描かれ、組み込みの
当たり判定、範囲選択、枠、ハンドル、吸着の候補、広がりが残ります。
残りの地物は定義で描かれ、当たりが決まります。地物が変わるたびに
問い直すので、答えは地物だけから決めてください。`add` はこれを
無視します。独自の型は、その型の地物をすべて受け持ちます。

<!-- docs-check:
declare const draw: import('@sakuzu/maplibre-gl-draw').Draw;
declare const pictureRenderer: import('@sakuzu/maplibre-gl-draw').FeatureRenderer;
-->

```ts
draw.extensions.featureTypes.override({
  type: 'Point',
  geometry: 'Point',
  renderer: pictureRenderer,
  appliesTo: (feature) => typeof feature.properties.picture === 'string',
});
```

行で持つレイヤーでは、このような描画器が受け持つ点は `draw` で 1 つずつ、
前後の行の間に描かれます。定義と描画器が行ごとに地物を作らずに行そのもの
から行うことは、それぞれの 1 つの欄 `rows` にあります。実験的で、型は
`/kasane` にあります (`FeatureTypeRows`、`FeatureRendererRows`)。

- `renderer.rows.sprites` は、描画器が点を描く絵を渡します。渡すのは、
  テクスチャと、書式ごとの絵の範囲と、画面の上の大きさです。こうした点は、
  レイヤーのほかの行と一緒に、行の順に同じ描画で描かれるので、絵で描く点と
  面が交互に並ぶレイヤーも少ない描画で描けます。大きさの欄
  (`transformFields.scaleKey`) を宣言する型の点は、絵があっても `draw` で
  描きます。絵は点の書式で選ぶもので、大きさについて行かないためです
- `rows.appliesTo(view, handle)` は、`appliesTo` と同じ答えを行から返します。
  行はレイヤーの `LayerTableView` で読みます (`getRowValue`、`getRowType`)。
  無いときは、描くために行を分けるたびに、その型の行ごとに地物を作って
  `appliesTo` に尋ねます
- `renderer.rows.draw(view, handles, ctx)` は、描画器が 1 つずつ描く行を、
  行から描きます。渡すのは、その型の続いた行のうち、隠れておらず見えている
  ものを、レイヤーの順に並べたものです。無いときは、そうした行の地物を作り、
  上限まで覚えて `draw` で描きます。まとめてドラッグしている行は、書かれた
  ままの値で渡します。描かれている所は `draw.rendered.getDraggedRows()` で
  分かります

## 地形

地形があるとき、共有の描画器は描くものを自分で地形に載せます。自分の
印のためには、`ctx.terrain` (`TerrainSurface`) が地形の面を渡します。

- `elevation(lngLat)` は地形の高さ (メートル) で、地形が無ければ 0 です。
  点の描画器に `elevationMeters` として渡すと、印が地形に載ります
- `occlusionOpacity(lngLat)` は、地形がカメラからその位置を隠すところで
  低くなります。印の不透明度に掛けてください
- `generation()` は、高さが変わったかもしれないときに変わります。高さを
  覚えておく描画器は、これで読み直す時を知ります

位置が画面のどこにあるか (地形があれば地形の上) は、どの位置とも同じく
`ctx.screen.project(lngLat)` です。

描画の外では、プラグインが窓口の `ctx.terrain` で同じ地形を読みます。
[地形](terrain.ja.md) を参照してください。

## 重ね描き

重ね描きは、1 つの地物ではないものを描きます。選択の上の印、格子、
自分のプレビューなどです。描画器と同じ `onAdd`、`draw`、`onRemove` を
同じ決まりで持ち、ほかに `name` を持ちます。
`draw.extensions.overlays.add` で足し、返る関数で外します。

どの経路にも、その始まりに印を付ける重ね描きです。

<!-- docs-check:
declare function verticesOf(feature: Feature): Position[];
-->

```ts
import type { OverlayRenderer } from '@sakuzu/maplibre-gl-draw';

const routeStarts: OverlayRenderer = {
  name: 'route-starts',
  onAdd() {},
  draw(ctx) {
    for (const feature of draw.features.list({ type: 'Route' })) {
      const [start] = verticesOf(feature);
      if (!start) continue;
      ctx.point.draw(start, {
        shape: 'square',
        size: 8,
        fillColor: '#e64d1a',
        fillOpacity: 1,
        strokeColor: '#ffffff',
        strokeWidth: 1,
        strokeOpacity: 1,
      });
    }
  },
  onRemove() {},
};

draw.extensions.overlays.add(routeStarts);
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

窓口 (`PointContext`。当たり判定も同じものを受け取ります) は、画面と
地図の上のポインター、ピクセルでの許容量、`screen` と、吸着が外す地物が
あるときは `excludeIds` を渡します。`excludeIds` は、描いている途中の
地物やドラッグしている地物のように、吸着させてはいけない地物です。
当たり判定には、この端末が丸ごとドラッグしている地物が入ります。`priority` は、同じ距離の候補の間の
順を決めます。大きい方が勝ちます。自分で決めた `kind` は頂点として
順位を決め、吸着の結果 (`target.kind`) にそのまま届きます。

### ハンドル

`HandleProvider` は、選ばれている地物に自分のハンドルを出します。
`handles(feature, ctx)` が、定義と同じ文脈と 2 つの種類で、地物が
1 つだけ選ばれているときにハンドルを返し、定義と同じく
`onHandleDrag(feature, handle, event)` がドラッグで変わる差分を返します。
`drawHandles(feature, handles, ctx)` は、定義のものと同じく `custom` の
ハンドルを描きます。`globalHandles(ctx)` は、どの
地物にも属さず、何を選んでいても出るハンドルを返します。そのドラッグ
では `feature` が `null` で届き、変わるものは提供者が自分で書き込み
ます。`onHandleDragStart` と `onHandleDragEnd` は、定義のものと同じ
ように、ドラッグの前後で呼ばれます。`onHandleDragStart` は `false` を
返してドラッグを拒めます。定義と同じく、
`resize` のハンドルはライブラリーが大きさを変えるハンドルとして描き、
`custom` のハンドルは提供者が `drawHandles` で描きます。
`globalHandles` のハンドルでは `feature` が `null` で届き、その文脈に
選択の枠はありません。

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
    return distancePx <= 14 ? { id: feature.id, distancePx } : null;
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
  ください。行で持つレイヤーでは、`rows.has(view, handle)` (実験的。型は
  `/kasane` にあります) が同じ答えを行から返します。無いときは、描く
  ために行を分けるたびに、行ごとに地物を作って `has` に尋ねます
- `rows.classifyKeys` (実験的) は、`has` と `rows.has` の答えが読む
  `properties` の鍵を挙げます。挙げると、行のほかの属性を書いたときは
  尋ね直さずに描きます。無いときは、行のどの属性を書いても、その行に
  ついて尋ね直します。答えが読むのに挙げていない鍵を書くと、その行は
  前の答えのまま描かれます
- `draw` は、地物そのものの直前に呼ばれます
- `hitTest` は、付き物が自分に付けた ID と距離 `{ id, distancePx }` か、
  `null` を返します。ライブラリーは、そこから外に渡す `Hit`
  (`map.clicked`、`ModeContext.hitTest`、`onClick`) を、種類 `companion`
  と、`featureId` の地物を埋めて作ります
- `hitTest` は、その地物の段で尋ねられます。ポインターが地物そのもの
  に当たらなかったときに、その後ろの地物より先に尋ねられます。その
  ため、画面の同じ点へのクリックは次の順で行き先が決まります
  - 選択のハンドルが最初です。付き物の下にあっても掴めます
  - 次に、重なりの順の手前から、地物そのもの、その付き物の順です。
    地物は、点の印、線、面にクリックの許容範囲を加えたところで当たり、
    自分の付き物に勝ちます。付き物は、その地物より後ろの地物に勝ちます
  - データセットの行に届くのは、手前の地物にも付き物にも当たらなかった
    ところだけです。地物より手前に重ねたデータセットは、その両方より
    先です
- 当たると `onClick` が呼ばれます。true を返すとクリックはそこで消費
  され、選択はそのままです。それ以外では、選択モードがそのクリックを
  地物へのクリックとして扱います

## 自分のシェーダー

共有の描画器は、線、面、点の印を描きます。それ以外のものは、描画器が
`ctx.gl` で自分のシェーダーをコンパイルして描きます。位置は、
`/webgl` の `viewUniforms(ctx)` が渡す描いている画面の GPU の値、`shader` (地図の
投影の関数)、`projection`、`offset` (精度を落とさずにカメラの近くを
描くための表示の中心) で決めます。`offsetUniformsAt(ctx, position)` は、
ほかの位置からの差の値を渡します。中心から遠い形を、その形の位置の
周りで描くときに使います。

入口 `@sakuzu/maplibre-gl-draw/webgl` には、ライブラリーのシェーダーの
土台になっている部品があります。投影の GLSL とその uniform のための
`ProjectionUniformManager`、`createProgram`、`QuadShader`、共有の描画器
が破線と地形に使う規則です ([webgl の入口](../api/webgl/index.md))。
主の入口と違い、マイナーリリースで変わることがあります
([版](../reference/README.md))。

シェーダーは色を数で受けます。`ctx.appliedStyle(feature)` の CSS の色は、
主の入口の `parseCssColor` で読みます。ライブラリーと同じ読み方で、
0 から 1 の `[red, green, blue, alpha]` を返します
([スタイル](styles.ja.md#地物自身のスタイル))。

地形の上に描く部品は、描画の呼び出しの描画の文脈か、その `terrain` を
受け取ります。描く前に `ProjectionUniformManager` や `QuadShader` の
`setTerrain(ctx)` を呼び、`terrainTessellationStep(ctx)` と
`drawQuadOnTerrain(ctx, ...)` にも渡します。描画の文脈はその
呼び出しの間だけ有効なので、呼び出しごとにそのときのものを渡して
ください。`null` を渡すと、地形なしで描きます。ライブラリーが渡した
ものでないオブジェクトを渡すと、`viewUniforms` と同じく、コード
`invalid-input` の `DrawError` を投げます。

```ts
import type { RenderContext } from '@sakuzu/maplibre-gl-draw';
import {
  densifyPath,
  type ProjectionUniformManager,
  terrainTessellationStep,
  viewUniforms,
} from '@sakuzu/maplibre-gl-draw/webgl';

function pathOnTerrain(
  ctx: RenderContext,
  program: WebGLProgram,
  uniforms: ProjectionUniformManager,
  coordinates: [number, number][],
): [number, number][] {
  const view = viewUniforms(ctx);
  ctx.gl.useProgram(program);
  uniforms.setTerrain(ctx);
  uniforms.setUniforms(view.projection, view.offset);
  const step = terrainTessellationStep(ctx);
  // path を送って描く
  return step ? densifyPath(coordinates, step) : coordinates;
}
```

地図の上に平らに置く独自の四角は、
`drawQuadOnTerrain(ctx, corners, content, opacity)` で、画像と同じく
地形の上に塗れます。起伏に沿い、
尾根の向こうでは隠れます。ライブラリーは、地面の画素ごとに四角の中の
位置と、隣の画素までのその変わり方を求めます。中身 (`QuadDrapeContent`)
は、その位置の色を GLSL の関数 `quadDrapeColor` で返し、関数が読む
uniform とテクスチャーを `QUAD_DRAPE_TEXTURE_UNITS` の単位に結びます。
四角を地形に貼れない所 (地形が無い、標高がまだ届いていない) では
`false` を返すので、描画器は `QuadShader` のときと同じく別の描き方で
描きます。

```ts
import type { RenderContext } from '@sakuzu/maplibre-gl-draw';
import {
  computeQuadVertices,
  drawQuadOnTerrain,
  type QuadDrapeContent,
} from '@sakuzu/maplibre-gl-draw/webgl';

// どの描画でも同じ GLSL の文字列を渡す (ライブラリーはこれごとにプログラムを作る)
const SOLID_GLSL = `
uniform vec4 u_solid_color;
vec4 quadDrapeColor(vec2 uv, vec2 uvDx, vec2 uvDy, float shade) {
  return vec4(u_solid_color.rgb * shade * u_solid_color.a, u_solid_color.a);
}`;

function drawSolidQuad(ctx: RenderContext, center: [number, number]): boolean {
  const content: QuadDrapeContent = {
    glsl: SOLID_GLSL,
    bind(gl, uniform) {
      gl.uniform4f(uniform('u_solid_color'), 0.2, 0.4, 0.8, 0.6);
    },
  };
  const corners = computeQuadVertices(center[0], center[1], 0.01, 0.01, 0);
  return drawQuadOnTerrain(ctx, corners, content, ctx.opacity);
}
```

`QuadShader` は、四角がどこにあっても同じように中身を描きます。地形の上では
`drawQuadOnTerrain` を通り、平らな地図と地球儀の上では同じ `quadDrapeColor`
を `shade` が 1 の値で呼びます。中身は作るときに渡します
(`new QuadShader(gl, content)`。省くと `QuadImageContent` の画像です)。中身が
読む値を設定してから `draw(vertices, opacity, projection)` を呼びます。

地形の上に深度なしで印を描くシェーダーは、地形が隠す印を
`TERRAIN_OCCLUSION_GLSL` で薄くします。CPU の `occlusionOpacity` と
同じことです。頂点シェーダーの `OFFSET_MODE_GLSL` の後に置くと、
`terrain_occlusion_opacity(offset, elevationMeters)` が、印を投影する
差と、その下の地面の高さから、印の不透明度を返します。同じ式と同じ
定数の判定を、シェーダーが地面を読む DEM のアトラスの上で行うので、
バッファーに持った印は、カメラが動いても CPU の仕事が要りません。
uniform は `TerrainOcclusionUniforms` が描くたびに書きます。位置が
アトラスの外にあるときや、視線が地面をかすめるときは、
`occlusionOpacity` と違う答えになることがあります。

行で持つレイヤーの地物をまとめてドラッグしている間、ライブラリーは
その行を GPU で動かして描き、離した後に書きます。行ごとに何かを描く
シェーダー (点に添える印など) は、`ROW_STATE_GLSL` で同じように動かせます。

- インスタンスごとに、自分のテクスチャー (`createRowStateTexture`) の
  行の番号を持たせます。テクスチャーには、`draw.rendered.getDraggedRows()`
  が渡す行の `rowStateOf(dragged, handle)` を書きます (`uploadRowState`)
- 描く前に、テクスチャーをユニット `ROW_STATE_TEXTURE_UNIT` に結び、
  `RowStateUniforms.write(rowStateBindingOf(dragged, texture), origin)`
  で uniform を書きます
- 頂点シェーダーでは、`rowStateMove(readRowState(row), offset)` が投影
  する差を返します。ライブラリーが行の点を動かすのと同じく、移し、回し、
  拡大縮小した差です

binding はドラッグの動きを写して持ちます。ドラッグが終わってから
行の位置を読み直すまでは、同じ binding で描くと、最後に描いた所に
描けます。

```glsl
in vec2 a_offset;
in float a_row;
in float a_elevation_meters;
out float v_opacity;

void main() {
    vec2 offset = rowStateMove(readRowState(a_row), a_offset);
    vec4 clip = project_position_to_clipspace_from_offset(offset, u_projection_matrix);
    v_opacity = terrain_occlusion_opacity(offset, a_elevation_meters);
    gl_Position = clip;
}
```

バッファーに原点からの float32 の差で持った印は、原点からの距離に応じて
画面でずれ、ずれはズームとともに大きくなります。
`rebasedRetainedOrigin(origin, extent, view, zoom, movedViews)` は、
ライブラリーが自分の塊に使う規則で、新しい原点から書き直す時を教えます。
見ている所の誤差が `RETAINED_ORIGIN_TOLERANCE_PX` の内なら `null` を
返します。カメラが止まっている間に呼び、ドラッグ中の行には
`rowStateMovedViews(binding, view)` を渡します。

## 関連する例

- [Custom feature types](../examples/custom-feature-types.ja.md) では、
  共有の線の描画器で描き、当たり判定、矩形選択、ハンドル、独自の
  スタイルのキーを持つルートの型を足し、そのキーのための節を標準の UI に
  足します。キーで型の登録を外し、また登録します

## リファレンス

- [FeatureTypeDefinition](../api/maplibre-gl-draw/interfaces/FeatureTypeDefinition.md)、
  [TransformFields](../api/maplibre-gl-draw/interfaces/TransformFields.md)、
  [Handle](../api/maplibre-gl-draw/type-aliases/Handle.md)、
  [HandleContext](../api/maplibre-gl-draw/interfaces/HandleContext.md)
- [FeatureRenderer](../api/maplibre-gl-draw/interfaces/FeatureRenderer.md)
  と [RenderContext](../api/maplibre-gl-draw/interfaces/RenderContext.md)
- [LineRenderer](../api/maplibre-gl-draw/interfaces/LineRenderer.md)、
  [FillRenderer](../api/maplibre-gl-draw/interfaces/FillRenderer.md)、
  [PointRenderer](../api/maplibre-gl-draw/interfaces/PointRenderer.md)
- [PointContext](../api/maplibre-gl-draw/interfaces/PointContext.md)
  と [Hit](../api/maplibre-gl-draw/interfaces/Hit.md)
- [OverlayRenderer](../api/maplibre-gl-draw/interfaces/OverlayRenderer.md)
- [SnapProvider](../api/maplibre-gl-draw/interfaces/SnapProvider.md)、
  [HandleProvider](../api/maplibre-gl-draw/interfaces/HandleProvider.md)、
  [CompanionProvider](../api/maplibre-gl-draw/interfaces/CompanionProvider.md)
- [TerrainSurface](../api/maplibre-gl-draw/interfaces/TerrainSurface.md)
