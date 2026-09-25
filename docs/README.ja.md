# ドキュメント

次の順に読んでください。はじめかたと手引きは、このライブラリーを
アプリケーションで使う人のための文書で、日本語版 (`*.ja.md`) もあります。
正は英語版です。リファレンスと内部の文書は英語だけです。

## はじめかた

- [getting-started.ja.md](getting-started.ja.md) — パッケージを
  インストールし、多角形を描き、変更を受け取り、描いたものを保存して
  読み込むまで
- [../examples/README.md](../examples/README.md) — 手引きごとに 1 つずつ
  ある、動かせる小さな例と、その起動の方法

## 手引き

どの手引きも 1 つの作業を扱います。必要なものを、どの順で読んでも
かまいません。

- [guides/drawing.ja.md](guides/drawing.ja.md) — 描画モード、選択、
  移動、拡縮、回転、頂点の編集、キーボードとタッチ
- [guides/layers.ja.md](guides/layers.ja.md) — レイヤー、グループ、
  アクティブなレイヤー、ロック、描画順と、レイヤーの間にネイティブの
  レイヤーを置く方法
- [guides/save-load.ja.md](guides/save-load.ja.md) — GeoJSON と独自の
  形式、画像、自前の保存先の接続
- [guides/styles.ja.md](guides/styles.ja.md) — 地物のスタイル、スタイル
  規則、凡例、メッセージ
- [guides/snapping-geometry.ja.md](guides/snapping-geometry.ja.md) —
  吸着、なぞり、共有する頂点、幾何演算、geometry のサブパス
- [guides/terrain.ja.md](guides/terrain.ja.md) — 地図に地形があるときに
  変わること
- [guides/read-only.ja.md](guides/read-only.ja.md) — 読み取り専用モード、
  操作ロック、クライアントごとの表示
- [guides/large-data.ja.md](guides/large-data.ja.md) — 大量データのための
  データセット
- [guides/plugins.ja.md](guides/plugins.ja.md) — プラグインと独自の
  モードの書き方
- [guides/custom-types.ja.md](guides/custom-types.ja.md) — 独自の描画と
  当たり判定を持つ地物の型の追加
- [guides/frameworks.ja.md](guides/frameworks.ja.md) — React、Svelte、
  Vue での使い方と、サーバーサイドレンダリングでの使い方
- [guides/performance.ja.md](guides/performance.ja.md) — 扱える規模の
  目安と、自分の場合の測り方
- [guides/migrating.ja.md](guides/migrating.ja.md) — mapbox-gl-draw や
  terra-draw からの移行

## リファレンス (英語)

- [API リファレンス](https://sakuzu.github.io/maplibre-gl-draw/api/) —
  すべての公開記号の生成したリファレンス。
  [デモ](https://sakuzu.github.io/maplibre-gl-draw/) と同じ場所で
  公開しています
- [reference/README.md](reference/README.md) — 公開 API の 2 つの層、
  版の保証、生成する API リファレンスの作り方
- [reference/data-format.md](reference/data-format.md) — 地物の型ごとの、
  独自の形式と GeoJSON の形式
- [reference/events.md](reference/events.md) — すべてのイベントと
  その payload

## 内部 (英語)

ライブラリー自体に手を入れる人のための文書です。どう作られているかを
説明しており、公開していない型にも触れます。

まず architecture を読んでください。残りの文書は、それぞれ 1 つの部分を
掘り下げています。

- [internals/README.md](internals/README.md) — 以下の文書を読む順番
- [internals/architecture.md](internals/architecture.md) — コードの層、
  正としての Store、入力、モード、プラグイン
- [internals/rendering.md](internals/rendering.md) — WebGL2 の描画の
  流れ、描画器、保持型のバッチ、地形、表示順
- [internals/hit-testing.md](internals/hit-testing.md) — 2 段階の当たり
  判定と、当たりを決める順番
- [internals/coordinate-precision.md](internals/coordinate-precision.md)
  — オフセット座標、globe、日付変更線
- [internals/maplibre-coupling.md](internals/maplibre-coupling.md) —
  maplibre-gl の内部に依存しているすべての箇所と、版を上げるときに
  確かめること
- [internals/test-design.md](internals/test-design.md) — テストのまとまり
  ごとに守っているもの
- [internals/releasing.md](internals/releasing.md) — 版、対応する
  maplibre-gl と Node、公開の手順

ライブラリーを変えるときの規則は
[../CONTRIBUTING.ja.md](../CONTRIBUTING.ja.md) にあります。
