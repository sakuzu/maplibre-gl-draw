---
aside: false
---

# Columnar data in a Worker

建物の外形 10,477 件を GeoParquet ファイルから Worker で読んでその列から
描き、100 万の点も同じ道筋で描きます。GeoJSON を経ず、行ごとの
オブジェクトも作らず、ページへ渡すときにコピーもしません。列を渡す
Arrow や GeoParquet の読み手には、この道筋を使います。ノートパソコン
では、Worker がファイルの列を読むのに約 45 ms、表を組み立てるのに
5 ms、下ごしらえに 12 ms かかります。100 万の点は作るのに約 120 ms、
下ごしらえに約 500 ms かかります。どれもページのスレッドでは動きません。

```example
columnar-data-in-a-worker
```

建物の外形は、ページを開いて少しすると Worker から届き、背景地図
Dark の上に、面積で塗り分けて描かれます。小さいものは赤紫、大きい
ものは黄色で、階級の境目は 50、100、200、500 m² です (建物の半分は
70 m² 未満です)。届いた行の数と、ファイル (700 KB) の取り寄せ、列の
読み込み、表の組み立て、下ごしらえにかかった時間、取り寄せを頼んでから
行を描く最初のフレームまでの時間がブラウザーのコンソールに出ます。
その間もページは操作できます。
建物をクリックすると、列から読んだ値とともにその行が出ます。
[Datasets](datasets.ja.md) と同じく、行は見せるだけで直さないので、
右のパネルは閉じたままです。

`M` を押すと、Worker が東京とその周りに 100 万の点を作ります。点は
そこから始まる移動です。Worker は点を GeoArrow の配置の表の型付き配列へ
直接書き込み、表の下ごしらえをして、配列をページへ移します。2 つめの
データセットがそれを描き、徒歩、自転車、車、電車の手段で塗り分けます。
コンソールには、Worker が表を組み立てるのにかかった時間と下ごしらえに
かかった時間、移すのにかかった時間 (何もコピーしないので 1 ms 未満です)、
表をデータセットに渡してから描く最初のフレームまでの時間、配列の大きさ
(88 MB) が出ます。ブラウザーが JavaScript のヒープの大きさを知らせる
場合は、その前と後の大きさも出ます。行はヒープにオブジェクトを足さない
ので、大きさは変わりません。縮小するとすべての点が見えます。データセットの
まとまりは少しずつ GPU に送られるので、タイルが届くように埋まって
いきます。点をクリックすると、その行が出ます。もう一度 `M` を押すと
消えます。

## キー

| キー | 働き |
| --- | --- |
| `M` | Worker から 100 万の点を読み込み、もう一度押すと消します |

## コード

データセットは空で始めます (1)。Worker はファイルを取り寄せ、
JavaScript だけで書かれた Parquet の読み手
[hyparquet](https://github.com/hyparam/hyparquet) で列を読みます。
ZSTD の圧縮は [fzstd](https://github.com/101arrowz/fzstd) でほどきます。
形状は WKB のまま受け取り、Worker が GeoArrow の配置の表の型付き配列へ
直接ほどきます。座標は 1 つの `Float64Array` に入れ、行、ポリゴン、
リングの区切りは `Int32Array` に入れます。文字の列は Arrow と同じ
辞書にし、数の列は `Float64Array` にして、ファイルに値がない行は NaN に
します。`@sakuzu/maplibre-gl-draw/table` の `prepareTable` は、
maplibre も WebGL も読み込まず、行の範囲、まとまり、クリックのための索引を
Worker の中で計算します。`transferList` は、配列をコピーせずにページへ
移します (2)。`setTable` は、届いた下ごしらえ済みの表をそのまま
受け取ります (3)。クリックは、データセットが列から読んだ属性とともに
行を渡します (4)。100 万の点では、Worker が点の表に書き込みます
(data.ts)。座標は 1 つの `Float64Array` に、手段は `Uint8Array` の
符号の辞書に、時間は `Uint8Array` に入れ、同じように下ごしらえをして
送ります。`draw.datasets.add` は下ごしらえ済みの表を `table` として
受け取り、`kind` のカテゴリーの規則で塗り分けます。
`draw.datasets.remove` で消します (5)。

::: code-group
<<< @/../examples/columnar-data-in-a-worker/main.ts
<<< @/../examples/columnar-data-in-a-worker/worker.ts
<<< @/../examples/columnar-data-in-a-worker/data.ts
<<< @/../examples/columnar-data-in-a-worker/index.html
:::

## 関連

- 大量のデータのガイドの
  [表を Worker で読む](../guides/large-data.ja.md#表を-worker-で読む)と
  [表で渡す](../guides/large-data.ja.md#表で渡す)
- [`prepareTable`](../api/table/functions/prepareTable.md)、
  [`Table`](../api/table/interfaces/Table.md)、
  [`Dataset.setTable`](../api/maplibre-gl-draw/interfaces/Dataset.md#settable)

データは [Overture Maps Foundation](https://overturemaps.org) のもので、
ライセンスは ODbL と CDLA です
([サンプルデータ](../../examples/public/data/README.md)、英語)。
