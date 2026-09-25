# Internals

These documents are for people who work on the library itself. They explain
how core is built and why, and they may describe internal types that are
not part of the public API. For what the public API promises, read the
[guides](../guides/drawing.md) and the [reference](../reference/README.md)
instead. The rules for contributing are in
[CONTRIBUTING.md](../../CONTRIBUTING.md).

## Reading order

Start with the architecture. The others each go deeper into one part and
can be read in any order after it.

1. [architecture.md](./architecture.md): the layers of the code and their
   dependency rules, the Store as the single source of truth, input,
   modes, plugins, read-only and locking, and the two tiers of the public
   API
2. [rendering.md](./rendering.md): the WebGL2 pipeline, the renderers,
   retained batches, datasets, terrain, draw order and
   frames
3. [hit-testing.md](./hit-testing.md): the two-stage hit test, the z-order
   walk, the per-type tests and hits on datasets
4. [coordinate-precision.md](./coordinate-precision.md): offset
   coordinates for Float32 precision, globe and the antimeridian
5. [maplibre-coupling.md](./maplibre-coupling.md): every place core relies
   on maplibre-gl internals, and what to check when upgrading it
6. [test-design.md](./test-design.md): what each layer of tests protects,
   the end-to-end tests and the tests of the examples
7. [releasing.md](./releasing.md): versions, the supported maplibre-gl and
   Node versions, tags, the changelog and the release steps
