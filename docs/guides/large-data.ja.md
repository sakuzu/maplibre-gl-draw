# 大量のデータを表示する

データセットは、たくさんの行を、編集の対象にしない代わりに速く表示
します。数万件の区画、100 万件の点、サーバーの検索結果などです。
全部を一度に渡すほか、地図を動かすたびに見えている範囲の分だけ
取り寄せることもできます。見た目は描いた地物と同じスタイル規則で
決められ、クリックすると属性を読めます。

このガイドでは、まずデータセットを使う場面と速い理由を説明します。
その後で、行の渡し方、見た目の決め方、読み出し方を順に説明します。

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

利用者が描いて編集するものは文書に入れます。データセットは描かれ
ますが、文書には入りません。1 つの行を編集したいときは、
`draw.features.create` で文書へ写します。2 つの写しの対応関係は、
ライブラリーでは持ちません。

<!-- docs-check: with datasets -->

```ts
const row = places.getRow(0);
if (row?.geometry) {
  draw.features.create({
    type: row.geometry.type,
    geometry: row.geometry,
    properties: { ...row.properties },
  });
}
```

## 描いた地物との違い

| | 描いた地物 | データセット |
| --- | --- | --- |
| 編集 | 移動、頂点の編集、幾何演算 | できない |
| イベント | `feature.created` など | `clicked`、`hovered`、`changed` |
| 選択 | 枠とハンドルの付いた選択 | 強調表示だけ (`setSelectedRowIds`) |
| 保存 | `document.toJSON()` | されない。重なりの順の中の ID だけ |
| 規模 | 20 万件でも編集できる | 数万件から 100 万件以上 |

データセットが速いのは、編集に要る処理をすべて省き、専用の方法で
描くからです。

- 行を場所ごとのまとまりに分けます。まとまりは少しずつ GPU に送るので、
  大きなデータセットはタイルが届くように少しずつ現れ、ページは
  止まりません
- 描くのは見えているまとまりだけです
- 表は、型付き配列から GPU へ直接送るので、行ごとにオブジェクトを
  作りません。描く前の下ごしらえ (行の範囲、まとまり、クリックのための
  索引) は Worker でできます
- provider を使うと、見えている範囲の行だけを持つので、元のデータ
  全体の大きさは関係ありません

## 最小のコード

```ts
import { createDraw } from '@sakuzu/maplibre-gl-draw';

const draw = createDraw(map);

const parcels = draw.datasets.add({
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

parcels.on('clicked', ({ row }) => {
  console.log(row.id, row.properties);
});
```

多角形は描いた地物の後ろに、`population` で塗り分けて描かれます。
クリックすると、その ID と属性がログに出ます。

## 行を渡す 3 つの方法

手元のデータの形に合わせて選びます。渡せるのは 3 つのうち 1 つだけ
で、2 つ渡すとコード `invalid-input` の `DrawError` になります。
どれも渡さなければ、データセットは空で始まります。すぐに置くことが
でき、行は後から `setRows` か `setTable` で渡します。

| 手元のデータ | オプション | 置き換え方 |
| --- | --- | --- |
| GeoJSON の地物の配列 | `rows` | `setRows` |
| GeoParquet、Arrow、FlatGeobuf の表 | `table` | `setTable` |
| 範囲を渡すと答えるサーバー | `provider` | `refresh` |

### 地物の配列で渡す

行は GeoJSON の地物 (`id`、`geometry`、`properties`) で、穴のある
多角形や Multi 型も渡せます。幾何の無い行は、位置を保ちますが、
描かれず、クリックも当たりません。3 つ目の要素 (標高) を持つ座標は、
経度と緯度だけに切り詰めます。

`setRows` はすべての行を置き換えます。一部だけを更新する方法は
ないので、新しい配列を作って渡してください。

<!-- docs-check: with datasets -->

```ts
parcels.setRows(nextRows);
```

### 表で渡す

GeoParquet、Arrow、FlatGeobuf から読んだ表は、もともと列の集まり
です。渡すためだけに行ごとに地物のオブジェクトを作ると、描くよりも
高くつきます。100 万件の点なら、時間とメモリーの大半がそこに使われ
ます。`table` は行をそのままの形で受け取ります。形は GeoArrow と同じ
で、座標は 1 本の `Float64Array`、行と部分とリングの区切りは
`Int32Array`、属性は列で持ちます。

```ts
const places = draw.datasets.add({
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

幾何の列は 1 つの型だけを持ちます。区切り (`offsets`) は、外側から
順に、各行がどこから始まるかを示します。

| 型 | `offsets` |
| --- | --- |
| `Point` | なし。行 `i` は座標 `i` |
| `LineString`、`MultiPoint` | `[行 → 座標]` |
| `Polygon` | `[行 → リング, リング → 座標]` |
| `MultiLineString` | `[行 → 部分, 部分 → 座標]` |
| `MultiPolygon` | `[行 → 多角形, 多角形 → リング, リング → 座標]` |

行 `i` は、`properties` が各列の `i` 番目の値で、ID が
`String(ids[i])` (`ids` の列が無ければ `String(i)`) の GeoJSON の
地物として振る舞います。そのため、スタイル規則、基本のスタイル、
`zoomScale`、間引き、重なりの順、選択は、地物のときと同じように
働きます。表の行は、行ごとのスタイルを持ちません。

- 列は、数の型付き配列、辞書 (Arrow の辞書型と同じ `codes` と
  `dictionary`)、ふつうの配列のどれかです。浮動小数点の列では、NaN
  が値なしを表します
- 幾何の無い行 (区切りが空の行、点で座標が NaN の行、`validity` の
  ビットが 0 の行) は、描かれず、クリックも当たりません
- 渡す列は、規則と自分のコードが読むものだけで足ります

データセットは配列を写さずに持ち続けて読みます。持たせている間は
配列を書き換えず、表ごと `setTable` で置き換えてください。行が地物の
オブジェクトになるのは、何かがそれを求めたときだけです。

- `clicked` と `hovered` は、その行と `rowIndex` を運びます。行の
  ほかの値は、自分の列から読んでください
- `listRows()` はすべての行を一度作るので、地物で渡したのと同じだけ
  かかります。`listVisibleRows(bbox)` は範囲の中の行だけを作り、
  `listDrawnRows(bbox)` は何も作りません
  ([行の番号で読む](#行の番号で読む) を参照)。データセットへの吸着も
  行を作ります
- `externalPointRender` は、点の行ごとに呼ばれます
- 地形のある地図では、地形に沿わせる線と多角形 (縁が実線でも破線でも)
  を地物として作ります

### GeoJSON から表を作る

行が GeoJSON の地物で来るけれど、オブジェクトのまま渡すには多すぎる
ときは、サブパス `@sakuzu/maplibre-gl-draw/table` で表を作ります。
`tableFromFeatures` は地物の配列を受け取り、`createTableBuilder` は
1 行ずつ受け取ります。

<!-- docs-check:
declare const features: import('geojson').Feature[];
-->

```ts
import { createTableBuilder, tableFromFeatures } from '@sakuzu/maplibre-gl-draw/table';

draw.datasets.add({ id: 'shops', table: tableFromFeatures(features) });

const builder = createTableBuilder({ geometryType: 'Point' });
builder.add({ type: 'Point', coordinates: [139.70, 35.68] }, { name: 'A' });
builder.add({ type: 'Point', coordinates: [139.71, 35.69] }, { name: 'B' });
draw.datasets.add({ id: 'stations', table: builder.finish() });
```

`geometryType` を指定したビルダーは、ほかの型の行を受け取ると例外を
投げます。指定しなければ、型の違う行があるとき、次の節の混在の列を
作ります。

### 幾何の型が違う行を混ぜる

点、線、多角形の行が混ざったファイルは、GeoArrow の混在の幾何の列
(Arrow の dense union) として渡します。型ごとに分ける必要は
ありません。子はそれぞれ上と同じ 1 つの型の幾何の列で、行 `i` の
幾何は、子 `types[i]` の行 `offsets[i]` です。

```ts
draw.datasets.add({
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

- 行 `i` は、その子の型の地物とまったく同じに振る舞います
- 子の中の行の並びは自由です。描く順は表の行の順です
- `types[i]` が負の行は幾何を持ちません。その上に `validity` も
  効きます
- `prepareTable` と `transferList` もこの形を受け取ります

### 表を Worker で読む

描く前に、データセットは各行の範囲を求め、行を場所ごとのまとまりに
分け、クリックのための索引を作ります。大きな表では、ページが止まる
ほど時間がかかるので、表を読む場所でこの作業をしてください。サブパス
`@sakuzu/maplibre-gl-draw/table` の `prepareTable` がこの作業をして、
結果を表と一緒に返します。このサブパスは maplibre も WebGL も
import しないので、Worker で使えます。`transferList` は、写さずに
移すバッファーの一覧を返します。

<!-- docs-check:
declare function readTable(data: unknown): Promise<import('@sakuzu/maplibre-gl-draw/table').Table>;
-->

```ts
// worker.ts
import { prepareTable, transferList } from '@sakuzu/maplibre-gl-draw/table';

self.onmessage = async (event) => {
  const table = await readTable(event.data); // 自分の読み込み処理が Table を返す
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

下ごしらえ済みの表なら、主スレッドはどれも計算し直さず、最初の
クリックの時点で索引ができています。下ごしらえしていない表を渡すと、
`setTable` が同じ配列を自分で計算します。`draw.datasets.add` の
`table` オプションは、どちらも受け取ります。

下ごしらえ済みの表は、行の数 (`length`) と範囲 (`bounds`。
`[west, south, east, north]` で、幾何を持つ行が無ければ `null`) も
持ちます。たとえば、読んだものに地図を合わせるのに使えます。

<!-- docs-check:
declare const prepared: import('@sakuzu/maplibre-gl-draw/table').PreparedTable;
-->

```ts
if (prepared.bounds) map.fitBounds(prepared.bounds, { padding: 20 });
console.log(`${prepared.length} 行`);
```

### 見えている範囲の分を取り寄せる

`provider` は、地図の見えている範囲が変わると、その範囲
(`[west, south, east, north]`、度) とズームを渡されて呼ばれ、その
範囲の行を返します。

```ts
draw.datasets.add({
  id: 'parcels',
  provider: async ([west, south, east, north], zoom) => {
    const query = `${west},${south},${east},${north}`;
    const res = await fetch(`/api/parcels?bbox=${query}&z=${zoom}`);
    return (await res.json()).features;
  },
});
```

- 呼び出しは地図が止まるのを待つ (200 ms) ので、続けてパンやズームを
  しても、呼ばれるのは最後の 1 回です
- 範囲は整数のズームとタイルの境界に丸めます。同じタイルの中で
  動いても呼ばれず、渡される範囲は丸めた後のものです
- 答えは範囲ごとに持っておきます (最後の 32 件)。前の範囲に戻ると、
  呼ばずにそのまま表示します
- 取り寄せている間は、前の行が画面に残ります。ライブラリーは
  読み込み中の表示を出しません
- 使うのは最新の要求への答えだけです。古い要求への答えが後から
  届いても捨てます
- promise が reject されたときは、行をそのままにして
  `console.error` に記録します

絞り込みを変えたときなど、ほかの理由で provider の返すものが
変わったら、`refresh()` を呼んでください。持っておいた答えを忘れ、
取り寄せ中の要求をその答えごと捨て、今の範囲を取り寄せ直すので、
地図を動かさなくても新しい行が現れます。

## 見た目

`styleRule` は、レイヤーと同じ規則 (`single`、`categorical`、
`graduated`、`continuous`。[スタイル](styles.ja.md) を参照) を
受け取ります。規則が決めるのは色だけです。線の幅、線の種類、
不透明度、点の大きさは、`baseStyle` で決めます。規則が塗る部分
ごとに、`FeatureStyle` の一部を 1 つずつ渡します。

<!-- docs-check: with datasets -->

```ts
parcels.setBaseStyle({
  stroke: { strokeWidth: 1, strokeColor: '#3366cc' },
  fill: { fillOpacity: 0.4 },
  point: { pointRadius: 4 },
});
```

同じものを複数が決めるときは、次の上のものが勝ちます。

1. 行ごとの `style` (地物で渡した行のとき)
2. 規則の色 (その部分だけ)
3. `baseStyle`
4. 既定値

`style` は `DatasetRow` のメンバーで、`FeatureStyle` です。`getRow`、
`listRows`、`listVisibleRows` で読み戻した行は、行ごとの `style` を
`baseStyle` に重ねたものを持ちます。

`setStyleRule(undefined)` と `setBaseStyle(undefined)` で外せます。
`getStyleRule()` と `getBaseStyle()` で読み返せるので、凡例はここから作れます。

`zoomScale` は、大きさと不透明度に、ズームで変わる係数を掛けます。
地図を描くたびに呼ばれ、返す値が変わっても何も作り直しません。

<!-- docs-check: with datasets -->

```ts
parcels.setZoomScale((zoom) => ({
  scale: zoom < 12 ? 0.5 : 1,
  opacity: 1,
}));
```

## 描いた地物との前後

`order` は、描いた地物に対するデータセットの位置を決めます。

| order | 位置 | 標準の UI のレイヤーパネル |
| --- | --- | --- |
| `below-store` | すべてのレイヤーの後ろ (既定) | 落とすと `layer-order` |
| `above-store` | すべてのレイヤーの前 | 落とすと `layer-order` |
| `layer-order` | 重なりの順の中の自分の ID の位置 | 重なりの順の中で移動 |

`above-store` のデータセットは選択のハンドルの後ろに描かれます。標準の
UI のレイヤーパネルでは、どのデータセットもレイヤーの間へドラッグでき
ます。パネルは、レイヤーの間に落とされた `below-store` か
`above-store` のデータセットを `draw.datasets.move` で `layer-order` に
移してから、`draw.layers.reorder` で置きます。並べ替えが断られたとき
(読み取り専用) は、データセットを元の order に戻します。

同じ側のデータセットは追加した順に描かれ、後から追加したものが前に
なります。データセットの中では、配列の末尾 (表なら最後の行) が前です。
`draw.datasets.list()` はすべてのデータセットを後ろから前の順で返し、
`draw.datasets.move` は側、側の中の位置、またはその両方を変えます。
動かしても何も作り直しません。順か側が変わると、ID を後ろから前の
順に並べた `dataset.reordered` が出ます。何も変わらない移動では何も
出ません。

```ts
draw.datasets.move('parcels', { order: 'above-store' });
draw.datasets.move('parcels', { index: 0 }); // その側でいちばん後ろ
```

`layer-order` のデータセットは、その ID が文書の重なりの順
(`draw.getStore().getLayerOrder()`) にある間だけ描かれ、位置もその
順だけで決まります。ID は `draw.layers.reorder` で入れます。このメソッドは
レイヤーの ID のほかに `layer-order` のデータセットの ID を受け取り、
渡されなかった項目はその場に残します。この項目は、読み込んだ文書
(その重なりの順は ID を位置ごと保ちます) か、`store` オプションで
渡した自分の Store からも入ります。

<!-- docs-check:
declare const notes: import('@sakuzu/maplibre-gl-draw').Layer;
declare const roads: import('@sakuzu/maplibre-gl-draw').Layer;
-->

```ts
// 行は後から setRows か setTable で渡すまで空
draw.datasets.add({ id: 'parcels', order: 'layer-order' });
draw.layers.reorder([roads.id, 'parcels', notes.id]); // 2 つのレイヤーの間
```

データセットを取り除いても、重なりの順は書き換えません。データセットの
無い ID が残っていても、飛ばして描きます。

重なりの順は文書の一部ですが、データセットは文書に入りません。
ネイティブ形式は、位置にある ID を保存し、行は保存しません。読み込んだ
後で同じ ID のデータセットを追加し直すと、保存した位置に描かれます
([レイヤー](layers.ja.md))。

## 重なった点を間引く

低いズームで多くの点を描くと、互いに覆い合って塗りつぶしたように
なります。`collisionThinning` は、その一部だけを描きます。画面上で
2 つの点のマーカーが重なるところでは、前の点を描き、もう一方は描き
ません。ズームインすると点どうしが離れるので、描かれる点が増えます。

<!-- docs-check:
declare const rows: import('@sakuzu/maplibre-gl-draw').DatasetRow[];
-->

```ts
const places = draw.datasets.add({
  id: 'places',
  rows,
  collisionThinning: { enabled: true, fullDisplayZoom: 17, marginPx: 2 },
});

const { total, visible } = places.getThinningStats();
```

- 重なりは描いたときの大きさ (半径、輪郭、`marginPx`) で調べるので、
  大きなマーカーほど多く間引かれます
- 間引くのは `Point` だけです。線、多角形、`MultiPoint` は必ず
  描きます
- `fullDisplayZoom` (17) 以上では、すべての点を描きます
- 間引かれた点は、描かれず、クリックも当たりません
- `getThinningStats()` は、何点のうち何点を描いているかを返します。
  「50,000 件中 1,200 件を表示」のような表示に使えます
- `setCollisionThinning` で後から間引きを変えられ、`null` で止め
  られます

### どの点を、いつ描くか

描く点は、見えている範囲からではなく、すべての点から整数のズーム
ごとに選びます。そのため、パンしても入れ替わりません。

地図を描くたびに、そのとき描くズーム (ズームやピッチの操作の途中
でも) から整数のズームを取り、そのズームのために選んだ点を描きます。
近くの整数のズームの点は、ページが手すきの間に先に選んでおくので、
そのズームに入っても手間はかかりません。行、スタイル、ズームの係数、
設定が変わると、点をすぐに選び直し、次に描くときに表示します。

そのため、カメラが動いたときにも、決まったカメラで画像を撮る前にも、
呼ぶものはありません。点は描くときに決まります。どの行が描かれて
いるかを知るには、行の番号で読みます
([行の番号で読む](#行の番号で読む))。`getDrawnRowsRevision()` で、
変わったかどうかがわかります。

## クリック、ホバー、選択

`clicked` と `hovered` は、`interactive: true` のときだけ出ます。
このとき、行は吸着の対象にもなります。`hovered` は対象が変わった
ときに出て、ポインターが離れたときに `row` と `rowIndex` を `null`
にして 1 回出ます。どちらも行の `rowIndex` を運びます。これは、
渡した行 (または provider の答え) の中の番号か、表の中の行です。
`on` は購読をやめる関数を返します。

<!-- docs-check: with datasets -->

```ts
places.on('hovered', ({ row }) => {
  map.getCanvas().style.cursor = row ? 'pointer' : '';
});
```

1 回のクリックの対象は 1 つです。描いた地物でもデータセットの行でも、
見えているものの中でいちばん前のものです。

- 見えているデータセットは、`interactive` かどうかにかかわらず、
  その下の地物へのクリックをさえぎります
- データセットがクリックを受けると、クリックが何も無い場所だった
  ときと同じく、文書の選択は解除されます
- インスタンスのイベント `dataset.clicked` は、どのデータセットの
  行へのクリックも `datasetId` を付けて知らせます。`map.clicked` は
  すべてのクリックを知らせ、当たったものを `hit` に持ちます (何も無い
  場所なら `null`)

```ts
draw.on('dataset.clicked', ({ datasetId, row }) => {
  console.log(datasetId, row.id);
});
```

`setSelectedRowIds` は、データセットの行を強調表示します。これは
データセットだけのもので、文書の選択とは別です。何も作り直しません。

<!-- docs-check: with datasets -->

```ts
places.setSelectedRowIds(['place-12']);
places.setSelectedRowIds([]); // 解除
```

`changed` イベントは、`interactive` にかかわらず、行、スタイル、
表示、選択、間引きで残す点が変わったときに出ます。何が変わったかは
`reason` でわかります。地図の横の一覧など、データセットから作った
ものを作り直すのに使ってください。自分で変えたときはすぐに出ます。
カメラが新しい整数のズームに入ったときは、新しい点を描いた直後に
(`thinning` で) 出ます。

`listVisibleRows(bbox)` は、範囲の中の行を描く順に、スタイルを
当てて返します。手間は全体の行数ではなく、範囲の中の行数で決まります。

## 行の番号で読む

点の横に文字を置くときのように、描かれているものだけをたどる
コードは、データセットを行の番号で読み、残す行だけを地物にできます。

`listDrawnRows(bbox)` は、範囲にかかっていて今描かれている行の番号を
小さい順に返します。幾何があり、隠されておらず、間引きで残った行
です。地物を作らないので、手間は範囲の中の行数で決まります。
「今描かれている」は、地図を最後に描いたときの行のことです。描く
ときは何かを描く前に整数のズームを決めるので、同じときに描く
重ね描きは、そのとき描かれる行を読みます。

`getDrawnRowsRevision()` は、描かれる行が変わる (行の置き換え、
間引きで残る点の変化) たびに変わる数です。読む手間はかからないので、
描かれる行から作ったものはこの数と一緒に持ち、数が変わったら作り
直してください。`listVisibleRowIds()` は同じ行を ID の集合で返します
(間引きで何も隠していなければ `null`)。変化の後の最初の呼び出しで、
すべての行を 1 回たどって作ります。そうした使い回しの鍵には、これも、
その同一性も使わないでください。

<!-- docs-check: with datasets -->

```ts
// 描かれる行が変わったときだけ文字を置き直す
let placedFor = -1;
function placeText(): void {
  const revision = places.getDrawnRowsRevision();
  if (revision === placedFor) return;
  placedFor = revision;
  // ... places.listDrawnRows(extent) をたどって文字を置く
}
```

1 つの行を読むメソッドも、`getRow` を除いて地物を作りません。

| メソッド | 返すもの |
| --- | --- |
| `getRowId(index)` | ID |
| `getRowType(index)` | 幾何の型 |
| `getRowBounds(index)` | 範囲 (`[west, south, east, north]`) |
| `getRowPoint(index)` | `Point` の位置 |
| `getRow(index)` | GeoJSON の地物としての行 |
| `findRow(id)` | ID の行の番号。無ければ `null` |

`findRow` は、最初の呼び出しで ID の索引を作ります。行の番号は
`clicked` と `hovered` の `rowIndex` と同じで、行を置き換えるまで
変わりません。

<!-- docs-check: with datasets -->

```ts
// 0.01 度のマスごとに、描く順で最初の点
const extent: [number, number, number, number] = [139.6, 35.6, 139.9, 35.8];
const taken = new Set<string>();
const names: string[] = [];
for (const index of places.listDrawnRows(extent)) {
  const point = places.getRowPoint(index);
  if (!point) continue;
  const cell = `${Math.floor(point[0] / 0.01)}:${Math.floor(point[1] / 0.01)}`;
  if (taken.has(cell)) continue;
  taken.add(cell);
  const row = places.getRow(index);
  if (row) names.push(String(row.properties?.name));
}
```

## 表示と非表示

`setVisible(false)` は描画とクリックの判定を止めますが、行と GPU に
送ったものは持ち続けるので、`setVisible(true)` で次に描くときに
表示します。隠している間も、`setRows`、`setStyleRule`、provider は
働きます。`draw.datasets.remove(id)` はすべてを手放します。

## 増えたり減ったりするデータセットを追う

データセットが追加されると `dataset.added` がそのデータセットを
付けて出て、取り除かれると `dataset.removed` がその `datasetId` を
付けて出ます。取り除かれたイベントが届いた時点で、
`draw.datasets.get` はもうそれを返しません。データセットの移動
(`dataset.reordered` が出ます) や行の変更では、どちらも出ません。
購読する前からあるデータセットは知らされないので、まず
`draw.datasets.list()` を一度たどり、その後はイベントを追ってください。

<!-- docs-check:
type Dataset = import('@sakuzu/maplibre-gl-draw').Dataset;
declare function watch(dataset: Dataset): () => void;
-->

```ts
const stops = new Map<string, () => void>();
const follow = (dataset: Dataset): void => {
  stops.set(dataset.id, watch(dataset));
};

for (const dataset of draw.datasets.list()) follow(dataset);
draw.on('dataset.added', ({ dataset }) => follow(dataset));
draw.on('dataset.removed', ({ datasetId }) => {
  stops.get(datasetId)?.();
  stops.delete(datasetId);
});
```

同じ ID で取り除いて追加し直したデータセットは別のオブジェクトなので、
取り除かれたイベントの後に追加されたイベントとして届きます。

## 点を自分で描く

`externalPointRender` は点の行を選びます。true を返した `Point` は
ライブラリーが描かず、自分のレンダラーが描きます。その点も間引き、
クリックの判定、選択には加わるので、振る舞いは変わりません。
`setExternalPointRender` で後から置き換えられます。

<!-- docs-check: with datasets -->

```ts
draw.datasets.add({
  id: 'stations',
  rows,
  externalPointRender: (row) => row.properties?.kind === 'station',
});
```

## 画像を撮る

画面の上では、大きなデータセットは何回かの描画にわたって少しずつ
現れます。印刷やサムネイルのために一度描いて画像を読み出す地図では、
`rendering.timeSlicing` を `false` にして、1 回の描画で見えている
ものをすべて用意させます。そのうえで、地図の `idle` と、
`hasPendingWork()` が false になるのを待ちます。後者は provider の
答えも含みます。

```ts
draw.options.update({ rendering: { timeSlicing: false } });

async function whenPictureComplete(): Promise<void> {
  map.triggerRepaint();
  await map.once('idle');
  while (draw.hasPendingWork()) await map.once('render');
}
```

間引きには何も要りません。どの点を見せるかは描くときに決まります。
[性能](performance.ja.md) も参照してください。

## 読み取り専用とロック

データセットは、[読み取り専用](read-only.ja.md) の 3 つの状態の外に
あります。文書が読み取り専用の間も追加と置き換えができ、操作ロック
中も `clicked` と `hovered` が出ます。`draw.hidden` も効きません。
表示を切り替えるには、`setVisible` を使うか、取り除いてください。

## 制限

- データセットは編集できません。編集するには、行を
  `draw.features.create` で文書へ写してください
- 行は丸ごと置き換えます。一部だけを更新する方法はありません
- 文書と一緒には保存されません。データかその取り寄せ先は自分で持ち、
  読み込んだ後でデータセットを追加し直してください
- 表の行は、行ごとのスタイルを持ちません
- 間引くのは `Point` だけです
- 表はその場で読むので、データセットに持たせている間は配列を書き
  換えないでください

## 例

- [Datasets](../examples/datasets.ja.md) は、100 万を超える行を利用者の
  描いたものと並べて表示します。作った 100 万の点は見えている範囲の分を
  `provider` が渡して間引き、六角形のセル 25 万個は一度に渡します。
  Overture Maps の東京都心の建物と場所も置きます。建物は外形の面積で
  塗り分け、`layer-order` で描いたものの 2 つのレイヤーの間に置き、
  セルはその奥に置きます。行のクリックを知らせ、描いた線は建物に
  スナップします
- [Columnar data in a Worker](../examples/columnar-data-in-a-worker.ja.md)
  は、同じ建物を GeoParquet のファイルから Worker で表に直接読み込み、
  そこで `prepareTable` で下ごしらえして、写さずに渡します。キーを
  押すと 100 万の点も同じように作り、それぞれの段階の時間をログに出します
- [200,000 features](../examples/200000-features.ja.md) は、比べる
  ために、208,073 の地物 (建物、公園、通り、施設) の街を文書の地物として
  読み込みます。どれも編集できます

描いた地物の代わりにデータセットを選ぶ規模の目安は、
[性能](performance.ja.md) を参照してください。

## リファレンス

- [draw.datasets](../api/maplibre-gl-draw/interfaces/DatasetsCollection.md)
- [Dataset](../api/maplibre-gl-draw/interfaces/Dataset.md)
- [DatasetOptions](../api/maplibre-gl-draw/type-aliases/DatasetOptions.md)
- [DatasetEvents](../api/maplibre-gl-draw/interfaces/DatasetEvents.md)
- [DatasetCollisionThinning](../api/maplibre-gl-draw/interfaces/DatasetCollisionThinning.md)
- [Table](../api/table/interfaces/Table.md)、
  [tableFromFeatures](../api/table/functions/tableFromFeatures.md)、
  [createTableBuilder](../api/table/functions/createTableBuilder.md)、
  [prepareTable](../api/table/functions/prepareTable.md)
- `dataset.clicked`、`dataset.added`、`dataset.removed`、
  `dataset.reordered` については [イベント](../reference/events.md)
