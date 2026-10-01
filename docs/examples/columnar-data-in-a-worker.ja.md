---
aside: false
---

# Columnar data in a Worker

GeoParquet ファイルの建物 10,477 件を Worker で読み、列のまま
データセットに渡します。GeoJSON を経ず、行ごとのオブジェクトも作らず、
ページへ渡すときにコピーもしません。

```example
columnar-data-in-a-worker
```

建物は、ページを開いて少しすると Worker から届き、高さで塗り分けて
描かれます。ファイルの取り寄せ、列の読み込み、表の組み立て、下ごしらえに
かかった時間と、取り寄せを頼んでから行を描く最初のフレームまでの時間が
ブラウザーのコンソールに出ます。その間もページは操作できます。
建物をクリックすると、列から読んだ値とともにその行が出ます。
[Datasets](datasets.ja.md) と同じく、行は見せるだけで直さないので、
右のパネルは閉じたままです。

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
行を渡します (4)。

::: code-group
<<< @/../examples/columnar-data-in-a-worker/main.ts
<<< @/../examples/columnar-data-in-a-worker/worker.ts
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
