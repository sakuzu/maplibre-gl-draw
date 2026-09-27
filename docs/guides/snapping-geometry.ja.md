# 吸着と幾何演算

この手引きでは、描いた形どうしをぴったり合わせるための道具を
説明します。頂点、辺、交点、ガイド線への吸着、既存の
地物の境界のなぞり、共有頂点の同時移動、幾何演算
(結合、差し引き、交差、分割、バッファー) です。最後に
geometry モジュールを扱います。これは純粋関数の集まりで、
単独でも、ブラウザーの外でも使えます。

## 最小のコード

<!-- docs-check:
declare const statusBar: HTMLElement;
declare const parcelA: string;
declare const parcelB: string;
-->

```ts
import { createMapLibreGLDraw } from '@sakuzu/maplibre-gl-draw';

const draw = createMapLibreGLDraw(map, {
  snap: { tolerancePx: 12 },
  topology: { sharedVertexDrag: true },
});

draw.on('draw.snap.change', (result) => {
  statusBar.textContent = result.target ? result.target.kind : '';
});

// 選択した面を 1 つのフィーチャーに結合する
draw.select([parcelA, parcelB]);
const merged = draw.geometry.union(); // 新しいフィーチャーの ID か null
```

## 吸着

描画中と頂点のドラッグ中は、ポインターが近くのものに吸着し
ます。吸着は入力がライブラリーに入る所で行うので、どの描画
モードでも、独自のモードでも、頂点のドラッグでも、
`draw.input` から送った入力でも同じように働きます。

既定で有効です。

| `Options.snap` | 既定 | 意味 |
| --- | --- | --- |
| `enabled` | `true` | 吸着の有効と無効 |
| `tolerancePx` | `10` | どれだけ近ければ吸着するか (画面の画素) |
| `disableKey` | `'alt'` | 押している間は吸着しない |
| `kinds` | すべて `true` | 種類ごとの有効と無効 |
| `datasets` | `true` | データセットにも吸着する |
| `guideStepDegrees` | `45` | 真北を基準にしたガイドの刻みの角度 |

`disableKey` には `'alt'`、`'shift'`、`'ctrl'`、`'meta'`、
`'none'` のどれかを指定します。キーを押している間は何にも
吸着しないので、1 点をそのままの位置に置けます。許容距離は、
どの方向でも、どの緯度でも、画面上で同じ距離です。

同じ設定は、実行中に `draw.snapping` で変えられます。

```ts
draw.snapping.setEnabled(false);
draw.snapping.setKindEnabled('guide', false);
draw.snapping.setDatasetsEnabled(false);
draw.snapping.setGuideStep(15);
draw.snapping.getOptions(); // 現在の設定
```

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
- 非表示の地物には吸着しません (全員に対して非表示の
  ものも、ローカルで非表示のものも)
- 描いている途中の形はまだ地物ではないので、吸着し
  ません
- ドラッグ中の頂点は、自分自身と自分の辺には吸着しませんが、
  同じ地物のほかの頂点には吸着します。そのため、
  リングを最初の頂点で閉じられます
- 頂点の多い地物のハンドルは画面上で間引きますが、
  吸着はすべての頂点を対象にします
- フリーハンドでは、描線の始点と終点だけが吸着します。手で
  描いた線が近くの境界に引き寄せられることはありません

### ガイド線

`draw_line` と `draw_polygon` では、最後に置いた頂点からガイド
線が出ます。1 つ目の頂点を置いた後は真北から刻みの角度ごとに、
2 つ目の頂点を置いた後は直前の線分の延長方向と垂直方向にも
出ます。許容距離の中に実際の頂点、交点、辺があれば、ガイドより
そちらが優先されます。

刻みの角度は `Options.snap.guideStepDegrees` で決めます (既定は
45 度で 8 本、15 度なら 24 本)。実行中は
`draw.snapping.setGuideStep(degrees)` で変えられ、次の吸着
から反映されます。0 以下の値や有限でない値を渡すと 45 度に
なります。

組み込みのガイドに加えて、別の刻みの角度のガイドを足したい
ときは、`createGuideSnapProvider` でガイドの提供者を作り、
プラグインから登録します (提供者は描画中の形を
`ctx.getStore()` から読みます)。

### 利用者に見えるもの

吸着している間は、吸着先に記号を描きます。頂点は輪、辺は
正方形、交点は点、ガイドは小さな輪とその下の破線のガイド線
です。これらのスタイルは `DEFAULT_SNAP_INDICATOR_STYLES` と
`DEFAULT_SNAP_GUIDE_LINE_STYLE` として公開しています。

`draw.snap.change` は、結果が変わるたびに `SnapResult` を載せて
発火します。吸着が外れると `target` はありません。
`target.kind`、`target.featureId`、`target.datasetId` (表示
専用のデータのとき)、`target.description` で、何に吸着したか
がわかります。ガイドと交点の説明の文言はメッセージの表から
取ります ([スタイル](styles.ja.md#メッセージ))。

### 自前のデータに吸着させる

提供者 (provider) を使うと、どこからでも候補を足せます。
たとえば、地物として地図に載っていない道路網です。

<!-- docs-check:
declare function queryRoadVertices(bbox: unknown): [number, number][];
-->

```ts
import type { SnapProvider } from '@sakuzu/maplibre-gl-draw';

const roads: SnapProvider = {
  name: 'road-vertices',
  candidates: (bbox) =>
    queryRoadVertices(bbox).map((coordinate) => ({
      kind: 'vertex',
      coordinate,
      description: 'road',
    })),
};

const unregister = draw.snapping.register(roads);
```

- `bbox` はポインターの周りを許容距離だけ広げた範囲で、単位は
  度です。範囲の外の候補を返しても問題はありません。距離による
  絞り込みと優先順位の判定はライブラリーが行います
- 候補は点 (`coordinate`) か線分 (`start` と `end`。`edge` と
  `guide` で使います) です。線分の上で最も近い点はライブラリー
  が計算します
- `startRef` と `endRef` (両端の頂点の参照) を持つ線分は実際の
  辺として扱われ、そこに吸着したクリックから辺のなぞりを
  始められます
- 第 2 引数には、ポインター、画素と度で表した許容距離、ズーム、
  修飾キー、除外するもの (`excludeFeatureId`、
  `excludeFeatureIds`、`excludeVertex`) が入ります

独自の地物の型は、`getSnapTargets` で自分の候補を示し
ます ([独自の地物の型](custom-types.ja.md))。

`draw.snapping.resolve(lngLat)` を使うと、ポインター以外から
来た座標 (入力欄に打ち込んだ値など) を吸着に通して、結果を
受け取れます。

## 辺のなぞり

`draw_line` と `draw_polygon` で、前のクリックと今回のクリック
がどちらも既存の地物の境界に吸着したときは、その
2 点の間にある境界の頂点を挿入します。隣の区画を描くときは、
共有する境界の角を 2 つクリックするだけでよく、境界を描き直す
必要はありません。

- 経路は、近くにある表示中の地物の辺をたどる経路の
  うち、地表の距離で最短のものです。頂点をぴったり共有する
  地物どうしはつながっているとみなすので、経路は複数の
  地物にまたがることがあります
- 経路の端になれるのは、頂点と、頂点の参照を持つ辺だけです。
  ガイドと交点は端になれません
- 2 点がつながっていなければ、クリックはふつうの頂点になります
- ポインターを動かしている間は、挿入される頂点をプレビューに
  表示します
- 挿入した頂点はふつうの頂点なので、Backspace で 1 つずつ消せ
  ます
- なぞりには吸着が必要です。吸着が無効の間はなぞり
  ません

```ts
draw.tracing.setEnabled(false); // または Options.trace: { enabled: false }
```

## 共有頂点の同時移動

`topology.sharedVertexDrag` を有効にすると、頂点をドラッグした
とき、ぴったり同じ位置にあるほかの地物の頂点も一緒に
動きます。隣り合う 2 つの多角形の境界を、すき間も重なりも
作らずに編集できます。既定では無効です。

```ts
draw.topology.setSharedVertexDrag(true);
```

- 位置は厳密に一致する必要があります (許容距離 0)。近いだけの
  頂点は付いてきません
- 線、面、点と、それぞれの Multi の型は付いてきます。`Circle`、
  `Image`、`Freehand` は付いてきません
- ロックされた地物と非表示の地物は付いてきま
  せん
- 1 つの地物の中で同じ位置にある複数の頂点 (リングを
  閉じる頂点や、外側のリングに接する穴の頂点) はすべて動きます
- 付いてくる頂点はドラッグを始めた時点で決まり、ドラッグ中は
  強調表示されます。ドラッグを始めるときに吸着の
  `disableKey` を押していると、掴んだ頂点だけが動きます
- 移動全体が 1 つの変更になり、選択されるのは掴んだ地物
  だけです

## 幾何演算

`draw.geometry` はストアの地物を編集します。対象を選択
から取り、geometry モジュールで計算して、結果を 1 つの変更と
して書き込みます。

| メソッド | 対象 | 結果 |
| --- | --- | --- |
| `union(ids?)` | 2 つ以上の面 | 1 つ。入力は消える |
| `subtract(targetId?, ids?)` | 2 つ以上の面 | 1 つ。入力は消える |
| `intersect(ids?)` | 2 つ以上の面 | 1 つ。入力は消える |
| `split(targetId?, lineId?)` | 面 1 つと線 1 つ | 断片。面は消える |
| `buffer(ids?, options)` | どの形状でも | 入力ごとに 1 つ。入力は残る |

<!-- docs-check:
declare const back: string;
declare const front: string;
declare const parcelId: string;
declare const cutLineId: string;
declare function toast(message: string): void;
-->

```ts
draw.select([back, front]);
draw.geometry.subtract(); // 前面のものを最背面から切り抜く

draw.geometry.split(parcelId, cutLineId);

const zones = draw.geometry.buffer({ distanceMeters: 100 });
draw.geometry.buffer([parcelId], { distanceMeters: -5, segments: 32 });

draw.on('draw.geometry.applied', ({ operation, status, resultIds }) => {
  if (status === 'empty') toast(`${operation}: nothing left`);
});
```

### すべての演算に共通する規則

- ID を省くと、現在選択している地物が対象になります。
  面として扱うのは `Polygon`、`MultiPolygon`、`Circle` で、
  `split` の線として扱うのは `LineString`、`MultiLineString`、
  `Freehand` です
- ロックされた地物と非表示の地物は対象から外し
  ます。読み取り専用の間は何もしません
- 入力の削除と結果の作成は 1 つの変更で、1 つの通知として
  届きます
- 結果の地物が選択されます
- 結果が空のときは何も変えません。メソッドは `null` か `[]` を
  返し、`draw.geometry.applied` が `status: 'empty'` で発火
  します

### 結果の形

- 結果は、パートが 1 つなら `Polygon`、そうでなければ
  `MultiPolygon` です。離れた面を結合すると `MultiPolygon` に
  なり、内側を切り抜くと穴になります
- `union`、`subtract`、`intersect` の結果は、最も前面にある
  入力のスタイルとプロパティーを受け継ぎ、その入力があった場所
  (レイヤー、グループ、並び順の位置) に入ります。`targetId` を
  省いた `subtract` は、ほかの面を最背面の面から切り抜きます
- `Circle` の入力は 64 角形になり、`radiusMeters` はなくなり
  ます
- `split` は線を残し、断片を面のあった場所に面のスタイルと
  プロパティーで置きます。穴は、それを含む側の断片に残ります。
  面を横切らない線では何も変わりません
- `buffer` は地表のメートルで計算するので、どの緯度でも距離が
  保たれます。点は円盤に、線は帯になり、面は広がります。負の
  距離は面だけを縮め、距離の 2 倍より細い部分は消えます。
  `Circle` は半径を変えた `Circle` のままです。結果はそれぞれ
  入力のすぐ前面に、入力のスタイルで入ります

## geometry モジュール

`@sakuzu/maplibre-gl-draw/geometry` は、形状の計算を純粋関数と
して提供します。MapLibre、DOM、ストア、イベントには依存せず、
実行時の依存は `polygon-clipping` だけです。パッケージのうち
地図に関わる部分を読み込まずに import でき、Node と Bun でも
同じ結果になります。

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

// polygonA と polygonB は GeoJSON の Polygon (またはそれを持つ地物)
const merged = union([polygonA, polygonB]);
if (merged !== null) {
  const areaSquareMeters = area(merged);
  const labelAnchor = pointOnSurface(merged);
}

const band = buffer(road, 100, { segments: 32 });
```

含まれるのは、計測 (`distance`、`bearing`、`destination`、
`midpoint`、`along`、`nearestPointOnLine`、`length`、`area`、
`perimeter`、`centroid`、`pointOnSurface`)、形の生成 (`circle`、
`buffer`)、面の配列に対するブール演算 (`union`、`intersection`、
`difference`) と `split`、判定 (`pointInPolygon`、`overlaps`、
`contains`、`bboxIntersects`、`bboxContains`)、整形 (`makeValid`、
`rewind`、`simplify`)、そして `bbox` と `metersToDegrees` です。

### すべての関数で成り立つこと

- 同じ入力からは常に同じ出力が返ります。引数は変更せず、結果は
  新しいオブジェクトです
- 入力は GeoJSON の geometry か、geometry を持つ地物です。点は
  位置 `[lng, lat]` か `Point` で渡します。結果は GeoJSON の
  geometry で、面はパートが 1 つなら `Polygon`、複数なら
  `MultiPolygon` で返ります
- 長さ、距離、半径、許容の単位はメートル、面積は平方メートル、
  方位と座標は度です
- `null` は結果が空であることを表します。関数が受け取れない形の
  入力には、コード `invalid-input` を持つ `GeometryError` を
  投げます

<!-- docs-check:
declare const polygon: import('geojson').Polygon;
-->

```ts
const shrunk = buffer(polygon, -50);
if (shrunk === null) {
  // 面が丸ごと消えた
}
```

- 壊れた入力は、先へ渡さずに入口で取り除きます。位置が 3 つに
  満たないリングや、有限の数でない座標は計算に届きません
- ブール演算は、結果を計算できないとき、コード
  `engine-failure` を持つ `GeometryError` を投げます
- 境界を共有するだけの面どうしは、重なっているとみなしません
- ±180° の経線をまたぐ形と、極の周辺は対象外です。そこでは
  `buffer` は `null` を返します
- 想定している規模は、編集中の地物が数個、データセット
  の地物が数万件です。重い処理をワーカーへ移すかどうか
  は呼び出し側で決めてください

## 関連する例

- [snapping-and-geometry](../../examples/snapping-and-geometry/)
  では、`Options.snap` を設定し、`draw.snapping`、
  `draw.tracing`、`draw.topology` を切り替え、`union`、
  `subtract`、`buffer`、`split` を実行し、`area` で
  面積を測ります

## リファレンス

- [`SnapOptions`](../api/maplibre-gl-draw/interfaces/SnapOptions.md)、
  [`SnappingOperations`](../api/maplibre-gl-draw/interfaces/SnappingOperations.md)、
  [`SnapProvider`](../api/maplibre-gl-draw/interfaces/SnapProvider.md)、
  [`SnapResult`](../api/maplibre-gl-draw/interfaces/SnapResult.md)
- [`TracingOperations`](../api/maplibre-gl-draw/interfaces/TracingOperations.md)
  と
  [`TopologyOperations`](../api/maplibre-gl-draw/interfaces/TopologyOperations.md)
- [`GeometryOperations`](../api/maplibre-gl-draw/interfaces/GeometryOperations.md)
  と
  [`GeometryAppliedPayload`](../api/maplibre-gl-draw/interfaces/GeometryAppliedPayload.md)
- [geometry モジュール](../api/geometry/index.md)。
  たとえば [`buffer`](../api/geometry/functions/buffer.md)
  と [`GeometryError`](../api/geometry/classes/GeometryError.md)
