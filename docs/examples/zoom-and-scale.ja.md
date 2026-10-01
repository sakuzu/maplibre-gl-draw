---
aside: false
---

# Zoom and scale

地物ごとの基準のズームでのピクセルの太さは、地面に塗った線のように
地図とともに太くも細くもなります。同じ太さを画面の上で固定した地物と
並べて比べます。

```example
zoom-and-scale
```

2 つの段には同じ地物があります。太い線、輪郭の太い面、大きな点です。
このページは上の段の基準のズームである 15 で開くので、2 つの段は
同じに見えます。地図を拡大したり縮小したりしてください。上の段の線と
輪郭は、地面に塗ったように地図とともに太くも細くもなります。下の段は
画面の上で同じ太さのままです。点はどちらの段でも大きさが変わりません。
点はいつもそうです。太い線の隣の細い線は、基準のズーム 13 で 2 px
なので、ズーム 15 では 8 px の線と同じ太さです。`Z` を押すとオプションの
`scaleWithZoom` が切り替わります。押す前と後に道具で線を描いて
比べてください。左のパネルの矢印は道具が描き込むレイヤーを示し、
ブラウザーのコンソールには今の状態がログで出ます。

## コード

2 つのレイヤーに同じ地物を入れます。1 つめのレイヤーの地物には
`maplibre-gl-draw:createdZoom` のプロパティーを持たせ、2 つめのレイヤーの
地物には持たせません (2)。基準のズームは地物ごとの値なので、
`draw.features.update` で 1 つの地物だけ変えられます (3)。オプションの
`scaleWithZoom` は、描画の道具が描いたときのズームを地物に書き込むか
どうかを決めます。`draw.options.update` で変えられます (4)。

::: code-group
<<< @/../examples/zoom-and-scale/main.ts
<<< @/../examples/zoom-and-scale/index.html
:::

## 関連

- [スタイル](../guides/styles.ja.md)。基準のズームでの線の太さと、
  インスタンスの動作中に変えられるオプションの `scaleWithZoom` を
  説明します
- 性能のガイドの[描画の大きさを変える](../guides/performance.ja.md#描画の大きさを変える)。
  地図を描いた大きさより大きく、または小さく見せるときの設定です
- [`DrawProperties`](../api/maplibre-gl-draw/type-aliases/DrawProperties.md)
  の `maplibre-gl-draw:createdZoom`
- [`RuntimeOptions`](../api/maplibre-gl-draw/interfaces/RuntimeOptions.md)
  の `scaleWithZoom` と
  [`options.update`](../api/maplibre-gl-draw/interfaces/OptionsResource.md#update)
