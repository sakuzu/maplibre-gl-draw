---
aside: false
---

# Read-only viewer

描画を見るためだけのページです。利用者は地物を選んで属性を読めますが、
何をしても描画は変わりません。

```example
read-only-viewer
```

街区か停留所をクリックしてください。右のパネルに名前、計測値、属性が
文字で出ます。そこでは何も変えられず、削除とロックのボタンは押せません。
隠すボタンは残ります。隠すのはこのページの中だけのことで、何も書き込まない
からです。左の凡例のタブには、街区の用途ごとの色が出ます。

## コード

先に、描画を 2 つのレイヤーに読み込みます (3)。まだ書き込めるうちに
読み込むためです。次に `setReadOnly(true)` で、利用者からもコードからも
書き込みをすべて断ります。`setInteractionLocked(true)` は、利用者が編集を
始めることも止めます。選んだ地物にハンドルは出ず、動かせません (4)。
標準の UI は、オプションで見るだけのページに合わせます (2)。道具の
バーを出さず、レイヤーのパネルでは追加も並べ替えもさせず、インスペクター
は属性のタブだけにして演算を出しません。描画が読み取り専用の間は、
インスペクターが出す欄はすべて変えられなくなります。

::: code-group
<<< @/../examples/read-only-viewer/main.ts
<<< @/../examples/read-only-viewer/data.ts
<<< @/../examples/read-only-viewer/index.html
:::

## 関連

- [読み取り専用](../guides/read-only.ja.md)。読み取り専用、操作の錠、
  ローカルの非表示と、それぞれが止めるものを説明します
- [`setReadOnly`](../api/maplibre-gl-draw/interfaces/Draw.md#setreadonly)
  と
  [`setInteractionLocked`](../api/maplibre-gl-draw/interfaces/Draw.md#setinteractionlocked)
- [保存と読み込み](../guides/save-load.ja.md)。`document.load` とその
  `layer` オプションです
- [標準の UI のオプション](../../ui/README.md#use) (英語)。道具のバー、
  レイヤーのパネル、インスペクターのオプションもあります
