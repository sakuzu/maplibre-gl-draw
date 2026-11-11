---
aside: false
---

# Images

地図に画像を置きます。利用者が画像の道具で選ぶ画像のファイルと、
コードで置く画像です。

```example
images
```

このページは、駅の上に置いた案内図を選んだ状態で開くので、右の
パネルにその不透明度が出ます。角をドラッグすると大きさが変わり、
上のハンドルをドラッグすると回ります。画像の道具を選ぶか `I` を押して
ファイルを選ぶと、画像が地図の中央に置かれ、選ばれた状態になります。

## コード

ライブラリーはファイルのダイアログを開きません。`draw_image` に
入ると、画像を置く位置を添えてオプション `requestImage` を呼びます。
ページはファイルの選択を開いてファイルを返し、ライブラリーはそれをその
位置に、アクティブなレイヤーへ、地図のズームで、1 つの確定として置きます
(1)。コードから画像を置くときは、画像をデータ URL で
`maplibre-gl-draw:imageData` に持つ型 `Image` の GeoJSON の地物を
`tx.import` で取り込みます。点を中心に、基準のズームのときのピクセルの
大きさで描かれます (3)。画像の見た目は `imageOpacity` で、パネルの
スライダーも同じキーを書き込みます (4)。

::: code-group
<<< @/../examples/images/main.ts
<<< @/../examples/images/data.ts
<<< @/../examples/images/index.html
:::

## 関連

- 描画と編集のガイドの[画像](../guides/drawing.ja.md#画像)
- データ形式の [Image](../reference/data-format.md#image) (英語)。
  保存するファイル、大きさ、回転を説明します
- [`RuntimeOptions`](../api/maplibre-gl-draw/interfaces/RuntimeOptions.md)。
  `requestImage` を持ちます
- 標準の UI の[道具のバー](../../ui/README.md#use) (英語)
