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
そこで変えると、星の色も変わります。星を置くたびと道具を変えるたびに、
プラグインが数えた星の数がコンソールに出ます。

このページには自分のキーが 1 つあります。キーの一覧はページを開いたときに
ブラウザーのコンソールに出ます。パネルの欄に入力している間は、キーは
働きません。

| キー | 切り替え |
| --- | --- |
| `U` | プラグインをその道具と節とともに取り除く、また足す |

`U` を押すと、星が道具のバーから消え、スタンプの節がパネルから消えます。
モード `stamp` の登録もなくなるので、`draw.setMode('stamp')` は
`not-found` を投げます。星は、状態と色を持った描画の地物として残ります。
もう一度 `U` を押すと、プラグイン、その道具、その節が戻ります。
プラグインは 0 から数え直します。

## コード

プラグイン (`stamp.ts`) は、コンテキストを通してモード `stamp` を登録し、
`feature.created` を聞いて星を数え、その数を `api` として渡します (2)。
プラグインがコンテキストを通して足したものは、`plugins.remove` で
プラグインを取り除くとまとめて消えます (5)。

標準の UI には、拡張のための口が 2 つあります (3、4)。`ui.tools.add` は、
登録したモードのボタンを道具のバーに置きます。名前、アイコン
(`currentColor` で描く SVG のマークアップ)、キーを渡します。
`ui.inspector.sections.add` は、`appliesTo` が受け入れた地物のために、
インスペクターに節を足します。UI は `fields` が並べた欄を描き、変更を
`onchange` に渡します。`onchange` はそれを `features.updateMany` で書き
込みます。UI は、道具や節がどのプラグインのものかを知りません。そこで
ページは、プラグインを取り除くときに `ui.tools.remove` と
`ui.inspector.sections.remove` で道具と節も取り除きます (5)。ページは
`plugins.getApi` で、名前を指定してプラグインに数を尋ねます (7)。

::: code-group
<<< @/../examples/plugins/main.ts
<<< @/../examples/plugins/stamp.ts
<<< @/../examples/plugins/data.ts
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
