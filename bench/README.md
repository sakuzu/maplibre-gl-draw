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

The features are loaded into the Store with `draw.load()`, on a map with
a background layer only (no network), in a fixed 1280 x 800 map. The
address sets the conditions:

| Parameter | Meaning | Default |
| --- | --- | --- |
| `n` | Number of features | `50000` |
| `order` | `grouped` (by type) or `interleaved` | `grouped` |
| `retained` | `1` for the retained batches, `0` for immediate drawing | `1` |
| `autoName` | `1` turns the automatic names on | `0` |

For automation, the page exposes `window.benchReady`, a Promise of the
load, and `window.runBench()`, which runs one measurement and returns the
statistics. Compare the same parameters on two branches.

## Test data

`npm run generate -w bench` writes native files of 1,000 and 10,000
random features around Tokyo into `bench/test-data/` (not committed).
Load them in the playground to try the editor on a large Store.
