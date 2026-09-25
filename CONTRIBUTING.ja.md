# 貢献の手引き

この文書は `CONTRIBUTING.md` の日本語版です。正は英語版で、日本語版は
参考として併記しています。

このリポジトリーは `@sakuzu/maplibre-gl-draw` (core) を提供しています。
ライセンスは AGPL-3.0-only で、著作権は SAKAIDA Atsushi が単独で保有して
います。core の商用ライセンスは可視化技研株式会社 (Kasika, Inc.) が販売
しています。

## 貢献の方針

core の著作権を単独で保っていることが商用ライセンスを出せる条件なので、
外部からのプルリクエストは今のところ受け付けていません。不具合の報告と
機能の要望は issue で受け付けています。再現の手順、期待する振る舞い、
実際の振る舞い、maplibre-gl の版を書いてください。

将来プルリクエストを受け付ける場合は、著作権の譲渡を含む貢献者契約
(CLA) を結ぶことが前提になります。

以下は、このリポジトリーの中で守っている規則です。

## ドキュメントの言語

ドキュメントは英語で書き、英語のファイル (`X.md`) を正とします。日本語版
(`X.ja.md`) を隣に置くのは利用者向けの文書だけで、`README.md`、
`docs/README.md`、`docs/getting-started.md` と `docs/guides/` の手引きが
該当します。リファレンス (`docs/reference/`) と内部の文書
(`docs/internals/`) は英語だけです。日本語版のある文書を変えるときは、
同じコミットで日本語版も変えて、両者の内容を揃えてください。

利用者向けの文書は次の規則で書きます。

- 読者はこのライブラリーを初めて使う開発者で、maplibre-gl は知っている
  ものとします。目的、最小のコード、結果、注意点の順に書きます
- コードは `examples/` の該当する例から取り、書いたとおりに動く形に
  します。import 元は `@sakuzu/maplibre-gl-draw` と
  `@sakuzu/maplibre-gl-draw/geometry` だけにします
- 型とメソッドを 1 つずつ説明しません。生成したリファレンスへリンクし、
  その説明は宣言の TSDoc に書きます
- 経緯、実測の記録、過去の不具合、受け入れ条件は書きません。数値は
  利用者が判断するのに必要なものだけを書きます

## 拡張との境界で守ること

### core は特定の拡張を前提にしない

拡張は、core が公開している拡張点の上に作る別のパッケージです。core は
拡張点を提供するだけで、どんな拡張があるかを知りません。core の記号の
名前には一般的な語だけを使います。特定の拡張に固有の概念を表す名前を
持ち込まないでください。

依存の向きは次のとおりです。

```text
拡張 (別パッケージ)
         │
         │ peerDependencies
         ▼
maplibre-gl-draw (core, 本リポジトリ)
```

拡張は core の export を import しますが、その逆は禁止です。

使ってよい名前の例は `Plugin`、`PluginContext`、`Hooks`、`Mode`、
`CustomFeatureHandler`、`addOverlayRenderer` (拡張の仕組みとして一般化
されているもの) です。

特定の拡張に固有の概念を表す名前は使えません。

ドキュメント、コメント、テスト、examples でも同じです。拡張点は一般的な
語で説明し、特定の拡張の機能や構造は書きません。

この規則は `npm run check:terms` (`npm run lint` に含まれます) で検査
します。ドキュメント、ソース、テスト、examples から特定の拡張を名指し
したり説明したりする語を探し、見つかれば失敗します。

## パッケージの構成

### サブパスの export は別の環境でも動く純関数に限る

`package.json` の `exports` には、モジュールの `.` と `./geometry` の
2 つと、メタデータの `./package.json` の 1 つがあります。`./geometry` は
maplibre、DOM、wasm のどれにも依存しない純関数だけを集めたモジュール
です。ブラウザーの外 (Node、Bun、Worker) でも core 本体を読み込まずに
同じ計算ができるように公開しています。この条件を満たさないサブパスの
export (`./store` や `./modes` など) は追加しません。実装の内部構造を
外部に対して固定してしまうからです。tree-shaking が目的なら
`"sideEffects": false` で十分です。

サブパスを増やすときは、依存が閉じていることを機械的に検査するテスト
(`src/geometry/dependency.test.ts` に相当するもの) を同時に用意して
ください。

`exports` の条件では `types` を先頭に置きます。TypeScript の node16 系の
解決は条件を上から順に見るので、`import` が先にあると型の解決に失敗する
ことがあります。モジュールの項はどれも、最後に `import` と同じ ES
モジュールを指す `default` 条件を置きます。ほかの 2 つのどちらにも
当たらない解決器のためです。

`./package.json` はモジュールではなくメタデータとして export しています。
インストールしたパッケージの manifest を読むツール
(`require.resolve('@sakuzu/maplibre-gl-draw/package.json')`、バンドラーの
プラグイン、ライセンスの検査) はこれが無いと失敗します。また、これは実装を
何も露出しません。上のサブパスの規則の対象外になるのはこの項だけです。

### 公開する範囲

`src/index.ts` では公開する記号を 1 つずつ名前で並べ、`export *` は
使いません。名前は 2 つの層に分かれ、ファイルでもこの順に 2 つの節に
分けて並べます。

- 層 1 は公開 API です。ファクトリー `createMapLibreGLDraw`、
  インスタンス `MapLibreGLDraw` とその `Options`、データモデル
  (`Feature`、`Layer`、`Group`、`StyleRule`、`LoadResult` など)、
  イベントの payload、拡張点 (`Plugin`、`PluginContext`、`ModeHandler`、
  `ModeContext`、`NormalizedEvent` の一群、`CustomFeatureHandler`、
  overlay renderer、snapping provider、hit test と box selection の
  strategy、補助ハンドルと companion の契約)、純関数 (style rule、
  プロパティーのアクセサー、トレース) を含みます。semver に従います。
- 層 2 は拡張を作る人向けの部品です。プラグイン、独自の地物の型、独自の
  モードが、core と同じやり方で描画や当たり判定をするために再利用できる
  部品を含みます。WebGL の補助 (`createProgram`、`QuadShader`、
  `ProjectionUniformManager`、blend と深度の補助)、地形に固定する関数、
  OBB と投影の計算、選択の補助、`ModeContext` と
  `CustomRendererDrawContext` が渡す core のサービスの型が該当します。
  保証は層 1 より弱く、minor の版で変わることがあります。一覧は
  `docs/reference/README.md` の節 "The two layers of the public API" に
  あります。

新しい記号をどこに置くかは次のように決めます。

- ホストのアプリケーションがライブラリーを使うのに必要な記号と、拡張が
  拡張点につなぐのに必要な記号は層 1 に置きます。
- 拡張が自分の描画や当たり判定の中で core と同じことを再現するための
  記号は層 2 に置きます。一般的な拡張点で足りるなら、新しい部品より
  そちらを選びます。
- 公開の宣言が参照する型 (引数、戻り値、フィールド) も export します。
  置く層は、その型を必要とする宣言の層に合わせます。ただし `ModeContext`
  と `CustomRendererDrawContext` から届く core のサービスの型は層 2 に
  置きます。
- それ以外は内部の記号で、並べません。

記号を公開するときは、そのドメインの barrel (`src/<domain>/index.ts`。
公開する記号だけを並べます) に足し、`src/index.ts` の該当する節に名前を
書き、`src/index.test.ts` のその層の一覧に足し、`CHANGELOG.md` に記録
します (層 2 なら `docs/reference/README.md` にも記録します)。テストが
一覧を固定しているので、公開する範囲が意図せず変わることはありません。

内部の記号のうち、生成される宣言に出てしまうもの (モジュールから export
した宣言や、公開のクラスとインターフェースのメンバーのうち契約に含まれ
ないもの) には JSDoc のタグ `@internal` を付け、`stripInternal` で
`dist/` から除きます。`src/index.test.ts` は宣言を生成し、宣言だけで型
検査が通ること (公開の宣言が除かれた宣言を参照していないこと) と、公開の
宣言が参照する名前付きの型がすべて export されていることを確かめます。
公開の宣言の JSDoc には、地の文であってもこのタグの語を書かないで
ください。コンパイラーがその宣言を除いてしまいます。

## 開発の流れ

```bash
npm install        # ルートで実行 (examples もまとめてインストール)
npx playwright-core install chromium-headless-shell  # 初回だけ (シェーダーの試験用)
npm run typecheck  # 型チェック
npm test           # vitest
npm run test:e2e   # 実際の maplibre の地図での E2E テスト (約 10 秒)
npm run build      # dist/ を生成
npm run lint       # biome lint のあと check:layers と check:terms
npm run check:layers  # 層の規則と import の循環
npm run check:terms   # 特定の拡張を指す語が無いこと
npm run docs:api   # API リファレンスを docs/reference/api/ に生成
npm run docs:check # ドキュメントの門 (docs/internals/releasing.md)
npm run build:site # GitHub Pages のサイトを site-dist/ に組み立てる
npm run lint:fix   # biome auto-fix
npm run dev        # examples をブラウザで起動 (localhost:3000)
```

ブラウザーはマシンごとに 1 度だけ入れます。
`src/view/shaders/compile.test.ts` がすべてのシェーダープログラムを
headless Chromium の WebGL2 でコンパイルするので、入っていないと
`npm test` が失敗します。同じブラウザーで `src/e2e/` の E2E テスト
(`npm run test:e2e`) も動きます。headless Chromium の中の実際の maplibre
の地図を、実際のマウスとキーボードで操作するテストです。約 10 秒かかるので
`npm test` からは外しています。入力の経路、モード、当たり判定を変えた
ときは、コミットの前に実行してください
(`docs/internals/test-design.md` の E2E の節を参照)。

`npm run check:layers` は、`docs/internals/architecture.md` の依存の
規則を `src/` の import 文に照らして検査します。規則に反する実行時の
import や、実行時の import の循環があると失敗します。逆を向いた型だけの
import は既知の逸脱として一覧に出すだけで、失敗にはしません。下の領域
から上の領域を呼ぶ必要が出たら、例外を足すのではなく、関数 (または型)
を下へ移してください。

コミットの前には、少なくとも typecheck、test、lint が通ることを確かめて
ください。開発にも公開するパッケージにも Node 22 以降が必要です
(`package.json` の `engines`)。

版、タグ、変更履歴、公開の手順は `docs/internals/releasing.md` に書いて
あります。

### GitHub Pages のデモ

デモ (<https://sakuzu.github.io/maplibre-gl-draw/>) は、README の最初の
画像の見本を開いた playground (`?plain` を付けると見本なしで開き、
`?showcase=tilted`、`?showcase=terrain`、`?showcase=globe` でほかの画像の
場面を開きます)、`/examples/` の例、`/api/` の生成した API リファレンスで
できています。bench は載せていません。`npm run docs:image` はこれらの場面
(`playground/showcase/`) から README の画像を撮り直します。

```bash
npm run build:site     # サイトを site-dist/ に組み立てる (コミットしない)
npm run deploy:pages -- --dry-run  # push 以外のすべて
npm run deploy:pages   # 組み立てて site-dist/ を origin の gh-pages ブランチへ push
npm run deploy:pages -- --remote upstream  # 別の remote へ push
```

公開は手元のクローンから行います。GitHub Actions は使いません。
`deploy:pages` は一時的な index を使って remote の `gh-pages` の上に
サイトをコミットする (`.nojekyll` を含みます) ので、作業ツリーには
触れません。どのページも相対パスで書いているので、`site-dist/` は
サブディレクトリーから配信しても動きます。リポジトリーの Pages の公開元は
`gh-pages` ブランチのルートです。

### リポジトリーの構成

- `src/` はライブラリー本体です
- `examples/` は手引きごとの小さな例です。`npm run dev` で開きます
- `playground/` はすべての機能を試せる 1 枚のページです
- `bench/` はフレーム時間を測るページです (貢献する人向け)
- `docs/` にははじめかた、手引き、リファレンス、内部の文書があります
  (索引は `docs/README.md`)
- `scripts/` には `npm run lint` と `npm run docs:check` が実行する
  検査と、GitHub Pages のサイトを組み立てて公開するスクリプトがあります

生成した API リファレンス (`docs/reference/api/`) はコミットしません。
利用者が気づく変更は `CHANGELOG.md` に記録します。
