---
layout: home
title: maplibre-gl-draw
hero:
  name: maplibre-gl-draw
  text: MapLibre の地図で図形を描き、編集する
  tagline: 独自の WebGL2 の描画で、20 万の地物を編集できるまま描きます。平らな地図でも、3D の地形の上でも、地球儀でも同じように描けます。
  actions:
    - theme: brand
      text: はじめかた
      link: /ja/getting-started
    - theme: alt
      text: Playground を試す
      link: /playground/
      target: _self
    - theme: alt
      text: 例
      link: /ja/examples/
features:
  - title: 描いて直す
    details: 点、線、面、円、フリーハンドの線を描けます。選んで動かし、大きさを変え、回し、頂点を直せます。吸着となぞりも使えます。
    link: /ja/guides/drawing
  - title: 20 万の地物を編集できる
    details: 描画全体を GPU で描くので、大きな描画も編集できるまま扱えます。
    link: /ja/guides/performance
  - title: 地形と地球儀
    details: 傾けた地図でも、3D の地形の上でも、地球儀でも同じように描けます。日付変更線もまたげます。
    link: /ja/guides/terrain
  - title: データセット
    details: 数万の区画や 100 万の点を、描いたものの横に速く表示できます。GeoJSON の地物からも、GeoParquet や Arrow の列からも直接渡せます。
    link: /ja/guides/large-data
  - title: どこでも使える幾何演算
    details: 結合、差、交差、分割、バッファー、長さ、面積は、Node や Worker でも動く普通の関数です。
    link: /ja/guides/snapping-geometry
  - title: 拡張できる
    details: プラグイン、モード、地物の型、重ね描き、提供者を、どれも同じ方法で足せます。組み込みの描画モードも同じ窓口で書かれています。
    link: /ja/guides/plugins
---

## インストール

```sh
npm install @sakuzu/maplibre-gl-draw
```

maplibre-gl は peer dependency です。アプリにすでに入っている
maplibre-gl を使います。まだ入っていなければ、npm 7 以降は一緒に
インストールされます。

続けて [はじめかた](getting-started.ja.md) に沿って、最初の面を
描いてください。

## 見てみる

東京の中心の上の playground の描画、同じ描画を傾けて回した地図、
地球儀、3D の地形、208,073 の編集できる地物の街です。

![東京の中心の上の playground。円、線、頂点のハンドル付きで選ばれた穴あきの面、記号、画像、スタイルの規則で塗り分けた区画、凡例、レイヤーのパネル](images/overview.jpg)

![最初の絵の描画を、地図を傾けて回し、北が上でない向きで見たところ](images/tilted.jpg)

![地球儀。大陸の間の大円の経路、2 本の経線と 2 本の緯線で囲んだ範囲、都市の記号](images/globe.jpg)

![インスブルックの上の山を 3D で。斜面に沿って掛けた範囲、山頂までの道、尾根の向こうに消える破線](images/terrain.jpg)

![傾けたカメラから見た架空の街。小さな家、通り、公園、施設の記号がすべて編集できる地物で、遠くまで続き、手前の公園が選ばれている](images/large-data.jpg)

## ライセンス

AGPL-3.0-only です。製品に AGPL が合わない場合は、可視化技研株式会社
(Kasika, Inc.) から商用ライセンスを受けられます
([kasika.xyz](https://www.kasika.xyz/))。
