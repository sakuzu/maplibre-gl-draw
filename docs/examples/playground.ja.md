---
aside: false
---

# Playground

ライブラリーのすべての機能を 1 つのページに載せています。すべての部品を
出した標準の UI、道具と節を足したプラグインと独自の地物の型、地形、
地球儀、データセット、読み取り専用と操作の錠、ブラウザーへの保存、
20 万の地物です。

```example
playground
```

下の道具で、点、線、面、円、フリーハンド、画像を描きます (画像の道具は
ファイルを尋ねます)。星はプラグインのモードで点を置き (`S`)、ルートの
道具は独自の型の地物を置きます (`R`)。どちらも右のパネルに自分の節を
持ちます。右下の地球儀のボタンで投影を切り替えます。地図にファイルを
落とすと、その場所に読み込みます。

道具でない切り替えは Shift を押しながらのキーです。ページを開いたときに、
ブラウザーのコンソールにも一覧が出ます。

| キー | 切り替え |
| --- | --- |
| Shift+T | 地形を出す、消す |
| Shift+D | 1 万のセルのデータセットを出す、消す |
| Shift+R | 読み取り専用にする、戻す |
| Shift+K | 操作の錠をかける、外す |
| Shift+S | 描画をこのブラウザーに保存する (localStorage) |
| Shift+O | このブラウザーに保存した描画を開く |
| Shift+B | 20 万の点を地物として読み込む、取り除く |

20 万の点を読み込んでいる間は、レイヤーのパネルに地物を並べず、レイヤー
だけを出します。

## コード

ページは `playground/` にあり、`npm run dev:playground` で単独で動きます
(ポート 3300)。プラグインは [Plugins](plugins.ja.md) の例から、型は
[Custom feature types](custom-feature-types.ja.md) の例から取り、その道具と
節を `ui.tools.add` と `ui.inspector.sections.add` で足します。

::: code-group
<<< @/../playground/main.ts
<<< @/../playground/switches.ts
<<< @/../playground/index.html
:::

## 関連

- [標準の UI](../../ui/README.md) とそのオプション (英語)
- ガイドの[読み取り専用](../guides/read-only.ja.md)、
  [地形](../guides/terrain.ja.md)、[大量のデータ](../guides/large-data.ja.md)、
  [プラグイン](../guides/plugins.ja.md)、
  [独自の地物の型](../guides/custom-types.ja.md)
