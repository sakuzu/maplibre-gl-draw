---
aside: false
---

# Snapping and tracing

すでにあるものに合わせて描きます。ポインターは頂点、辺、ガイド線に
吸着します。境界の 2 点をクリックすると、その間の境界をなぞります。

```example
snapping-and-tracing
```

面の道具を選び、ポインターを区画に近づけると、吸着する先に印が
出ます。区画の東側の曲がった辺の南の端をクリックし、次に北の端を
クリックします。その間の頂点が入るので、隣の区画は境界を描き直さずに
共有できます。東へ描き進めて面を閉じます。最初の頂点を置いた後は、
北から 15 度ごとのガイド線で真っすぐに描けます。Alt を押している間は
吸着せずに頂点を置けます。道具のバーの端のスイッチで、吸着を
切り替えます。

## コード

区画と道路が吸着する先の地物です (1)。`draw.options.update` は渡した
キーだけを変えます。ここでは吸着する距離 (ピクセル)、ガイド線の
角度の刻み、吸着する先の種類を変え、辺のなぞりを有効にします (2)。
辺のなぞりには吸着が必要です。`snap.changed` は、ポインターの動きに
つれて吸着した先を知らせます (3)。道具のバーのスイッチは、同じ
呼び出しで `snapping.enabled` を書き込みます (4)。

::: code-group
<<< @/../examples/snapping-and-tracing/main.ts
<<< @/../examples/snapping-and-tracing/index.html
:::

## 関連

- 吸着と幾何演算のガイドの[吸着](../guides/snapping-geometry.ja.md#吸着)、
  [ガイド線](../guides/snapping-geometry.ja.md#ガイド線)、
  [辺のなぞり](../guides/snapping-geometry.ja.md#辺のなぞり)
- [`SnappingOptions`](../api/maplibre-gl-draw/interfaces/SnappingOptions.md)
  と [`TracingOptions`](../api/maplibre-gl-draw/interfaces/TracingOptions.md)
- [`options.update`](../api/maplibre-gl-draw/interfaces/OptionsResource.md#update)
- [入力のイベント](../reference/events.md#input) (英語)。
  `snap.changed` もその 1 つです
- 標準の UI の[道具のバー](../../ui/README.md#use) (英語)
