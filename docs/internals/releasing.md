# Releasing

This document fixes how `@sakuzu/maplibre-gl-draw` (core) is versioned,
tagged and published, how its documentation is kept in step with the
code, and how the standard UI (`ui/`) is released beside it.

## Versions

The package follows [semantic versioning](https://semver.org/). The first
public release was `1.0.0`, and the rules are the following.

- A major release (`2.x` to `3.0.0`) is required for any incompatible
  change of the public API (layer 1 of the public surface, see
  [the reference](../reference/README.md)): a removed or changed signature
  or behavior, a change of the stored data format that old data cannot be
  read under, or a higher lower bound of the maplibre-gl peer or of Node.
- A minor release (`2.0.x` to `2.1.0`) carries compatible additions. It
  may also change a building block for extension authors (layer 2, the
  `/webgl` entry) incompatibly; such a change is marked in
  `CHANGELOG.md`, and an extension declares the minors of core it was
  tested against (`~2.0.0`).
- A patch release (`2.0.0` to `2.0.1`) carries fixes only. Adding a
  checked minor of maplibre-gl to the peer is a patch.

## Supported versions of maplibre-gl and Node

maplibre-gl is a peer dependency declared as `~6.11.1`. Every reliance on
maplibre internals is recorded in
[maplibre-coupling.md](./maplibre-coupling.md) and was checked against
6.11.1, which is also the exact version in `devDependencies` that the tests
and the examples run on.

- The peer declares only the minors whose coupling points were checked,
  each with `~`, so it accepts the patch releases of those minors and
  nothing newer. A minor that has not been checked is never declared.
- When a new minor of maplibre-gl comes out, raise the `devDependencies`
  entry to it, check every item of
  [maplibre-coupling.md](./maplibre-coupling.md) against the new source,
  run the gates and the examples, then widen the peer with that minor
  (`~6.11.1 || ~6.12.0`) and release a patch.
- A new major of maplibre-gl is added to the peer (`~6.11.1 || ~7.0.0`)
  the same way, only after the same check.

`engines.node` is `>=22`, the oldest Node LTS line that is still
maintained. The published files are ES modules resolved through
`exports` (built with `module: NodeNext`), which that line loads as is;
the geometry subpath is the part meant to run under Node. The lower bound
is raised, in a minor release, when that line reaches its end of life.

## Tags and the changelog

Each release is tagged `vX.Y.Z` (for example `v1.0.0`) on the commit the
package was built from. The tag is annotated and carries the version as
its message. Pushing the tag starts the release workflow
(`.github/workflows/release.yml`), which publishes the package; only the
maintainers can create tags matching `v*`.

`CHANGELOG.md` follows
[Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/) and is
shipped in the package (it is listed in `files`).

- During development, every change that a user can notice adds one bullet
  to the `## [Unreleased]` section, starting with the kind of change:
  `Added:`, `Changed:`, `Deprecated:`, `Removed:`, `Fixed:` or
  `Security:`.
- The section opens with one sentence that names the version its
  changes will be released as ("These changes will be released as
  2.1.0"), chosen by the rules of [Versions](#versions) from the
  bullets: an incompatible change makes a major release, an addition at
  least a minor one, and fixes alone a patch. The bullet that raises the
  kind of release updates the sentence in the same commit, so the
  version set at step 2 of the release is already decided.
- At a release, the `## [Unreleased]` heading becomes
  `## [X.Y.Z] - YYYY-MM-DD`, the sentence gives way to a short paragraph
  on what the release brings, its bullets are grouped under
  `### Added`, `### Changed`, `### Deprecated`, `### Removed`,
  `### Fixed` and `### Security` (in that order, without the prefix),
  and an empty `## [Unreleased]` section is put back on top.
- Link references at the end of the file point each version at its
  comparison:
  `[Unreleased]: https://github.com/sakuzu/maplibre-gl-draw/compare/vX.Y.Z...HEAD`
  and
  `[X.Y.Z]: https://github.com/sakuzu/maplibre-gl-draw/compare/vW.V.U...vX.Y.Z`
  (the first release links to `releases/tag/v1.0.0`).
- The release workflow takes the body of the GitHub release from the
  version's section (`scripts/release-notes.mjs`), so the section must
  exist and must not be empty.

When `package.json` already carries the version being released, as it
does for `2.0.0`, the `npm version` step below is skipped.

npm cannot create a package by trusted publishing, so the first release,
`1.0.0`, was published by hand, with `npm publish` from a clean checkout
of the release commit and the maintainer's 2FA, before its tag was
pushed. The release workflow skips the publish step for a version that
is already on npm and creates the GitHub release. After the first
release, the trusted publisher is registered and tokens are disallowed:

```sh
npm trust github @sakuzu/maplibre-gl-draw --file release.yml \
  --repo sakuzu/maplibre-gl-draw --env npm --allow-publish --yes
npm access set mfa=publish @sakuzu/maplibre-gl-draw
```

`1.0.0` carries no provenance statement; every later version does.

## Steps

Run the steps on an up-to-date `main` with a clean working tree. After
the first release, the package is never published from a local machine:
the release workflow publishes it from GitHub Actions by trusted
publishing, so that npm attaches a provenance statement tying the
published files to the tagged commit.

1. Install from the lock file and run every gate, the documentation
   gate included (see [The documentation gate](#the-documentation-gate)).
   Resolve its warnings too: a warning left at a release is a document
   that no longer matches the code. The release workflow runs the same
   gates again and stops before publishing when one fails.

   ```sh
   npm ci
   npm run lint
   npm run typecheck
   npm test
   npm run docs:check -- --base vW.V.U   # the previous release
   ```

2. Set the new version without committing yet (`major`, `minor` or
   `patch`, as the first sentence of the `## [Unreleased]` section
   names it).

   ```sh
   npm version minor --no-git-tag-version
   ```

3. Turn the `## [Unreleased]` section of `CHANGELOG.md` into the new
   version as described above, and add its link reference. Check the
   body of the release:

   ```sh
   node scripts/release-notes.mjs vX.Y.Z
   ```

4. Build and check the package that would be published. `check:package`
   packs with `--ignore-scripts`, so it reads the `dist/` that the build
   leaves.

   ```sh
   npm run build
   npm run check:package
   ```

5. Commit the version and the changelog together, tag the commit, and
   push both. The tag starts the release workflow.

   ```sh
   git commit -am "Release vX.Y.Z"
   git tag -a vX.Y.Z -m vX.Y.Z
   git push origin main vX.Y.Z
   ```

6. Watch the workflow. It runs the gates, publishes to npm (`prepack`
   builds `dist/` from the tagged commit) and creates the GitHub release.
   Then check the published version.

   ```sh
   gh run watch
   npm view @sakuzu/maplibre-gl-draw version
   ```

7. Publish the site again, so that the guides, the examples and the API
   reference on it describe the released version.

   ```sh
   npm run deploy:pages
   ```

   The site is the VitePress build of `docs/` (`npm run site:build`,
   which `npm run build:site` runs into `site-dist/` after building core
   and the standard UI): the guides, the gallery of the examples and
   their pages, the built examples under `/examples/<name>/`, the
   playground under `/playground/` and the API reference under `/api/`.
   The build also writes the redirects of the URLs the site published
   before (`scripts/site-redirects.mjs`): every HTML page of the old API
   reference of 1.0 and 2.0 (`scripts/site-redirects-api.json`) goes to
   the page of the same symbol under its current module and name, or
   else to the page of the module, and every replaced example
   (`scripts/site-redirects-examples.json`) to the page of the example
   that took its place. Check the build with `npm run site:preview`
   before the push.

When the workflow fails before the publish step, nothing was published:
fix the cause on `main`, move the tag to the fixed commit
(`git tag -d vX.Y.Z`, `git push origin :refs/tags/vX.Y.Z`, then step 5
again). When it fails after the publish step, the version is on npm and
cannot be published again; create the GitHub release by hand
(`gh release create vX.Y.Z --verify-tag --notes-file <notes>`). A
published version is never unpublished; a broken one is followed by a
patch release and marked with `npm deprecate`.

## Releasing the UI

The standard UI, `@sakuzu/maplibre-gl-draw-ui` in `ui/`, is a package of
its own. It follows the same rules of semantic versioning as core, with
its own version in `ui/package.json`; its public API is what
`ui/src/index.ts` exports, its options and `style.css` with the tokens it
reads. Core is a peer dependency (`^2.0.0`): a release of core that the
UI keeps working with needs no release of the UI, and a major release of
core is followed by a release of the UI that moves its peer.

Each release is tagged `ui-vX.Y.Z` (for example `ui-v1.0.0`). Pushing the
tag starts `.github/workflows/release-ui.yml`, which runs the gates
(`ci.yml`), publishes the package from the root with
`npm publish --workspace ui --provenance` (the `prepack` of `ui/` builds
`ui/dist` after core's build) and creates the GitHub release from the
version's section of `ui/CHANGELOG.md`, without marking it as the latest
release of the repository. A tag filter matches the whole name of the
tag, so `ui-v` tags never start the release workflow of core.

The tags and the environment are guarded for both packages: the tag
ruleset of the repository lists `refs/tags/ui-v*` beside
`refs/tags/v*`, and the `npm` environment accepts the tags `ui-v*.*.*`
beside `v*.*.*`.

`ui/CHANGELOG.md` follows the same rules as the changelog of core: the
`## [Unreleased]` section during development, opened by the sentence
that names the next version of the UI, and
`## [X.Y.Z] - YYYY-MM-DD` with a short paragraph on top at a release.
Check the body of the release with:

```sh
node scripts/release-notes.mjs ui-vX.Y.Z --changelog ui/CHANGELOG.md --prefix ui-v
```

The script also fails when the tag does not match the version in
`ui/package.json`.

### The steps of a UI release

Run the steps on an up-to-date `main` with a clean working tree.

1. Install from the lock file, build core, and run every gate of the UI
   and of the repository.

   ```sh
   npm ci
   npm run build
   npm run lint
   npm run ui:check            # typecheck, test, end-to-end, build
   npm run ui:check:package    # publint and attw on the packed package
   ```

2. Set the new version of the UI without committing yet.

   ```sh
   npm version minor --workspace ui --no-git-tag-version
   ```

3. Turn the `## [Unreleased]` section of `ui/CHANGELOG.md` into the new
   version, put an empty `## [Unreleased]` back on top, and check the
   body of the release with `scripts/release-notes.mjs` as above.

4. Commit, tag and push. The tag starts the release workflow.

   ```sh
   git commit -am "Release ui-vX.Y.Z"
   git tag -a ui-vX.Y.Z -m ui-vX.Y.Z
   git push origin main ui-vX.Y.Z
   ```

5. Watch the workflow and check the published version.

   ```sh
   gh run watch
   npm view @sakuzu/maplibre-gl-draw-ui version
   ```

A failure is handled as for core: before the publish step, fix the cause
and move the tag; after it, create the GitHub release by hand.

### The first release of the UI

npm cannot create a package by trusted publishing, so the first release
(`1.0.0`) is published by hand from a clean checkout of the release
commit, with the maintainer's 2FA, before its tag is pushed. Then the
trusted publisher is registered for `release-ui.yml` and the environment
`npm`, and tokens are disallowed. The workflow started by the tag skips
the publish step, because the version is already on npm, and creates the
GitHub release.

```sh
npm ci
npm run build
npm run ui:check
npm run ui:check:package
npm publish --workspace ui --access public
npm trust github @sakuzu/maplibre-gl-draw-ui --file release-ui.yml \
  --repo sakuzu/maplibre-gl-draw --env npm --allow-publish --yes
npm access set mfa=publish @sakuzu/maplibre-gl-draw-ui
git tag -a ui-v1.0.0 -m ui-v1.0.0
git push origin ui-v1.0.0
```

`1.0.0` of the UI carries no provenance statement; every later version
does.

## Documentation

Development goes on after a release, so the documentation is kept in step
with the code by where each kind of text lives, by a rule for changes to
the public surface, and by a gate.

### Where each kind of text lives

- The description of each exported symbol is its TSDoc, changed in the
  same commit as the declaration. The API reference is generated from it
  (`npm run docs:api`)
- How to use the library is in getting started and the guides
  (`docs/getting-started.md`, `docs/guides/`)
- The stored data format and the events are in the reference
  (`docs/reference/`)
- How the library is built and why is in the internals
  (`docs/internals/`)
- The history of the work, dates, measurement records and plans are not
  written in any document. `CHANGELOG.md` and the git history keep what
  changed

### Changing the public surface

A change that a user can notice changes, in the same commit, the TSDoc of
the declarations it touches, the guides that cover them, `CHANGELOG.md`
(the `## [Unreleased]` section) and the Japanese version of every document
it changes.

`docs/doc-map.json` lists which document covers which sources, with the
English document as the key. When a file moves or a guide takes on a new
topic, change the map in the same commit. Every guide, getting started
and every page of the reference are in it.

### The documentation gate

`npm run docs:check` runs these steps in order and fails when any step
reports an error. Run it at milestones and before a release. The CI
workflow runs it on every pull request, with the end-to-end tests in a
job of their own.

1. typedoc builds the API reference with no warning
2. The `ts` and `js` code blocks of the READMEs, getting started and the
   guides are type-checked against the built package (`dist/`, built
   first when it is older than `src/`)
3. Relative links and heading anchors resolve. External URLs are not
   fetched
4. markdownlint passes with the repository's configuration
5. The documents name no product that uses the library, and carry no
   history of the work, dates or work notes. `check:terms` (part of
   `npm run lint`) is the separate check that nothing describes a
   particular extension
6. A Japanese version with a different number of headings from its
   English version is reported as behind (a warning)
7. A source that changed since the base ref, while the document that
   covers it did not, is reported (a warning), and so is an English
   document that changed without its Japanese version. A map entry that
   names a missing file is an error
8. The end-to-end tests open every example (`npm run test:e2e`)

The options are `--base <ref>` (the ref step 7 compares with, `main` by
default), `--skip-e2e`, `--only <step,...>` and `--skip <step,...>`,
with the step names `typedoc`, `snippets`, `links`, `markdownlint`,
`terms`, `translations`, `doc-map` and `e2e`. The configuration of the
steps (the files of each step, the terms, the declarations every code
block sees) is `scripts/docs-check.config.mjs`.

A code block is a fragment, so it sees a few declarations that the guides
take as given: `map`, `draw`, `feature`, `featureId`, `layerId` and
`groupId`. It also sees the imports of the earlier blocks of the same
file. Anything else it needs is declared in an HTML comment on the line
before the block, which the rendered page does not show.

```md
<!-- docs-check:
declare const parcels: string;
-->
```

`<!-- docs-check: continue -->` makes the declarations of the previous
block of the file visible, `<!-- docs-check: with <name> -->` adds a
named set of declarations from the configuration, and
`<!-- docs-check: skip -->` leaves the block out. Prefer a declaration
to a skip, so that the rest of the block is still checked.
