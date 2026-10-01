---
aside: false
---

# Columnar data in a Worker

20 万行の表を Worker で読み、列のままデータセットに渡します。
コピーもせず、行ごとのオブジェクトも作りません。

```example
columnar-data-in-a-worker
```

点は、ページを開いて少しすると Worker から届きます。Worker で
かかった時間、届くまでの時間、データセットが受け取るのにかかった
時間がブラウザーのコンソールに出ます。その間もページは操作できます。
点をクリックすると、列から読んだ値とともにその行が出ます。
[Datasets](datasets.ja.md) と同じく、行は見せるだけで直さないので、
右のパネルは閉じたままです。

## コード

データセットは空で始めます (1)。Worker は、GeoParquet や Arrow の
読み手が渡すのと同じ GeoArrow の配置で、型付き配列の表を作ります。
それを `@sakuzu/maplibre-gl-draw/table` の `prepareTable` で
下ごしらえします。このサブパスは maplibre も WebGL も読み込みません。
`transferList` は、配列をコピーせずにページへ移します (2)。
`setTable` は、届いた下ごしらえ済みの表をそのまま受け取ります (3)。
クリックは行の番号を渡し、ページは持っている列からその値を読みます
(4)。

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
