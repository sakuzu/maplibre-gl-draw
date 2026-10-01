---
aside: false
---

# Terrain

地図の 3D の地形の上で描き、直します。標準の UI を重ねています。

```example
terrain
```

地図はアルプスの上で傾いた状態で開き、谷を渡る線と斜面の上の面が
あります。どちらも起伏の上に載っています。下の道具で描くと、頂点は
ポインターの下の地面に置かれます。地物を選ぶと、その地物や頂点を
ドラッグで動かせます。ハンドルは地面の上に立ちます。右ボタンか、
Ctrl を押しながらのドラッグで地図を回し、右下のコンパスを押すと
平らに戻ります。最後のフレームを地形の上に描いたかどうかが、
ブラウザーのコンソールに出ます。

## コード

地形は地図のものです。`raster-dem` のソースと `map.setTerrain` で
設定します (2)。ライブラリーには地形の設定がなく、地図に従います。
そのため、地物 (3) と標準の UI (4) は平らな地図と同じように作ります。
`draw.debug.terrain` は最後のフレームの描き方を返します (5)。
標高は [Mapterhorn](https://mapterhorn.com/) です。全球を覆う公開の
DEM で、符号化の方式とタイルの大きさと帰属は TileJSON が持つので、
ソースにはアドレスだけを書きます。

::: code-group
<<< @/../examples/terrain/main.ts
<<< @/../examples/terrain/data.ts
<<< @/../examples/terrain/index.html
:::

## 関連

- [地形](../guides/terrain.ja.md)。地形の上で変わること、点とハンドル、
  誇張、診断、制限を説明します
- [`TerrainDiagnostics`](../api/maplibre-gl-draw/interfaces/TerrainDiagnostics.md)。
  `draw.debug.terrain` が返すものです
- 標準の UI の[地図の操作ボタン](../../ui/README.md#map-controls) (英語)
