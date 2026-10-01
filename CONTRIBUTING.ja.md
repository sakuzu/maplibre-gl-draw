# 貢献の手引き

この文書は `CONTRIBUTING.md` の日本語版です。正は英語版で、日本語版は
参考として併記しています。

このリポジトリーは `@sakuzu/maplibre-gl-draw` (core) を提供しています。
ライセンスは AGPL-3.0-only で、著作権は SAKAIDA Atsushi が保有して
います。core の商用ライセンスは可視化技研株式会社 (Kasika, Inc.) が販売
しています。

## 貢献の方針

不具合の報告と機能の要望は issue で受け付けています。再現の手順、期待
する振る舞い、実際の振る舞い、maplibre-gl の版を書いてください。

プルリクエストは、[CLA.md](CLA.md) の貢献者ライセンス契約 (CLA) の
もとで受け付けています。core は AGPL と商用ライセンスの両方で提供して
いるので、著作権者には core のすべての部分を AGPL 以外の条件で許諾する
権利が要ります。CLA はその権利を与えるものです。貢献した部分の著作権は
あなたに残り、あなたはそれを任意の条件で利用できる永久、無償、再許諾
可能な許諾を与えます。あわせて、プロジェクトに対して著作者人格権を
行使しないこと、貢献に含まれる特許を許諾することを約束します。

CLA への同意は 1 手順です。最初のプルリクエストを開くと CLA Assistant
の bot がコメントを付けるので、求められた 1 文をプルリクエストに返信
してください。bot が同意を `sakuzu/cla-signatures` に記録します。同意は
1 回だけで、以後のプルリクエストでは何もしなくてよいです。コミットの
作者全員が同意するまでプルリクエストはマージされません。

大きな変更は、先に issue を開いて設計を合意してください。自分で書いて
いないコードは、そのライセンスとともにプルリクエストに明記してください。

すべてのプルリクエストで、次の門が GitHub Actions
(`.github/workflows/ci.yml`) で走ります。`typecheck`、`lint`、`test`、
`build`、`check:package`、`docs:check`、`test:e2e`。push の前にローカル
でも回してください。E2E は最初に 1 回 `npx playwright-core install
chromium-headless-shell` が要ります。

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

使ってよい名前の例は `Plugin`、`PluginContext`、`Mode`、
`FeatureTypeDefinition`、`draw.extensions.overlays` (拡張の仕組みとして
一般化されているもの) です。

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

`src/index.ts`、`src/geometry/index.ts`、`src/table/index.ts`、
`src/webgl/index.ts` では公開する記号を 1 つずつ名前で並べ、`export *`
は使いません。名前は 2 つの層に分かれます。層 1 は main の入口 (同じ
規則に従う `/geometry` と `/table` を含みます) で、層 2 は入口
`@sakuzu/maplibre-gl-draw/webgl` です。

- 層 1 は公開 API です。`createDraw` と、コレクションと資源の型を
  持つインスタンス `Draw`、`DrawOptions` と `RuntimeOptions`、入力と
  差分と絞り込みを含む文書のモデル (`Feature`、`Layer`、`Group`、
  `StyleRule`、`DrawDocument` など)、状態、`DrawEvents`、`DrawError`、
  データセット、Store の契約、拡張の窓口 (`Plugin`、各種の窓口、
  `ModeHandler`、`FeatureTypeDefinition`、描画器、提供者)、スタイルの
  規則の関数を含みます。契約は `src/api/` と `src/api/extension/` で
  宣言します。semver に従います。
- 層 2 は独自のシェーダーを書く人向けの部品です (`src/webgl/index.ts`)。
  core のシェーダーと地形の描き方に結び付いた部品を含みます。GLSL の
  断片と投影の uniform、`createProgram`、`QuadShader`、合成と看板の補助、
  共有の線の描画器の入力の型、破線と地形の分割の規則、
  `PointHitTestStrategy` が該当します。それに結び付かない純粋な計算
  (向きのある矩形、px と度の換算、色のコントラスト) は公開せず、拡張の側で
  持ちます。保証は層 1 より弱く、minor の版で変わることがあります。層 1
  の宣言は層 2 の型を参照しません。

新しい記号をどこに置くかは次のように決めます。

- ホストのアプリケーションがライブラリーを使うのに必要な記号と、拡張が
  拡張点につなぐのに必要な記号は層 1 に置きます。
- 独自のシェーダーが core のシェーダーと同じことを再現するための記号は
  層 2 に置きます。一般的な拡張点で足りるなら、新しい部品よりそちらを
  選びます。
- 公開の宣言が参照する型 (引数、戻り値、フィールド) も export します。
  置く層は、その型を必要とする宣言の層に合わせます。
- それ以外は内部の記号で、並べません。

記号を公開するときは、その層の契約を置く場所 (main の入口なら
`src/api/`) で宣言し、入口のファイルの該当する節に名前を書き、
`src/index.test.ts` のその入口の一覧に足し、`CHANGELOG.md` に記録
します。テストが一覧を固定して
いるので、公開する範囲が意図せず変わることはありません。

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
npm run docs:api   # API リファレンスを docs/api/ に生成 (サイト用の Markdown)
npm run docs:check # ドキュメントの門 (docs/internals/releasing.md)
npm run build:site # GitHub Pages のサイトを site-dist/ に組み立てる
npm run site:dev   # 例と playground を含めてサイトを起動 (localhost:5173)
npm run lint:fix   # biome auto-fix
npm run dev        # examples をブラウザで起動 (localhost:3200)
```

例と playground は `ui/` の標準の UI を地図に重ねていて、アプリが npm
から取るのと同じように、そのビルド `ui/dist/` から取ります。これが無いと
`npm run dev`、`npm run site:dev`、`npm run site:build`、
`npm run test:e2e` はメッセージを出して止まります。
先に `npm run build` と `npm run ui:build` を実行し、`ui/` を直したら
もう一度 `npm run ui:build` を実行してください。

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

### GitHub Pages のサイト

サイト (<https://sakuzu.github.io/maplibre-gl-draw/>) は、VitePress
(`docs/.vitepress/`) で組み立てる `docs/` のドキュメントのサイトです。
英語と日本語のはじめかたと手引き、`/examples/` の例のギャラリーと、
例をコードと一緒に動かす例ごとのページ、`/playground/` の playground、
`/api/` の API リファレンスでできています。ビルドは、サイトが以前に
公開していた URL からのリダイレクトも書きます。古い API リファレンスの
HTML のページと、置き換えた例の URL です (`scripts/site-redirects.mjs`)。
bench は載せていません。

```bash
npm run site:dev       # サイト、例、playground をまとめて起動
npm run site:thumbnails  # ギャラリーの画像を撮り直す
npm run build:site     # サイトを site-dist/ に組み立てる (コミットしない)
npm run site:preview   # site-dist/ を組み立てたときのアドレスで配信
npm run deploy:pages -- --dry-run  # push 以外のすべて
npm run deploy:pages   # 組み立てて site-dist/ を origin の gh-pages ブランチへ push
npm run deploy:pages -- --remote upstream  # 別の remote へ push
```

`npm run site:dev` は、例 (ポート 3200)、playground (ポート 3300)、
VitePress (ポート 5173) の開発サーバーを起動し、3 つが応答したら
<http://localhost:5173/maplibre-gl-draw/> を表示します。Ctrl-C で 3 つとも
止まります。ページは例と playground をそれぞれの開発サーバーから枠に
出すので、例、ライブラリー、ページを直すと、読み込み直すだけで反映
されます。例だけを開くときは、これまでどおり `npm run dev` を使います。

ギャラリーの画像 (`docs/public/examples/<name>.png`) は、
`npm run site:thumbnails` が例と playground からネットワークを使わずに
撮り、コミットします。`npm run docs:image` は、playground の見本の場面
(`?showcase`、`?showcase=tilted`、`?showcase=terrain`、
`?showcase=globe`、`?showcase=large-data`、`playground/showcase/`) から
README の画像を撮り直します。

公開は手元のクローンから行います。GitHub Actions は使いません。
`deploy:pages` は一時的な index を使って remote の `gh-pages` の上に
サイトをコミットする (`.nojekyll` を含みます) ので、作業ツリーには
触れません。ページはリポジトリーの Pages のアドレス `/maplibre-gl-draw/`
(VitePress の設定の `base`) に合わせて組み立てます。
`npm run site:preview` も同じアドレスで配信します。リポジトリーの Pages の
公開元は `gh-pages` ブランチのルートです。

### リポジトリーの構成

- `src/` はライブラリー本体です
- `examples/` は例です。`npm run dev` で開きます。例のページとギャラリーは
  `docs/examples/` にあります
- `playground/` はすべての機能を試せる 1 枚のページです
- `bench/` はフレーム時間を測るページです (貢献する人向け)
- `docs/` にははじめかた、手引き、リファレンス、内部の文書があります
  (索引は `docs/README.md`)
- `scripts/` には `npm run lint` と `npm run docs:check` が実行する
  検査と、GitHub Pages のサイトを組み立てて公開するスクリプトがあります

生成した API リファレンス (`docs/api/`) はコミットしません。
利用者が気づく変更は `CHANGELOG.md` に記録します。
