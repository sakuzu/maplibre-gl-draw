---
aside: false
---

# Save and load

描いたものを書き出し、読み戻します。GeoJSON とライブラリーの形式、
地図に落としたファイル、読み込みで外された地物を扱います。

```example
save-and-load
```

このページは 5 つの地物を持つ GeoJSON のファイルで開きます。4 つは
描いたものに足されます。5 つ目は位置が 1 つしかない線なので外され、
その理由がブラウザーのコンソールに出ます。描いたものを変えてから `S`
を押すと、文書の全体がライブラリーの形式でブラウザーに保存され、
その GeoJSON がコンソールに出ます。`O` を押すと、保存した文書が
描いたものの代わりに読み込まれます。ページを読み直しても、保存した
文書で開きます。GeoJSON のファイル、保存した文書、画像を地図に
落とすと読み込まれます。画像は落とした場所に置かれます。

## コード

`draw.document.load` は中身から形式を判断して読み込み (2)、形式、
読んだ地物、外した地物を `LoadResult` で返します (1)。
`draw.document.toJSON` はレイヤー、グループ、その順序を含む文書の
全体を書き出し、`draw.document.toGeoJSON` は地物だけを書き出します
(3)。ライブラリーの形式の文書は、読み込むと描いたものを置き換えます
(4)。キー (5) とファイルの落とし込み (6) はページが受け持ちます。
ライブラリーはこれらをアプリケーションに任せています。

::: code-group
<<< @/../examples/save-and-load/main.ts
<<< @/../examples/save-and-load/data.ts
<<< @/../examples/save-and-load/index.html
:::

## 関連

- [保存と読み込み](../guides/save-load.ja.md)。2 つの形式、読み込みで
  外される地物、地図に落としたファイル、変更のたびの保存を説明します
- [`draw.document`](../api/maplibre-gl-draw/interfaces/DocumentResource.md)、
  [`LoadOptions`](../api/maplibre-gl-draw/interfaces/LoadOptions.md)、
  [`LoadResult`](../api/maplibre-gl-draw/interfaces/LoadResult.md)
- 2 つの形式の[データ形式](../reference/data-format.md) (英語)
