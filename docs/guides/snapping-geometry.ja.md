# 吸着と幾何演算

この手引きでは、描いた形どうしをぴったり合わせるための道具を
説明します。頂点、辺、交点、ガイド線への吸着、既存の地物の境界の
なぞり、共有頂点の同時移動、地物を組み合わせたり分けたりする演算
(結合、差し引き、交差、分割、バッファー) です。最後に geometry の
入口を扱います。地図なしで形を測ったり組み合わせたりする関数の
集まりで、ブラウザーの外でも使えます。

## 最小のコード

<!-- docs-check:
declare const statusBar: HTMLElement;
declare const parcelA: string;
declare const parcelB: string;
-->

```ts
import { createDraw } from '@sakuzu/maplibre-gl-draw';

const draw = createDraw(map, {
  snapping: { tolerancePx: 12 },
  topology: { sharedVertexDrag: true },
});

draw.on('snap.changed', ({ result }) => {
  statusBar.textContent = result?.target?.kind ?? '';
});

// 2 つの面を 1 つの地物に結合する
// 新しい地物か、変更を拒んだときは null
const merged = draw.features.union([parcelA, parcelB]);
```

## 吸着

描画中と頂点のドラッグ中は、ポインターが近くのものに吸着します。
吸着は入力がライブラリーに入る所で行うので、どの描画モードでも、
頂点のドラッグでも、自分で足したモードでも同じように働きます。

既定で有効です。

| `snapping` | 既定 | 意味 |
| --- | --- | --- |
| `enabled` | `true` | 吸着の有効と無効 |
| `tolerancePx` | `10` | どれだけ近ければ吸着するか (画面の画素) |
| `disableKey` | `'alt'` | 押している間は吸着しない |
| `kinds` | すべて `true` | 種類ごとの有効と無効 |
| `datasets` | `true` | データセットの行にも吸着する |
| `guideStepDegrees` | `45` | 真北を基準にしたガイドの刻みの角度 |
| `indicator` | `#00C7BE` の印 | 吸着した点の印 (種類ごと) |
| `guideLine` | 1 px の破線 | 吸着したガイドに沿う線 |

`disableKey` には `'alt'`、`'shift'`、`'ctrl'`、`'meta'`、
`'none'` のどれかを指定します。キーを押している間は何にも
吸着しないので、1 点をそのままの位置に置けます。許容距離は、
どの方向でも、どの緯度でも、画面上で同じ距離です。

同じ設定は、インスタンスの実行中に `draw.options` で変えられます。
変わるのは渡した鍵だけです。

```ts
draw.options.update({ snapping: { enabled: false } });
draw.options.update({ snapping: { kinds: { guide: false } } });
draw.options.update({ snapping: { datasets: false, guideStepDegrees: 15 } });
draw.options.update({
  snapping: {
    indicator: { vertex: { strokeColor: '#ff5722', size: 18 } },
    guideLine: { color: '#ff5722', width: 2 },
  },
});
draw.options.get().snapping; // 現在の設定
```

0 以下の刻みの角度のように型や値の合わない設定を渡すと、コード
`invalid-input` の `DrawError` を投げ、何も変えません。

### 吸着先

| 種類 | 候補 |
| --- | --- |
| `vertex` | 点、線、面のすべての頂点 (穴とパートも含む) |
| `intersection` | 異なる 2 つの地物の辺が交わる所 |
| `edge` | 線か面の辺の上で最も近い点 |
| `guide` | 描画中に、最後に置いた頂点から出るガイド線 |

届く範囲に複数あるときは、種類で決まります (頂点、交点、辺、
ガイドの順)。同じ種類の中では最も近いものが選ばれます。

- `Circle`、`Image`、`Freehand` には吸着しません
- 非表示の地物には吸着しません。文書で非表示のものも、この
  端末だけで隠しているものも同じです
- 描いている途中の形はまだ地物ではないので、吸着しません
- ドラッグ中の頂点は、自分自身と自分の辺には吸着しませんが、
  同じ地物のほかの頂点には吸着します。そのため、リングを最初の
  頂点で閉じられます
- 頂点の多い地物のハンドルは画面上で間引きますが、吸着はすべての
  頂点を対象にします
- フリーハンドでは、描線の始点と終点だけが吸着します。手で
  描いた線が近くの境界に引き寄せられることはありません

### ガイド線

`draw_line` と `draw_polygon` では、最後に置いた頂点からガイド
線が出ます。1 つ目の頂点を置いた後は真北から刻みの角度ごとに、
2 つ目の頂点を置いた後は直前の線分の延長方向と垂直方向にも
出ます。許容距離の中に実際の頂点、交点、辺があれば、ガイドより
そちらが優先されます。

刻みの角度は `snapping.guideStepDegrees` で決めます。45 度なら
8 本、15 度なら 24 本です。`draw.options.update` で変えると、
次の吸着から反映されます。

### 利用者に見えるもの

吸着している間は、吸着先に記号を描きます。頂点は輪、辺は
正方形、交点は点、ガイドは小さな輪とその下の破線のガイド線
です。

`snap.changed` は、結果が変わるたびに発火します。`result` は
`SnapResult` で、吸着が外れると `null` です。`target.kind`、
`target.featureId`、`target.datasetId` (データセットの行の
とき)、`target.description` で、何に吸着したかがわかります。
ガイドと交点の説明はライブラリーが表示する言葉から取り、
`messages` の設定で置き換えられます ([スタイル](styles.ja.md))。

### 自前のデータに吸着させる

吸着の提供者を使うと、地物として地図に載っていない道路網の
ような、どこからでも候補を足せます。

<!-- docs-check:
declare function queryRoadVertices(
  near: import('geojson').Position,
): import('geojson').Position[];
-->

```ts
import type { SnapProvider } from '@sakuzu/maplibre-gl-draw';

const roads: SnapProvider = {
  name: 'road-vertices',
  candidates: ({ lngLat }) =>
    queryRoadVertices(lngLat).map((position) => ({
      kind: 'vertex',
      position,
      source: 'road',
    })),
};

const removeRoads = draw.extensions.snapProviders.add(roads);
```

- `candidates` は、ポインターの位置 (画面の `point` と地図の
  `lngLat`)、画素での許容距離、地図と画面の変換 (`screen`)、
  除外する ID (`excludeIds`) を受け取ります。許容距離より遠い
  候補を返しても問題ありません。近いものだけを残し、どれを
  選ぶかはライブラリーが決めます
- 候補は点です。自前のデータの線分に沿って吸着させたいときは、
  線分の上で最も近い点を返します ([geometry の
  入口](#geometry-の入口) の `nearestPointOnLine`)
- `priority` は同じ距離の候補のどれを選ぶかを決め、大きい方が
  選ばれます。`source` は吸着の結果の `description` として
  返ります
- `add` が返す関数を呼ぶと提供者を外せます。
  `draw.extensions.snapProviders.remove('road-vertices')` でも
  外せます

独自の地物の型は、定義の `snapCandidates` で自分の候補を出します
([独自の地物の型](custom-types.ja.md))。自分で足したモードは、
入力ごとに吸着した位置を `event.snapped` で受け取り、画面上の
任意の点をコンテキストの `snap(point)` で吸着させられます
([プラグイン](plugins.ja.md))。

## 辺のなぞり

`draw_line` と `draw_polygon` で、前のクリックと今回のクリック
がどちらも既存の地物の境界に吸着したときは、その 2 点の間に
ある境界の頂点を挿入します。隣の区画を描くときは、共有する
境界の角を 2 つクリックするだけでよく、境界を描き直す必要は
ありません。

- 経路は、近くにある表示中の地物の辺をたどる経路のうち、地表の
  距離で最短のものです。頂点をぴったり共有する地物どうしは
  つながっているとみなすので、経路は複数の地物にまたがることが
  あります
- データセットへの吸着が有効な間は、データセットの行もなぞれます
- 経路の端になれるのは頂点と辺だけです。ガイド、交点、吸着の
  提供者の候補は端になれません
- 2 点がつながっていなければ、クリックはふつうの頂点になります
- ポインターを動かしている間は、挿入される頂点をプレビューに
  表示します
- 挿入した頂点はふつうの頂点なので、Backspace で 1 つずつ消せ
  ます
- なぞりには吸着が必要です。吸着が無効の間はなぞりません

なぞりは既定で有効です。無効にするには次のようにします。

```ts
draw.options.update({ tracing: { enabled: false } });
```

## 共有頂点の同時移動

`topology.sharedVertexDrag` を有効にすると、頂点をドラッグした
とき、ぴったり同じ位置にあるほかの地物の頂点も一緒に動きます。
隣り合う 2 つの多角形の境界を、すき間も重なりも作らずに編集
できます。既定では無効です。

```ts
draw.options.update({ topology: { sharedVertexDrag: true } });
```

- 位置は厳密に一致する必要があります (許容距離 0)。近いだけの
  頂点は付いてきません
- 線、面、点とそれぞれの Multi の型は付いてきます。`Circle`、
  `Image`、`Freehand` は付いてきません
- ロックされた地物と非表示の地物は付いてきません
- 1 つの地物の中で同じ位置にある複数の頂点 (リングを閉じる
  頂点や、外側のリングに接する穴の頂点) はすべて動きます
- 付いてくる頂点はドラッグを始めた時点で決まり、ドラッグ中は
  強調表示されます。ドラッグを始めるときに吸着の `disableKey` を
  押していると、掴んだ頂点だけが動きます
- 移動全体が 1 つの変更になり、選択されるのは掴んだ地物だけです

## 地物を組み合わせる、分ける

コレクション `draw.features` には、文書を変える演算があります。
どれも地物の ID を受け取って結果を計算し、1 つの変更として
書き込みます。

- `union(ids)` は 2 つ以上の面を 1 つの地物に結合し、それらと
  置き換えます
- `difference(id, subtractIds)` は面からほかの面を切り抜きます。
  結果は切り抜かれた面と置き換わり、切り抜くのに使った面は
  残ります
- `intersection(ids)` は 2 つ以上の面が重なる所を 1 つの地物に
  し、それらと置き換えます
- `split(id, lineId)` は面を線で断片に分け、面と置き換えます。
  線は残ります
- `buffer(ids, { distanceMeters, segments })` は点、線、面の
  周りの範囲を入力ごとに 1 つ作ります。入力は残ります

<!-- docs-check:
declare const back: string;
declare const front: string;
declare const parcelId: string;
declare const cutLineId: string;
declare function toast(message: string): void;
-->

```ts
// 前面の面を背面の面から切り抜く。前面の面は残る
const cut = draw.features.difference(back, [front]);
if (cut === null) toast('nothing left');

const pieces = draw.features.split(parcelId, cutLineId);

const { ids } = draw.selection.get();
const zones = draw.features.buffer(ids, { distanceMeters: 100 });
draw.features.buffer([parcelId], { distanceMeters: -5, segments: 32 });
```

選択しているものに対して行うときは、`draw.selection.get().ids`
を渡します。結果は選択されません。利用者がそのまま続けて作業する
ときは、`draw.selection.set('feature', ids)` で選択します。

### すべての演算に共通する規則

- 面は `Polygon`、`MultiPolygon`、`Circle` です。`split` の線は
  `LineString`、`MultiLineString`、`Freehand` です
- 引数の誤りには `DrawError` を投げ、何も変えません。無い ID には
  `not-found`、型の合わない地物 (`union` に渡した線や `buffer` に
  渡した `Image`) や有限の数でない距離には `invalid-input` です
- 文書が読み取り専用のときと、地物のどれかがロックされている
  ときは拒み、`null` を返して何も変えません
- 入力の削除と結果の作成は 1 つの変更で、`document.changed` が
  1 回届きます
- 結果が空のときは何も変えません。重ならない面の `intersection`
  と、すべてを切り抜いてしまう `difference` は `null` を返します。
  面を分けない線を渡した `split` と、距離 0 の `buffer` は `[]` を
  返します

### 結果の形

- 結果は、パートが 1 つなら `Polygon`、そうでなければ
  `MultiPolygon` です。離れた面を結合すると `MultiPolygon` に
  なり、内側を切り抜くと穴になります
- `union` と `intersection` の結果は、最も前面にある入力の
  スタイルとプロパティーを受け継ぎ、その入力があった場所
  (レイヤー、グループ、並び順の位置) に入ります。`difference` は
  切り抜かれた面のものを受け継ぎ、切り抜くのに使った面は
  そのまま残ります
- `Circle` の入力は 64 角形になり、半径はなくなります
- `split` は線を残し、断片を面のあった場所に面のスタイルと
  プロパティーで置きます。穴は、それを含む側の断片に残ります
- `buffer` は地表のメートルで計算するので、どの緯度でも距離が
  保たれます。点は円盤に、線は帯になり、面は広がります。負の
  距離は面だけを縮め、距離の 2 倍より細い部分は消えます。
  `Circle` は半径を変えた `Circle` のままです。結果はそれぞれ
  入力のすぐ前面に、入力のスタイルで入ります

## geometry の入口

`@sakuzu/maplibre-gl-draw/geometry` は、形の計算をふつうの関数と
して提供します。地図も draw のインスタンスも DOM も要らないので、
パッケージのほかの部分を読み込まずに import でき、Worker、Node、
Bun でも同じ結果になります。

<!-- docs-check:
declare const polygonA: import('geojson').Polygon;
declare const polygonB: import('geojson').Polygon;
declare const road: import('geojson').LineString;
-->

```ts
import {
  area,
  buffer,
  pointOnSurface,
  union,
} from '@sakuzu/maplibre-gl-draw/geometry';

// polygonA と polygonB は GeoJSON の Polygon か、
// それを持つ GeoJSON の Feature
const merged = union([polygonA, polygonB]);
if (merged !== null) {
  const areaSquareMeters = area(merged);
  const marker = pointOnSurface(merged);
}

const band = buffer(road, 100, { segments: 32 });
```

関数は、することで分かれています。

- 測る: `distance`、`bearing`、`destination`、`midpoint`、`along`、
  `nearestPointOnLine`、`length`、`area`、`perimeter`、`centroid`、
  `pointOnSurface`
- 作る: `circle`、`buffer`
- 組み合わせる: `union`、`intersection`、`difference`、`split`
- 調べる: `pointInPolygon`、`overlaps`、`contains`、
  `bboxIntersects`、`bboxContains`
- 整える: `makeValid`、`rewind`、`simplify`
- 範囲と単位: `bbox`、`metersToDegrees`

描いた地物は、そのまま入力にできます。関数は、GeoJSON の Feature と
同じように、`geometry` の欄を持つものなら何でも使います。読むのは
地物の `type` でなく `geometry` なので、`Circle` はその幾何である
`Polygon` として測ります。関数が
受け取れない幾何の地物には `GeometryError` を投げるので、種類が
混ざるときは先に確かめます。

```ts
import { area, union } from '@sakuzu/maplibre-gl-draw/geometry';

const parcels = draw.features
  .list()
  .filter((f) => f.geometry.type === 'Polygon');
const total = parcels.reduce((sum, f) => sum + area(f), 0);
const merged = union(parcels);
```

### すべての関数で成り立つこと

- 同じ入力からは常に同じ出力が返ります。引数は変更せず、結果は
  新しいオブジェクトです
- 入力は GeoJSON の geometry か、`geometry` の欄を持つもの
  (GeoJSON の Feature、描いた地物) で、その geometry を使います。点は位置 `[lng, lat]` か `Point` で渡します。
  結果は GeoJSON の geometry で、面はパートが 1 つなら `Polygon`、
  複数なら `MultiPolygon` で返ります
- 長さ、距離、半径、許容の単位はメートル、面積は平方メートル、
  方位と座標は度です
- `null` は結果が空であることを表します。関数が受け取れない形の
  入力には、コード `invalid-input` を持つ `GeometryError` を
  投げます

<!-- docs-check:
declare const polygon: import('geojson').Polygon;
-->

```ts
import { buffer } from '@sakuzu/maplibre-gl-draw/geometry';

const shrunk = buffer(polygon, -50);
if (shrunk === null) {
  // 面が丸ごと消えた
}
```

- 壊れた入力は、先へ渡さずに入口で取り除きます。位置が 3 つに
  満たないリングや、有限の数でない座標は計算に届きません
- 面を組み合わせる関数は、結果を計算できないとき、コード
  `engine-failure` を持つ `GeometryError` を投げます
- 境界を共有するだけの面どうしは、重なっているとみなしません
- ±180° の経線をまたぐ形と、極の周辺は対象外です。そこでは
  `buffer` は `null` を返します
- 想定している規模は、編集中の地物が数個、データセットの行が
  数万件です。重い処理を Worker へ移すかどうかは呼び出し側で
  決めてください

## 関連する例

- [snapping-and-geometry](../../examples/snapping-and-geometry/)
  では、`snapping` の設定をし、`draw.options.update` で吸着、
  なぞり、共有頂点を切り替え、`union`、`difference`、`buffer`、
  `split` を実行し、`area` で面積を測ります

## リファレンス

- [`SnappingOptions`](../api/maplibre-gl-draw/interfaces/SnappingOptions.md)、
  [`SnapResult`](../api/maplibre-gl-draw/interfaces/SnapResult.md)、
  [`SnapProvider`](../api/maplibre-gl-draw/interfaces/SnapProvider.md)、
  [`SnapCandidate`](../api/maplibre-gl-draw/interfaces/SnapCandidate.md)
- [`TracingOptions`](../api/maplibre-gl-draw/interfaces/TracingOptions.md)
  と
  [`TopologyOptions`](../api/maplibre-gl-draw/interfaces/TopologyOptions.md)
- `union`、`difference`、`intersection`、`split`、`buffer` は
  [`FeaturesCollection`](../api/maplibre-gl-draw/interfaces/FeaturesCollection.md)
- [geometry の入口](../api/geometry/index.md)。たとえば
  [`buffer`](../api/geometry/functions/buffer.md) と
  [`GeometryError`](../api/geometry/classes/GeometryError.md)
