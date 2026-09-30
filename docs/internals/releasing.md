# Releasing

This document fixes how `@sakuzu/maplibre-gl-draw` (core) is versioned,
tagged and published, and how its documentation is kept in step with the
code.

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
- At a release, the `## [Unreleased]` heading becomes
  `## [X.Y.Z] - YYYY-MM-DD`, its bullets are grouped under `### Added`,
  `### Changed`, `### Deprecated`, `### Removed`, `### Fixed` and
  `### Security` (in that order, without the prefix), and an empty
  `## [Unreleased]` section is put back on top.
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
   `patch`, following the rules above).

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

7. Publish the live demo and the API reference again, so that the
   reference on the site describes the released version.

   ```sh
   npm run deploy:pages
   ```

When the workflow fails before the publish step, nothing was published:
fix the cause on `main`, move the tag to the fixed commit
(`git tag -d vX.Y.Z`, `git push origin :refs/tags/vX.Y.Z`, then step 5
again). When it fails after the publish step, the version is on npm and
cannot be published again; create the GitHub release by hand
(`gh release create vX.Y.Z --verify-tag --notes-file <notes>`). A
published version is never unpublished; a broken one is followed by a
patch release and marked with `npm deprecate`.

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
