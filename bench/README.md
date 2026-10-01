# Bench

Measurement pages for contributors: they show whether a change to the
rendering keeps its frame rate. They are not examples of the API; see
[examples/](../examples/) for those.

Start them from the root of the repository.

```sh
npm install
npm run dev:bench   # opens perf.html at http://localhost:3002
```

## perf.html

A dataset of 50,000 polygons (about 5,000 in view) over
the OpenFreeMap basemap. It shows the live frame rate, and a button runs
a 10 second pan and zoom path and reports the average, p50, p90 and worst
frame times. The target is an average of 55 fps or more with a p90 of
20 ms or less.

## bench.html

The features are loaded into the Store with `draw.document.load()`, on a map
with a background layer only (no network), in a fixed 1280 x 800 map.
The address sets the conditions:

| Parameter | Meaning | Default |
| --- | --- | --- |
| `n` | Number of features | `50000` |
| `order` | `grouped` (by type) or `interleaved` | `grouped` |
| `retained` | `1` caches the geometry, `0` draws at once | `1` |
| `autoName` | `1` turns the automatic names on | `0` |

For automation, the page exposes `window.benchReady`, a Promise of the
load, and `window.runBench()`, which runs one measurement and returns the
statistics. Compare the same parameters on two branches.

## drape.html

Lines painted on the terrain by the analytic drape. Rows of zigzag lines
cover the view of a camera pitched 60 degrees at zoom 15 over a flat
terrain made in the page (no network), in a fixed 1280 x 800 map. The same
frame is drawn again and again, each one waiting for the GPU, so the time
of a frame is the time the drape takes to paint it.

| Parameter | Meaning | Default |
| --- | --- | --- |
| `edges` | Number of edges of the lines | `20000` |
| `style` | `solid`, `dashed` or `dotted` | `solid` |
| `width` | Line width in CSS pixels | `3` |
| `frames` | Number of frames measured | `60` |

For automation, the page exposes `window.drapeReady`, a Promise that
settles once the lines are on the drape, and `window.runDrapeBench()`,
which returns the statistics of the frame times and the diagnostics of
the drape. Compare `style=dashed` with `style=solid` at the same number of
edges, with a few edges (`edges=100`) as the cost of the frame without
lines.

## Test data

`npm run generate -w bench` writes native files of 1,000 and 10,000
random features around Tokyo into `bench/test-data/` (not committed).
Load them in the playground to try the editor on a large Store.
