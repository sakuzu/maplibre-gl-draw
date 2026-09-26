# 大量のデータを表示する

データセットは、利用者が編集しない大量の地物を表示する
ためのものです。数万件の区画、地点の表、検索の結果などを表示
できます。描いた地物と同じ描画器、同じスタイル規則で描きますが、
Store とは別の経路なので、編集のための負担はまったくかかりま
せん。

データセットは Store に入りません。そのため、次の 4 つ
が成り立ちます。

- 編集できません。移動、頂点の編集、幾何演算のどれも
  できません
- `draw.feature.*` イベントを出さないので、Store の変更の
  購読者からは見えません
- Store の選択の対象にならず、ハンドルも外接枠も出ません
- `getAllFeatures()`、`export()`、保存の対象になりません

データセットの地物を編集したいときは、`addFeature` で Store へ
写します。2 つの写しの対応関係はライブラリーでは持ちません。

## 最小のコード

```ts
import { createMapLibreGLDraw } from '@sakuzu/maplibre-gl-draw';

const draw = createMapLibreGLDraw(map);

const parcels = draw.addDataset({
  id: 'parcels',
  features: [
    {
      id: 'p-1',
      type: 'Polygon',
      coordinates: [
        [
          [139.70, 35.68],
          [139.71, 35.68],
          [139.71, 35.69],
          [139.70, 35.68],
        ],
      ],
      properties: { population: 4200 },
    },
  ],
  styleRule: {
    kind: 'graduated',
    property: 'population',
    breaks: [1000, 5000, 10000],
    colors: ['#eff3ff', '#bdd7e7', '#6baed6', '#2171b5'],
    other: '#cccccc',
  },
  interactive: true,
});

parcels.on('click', ({ feature }) => {
  console.log(feature.id, feature.properties);
});
```

多角形は描いた地物の後ろに、`population` で塗り分けて描かれ
ます。クリックすると、その地物がログに出ます。地物の形は Store
の地物と同じ (`id`、`type`、`coordinates`、`properties`、
`style`) で、穴のある多角形や Multi 型も描けます。`layerId`、
`locked`、`visible` は省けます。3 つ目の要素 (GeoJSON の標高)
を持つ座標は、経度と緯度だけに切り詰めます。

## 静的な地物と provider

地物は、`features` で一度に渡すか、`provider` で必要になった
ときに渡します。両方を渡すと例外になります。大きな表は、型付き
配列の列として渡すこともできます。
[型付き配列の列で渡す](#型付き配列の列で渡す) を参照してください。

静的なデータセットの中身は、`setFeatures` で丸ごと置き換え
ます。一部だけを更新する方法はないので、新しい配列を作って
渡してください。

<!-- docs-check: with datasets -->

```ts
parcels.setFeatures(nextFeatures);
```

`provider` は、表示範囲が変わると範囲とズームを受け取って
呼ばれ、その範囲の地物を返します。

```ts
draw.addDataset({
  id: 'parcels',
  provider: async (bbox, zoom) => {
    const query = `${bbox.minX},${bbox.minY},${bbox.maxX},${bbox.maxY}`;
    const res = await fetch(`/api/parcels?bbox=${query}&z=${zoom}`);
    return res.json();
  },
});
```

- 呼び出しは間引かれます (200 ms)。パンやズームを続けても、
  呼ばれるのは最後の 1 回だけです
- 範囲は、整数のズームとタイルの境界に丸めます。同じタイルの
  中で動いても呼ばれません。渡される `bbox` は丸めた後の範囲
  です
- 結果はタイルの範囲ごとに、直近の 32 件をキャッシュします。
  一度取得した範囲に戻ったときは、呼び出さずに復元します
- 取得中は、前の結果を表示したままにします。ライブラリーは
  スピナーを出しません
- 反映するのは最新の要求への応答だけです。遅れて届いた古い応答
  は捨てます
- promise が reject されても表示は変えず、`console.error` に
  記録します

フィルターを変えたときなど、ほかの理由で provider が返すものが
変わったときは、`invalidateProviderCache()` を呼びます。
キャッシュを空にし、取得中の要求をその応答ごと捨てて、今の範囲
を取り直すので、地図を動かさなくても新しい中身が表示されます。

## 型付き配列の列で渡す

GeoParquet、Arrow、FlatGeobuf から読んだ表は、もともと列の集まり
です。渡すためだけに行ごとに地物のオブジェクトを作ると、描く
よりも時間がかかります。点が 100 万件なら、時間とメモリーの
大半がそこに使われます。`columnar` は、GeoArrow と同じ並びの
まま行を受け取ります。座標は 1 つの `Float64Array` に、行と
部分と環の区切りは `Int32Array` に、属性は列にします。

```ts
const places = draw.addDataset({
  id: 'places',
  columnar: {
    length: 3,
    geometry: {
      type: 'Point',
      coords: new Float64Array([139.70, 35.68, 139.71, 35.69, 139.72, 35.66]),
    },
    columns: {
      kind: { codes: new Uint8Array([0, 1, 0]), dictionary: ['shop', 'school'] },
      visitors: new Float64Array([3.5, 0.7, 3.0]),
    },
  },
  styleRule: {
    kind: 'categorical',
    property: 'kind',
    map: { shop: '#e15759', school: '#59a14f' },
    other: '#cccccc',
  },
});
```

1 つの幾何の列が持つ種類は 1 つです (行ごとに種類の違う表は
後で説明します)。区切りは、各行がどこから始まるかを外側から順に
表します。

| 種類 | `offsets` |
| --- | --- |
| `Point` | なし。行 `i` は座標 `i` です |
| `LineString`、`MultiPoint` | `[行 → 座標]` |
| `Polygon` | `[行 → 環, 環 → 座標]` |
| `MultiLineString` | `[行 → 部分, 部分 → 座標]` |
| `MultiPolygon` | `[行 → 多角形, 多角形 → 環, 環 → 座標]` |

行 `i` は、`properties` が各列の `i` 番目の値で、id が
`String(ids[i])` (`ids` の列が無ければ `String(i)`) の地物と
同じように振る舞います。そのため、スタイル規則、ベーススタイル、
`zoomScale`、間引き、重なりの順序、選択は、地物で渡したときと
同じように働きます。行は個別のスタイルを持ちません。列には、
数の型付き配列、辞書 (Arrow の辞書型と同じ `codes` と
`dictionary`)、普通の配列を使えます。浮動小数点の列では、NaN
は値が無いことを表します。幾何の無い行 (座標の範囲が空の行、
点なら座標が NaN の行、`validity` のビットが 0 の行) は、描かれ
ず、当たり判定にもかかりません。規則と自分のコードが読む列
だけを渡せば十分です。

データセットは配列を写さずに持ち、そのまま読みます。持っている
間は配列を書き換えず、表を替えるときは `setColumnar` を使って
ください。行は GPU の配列に直接詰められ、地物になるのは求め
られたときだけです。

- `click` と `hover` は、その行の地物と行の番号 `row` を渡します。
  行のほかの値は、自分の列から読んでください
- `getFeatures()` は全行を一度だけ地物にするので、地物で渡した
  ときと同じだけかかります。`collectVisible(bounds)` は範囲の中の
  行を地物にし、`collectDrawnRows(bounds)` はどの行も地物にしません
  ([行の番号で読む](#行の番号で読む) を見てください)。表示中の
  データへのスナップは `getFeatures()` を読みます
- `externalPointRender` は、点の行ごとにその地物を受け取ります
- 地形のある地図では、地形に沿って描く線と多角形を地物にします

### 種類の違う行を混ぜる

点、線、多角形が混ざったファイルのように、行ごとに幾何の種類が
違う表は、GeoArrow の混在する幾何の列 (Arrow の dense union) で
渡します。子の列は、それぞれ上で説明した 1 種類の幾何の列です。
行 `i` の幾何は、`types[i]` 番目の子の `offsets[i]` 番目の行です。

```ts
draw.addDataset({
  id: 'network',
  columnar: {
    length: 3,
    geometry: {
      type: 'Mixed',
      types: new Int8Array([1, 0, -1]),
      offsets: new Int32Array([0, 0, 0]),
      children: [
        { type: 'Point', coords: new Float64Array([139.70, 35.68]) },
        {
          type: 'LineString',
          coords: new Float64Array([139.71, 35.69, 139.72, 35.66]),
          offsets: [new Int32Array([0, 2])],
        },
      ],
    },
    columns: { name: ['route', 'station', 'unknown'] },
  },
});
```

行 `i` は、その子の種類の地物とまったく同じように振る舞います。
子の中の行の順序は自由で、描く順序は表の行の順序です。
`types[i]` が負の行は幾何を持たず、`validity` もその上で効きます。
`prepareDatasetColumnar` と `columnarTransferables` も、この形を
受け取ります。

### Worker で読む

データセットは描く前に、各行の外接矩形を計算し、行を空間の
チャンクに分け、当たり判定の空間索引を作ります。サブパス
`@sakuzu/maplibre-gl-draw/columnar` の `prepareDatasetColumnar`
は、この処理を表を読む場所で行います。このサブパスは maplibre
も WebGL も読み込まないので、Worker で使えます。
`columnarTransferables` は、写さずに移すバッファーの一覧を返し
ます。

<!-- docs-check:
declare function readTable(data: unknown): Promise<import('@sakuzu/maplibre-gl-draw').DatasetColumnarInput>;
-->

```ts
// worker.ts
import {
  columnarTransferables,
  prepareDatasetColumnar,
} from '@sakuzu/maplibre-gl-draw/columnar';

self.onmessage = async (event) => {
  const input = await readTable(event.data); // your reader returns a DatasetColumnarInput
  const prepared = prepareDatasetColumnar(input);
  const transfer = columnarTransferables(input, prepared);
  self.postMessage({ input, prepared }, { transfer });
};
```

<!-- docs-check: with datasets
declare const file: File;
-->

```ts
// main.ts
const worker = new Worker(new URL('./worker.ts', import.meta.url), {
  type: 'module',
});
worker.onmessage = (event) => {
  const { input, prepared } = event.data;
  places.setColumnar(input, prepared);
};
worker.postMessage(file);
```

`prepared` を渡すと、本体のスレッドはどれも計算し直さず、最初の
当たり判定のときには索引ができています。渡さなければ、
`setColumnar` が同じ配列を自分で計算します。`prepared` はその表
だけのもので、行の数が違う表のものを渡すと例外になります。

## スタイル

`styleRule` には、レイヤーと同じ規則 (`single`、`categorical`、
`graduated`、`continuous`。[スタイル](styles.ja.md) を参照して
ください) を指定します。規則が決めるのは色だけです。太さ、線の
種類、不透明度、点の大きさは `baseStyle` で指定します。
`baseStyle` はチャンネルごとに `FeatureStyle` の一部を持ち
ます。

<!-- docs-check: with datasets -->

```ts
parcels.setBaseStyle({
  stroke: { strokeWidth: 1, strokeColor: '#3366cc' },
  fill: { fillOpacity: 0.4 },
  point: { pointRadius: 4 },
});
```

優先順位は、地物自身の `style`、規則の色 (対応するチャンネル
だけ)、`baseStyle`、既定値の順です。`setStyleRule(undefined)`
と `setBaseStyle(undefined)` で取り除けます。

`zoomScale` は、大きさと不透明度に、ズームに応じた倍率を掛け
ます。毎フレーム評価しますが、バッチを作り直すことはありま
せん。

<!-- docs-check: with datasets -->

```ts
parcels.setZoomScale((zoom) => ({
  scale: zoom < 12 ? 0.5 : 1,
  opacity: 1,
}));
```

## 重なりの順序

`order` で、Store に対するデータセットの位置を決めます。

| order | 位置 |
| --- | --- |
| `below-store` | Store のすべてのレイヤーの後ろ (既定) |
| `above-store` | すべてのレイヤーの前、選択 UI の後ろ |
| `layer-order` | `setLayerOrder()` の中で自分の id がある位置 |

同じ側のデータセットは追加した順に描き、後から追加したものが
前に来ます。データセットの中では、配列の末尾が前になります。
`getDatasets()` はすべてのデータセットを後ろから前の
順に返します。`moveDataset` では、側、側の中での位置、
またはその両方を変えられます。並べ替えで作り直されるものは
ありません。順序か側が変わる並べ替えでは、後ろから前の順の id を
持つ `draw.dataset.reorder` が発火します。何も動かない呼び出し
では発火しません。

```ts
draw.moveDataset('parcels', { order: 'above-store' });
draw.moveDataset('parcels', { index: 0 }); // backmost of its side
```

`layer-order` のデータセットは、レイヤーの順序に自分の id が
含まれている間だけ描かれ、位置はその順序だけで決まります。

<!-- docs-check: with datasets -->

```ts
draw.addDataset({ id: 'parcels', features, order: 'layer-order' });
draw.setLayerOrder(['base', 'parcels', 'notes']);
```

データセットを削除しても、レイヤーの順序は変わりません。id は
`setLayerOrder` で自分で取り除いてください (残った id は無視
されます)。

レイヤーの順序は文書の一部ですが、データセットは文書に含まれません。
自前の形式は id をその位置ごと保存し、地物は保存しません。読み込んだ
後に同じ id でデータセットを追加し直せば、保存した位置に描かれます
([レイヤーとグループ](layers.ja.md) を参照)。

## 点の衝突による間引き

低いズームで大量の点を描くと、点どうしが重なります。
`collisionThinning` を使うと、画面上で重なる点のマーカーを
描かなくなります。

<!-- docs-check:
declare const features: import('@sakuzu/maplibre-gl-draw').DatasetFeatureInput[];
-->

```ts
const places = draw.addDataset({
  id: 'places',
  features,
  collisionThinning: { enabled: true, fullDisplayZoom: 17, marginPx: 2 },
});

const { total, visible } = places.getThinningStats();
```

- 重なりの判定には描画する大きさ (半径、縁取り、余白) を使う
  ので、マーカーが大きいほど多く間引かれます
- 残す点は、整数のズームごとに、表示範囲ではなくすべての地物
  から決めます。そのため、パンしても入れ替わりません。前にある
  ものが残ります
- 間引くのは `Point` だけです。線、多角形、`MultiPoint` は常に
  描きます
- `fullDisplayZoom` (17) 以上では、すべての点を描きます
- 残す点を選び直すのは、地物かスタイルが変わったときと、ズーム
  やピッチの操作が終わったときです。操作の途中では選び直しま
  せん

間引かれた点は描かれず、クリックも当たりません。
`getVisibleFeatureIds` でどの点が描かれているかがわかるので、描かれて
いる点にだけラベルを付けたいホストで使えます。`getThinningStats` で
その数がわかります。画面の写しのように、決まったズームで 1 枚だけ
描くときは、先に `refreshThinning(zoom)` を呼んでください。

## クリック、ホバー、選択

`click` と `hover` は、`interactive: true` のときだけ発火し
ます。`hover` は、対象が変わったときに発火し、対象からポインター
が離れたときにも `feature: null` で 1 回発火します。どちらも
地物の行の番号 `row` を渡します。渡した地物 (または provider
の結果) の中の位置か、列の形の表の行です。`on` は購読を解除
する関数を返します。

<!-- docs-check: with datasets -->

```ts
places.on('hover', ({ feature }) => {
  map.getCanvas().style.cursor = feature ? 'pointer' : '';
});
```

表示中のデータセットは、`interactive` かどうかにかかわらず、
下にある地物へのクリックを遮ります。クリックを受け取るのは 1 つ
だけで、Store の地物かデータセットの地物かを問わず、見えている
もののうち最も前面にある地物です。データセットが受け取った
ときは、何も無い所をクリックしたときと同じように、Store の
選択が解除されます。インスタンスのイベント `draw.dataset.click`
は、選択モードでのクリックのうち、Store に当たらなかったものを
すべて知らせます。当たったデータセットと地物が届き、何にも
当たらなかったときは両方とも `null` です。

`setSelectedIds` で、データセットの地物を強調表示できます。
これはデータセットだけの状態で、Store の選択とは別です。バッチ
を作り直すこともありません。

<!-- docs-check: with datasets -->

```ts
places.setSelectedIds(['place-12']);
places.setSelectedIds([]); // clear
```

`change` イベントは、`interactive` にかかわらず、地物、スタイル、
表示状態、選択、間引きで残す点のどれかが変わると発火します。
どれが変わったかは `reason` でわかります。ラベルなど、コレク
ションをもとに作るものを作り直すときに使ってください。
`collectVisible(bounds)` は、範囲の中の地物を、描画順に、
スタイルを当てた形で返します。処理の重さは、全体の件数ではなく
範囲の中の件数で決まります。

## 行の番号で読む

点の横に文字を置くときのように、描かれているものだけを見て回る
コードは、データセットを行の番号で読み、残すと決めた行だけを地物
にできます。`collectDrawnRows(bounds)` は、範囲にかかり、いま
描かれている行を、描画順に返します。幾何を持ち、隠されておらず、
衝突による間引きで残った行です。`collectVisible(bounds)` を
`getVisibleFeatureIds()` で絞ったものと同じ行ですが、地物を作らない
ので、処理の重さは範囲の中の行の数で決まります。

1 つの行を読むメソッドも、その行を地物にしません。`getRowId`、
`getRowType`、`getRowBounds` (空間索引が持つ外接矩形)、
`getRowPoint` (`Point` の `[lng, lat]`) があります。
`getRowFeature` は、行を、スタイルを当てた地物にします。
`collectVisible` が返すものと同じです。行の番号は `click` と
`hover` の `row` と同じで、中身が差し替えられるまで変わりません。

<!-- docs-check: with datasets -->

```ts
// 0.01 度の升目ごとに、描画順で最初の点を選ぶ
const extent = { minX: 139.6, minY: 35.6, maxX: 139.9, maxY: 35.8 };
const taken = new Set<string>();
const names: string[] = [];
for (const row of places.collectDrawnRows(extent)) {
  const point = places.getRowPoint(row);
  if (!point) continue;
  const cell = `${Math.floor(point[0] / 0.01)}:${Math.floor(point[1] / 0.01)}`;
  if (taken.has(cell)) continue;
  taken.add(cell);
  const feature = places.getRowFeature(row);
  if (feature) names.push(String(feature.properties.name));
}
```

## 表示と非表示

`setVisible(false)` にすると描画と当たり判定は止まりますが、
地物と GPU の資源は持ったままです。そのため、
`setVisible(true)` にすると次のフレームで表示されます。非表示の
間も、`setFeatures`、`setStyleRule`、provider は働きます。
`remove()` (または `removeDataset(id)`) で、すべてを
解放します。

## データセットの追加と削除を追う

データセットを追加すると `draw.dataset.add` が、削除すると
`draw.dataset.remove` が発火します。どちらも `datasetId` を
持ちます。追加のイベントが届いた時点で `getDataset` は
そのデータセットを返し、削除のイベントが届いた時点ではもう返し
ません。データセットの並べ替え (こちらは `draw.dataset.reorder`) や
中身の変更では、どちらも発火しません。購読する前からあるデータセットは知らされないので、
最初に `getDatasets()` を一度たどってから、イベントを
追ってください。

<!-- docs-check:
type Dataset = import('@sakuzu/maplibre-gl-draw').Dataset;
declare function watch(dataset: Dataset): () => void;
-->

```ts
const stops = new Map<string, () => void>();
const follow = (id: string): void => {
  const dataset = draw.getDataset(id);
  if (dataset) stops.set(id, watch(dataset));
};

for (const dataset of draw.getDatasets()) follow(dataset.id);
draw.on('draw.dataset.add', ({ datasetId }) => follow(datasetId));
draw.on('draw.dataset.remove', ({ datasetId }) => {
  stops.get(datasetId)?.();
  stops.delete(datasetId);
});
```

同じ id で削除して追加し直したデータセットは別のオブジェクト
なので、削除と追加の 2 つのイベントとして届きます。

## 点を自分で描く

`externalPointRender` には述語を指定します。述語が true を
返した `Point` はライブラリーが描かないので、自分の描画器で
描きます。その点も間引き、当たり判定、選択の対象には残るので、
振る舞いは変わりません。後から `setExternalPointRender` で差し
替えられます。

<!-- docs-check: with datasets -->

```ts
draw.addDataset({
  id: 'stations',
  features,
  externalPointRender: (feature) => feature.properties.kind === 'station',
});
```

## 読み取り専用、ロック、ローカル非表示との関係

データセットは、[読み取り専用](read-only.ja.md) で説明
した 3 つの状態の対象外です。Store が読み取り専用でも追加と
置き換えができ、操作ロック中も `click` と `hover` は発火し、
ローカル非表示は効きません。表示と非表示は、`setVisible` か、
データセットの削除で切り替えます。

## 関連する例

- [examples/large-data/](../../examples/large-data/) では、
  5 万件の静的な多角形と、provider を使うデータセットを追加し、
  スタイル規則、間引き、クリック、並べ替えを試せます
- [examples/columnar-worker/](../../examples/columnar-worker/)
  では、20 万件か 100 万件の点を Worker で列として作り、そこで
  下ごしらえをして、写さずに渡します

Store とデータセットのどちらを選ぶかの規模の目安は、
[性能](performance.ja.md) を参照してください。

## リファレンス

- [addDataset](../reference/api/interfaces/index.MapLibreGLDraw.html)
  と、`MapLibreGLDraw` のそのほかのデータセットのメソッド
- [Dataset](../reference/api/interfaces/index.Dataset.html)
- [DatasetOptions](../reference/api/interfaces/index.DatasetOptions.html)
- [DatasetColumnarInput](../reference/api/interfaces/index.DatasetColumnarInput.html)
  と [prepareDatasetColumnar](../reference/api/functions/columnar.prepareDatasetColumnar.html)
- [DatasetCollisionThinning](../reference/api/interfaces/index.DatasetCollisionThinning.html)
- [DatasetChangePayload](../reference/api/interfaces/index.DatasetChangePayload.html)
- `draw.dataset.click`、`draw.dataset.add`、`draw.dataset.remove`、
  `draw.dataset.reorder` については [イベント](../reference/events.md)
