# Contributing Guide

This repository provides `@sakuzu/maplibre-gl-draw` (core). It is licensed
under AGPL-3.0-only, and SAKAIDA Atsushi holds the copyright. Commercial
licenses for core are sold by Kasika, Inc.

## Contribution policy

Bug reports and feature requests are accepted as issues. Write the steps to
reproduce, the expected behavior, the actual behavior, and the version of
maplibre-gl.

Pull requests are accepted under the contributor license agreement in
[CLA.md](CLA.md). Because core is offered both under the AGPL and under
commercial licenses, the copyright holder needs the right to license every
part of it under terms other than the AGPL. The CLA gives that right: you
keep the copyright in your contribution and grant a perpetual, royalty-free,
sublicensable license to use it under any terms. It also asks you not to
assert moral rights against the project and grants a patent license for
your contribution.

Accepting the CLA takes one step. When you open your first pull request,
the CLA Assistant bot posts a comment; reply to the pull request with the
sentence it asks for, and the bot records your acceptance in
`sakuzu/cla-signatures`. You do this once; later pull requests need no
further action. A pull request is not merged until every author of its
commits has accepted.

Open an issue before a large change, so that the design can be agreed on
first. Code you did not write yourself must be identified in the pull
request together with its license.

Every pull request runs the gates below on GitHub Actions
(`.github/workflows/ci.yml`): `typecheck`, `lint`, `test`, `build`,
`check:package`, `docs:check` and `test:e2e`. Run them locally before you
push; the end-to-end tests need `npx playwright-core install
chromium-headless-shell` once.

The rules below are the ones we keep inside this repository.

## Documentation language

Documentation is written in English, and the English file (`X.md`) is
authoritative. A Japanese version (`X.ja.md`) is kept next to it only for
the documents for users: `README.md`, `docs/README.md`,
`docs/getting-started.md` and the guides in `docs/guides/`. The reference
(`docs/reference/`) and the internals (`docs/internals/`) are in English
only. When you change a document that has a Japanese version, change the
Japanese version in the same commit so the two say the same thing.

The documents for users follow these rules.

- The reader uses this library for the first time and knows maplibre-gl.
  Explain in the order purpose, minimal code, result, caveats
- Take code from the matching example in `examples/`, so that it runs as
  written. Import from `@sakuzu/maplibre-gl-draw` and
  `@sakuzu/maplibre-gl-draw/geometry` only
- Do not describe types and methods one by one; link to the generated
  reference instead, and write that description in the TSDoc of the
  declaration
- Leave out history, measurement records, past bugs and acceptance
  criteria. Give a number only when a user needs it to decide something

## Invariants of the extension boundary

### core does not assume any particular extension

Extensions are separate packages built on the public extension points of
core. core provides the extension points and does not know which
extensions exist. Symbol names in core use general words only. Do not
bring in names that stand for a concept specific to a particular
extension.

The direction of dependency is as follows.

```text
extension (separate package)
         │
         │ peerDependencies
         ▼
maplibre-gl-draw (core, this repository)
```

An extension imports the exports of core, but the opposite is forbidden.

Examples that are allowed are `Plugin`, `PluginContext`, `Hooks`, `Mode`,
`CustomFeatureHandler`, and `addOverlayRenderer` (generalized as an
extension mechanism).

Names that stand for a concept specific to a particular extension are not
allowed.

The same holds for documentation, comments, tests and examples: describe
extension points in general terms and do not describe the features or the
structure of any particular extension.

`npm run check:terms` (part of `npm run lint`) is the gate for this rule.
It searches the documentation, sources, tests and examples for words that
name or describe a particular extension and fails when it finds one.

## Package structure

### Subpath exports are limited to pure functions that also run elsewhere

The `exports` of `package.json` has two module entries, `.` and
`./geometry`, and one metadata entry, `./package.json`.
`./geometry` is a module that collects only pure functions that depend on
neither maplibre, the DOM, nor wasm, and it is published so that the same
computation can be reproduced outside the browser (Node / Bun / Worker)
without loading core itself. Do not add subpath exports that do not meet
this condition (`./store`, `./modes` and the like). The reason is that they
would freeze the internal structure of the implementation in place for the
outside world; if the purpose is tree-shaking, `"sideEffects": false` works
well enough.

When adding a subpath, prepare at the same time a test that mechanically
checks how the dependencies are closed (equivalent to
`src/geometry/dependency.test.ts`).

Put `types` first among the conditions of `exports`. The node16 family of
TypeScript resolution looks at the conditions in order from the top, so if
`import` comes first the resolution of types can fail. End every module
entry with a `default` condition that points at the same ES module as
`import`, for resolvers that match neither of the other two.

`./package.json` is exported as metadata, not as a module: tools that read
the manifest of an installed package
(`require.resolve('@sakuzu/maplibre-gl-draw/package.json')`, bundler
plugins, license checkers) fail without it, and it exposes nothing of the
implementation. It is the only entry that the rule on subpaths above does
not cover.

### The public surface

`src/index.ts` and `src/webgl/index.ts` name every public symbol one by
one; they have no `export *`. The names fall into two layers: layer 1 is
the main entry, and layer 2 is the entry `@sakuzu/maplibre-gl-draw/webgl`.

- Layer 1, the public API. The factory `createMapLibreGLDraw`, the
  `MapLibreGLDraw` instance and its `Options`, the data model (`Feature`,
  `Layer`, `Group`, `StyleRule`, `LoadResult` and so on), the event
  payloads, the extension points (`Plugin`, `PluginContext`, `ModeHandler`,
  `ModeContext`, the `NormalizedEvent` family, `CustomFeatureHandler`, the
  overlay renderer, the snapping provider, the hit test and box selection
  strategies, the auxiliary handle and the companion contracts) and the pure
  functions (style rules, property accessors, tracing). It follows semver.
- Layer 2, the building blocks for custom shaders (`src/webgl/index.ts`).
  Parts tied to the shaders and the terrain drawing of core: the GLSL
  snippet and the projection uniforms, `createProgram`, `QuadShader`, the
  blend and billboard helpers, the input types of the shared line
  renderer, the dash and terrain subdivision rules, and
  `PointHitTestStrategy`. Pure math that is not tied to them (oriented
  boxes, pixel and degree conversion, contrast colors) is not published;
  an extension keeps its own. Its guarantee is weaker than that of layer
  1: it may change in a minor release. No layer 1 declaration refers to a
  layer 2 type.

Where a new symbol goes is decided as follows.

- A symbol that a host application needs to use the library, or that an
  extension needs to plug into an extension point, is layer 1.
- A symbol that exists so that a custom shader can reproduce what the
  shaders of core do is layer 2. Prefer a general extension point to a new
  building block when one would do.
- A type that a public declaration refers to is exported too (a parameter,
  a return value, a field), in the layer of the declaration that needs it.
- Everything else is internal and is not listed.

To publish a symbol, add it to the barrel of its domain
(`src/<domain>/index.ts`, which lists only public symbols), name it in the
right section of `src/index.ts` or `src/webgl/index.ts`, add it to the list
of that layer in `src/index.test.ts`, and record it in `CHANGELOG.md`. The
test pins the lists, so a change to the surface never happens by accident.

An internal symbol that would still appear in the emitted declarations (an
exported declaration of a module, or a member of a public class or
interface that is not part of the contract) carries the `@internal` JSDoc
tag, and `stripInternal` drops it from `dist/`. `src/index.test.ts` emits
the declarations and checks that they type-check on their own (nothing
public refers to a stripped declaration) and that every named type a public
declaration refers to is exported. Keep the word for the tag out of the
JSDoc of a public declaration, even in prose: the compiler would strip the
declaration.

## Development flow

```bash
npm install        # run at the root (also installs examples)
npx playwright-core install chromium-headless-shell  # once, for the shader test
npm run typecheck  # type check
npm test           # vitest
npm run test:e2e   # end-to-end tests on a real maplibre map (about 10 s)
npm run build      # emit dist/
npm run lint       # biome lint, then check:layers and check:terms
npm run check:layers  # layer rules and import cycles
npm run check:terms   # no word that names a particular extension
npm run docs:api   # generate the API reference (Markdown) into docs/api/
npm run docs:check # the documentation gate (docs/internals/releasing.md)
npm run build:site # build the GitHub Pages site into site-dist/
npm run lint:fix   # biome auto-fix
npm run dev        # serve examples in the browser (localhost:3000)
```

The browser is needed once per machine: `src/view/shaders/compile.test.ts`
compiles every shader program on the WebGL2 of headless Chromium, and
`npm test` fails without it. The same browser runs the end-to-end tests
of `src/e2e/` (`npm run test:e2e`): a real maplibre map in headless
Chromium, driven by the real mouse and keyboard. They take about ten
seconds and are kept out of `npm test`; run them before a change to the
input route, the modes or the hit testing is committed (see the end-to-end
section of `docs/internals/test-design.md`).

`npm run check:layers` checks the dependency rules of
`docs/internals/architecture.md` against the import statements of `src/`. A
runtime import that breaks a rule, or a runtime import cycle, fails it.
Type-only imports that point the wrong way are listed as the known
deviations and do not fail it. When a change needs a lower area to call an
upper one, move the function (or the type) down instead of adding an
exception.

Before each commit, confirm at the very least that typecheck, test, and lint
are green. Development and the published package need Node 22 or later
(`engines` in `package.json`).

Versions, tags, the changelog and the publishing steps are described in
`docs/internals/releasing.md`.

### The live demo on GitHub Pages

The live demo (<https://sakuzu.github.io/maplibre-gl-draw/>) is the
playground opening the showcase of the first README image (`?plain` opens
it without the showcase, and `?showcase=tilted`, `?showcase=terrain` and
`?showcase=globe` open the scenes of the other images), the examples under
`/examples/`, and the generated API reference under `/api/`. The bench is
not part of it. `npm run docs:image` takes the README images again from
these scenes (`playground/showcase/`).

```bash
npm run build:site     # build the site into site-dist/ (not committed)
npm run deploy:pages -- --dry-run  # everything but the push
npm run deploy:pages   # build and push site-dist/ to the gh-pages branch of origin
npm run deploy:pages -- --remote upstream  # push to another remote
```

The site is published from a local clone. GitHub Actions is not used.
`deploy:pages` commits the site on top of the remote's `gh-pages` with a
temporary index (with `.nojekyll`), so the working tree is not touched.
Every page uses relative paths, so `site-dist/` also works when served
from a subdirectory. The repository's Pages source is the `gh-pages`
branch, root directory.

### Repository layout

- `src/` — the library
- `examples/` — small examples, one per guide, served by `npm run dev`
- `playground/` — one page to try every feature
- `bench/` — pages that measure frame times, for contributors
- `docs/` — getting started, the guides, the reference and the internals
  (`docs/README.md` is the index)
- `scripts/` — the checks run by `npm run lint` and `npm run docs:check`,
  and the scripts that build and deploy the GitHub Pages site

The generated API reference (`docs/api/`) is not committed.
Changes a user can notice are recorded in `CHANGELOG.md`.
