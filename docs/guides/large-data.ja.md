# 大量のデータを表示する

データセットは、大きなデータを、編集の対象にしない代わりに速く表示
します。数万件の区画、100 万件の点、サーバーの検索結果などです。
全部を一度に渡すほか、地図を動かすたびに見えている範囲の分だけ
取り寄せることもできます。見た目は描いた地物と同じスタイル規則で
決められ、クリックすると属性を読めます。

このガイドでは、まずデータセットを使う場面と速い理由を説明します。
その後で、データの渡し方、見た目の決め方、読み出し方を順に説明
します。

## データセットを使う場面

表示はするけれど編集はしないデータに使います。たとえば次のような
場面です。

- 市の 5 万件の区画を、土地の用途で塗り分けて描いた地物の後ろに敷くとき。
  利用者がその上に新しい境界を描くと、区画の辺や頂点に吸着します
- GeoParquet のファイルから読んだ 100 万件のセンサーの点を表示する
  とき
- 行政界を背景として表示するとき
- サーバーにある点を、地図を動かすたびに見えている範囲の分だけ
  取り寄せて表示するとき

利用者が描いて編集するものは、Store に入れます。データセットの
地物を 1 つだけ編集したいときは、`addFeature` で Store へ写します。2 つの写しの対応関係は、ライブラリーでは持ちません。

## 描いた地物との違い

| | 描いた地物 | データセット |
| --- | --- | --- |
| 編集 | 移動、頂点の編集、幾何演算 | できない |
| イベント | 変更のたびに `draw.feature.*` | データセットの `click`、`hover`、`change` |
| 選択 | 枠とハンドルの付いた選択 | 強調表示だけ (`setSelectedIds`) |
| 保存 | `export()`、`getAllFeatures()` | されない。レイヤーの順序の中の id だけ |
| 規模 | 20 万件でも編集できる | 数万件から 100 万件以上 |

データセットが速いのは、編集に要る処理をすべて省き、専用の経路で
描くからです。

- 行を空間のチャンクに分けます。チャンクはフレームごとに決まった
  時間の中で少しずつ GPU に送るので、大きなデータセットはタイルが
  届くように少しずつ現れ、画面は止まりません
- 描くのは見えているチャンクだけです
- 列の形で渡した表は、型付き配列から GPU の配列へ直接詰めるので、
  行ごとにオブジェクトを作りません。描く前の下ごしらえ (外接矩形、
  チャンク、空間索引) は Worker でできます
- provider を使うと、見えている範囲の地物だけを持つので、元の
  データ全体の大きさは関係ありません

## 最小のコード

```ts
import { createMapLibreGLDraw } from '@sakuzu/maplibre-gl-draw';

const draw = createMapLibreGLDraw(map);

const parcels = draw.addDataset({
  id: 'parcels',
  rows: [
    {
      type: 'Feature',
      id: 'p-1',
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [139.70, 35.68],
            [139.71, 35.68],
            [139.71, 35.69],
            [139.70, 35.68],
          ],
        ],
      },
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

多角形は描いた地物の後ろに、`population` で塗り分けて描かれます。
クリックすると、その id と属性がログに出ます。

## データを渡す 3 つの方法

手元のデータの形に合わせて選びます。渡せるのは 3 つのうち 1 つだけ
で、2 つ渡すと例外になります。

| 手元のデータ | オプション | 置き換え方 |
| --- | --- | --- |
| GeoJSON の地物の配列 | `rows` | `setRows` |
| GeoParquet、Arrow、FlatGeobuf の表 | `table` | `setTable` |
| 範囲を渡すと答えるサーバー | `provider` | `invalidateProviderCache` |

### 地物の配列で渡す

行は GeoJSON の地物 (`id`、`geometry`、`properties`) で、穴のある
多角形や Multi 型も渡せます。行ごとのスタイルを `style` に持たせる
こともできます。幾何の無い行は、位置を保ちますが、描かれず、クリック
も当たりません。3 つ目の要素 (標高) を持つ座標は、経度と緯度だけに
切り詰めます。

中身は `setRows` で丸ごと置き換えます。一部だけを更新する方法は
ないので、新しい配列を作って渡してください。

<!-- docs-check: with datasets -->

```ts
parcels.setRows(nextRows);
```

### 表を列の形で渡す

GeoParquet、Arrow、FlatGeobuf から読んだ表は、もともと列の集まり
です。渡すためだけに行ごとに地物のオブジェクトを作ると、描くよりも
時間がかかります。点が 100 万件なら、時間とメモリーの大半がそこに
使われます。`table` は、GeoArrow と同じ並びのまま行を受け取り
ます。座標は 1 つの `Float64Array` に、行と部分と環の区切りは
`Int32Array` に、属性は列にします。サブパス
`@sakuzu/maplibre-gl-draw/table` の `tableFromFeatures` と
`createTableBuilder` は、GeoJSON からこの並びを作ります。

```ts
const places = draw.addDataset({
  id: 'places',
  table: {
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

1 つの幾何の列が持つ種類は 1 つです。区切りは、各行がどこから
始まるかを外側から順に表します。

| 種類 | `offsets` |
| --- | --- |
| `Point` | なし。行 `i` は座標 `i` です |
| `LineString`、`MultiPoint` | `[行 → 座標]` |
| `Polygon` | `[行 → 環, 環 → 座標]` |
| `MultiLineString` | `[行 → 部分, 部分 → 座標]` |
| `MultiPolygon` | `[行 → 多角形, 多角形 → 環, 環 → 座標]` |

行 `i` は、`properties` が各列の `i` 番目の値で、id が
`String(ids[i])` (`ids` の列が無ければ `String(i)`) の地物と同じ
ように振る舞います。そのため、スタイル規則、ベーススタイル、
`zoomScale`、間引き、重なりの順序、選択は、地物で渡したときと同じ
ように働きます。行は個別のスタイルを持ちません。

- 列には、数の型付き配列、辞書 (Arrow の辞書型と同じ `codes` と
  `dictionary`)、普通の配列を使えます。浮動小数点の列では、NaN は
  値が無いことを表します
- 幾何の無い行 (座標の範囲が空の行、点なら座標が NaN の行、
  `validity` のビットが 0 の行) は、描かれず、クリックも当たりません
- 渡すのは、規則と自分のコードが読む列だけで十分です

データセットは配列を写さずに持ち、そのまま読みます。持っている間は
配列を書き換えず、表を替えるときは `setTable` を使ってください。
行が地物のオブジェクトになるのは、求められたときだけです。

- `click` と `hover` は、その行の地物と行の番号 `row` を渡します。
  行のほかの値は、自分の列から読んでください
- `getFeatures()` は全行を一度だけ地物にするので、地物で渡したとき
  と同じだけかかります。`collectVisible(bounds)` は範囲の中の行を
  地物にし、`collectDrawnRows(bounds)` はどの行も地物にしません
  ([行の番号で読む](#行の番号で読む) を参照)。データセットへの吸着は
  `getFeatures()` を読みます
- `externalPointRender` は、点の行ごとにその地物を受け取ります
- 地形のある地図では、地形に沿って描く線と多角形を地物にします

### 種類の違う行が混ざった表

点、線、多角形が行ごとに混ざったファイルは、GeoArrow の混在する
幾何の列 (Arrow の dense union) で渡します。種類ごとに分ける必要は
ありません。子の列は、それぞれ上で説明した 1 種類の幾何の列です。
行 `i` の幾何は、`types[i]` 番目の子の `offsets[i]` 番目の行です。

```ts
draw.addDataset({
  id: 'network',
  table: {
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

- 行 `i` は、その子の種類の地物とまったく同じように振る舞います
- 子の中の行の順序は自由です。描く順序は表の行の順序です
- `types[i]` が負の行は幾何を持ちません。`validity` もその上で効き
  ます
- `prepareTable` と `transferList` も、この形を受け取ります

### 表を Worker で読む

データセットは描く前に、各行の外接矩形を計算し、行を空間のチャンク
に分け、クリックのための空間索引を作ります。大きな表ではこれに画面
が止まるほどの時間がかかるので、表を読む場所で済ませます。サブパス
`@sakuzu/maplibre-gl-draw/table` の `prepareTable` がこの処理をし、
結果を表と一緒に返します。このサブパスは maplibre も WebGL も読み
込まないので、Worker で使えます。`transferList` は、写さずに移す
バッファーの一覧を返します。

<!-- docs-check:
declare function readTable(data: unknown): Promise<import('@sakuzu/maplibre-gl-draw/table').Table>;
-->

```ts
// worker.ts
import { prepareTable, transferList } from '@sakuzu/maplibre-gl-draw/table';

self.onmessage = async (event) => {
  const table = await readTable(event.data); // your reader returns a Table
  const prepared = prepareTable(table);
  self.postMessage(prepared, { transfer: transferList(prepared) });
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
  places.setTable(event.data);
};
worker.postMessage(file);
```

下ごしらえ済みの表を渡すと、本体のスレッドはどれも計算し直さず、
最初のクリックのときには索引ができています。下ごしらえをしていない
表なら、`setTable` が同じ配列を自分で計算します。`addDataset` でも、
どちらも `table` オプションで渡せます。

### 見えている範囲の分だけ取り寄せる

`provider` は、地図の見えている範囲が変わると、その範囲とズームを
受け取って呼ばれ、その範囲の地物を返します。

```ts
draw.addDataset({
  id: 'parcels',
  provider: async (bbox, zoom) => {
    const query = `${bbox.minX},${bbox.minY},${bbox.maxX},${bbox.maxY}`;
    const res = await fetch(`/api/parcels?bbox=${query}&z=${zoom}`);
    return (await res.json()).features;
  },
});
```

- 呼び出しは間引かれます (200 ms)。パンやズームを続けても、呼ばれる
  のは最後の 1 回だけです
- 範囲は、整数のズームとタイルの境界に丸めます。同じタイルの中で
  動いても呼ばれません。渡される `bbox` は丸めた後の範囲です
- 結果はタイルの範囲ごとに、直近の 32 件をキャッシュします。一度
  取得した範囲に戻ったときは、呼び出さずに復元します
- 取得中は、前の結果を表示したままにします。ライブラリーはスピナー
  を出しません
- 反映するのは最新の要求への応答だけです。遅れて届いた古い応答は
  捨てます
- promise が reject されても表示は変えず、`console.error` に記録
  します

フィルターを変えたときなど、ほかの理由で provider が返すものが
変わったときは、`invalidateProviderCache()` を呼びます。キャッシュ
を空にし、取得中の要求をその応答ごと捨てて、今の範囲を取り直すので、
地図を動かさなくても新しい中身が表示されます。

## スタイル

`styleRule` には、レイヤーと同じ規則 (`single`、`categorical`、
`graduated`、`continuous`。[スタイル](styles.ja.md) を参照) を指定
します。規則が決めるのは色だけです。太さ、線の種類、不透明度、点の
大きさは `baseStyle` で指定します。`baseStyle` はチャンネルごとに
`FeatureStyle` の一部を持ちます。

<!-- docs-check: with datasets -->

```ts
parcels.setBaseStyle({
  stroke: { strokeWidth: 1, strokeColor: '#3366cc' },
  fill: { fillOpacity: 0.4 },
  point: { pointRadius: 4 },
});
```

同じものを複数が決めているときは、次の並びで上にあるものが勝ち
ます。

1. 地物自身の `style`
2. 規則の色 (対応するチャンネルだけ)
3. `baseStyle`
4. 既定値

`setStyleRule(undefined)` と `setBaseStyle(undefined)` で取り除け
ます。

`zoomScale` は、大きさと不透明度に、ズームに応じた倍率を掛けます。
毎フレーム評価しますが、バッチを作り直すことはありません。

<!-- docs-check: with datasets -->

```ts
parcels.setZoomScale((zoom) => ({
  scale: zoom < 12 ? 0.5 : 1,
  opacity: 1,
}));
```

## 描いた地物との重なりの順序

`order` で、描いた地物に対するデータセットの位置を決めます。

| order | 位置 |
| --- | --- |
| `below-store` | Store のすべてのレイヤーの後ろ (既定) |
| `above-store` | すべてのレイヤーの前、選択 UI の後ろ |
| `layer-order` | `setLayerOrder()` の中で自分の id がある位置 |

同じ側のデータセットは追加した順に描き、後から追加したものが前に
来ます。データセットの中では、配列の末尾 (表なら最後の行) が前に
なります。`getDatasets()` はすべてのデータセットを後ろから前の順に
返します。`moveDataset` では、側、側の中での位置、またはその両方を
変えられます。並べ替えで作り直されるものはありません。順序か側が
変わる並べ替えでは、後ろから前の順の id を持つ
`draw.dataset.reorder` が発火します。何も動かない呼び出しでは発火
しません。

```ts
draw.moveDataset('parcels', { order: 'above-store' });
draw.moveDataset('parcels', { index: 0 }); // backmost of its side
```

`layer-order` のデータセットは、レイヤーの順序に自分の id が含まれて
いる間だけ描かれ、位置はその順序だけで決まります。

<!-- docs-check: with datasets -->

```ts
draw.addDataset({ id: 'parcels', rows, order: 'layer-order' });
draw.setLayerOrder(['base', 'parcels', 'notes']);
```

データセットを削除しても、レイヤーの順序は変わりません。id は
`setLayerOrder` で自分で取り除いてください (残った id は無視され
ます)。

レイヤーの順序は文書の一部ですが、データセットは文書に含まれません。
自前の形式は id をその位置ごと保存し、地物は保存しません。読み込んだ
後に同じ id でデータセットを追加し直せば、保存した位置に描かれます
([レイヤーとグループ](layers.ja.md) を参照)。

## 重なる点の間引き

低いズームで大量の点を描くと、点どうしが重なり、塗りつぶしたような
塊になります。`collisionThinning` を使うと、点の一部だけを描きます。
2 つの点のマーカーが画面上で重なるところでは、前にある点を描き、
もう一方は描きません。ズームインすると点どうしが離れるので、描く点が
増えます。

<!-- docs-check:
declare const rows: import('@sakuzu/maplibre-gl-draw').DatasetRow[];
-->

```ts
const places = draw.addDataset({
  id: 'places',
  rows,
  collisionThinning: { enabled: true, fullDisplayZoom: 17, marginPx: 2 },
});

const { total, visible } = places.getThinningStats();
```

- 重なりの判定には描く大きさ (半径、縁取り、`marginPx`) を使うので、
  マーカーが大きいほど多く間引かれます
- 間引くのは `Point` だけです。線、多角形、`MultiPoint` は常に描き
  ます
- `fullDisplayZoom` (17) 以上では、すべての点を描きます
- 間引かれた点は描かれず、クリックも当たりません
- 何件のうち何件を描いているかは `getThinningStats()` でわかります。
  「5 万件のうち 1,200 件を表示」のような表示に使えます

### どの点がいつ描かれるか

描く点は、見えている範囲ではなくすべての点から、整数のズームごとに
選びます。そのため、パンしても入れ替わりません。

どのフレームも、そのフレームを描くズームから整数のズームを決め、その
ズームで選んだ点を描きます。ズームやピッチの操作の途中でも同じです。
近くの整数のズームの分は、ページが空いている間に先に選んでおくので、
そこへ移るときに選ぶ時間はかかりません。地物、スタイル、ズームごとの
倍率、設定が変わったときは、その場で選び直し、次のフレームで描き
ます。

そのため、カメラが動いたときも、決まったカメラで画像を撮る前も、
呼ぶものはありません。その画像を描くフレームが、描く点を決めます。
どの行が描かれているかは、行の番号で読んで確かめます
([行の番号で読む](#行の番号で読む))。変わったかどうかは
`getDrawnRowsRevision()` でわかります。

## クリック、ホバー、選択

`click` と `hover` は、`interactive: true` のときだけ発火します。
`hover` は、対象が変わったときに発火し、対象からポインターが離れた
ときにも `feature: null` で 1 回発火します。どちらも地物の行の番号
`row` を渡します。渡した地物 (または provider の結果) の中の位置か、
列の形の表の行です。`on` は購読を解除する関数を返します。

<!-- docs-check: with datasets -->

```ts
places.on('hover', ({ feature }) => {
  map.getCanvas().style.cursor = feature ? 'pointer' : '';
});
```

1 回のクリックを受け取るのは 1 つだけです。描いた地物かデータセット
の地物かを問わず、見えているもののうち最も前にある地物が受け取り
ます。

- 表示中のデータセットは、`interactive` かどうかにかかわらず、下に
  ある地物へのクリックを遮ります
- データセットが受け取ったときは、何も無い所をクリックしたときと
  同じように、Store の選択が解除されます
- インスタンスのイベント `draw.dataset.click` は、選択モードでの
  クリックのうち、描いた地物に当たらなかったものをすべて知らせます。
  当たったデータセットと地物が届き、何にも当たらなかったときは両方
  とも `null` です

`setSelectedIds` で、データセットの地物を強調表示できます。これは
データセットだけの状態で、Store の選択とは別です。バッチを作り直す
こともありません。

<!-- docs-check: with datasets -->

```ts
places.setSelectedIds(['place-12']);
places.setSelectedIds([]); // clear
```

`change` イベントは、`interactive` にかかわらず、地物、スタイル、
表示状態、選択、間引きで描く点のどれかが変わると発火します。どれが
変わったかは `reason` でわかります。ラベルなど、データセットをもとに
作るものを作り直すときに使ってください。自分で変えたときはその場で
発火し、カメラが別の整数のズームに入ったときは、新しい点を描いた
フレームの直後に発火します (`thinning`)。

`collectVisible(bounds)` は、範囲の中の地物を、描画順に、スタイルを
当てた形で返します。処理の重さは、全体の件数ではなく範囲の中の件数で
決まります。

## 行の番号で読む

点の横に文字を置くときのように、描かれているものだけを見て回る
コードは、データセットを行の番号で読み、残すと決めた行だけを地物に
できます。

`collectDrawnRows(bounds)` は、範囲にかかり、いま描かれている行を、
描画順に返します。幾何を持ち、隠されておらず、間引きで残った行です。
地物を作らないので、処理の重さは範囲の中の行の数で決まります。「いま
描かれている」とは、最後のフレームの行のことです。フレームは何かを
描く前に整数のズームを決めるので、同じフレームで描くレイヤーは、
そのフレームが描く行を読めます。

`getDrawnRowsRevision()` は、描く行が変わるたびに進む数です (中身を
差し替えたときや、間引きで描く点が変わったとき)。読むのに手間はかからないので、
描く行から作ったものはこの数と一緒に持ち、数が変わったら作り直して
ください。`getVisibleFeatureIds()` は同じ行を id の集合で返しますが、
変わった後の最初の呼び出しで全部の行を 1 回なめて作ります。この集合
やその同一性を、作ったものの鍵に使わないでください。

<!-- docs-check: with datasets -->

```ts
// 描く行が変わったときだけ、文字を置き直す
let placedFor = -1;
function placeText(): void {
  const revision = places.getDrawnRowsRevision();
  if (revision === placedFor) return;
  placedFor = revision;
  // ... places.collectDrawnRows(extent) を見て回り、文字を置く
}
```

1 つの行を読むメソッドも、その行を地物にしません。

| メソッド | 返すもの |
| --- | --- |
| `getRowId(row)` | id |
| `getRowType(row)` | 幾何の種類 |
| `getRowBounds(row)` | 空間索引が持つ外接矩形 |
| `getRowPoint(row)` | `Point` の `[lng, lat]` |
| `getRow(row)` | スタイルを当てた地物。`collectVisible` が返すものと同じ |
| `findRow(id)` | id の行。無ければ `null` (最初の呼び出しで id の索引を作る) |

行の番号は `click` と `hover` の `row` と同じで、中身が差し替えられる
まで変わりません。

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
  const feature = places.getRow(row);
  if (feature) names.push(String(feature.properties.name));
}
```

## 表示と非表示

`setVisible(false)` にすると描画と当たり判定は止まりますが、地物と
GPU の資源は持ったままです。そのため、`setVisible(true)` にすると
次のフレームで表示されます。非表示の間も、`setRows`、
`setStyleRule`、provider は働きます。`remove()` (または
`removeDataset(id)`) で、すべてを解放します。

## データセットの追加と削除を追う

データセットを追加すると `draw.dataset.add` が、削除すると
`draw.dataset.remove` が発火します。どちらも `datasetId` を持ち
ます。追加のイベントが届いた時点で `getDataset` はそのデータセット
を返し、削除のイベントが届いた時点ではもう返しません。データセットの
並べ替え (こちらは `draw.dataset.reorder`) や中身の変更では、どちらも
発火しません。購読する前からあるデータセットは知らされないので、最初
に `getDatasets()` を一度たどってから、イベントを追ってください。

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

同じ id で削除して追加し直したデータセットは別のオブジェクトなので、
削除と追加の 2 つのイベントとして届きます。

## 点を自分で描く

`externalPointRender` には述語を指定します。述語が true を返した
`Point` はライブラリーが描かないので、自分の描画器で描きます。その
点も間引き、当たり判定、選択の対象には残るので、振る舞いは変わり
ません。後から `setExternalPointRender` で差し替えられます。

<!-- docs-check: with datasets -->

```ts
draw.addDataset({
  id: 'stations',
  rows,
  externalPointRender: (feature) => feature.properties.kind === 'station',
});
```

## 印刷やサムネイルのために描く

画面の上では、大きなデータセットは何フレームかかけて少しずつ現れ
ます。印刷やサムネイルのために絵を取り出す地図では、
`renderingStyle.timeSlicing` を `false` にします。すると、どの
フレームも見えているチャンクをすべて作ってから描きます。そのうえで、
地図の `idle` を待ち、さらに `hasPendingWork()` が false になるまで
待ちます。provider の応答を待つのもこれに含まれます。

```ts
async function whenPictureComplete(): Promise<void> {
  map.triggerRepaint();
  await map.once('idle');
  while (draw.hasPendingWork()) await map.once('render');
}
```

間引きのために呼ぶものはありません。描く点はそのフレームが決めます。
詳しくは [性能](performance.ja.md#絵を取り出すための完全なフレーム) を
参照してください。

## 読み取り専用とロック

データセットは、[読み取り専用](read-only.ja.md) で説明した 3 つの
状態の対象外です。Store が読み取り専用でも追加と置き換えができ、
操作ロック中も `click` と `hover` は発火し、ローカル非表示は効き
ません。表示と非表示は、`setVisible` か、データセットの削除で切り
替えます。

## 制約

- データセットは編集できません。編集したい地物は `addFeature` で
  Store へ写します
- 中身は丸ごと置き換えます。一部だけを更新する方法はありません
- 保存も書き出しもされません。データそのものか、取り寄せた場所を
  自分で持っておき、読み込んだ後にデータセットを追加し直します
- 列の形の表の行は、個別のスタイルを持てません
- 間引くのは `Point` だけです
- 列の形の表は写さずに読むので、データセットが持っている間は配列を
  書き換えないでください

## 例

- [データセット](../../examples/large-data/) では、属性で色を分けた
  5 万のマス目と、見えている範囲の分だけ取り寄せる点を表示し、
  間引き、クリック、並べ替えを試せます
- [100 万の点](../../examples/table-worker/) では、20 万件か
  100 万件の点を Worker で列として作り、そこで下ごしらえをして、
  写さずに渡します

描いた地物とデータセットのどちらを選ぶかの規模の目安は、
[性能](performance.ja.md) を参照してください。

## リファレンス

- `MapLibreGLDraw` の [addDataset](../api/maplibre-gl-draw/interfaces/MapLibreGLDraw.md)
  をはじめとするデータセットのメソッド
- [Dataset](../api/maplibre-gl-draw/interfaces/Dataset.md)
- [DatasetOptions](../api/maplibre-gl-draw/interfaces/DatasetOptions.md)
- [Table](../api/table/interfaces/Table.md)
  と [prepareTable](../api/table/functions/prepareTable.md)
- [DatasetCollisionThinning](../api/maplibre-gl-draw/interfaces/DatasetCollisionThinning.md)
- [DatasetChangePayload](../api/maplibre-gl-draw/interfaces/DatasetChangePayload.md)
- `draw.dataset.click`、`draw.dataset.add`、`draw.dataset.remove`、
  `draw.dataset.reorder` については [イベント](../reference/events.md)
