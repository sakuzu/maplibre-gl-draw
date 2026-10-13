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

## table.html

The same features drawn two ways: held as rows of columns (`mode=table`)
or as features of the Store (`mode=store`), on a map with a background
layer only (no network), in a fixed 1280 x 800 map. The features are made
in the page; in `mode=table` a Worker builds them into row groups and
hands them to the page without a copy.

Open it from the root of the repository:

```sh
npm install
npm run dev:bench
```

Then open <http://localhost:3002/table.html>, for example
<http://localhost:3002/table.html?mode=table&n=10000&kind=mixed>. The
address sets the conditions (the form on the right side of the page
writes them too):

| Parameter | Meaning | Default |
| --- | --- | --- |
| `mode` | `table` (rows) or `store` (features) | `table` |
| `n` | Number of features | `10000` |
| `kind` | `point`, `line`, `polygon5`, `polygon50` or `mixed` | `mixed` |
| `styles` | Number of distinct styles | `1` |
| `alpha` | `1` translucent, `0` opaque | `1` |
| `cuts` | Artificial cuts: `0`, `100`, `1000`, `3000` | `0` |
| `limit` | Heap limit in MB: `1024`, `500`, `400` | `1024` |

A `line` has 10 vertices, `polygon5` and `polygon50` have 5 and 50, and
`mixed` takes the four kinds in turn. The cuts split the ranges drawn of
`mode=table` only. The heap limits are those of a PC (`1024`), an iPad
(`500`) and an iPhone (`400`).

More than 100,000 features need the confirmation button before Start.
Start opens the map, shows the whole of it, stops at zoom 14, then pans
and zooms. The page shows the time of each step of the opening, the
median, 95th percentile and longest frame interval of each phase, the JS
heap, the memory measured by the browser and the GPU memory of the
drawing. The opening is a phase as well: its longest frame interval is
the longest time the page stops while the map opens (in `mode=table` the
row groups are taken in over the frames, after `adoptQueue`). The run
stops when the JS heap goes past `limit`, and reports what it measured
until then.

Only this page is served cross-origin isolated (COOP and COEP headers, by
the dev and preview servers of `bench/vite.config.ts`), so
`performance.measureUserAgentSpecificMemory()` works; the page shows
`isolated=true` when it is. The heap of `performance.memory` is shown in
Chromium-based browsers only.

Once the map is open, Edit repeats an edit and Stream sends changes of
others, each measured before, during and after it (the frames, the JS
heap and its peak, the GPU memory, and what the rows written, the deltas
and the next versions of the row groups did):

| Parameter | Meaning | Default |
| --- | --- | --- |
| `op` | The edit (below) | `color1` |
| `reps` | Times an edit is repeated | `100` |
| `remote` | The changes of others (below) | `color` |
| `rate` | Rows changed per second | `10` |
| `seconds` | How long a stream runs | `10` |
| `importN` | Rows an import sends | `100000` |
| `txn` | Rows of one write of an import | `1000` |
| `groups` | Groups of features of `group` | `20` |
| `members` | Members of each of them | `50` |
| `moving` | Version builds while moving, ms | `0` |
| `worker` | `1`: merges in a Worker | `1` |

The edits are `color1`, `colorSlide`, `ruleSlide`, `attr`, `point`,
`longLine`, `corner` and `finish` (a building written in the middle of the
order), one change per frame. The changes of others are written in place
(`color`, `attr`, `position`, `corner`) or placed elsewhere: `reorder`
puts rows in another place of the order, `group` puts groups of features
in another place, `vertex` adds a vertex past the place of a building, and
`import` writes `importN` new buildings after every row of the layer,
`txn` at a time, until all are sent (`seconds` does not stop it). With
`moving=0` the chunks of the next versions of the row groups are built
once the camera is still; a time in ms lets them build while it moves.
With `worker=0` the large merges and builds run on the main thread.

For automation, the page exposes `window.runTableBench()`, which runs one
measurement and returns the results, `window.runTableEdit(op)` and
`window.runTableStream(kind, rate)`, and `window.benchResult`, the results
so far.

## Test data

`npm run generate -w bench` writes native files of 1,000 and 10,000
random features around Tokyo into `bench/test-data/` (not committed).
Load them in the playground to try the editor on a large Store.
