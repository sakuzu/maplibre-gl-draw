# THIRD PARTY NOTICES

This package (`@sakuzu/maplibre-gl-draw`) is distributed under the GNU
Affero General Public License version 3 (AGPL-3.0-only) (see `LICENSE` at
the root of the repository). This file records the original copyright
notices and license texts for the third-party software that is ported into
the source code, as well as for the places where third-party strings are
concatenated and used at runtime. All of them are licenses compatible with
AGPL-3.0.

There are four items.

1. deck.gl (MIT) — port of the projection GLSL
2. math.gl (MIT) — port of the coefficient formula
3. maplibre-gl (BSD-3-Clause) — port of the terrain shader and runtime
   concatenation of the prelude
4. earcut (ISC) — port of the triangulation

For @types/geojson, earcut, polygon-clipping, rbush and ulid, which are
obtained as npm `dependencies`, together with their transitive dependencies
(robust-predicates, splaytree, quickselect), the license notices bundled
with each package apply.

---

## 1. deck.gl (MIT License)

The projection GLSL and the coefficient computation in
`src/view/shaders/helpers.ts` include a port from the `project` module of
deck.gl (`modules/core/src/shaderlib/project`). Specifically, the GLSL
functions of the offset mode, `project_offset` /
`project_position_mercator` / `project_offset_to_clipspace`, have the same
structure and the same formulas as deck.gl's `project_offset_` and
`project_common_position_to_clipspace`, and the whole computation flow of
obtaining the projection center at 64-bit precision on the CPU side and
adding it last also follows deck.gl's approach.

Upstream: <https://github.com/visgl/deck.gl>

The following is a reproduction of the full text of deck.gl's LICENSE.

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

The derivation of `unitsPerDegree2` (the non-linear correction
coefficient) in `src/view/shaders/helpers.ts` uses the same formula as the
highPrecision clause of `getDistanceScales` in `@math.gl/web-mercator`
(`modules/web-mercator/src/web-mercator-utils.ts`), and the definition of
the intermediate variable `latCosine2` is identical as well. The only
difference is that this package flips the sign of the Y axis to match the
tile coordinate system.

Upstream: <https://github.com/uber-web/math.gl>

The following is a reproduction of the full text of math.gl's LICENSE. The
notices for gl-matrix / THREE.js / Cesium that math.gl itself records in
the same file are included verbatim as well.

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

This package takes maplibre-gl as a peer dependency and draws as a custom
layer. There are two kinds of places derived from maplibre-gl's code.

### 3.1 Port of the Terrain Shader

`TERRAIN_SAMPLE_GLSL` in `src/view/terrain/drape/shared.ts` is a port of
the `#ifdef TERRAIN3D` clause of MapLibre's vertex shader prelude (DEM
sampling and elevation decoding). The bilinear interpolation and the
handling of the 1px border in the fragment shader of
`src/view/terrain/dem-atlas.ts` is a port of `get_elevation` in the same
prelude. Both keep the same structure and the same formulas, so that
elevation is looked up with the same function, the same DEM and the same
grid as MapLibre's terrain surface and our own mesh matches MapLibre's
terrain.

### 3.2 Runtime Concatenation of the Prelude

The vertex shader prelude string that MapLibre provides at runtime
(`CustomRenderMethodInput.shaderData.vertexShaderPrelude`) is concatenated
onto our own shader source, and the functions the prelude defines, such as
`projectTile()`, and its uniforms (`u_projection_transition` and others)
are called. This is the use of a string received at runtime, not a
transcription of code.

Upstream: <https://github.com/maplibre/maplibre-gl-js>

The following is a reproduction of the LICENSE of maplibre-gl-js (the
BSD-3-Clause part).

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

`src/view/renderers/polygon/earcut-sliced.ts` is a port of earcut 3.2.3
(`src/earcut.js`). The ear clipping algorithm and the helper functions are
identical to upstream; the only changes are that the main loop was made
able to break partway and resume from where it left off later, and that
TypeScript types were added (so that splitting a huge polygon does not
freeze the main thread). The English comments from upstream are also kept
as they are, as an explanation of the algorithm.

Note that earcut is also used as an npm dependency (polygons of ordinary
size call that one), and for that distribution the license bundled with the
earcut package applies.

Upstream: <https://github.com/mapbox/earcut>

The following is a reproduction of the full text of earcut's LICENSE.

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

---

## Sample data of the examples (Overture Maps)

The examples of the repository (`examples/`, not part of the package)
show buildings and places of central Tokyo from Overture Maps, in
`examples/public/data/`. `scripts/fetch-overture-sample.mjs` extracts
them, and `examples/public/data/README.md` records the release, the
extent, the counts and the sources of the rows.

Attribution: © OpenStreetMap contributors, Overture Maps Foundation.

- The buildings (`tokyo-buildings.geojson` and `tokyo-buildings.parquet`)
  are a database derived from Overture's buildings theme, under the Open
  Database License 1.0 (ODbL): <https://opendatacommons.org/licenses/odbl/1-0/>.
  Its rows come from OpenStreetMap and Microsoft's Global ML Building
  Footprints (ODbL), and from Qian Shi, et al., A First High-quality
  Vector Data of Buildings in East Asian Countries Based on a
  Comprehensive Large-scale Mapping Framework, Zenodo,
  doi:10.5281/zenodo.8174931 (CC BY 4.0)
- The places (`tokyo-places.geojson`) come from Overture's places theme,
  under the Community Data License Agreement Permissive 2.0:
  <https://cdla.dev/permissive-2-0/>. Rows from Foursquare are under the
  Apache License 2.0 (Copyright 2024 Foursquare Labs, Inc.), and rows from
  AllThePlaces under CC0 1.0

The terms of every source are on
<https://docs.overturemaps.org/attribution/>.
