---
aside: false
---

# Build your own UI

標準の UI を使いません。道具のバーと、選んだ地物のパネルを、ライブラリーの
公開 API だけで作ります。素の TypeScript と数行の CSS で書きます。標準の
UI ができることは、すべてこの方法で作れます。

```example
custom-ui
```

下のボタンで描きます。地物を 1 つ選ぶと、右上のパネルにその名前と色が
出ます。そこで変えた値はすぐに反映されます。削除のボタンは選んだものを
消します。

## コード

ボタンは `draw.setMode` でモードを求めます (1)。道具のバーは
`mode.changed` を聞くので (2)、ボタン、キー、描画の終わりのどれでモードが
変わっても、今のモードを示します。パネルは `selection.changed` と
`document.changed` を聞き (4)、`features.getAppliedStyle` で、地物が実際に
描かれている色を出します。欄は値を `features.update` で書き込みます (5)。
標準の UI のインスペクターと同じ呼び出しです。地物を変えられない間は、
`features.isEditable` を見て欄を無効にします。ページは自分の
`style.css` を持ちます。

::: code-group
<<< @/../examples/custom-ui/main.ts
<<< @/../examples/custom-ui/style.css
<<< @/../examples/custom-ui/index.html
:::

## 関連

- [はじめかた](../getting-started.ja.md)。同じ呼び出しを 1 つずつ説明します
- [描画と編集](../guides/drawing.ja.md)。モード、選択、キーを説明します
- [`Draw`](../api/maplibre-gl-draw/interfaces/Draw.md) と
  [`FeaturesCollection`](../api/maplibre-gl-draw/interfaces/FeaturesCollection.md)
- [イベント](../reference/events.md) (英語)。`mode.changed` と
  `selection.changed` もあります
- [標準の UI の部品を 1 つずつ置く](../../ui/README.md#use) (英語)。
  標準の UI の一部だけを使うページのためです
