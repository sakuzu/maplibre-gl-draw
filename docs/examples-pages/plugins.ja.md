---
aside: false
---

# Plugins

プラグインで描画に独自のモードを足し、ページはそのモードの道具を道具の
バーに、その地物のための節を右のパネルに足します。

```example
plugins
```

道具のバーの最後にある星か、`S` キーでプラグインのモードに入ります。
地図をクリックするたびに、その場所に星が置かれます。`Escape` か別の道具で
抜けます。星を選ぶと、スタイルの下のスタンプの節に、予定か済みかが出ます。
そこで変えると、星の色も変わります。道具を変えるたびに、プラグインが
数えた星の数がコンソールに出ます。

## コード

プラグイン (`stamp.ts`) は、コンテキストを通してモード `stamp` を登録し、
`feature.created` を聞いて星を数え、その数を `api` として渡します。
プラグインが足したものは、`plugins.add` が返す関数でまとめて取り除けます
(1)。

標準の UI には、拡張のための口が 2 つあります (3、4)。`ui.tools.add` は、
登録したモードのボタンを道具のバーに置きます。名前、アイコン
(`currentColor` で描く SVG のマークアップ)、キーを渡します。
`ui.inspector.sections.add` は、`appliesTo` が受け入れた地物のために、
インスペクターに節を足します。UI は `fields` が並べた欄を描き、変更を
`onchange` に渡します。`onchange` はそれを `features.updateMany` で書き
込みます。ページは `plugins.getApi` で、名前を指定してプラグインに数を
尋ねます (6)。

::: code-group
<<< @/../examples/plugins/main.ts
<<< @/../examples/plugins/stamp.ts
<<< @/../examples/plugins/index.html
:::

## 関連

- [プラグイン](../guides/plugins.ja.md)。プラグインのコンテキスト、
  イベント、api、プラグインが足すモードを説明します
- [`Plugin`](../api/maplibre-gl-draw/interfaces/Plugin.md) と
  [`ModeContext`](../api/maplibre-gl-draw/interfaces/ModeContext.md)。
  `commitFeature` もここにあります
- 標準の UI の 2 つの口 (英語)。
  [独自のモードの道具](../../ui/README.md#use)と
  [インスペクターの節](../../ui/README.md#inspector)です
