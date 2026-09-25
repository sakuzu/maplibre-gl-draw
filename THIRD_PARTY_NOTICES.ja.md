# THIRD PARTY NOTICES

この文書は `THIRD_PARTY_NOTICES.md` の日本語版です。正は英語版で、
日本語版は参考として併記しています。

このパッケージ (`@sakuzu/maplibre-gl-draw`) は GNU Affero General Public
License version 3 (AGPL-3.0-only) で配布しています (リポジトリー直下の
`LICENSE` を参照)。このファイルには、ソースコードに移植した第三者の
ソフトウェアと、実行時に第三者の文字列を連結して使っている箇所について、
元の著作権表示とライセンスの条文を載せています。いずれも AGPL-3.0 と
両立するライセンスです。

対象は次の 4 つです。

1. deck.gl (MIT) — 投影の GLSL の移植
2. math.gl (MIT) — 係数の計算式の移植
3. maplibre-gl (BSD-3-Clause) — 地形シェーダーの移植と prelude の実行時の
   連結
4. earcut (ISC) — 三角形分割の移植

npm の `dependencies` として取得する @types/geojson、earcut、
polygon-clipping、rbush、ulid と、その推移的な依存 (robust-predicates、
splaytree、quickselect) には、それぞれのパッケージに同梱されている
ライセンス表示が適用されます。

---

## 1. deck.gl (MIT License)

`src/view/shaders/helpers.ts` の投影の GLSL と係数の計算には、deck.gl の
`project` モジュール (`modules/core/src/shaderlib/project`) から移植した
部分が含まれています。具体的には、オフセットモードの GLSL の関数
`project_offset`、`project_position_mercator`、
`project_offset_to_clipspace` が、deck.gl の `project_offset_` と
`project_common_position_to_clipspace` と同じ構造と数式を持っています。
また、CPU 側で投影の中心を 64 bit の精度で求めて最後に加える計算の流れ
全体も、deck.gl のやり方にならっています。

上流のリポジトリーは <https://github.com/visgl/deck.gl> です。

以下は deck.gl の LICENSE の全文の転載です。

```text
Copyright Vis.gl contributors.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

---

## 2. math.gl (MIT License)

`src/view/shaders/helpers.ts` の `unitsPerDegree2` (非線形の補正係数) の
導出には、`@math.gl/web-mercator` の `getDistanceScales` の
highPrecision の節 (`modules/web-mercator/src/web-mercator-utils.ts`)
と同じ式を使っており、中間の変数 `latCosine2` の定義も同じです。違うのは、
このパッケージがタイルの座標系に合わせて Y 軸の符号を反転している点
だけです。

上流のリポジトリーは <https://github.com/uber-web/math.gl> です。

以下は math.gl の LICENSE の全文の転載です。math.gl 自身が同じファイルに
載せている gl-matrix、THREE.js、Cesium の表示も、原文のまま含めています。

```text
MIT License

Copyright (c) 2017 Uber Technologies, Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.

---

math.gl builds on docs and code from "gl-matrix", which is MIT licensed as follows:

Copyright (c) 2015, Brandon Jones, Colin MacKenzie IV.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.

--

math.gl builds on docs and code from THREE.js, which is MIT licensed as follows:

The MIT License

Copyright © 2010-2017 three.js authors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.

---

math.gl includes certain files from Cesium
(https://github.com/AnalyticalGraphicsInc/cesium) under the Apache 2 License:

Copyright 2011-2018 CesiumJS Contributors

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at
http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.

Cesium-derived code can be found in the submodule: modules/3d-tiles
```

---

## 3. maplibre-gl (BSD-3-Clause)

このパッケージは maplibre-gl を peer dependency とし、カスタムレイヤー
として描画します。maplibre-gl のコードに由来する箇所は次の 2 種類です。

### 3.1 地形シェーダーの移植

`src/view/terrain/drape/shared.ts` の `TERRAIN_SAMPLE_GLSL` は、MapLibre の
頂点シェーダーの prelude のうち `#ifdef TERRAIN3D` の節 (DEM の
サンプリングと標高の復号) を移植したものです。
`src/view/terrain/dem-atlas.ts` のフラグメントシェーダーでの双一次補間と
縁の 1px の扱いは、同じ prelude の `get_elevation` を移植したものです。
どちらも同じ構造と数式を保っています。MapLibre の地形の表面と同じ関数、
同じ DEM、同じ格子で標高を引き、自前のメッシュを MapLibre の地形と一致
させるためです。

### 3.2 prelude の実行時の連結

MapLibre が実行時に渡す頂点シェーダーの prelude の文字列
(`CustomRenderMethodInput.shaderData.vertexShaderPrelude`) を自前の
シェーダーのソースに連結し、prelude が定義する `projectTile()` などの関数と
uniform (`u_projection_transition` など) を呼び出しています。これは実行時に
受け取った文字列を使っているのであり、コードを書き写したものではありません。

上流のリポジトリーは <https://github.com/maplibre/maplibre-gl-js> です。

以下は maplibre-gl-js の LICENSE (BSD-3-Clause の部分) の転載です。

```text
Copyright (c) 2023, MapLibre contributors

All rights reserved.

Redistribution and use in source and binary forms, with or without modification,
are permitted provided that the following conditions are met:

    * Redistributions of source code must retain the above copyright notice,
      this list of conditions and the following disclaimer.
    * Redistributions in binary form must reproduce the above copyright notice,
      this list of conditions and the following disclaimer in the documentation
      and/or other materials provided with the distribution.
    * Neither the name of MapLibre GL JS nor the names of its contributors
      may be used to endorse or promote products derived from this software
      without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
"AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR
CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL,
EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO,
PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR
PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF
LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING
NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

---

## 4. earcut (ISC License)

`src/view/renderers/polygon/earcut-sliced.ts` は earcut 3.2.3
(`src/earcut.js`) を移植したものです。耳切り (ear clipping) の
アルゴリズムと補助の関数は上流と同じです。変えたのは、本体のループを途中で
抜けて後から続きを再開できるようにしたことと、TypeScript の型を付けた
ことだけです (巨大なポリゴンの分割でメインスレッドを止めないためです)。
上流の英語のコメントも、アルゴリズムの説明としてそのまま残しています。

なお、earcut は npm の依存としても使っており (通常の大きさのポリゴンでは
そちらを呼びます)、その配布物には earcut のパッケージに同梱されている
ライセンスが適用されます。

上流のリポジトリーは <https://github.com/mapbox/earcut> です。

以下は earcut の LICENSE の全文の転載です。

```text
ISC License

Copyright (c) 2026, Mapbox

Permission to use, copy, modify, and/or distribute this software for any purpose
with or without fee is hereby granted, provided that the above copyright notice
and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND
FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS
OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER
TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF
THIS SOFTWARE.
```
