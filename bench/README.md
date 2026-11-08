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
in the page; in `mode=table` several Workers build them into row groups,
each Worker a run of the order of the rows, and hand them to the page
without a copy, a batch at a time, and the rows are held by an in-memory
Store of rows (`createTableStore`). The page takes the groups in a
run after the other, in the order of their keys, as they come.

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
| `workers` | Workers of the opening (`0`: cores but one, 8 at most) | `0` |
| `terrain` | `1` turns the terrain on | `0` |

A `line` has 10 vertices, `polygon5` and `polygon50` have 5 and 50, and
`mixed` takes the four kinds in turn. The cuts split the ranges drawn of
`mode=table` only. The heap limits are those of a PC (`1024`), an iPad
(`500`) and an iPhone (`400`).

A file of one feature per line (`data=<file>.ndjson`, in the order of
the file) is fetched by the page and sent to the Workers as it comes,
about as many bytes to each, cut at the ends of lines. Each Worker counts
the lines of its part from their bytes as they come; once the parts
before it are counted, it reads and builds its lines a part of the bytes
at a time, with the ids and keys of their places in the file, and sends
the row groups in batches of 16,384 rows. A Worker holds the bytes it has
not read yet and one batch of features, not the features of its whole
part. Rows put in an order at random (`shuffle=1`) or a FeatureCollection
are read and built whole in one Worker. The steps of the opening are
`fetch` (the file fetched and sent), `counted` (the lines of every part
counted), `generate`, `addRows` and `buildGroups` (the longest a Worker
took reading its lines, adding them and building the groups; made
features are made as they are added), `firstGroups` (the first groups
taken in), `workerTotal` (every group built), `adoptQueue` (the page
taking the groups in) and `firstDraw` (the rest of the drawing after the
last group).

The opening does not wait silently: while it runs, the status line tells
how many bytes were sent and what each Worker did, and it stops with the
reason when a Worker fails or cannot run, when nothing comes from the
Workers and the file for 30 seconds, or when the drawing still has work
60 seconds after the last group. The opening runs without a browser in
its tests (`npx vitest run --config bench/vitest.config.ts`).

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

With `terrain=1` the map has the terrain on: the elevation tiles of the
examples and the playground ([Mapterhorn](https://mapterhorn.com/), from
its TileJSON) are a `raster-dem` source of the map under
`map.setTerrain`, with the exaggeration of the terrain example (1.5). The
run waits until the elevation tiles of the view are loaded before it
opens the map (it stops with the reason after 60 seconds), and adds a
phase after the pan and zoom: the camera pitched 45 degrees at zoom 14,
still for 3 seconds, then panned and back. The edits run at zoom 14 with
the camera not pitched, on the terrain. Compare `mode=table` with
`mode=store` at the same parameters, both with `terrain=1`, for example
<http://localhost:3002/table.html?mode=table&terrain=1&n=100000&kind=mixed>
and the same with `mode=store`.

After the opening, each phase and each edit, the page records the ranges
of rows drawn in 2 frames and shows how they were drawn: in one draw per
chunk with rows of every kind (`rows`), as on a flat map, or by kind
(`polygon`, `line`, `point` and `immediate`, `(delta)` for the rows of a
delta), as on the terrain and the globe. Beside them it shows whether the
terrain was on in the last drawing and whether the areas were laid on the
analytic drape (`draw.debug.terrain()`), and the errors of the map, so
that elevation tiles that cannot be read are seen. In `mode=store` no
rows are drawn: the features are drawn by the renderers of the Store.

Only this page is served cross-origin isolated (COOP and COEP headers, by
the dev and preview servers of `bench/vite.config.ts`), so
`performance.measureUserAgentSpecificMemory()` works; the page shows
`isolated=true` when it is. The elevation tiles are read from another
origin in the isolated page: they are fetched in CORS mode and their
server allows every origin (`Access-Control-Allow-Origin: *`), which the
embedder policy `require-corp` accepts. The heap of `performance.memory`
is shown in Chromium-based browsers only.

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
| `bigArea` | Vertices of a large area under the rows | `0` |
| `held` | Rows the edits of many rows select | `2000` |
| `moveFrom` | Rows held from which a move is drawn by state | library's |

The edits are `color1`, `colorSlide`, `ruleSlide`, `attr`, `point`,
`longLine`, `corner` and `finish` (a building written in the middle of the
order), one change per frame. The edits of a feature at a time are made
as the select mode makes them: `hover` moves the pointer over the map
(the events of the mouse sent to the canvas, a move per frame, the time
of each move measured), `click` clicks a building (the time from the
click to the frame its handles are drawn in), `vertexAdd` drags a
midpoint of a building selected (the vertex put, moved over 6 frames as
the middle of the drag, then ended), `vertexRemove` puts a vertex and
takes it off, and `delete` selects a feature and deletes it. `bigArea`
puts a large area of that many vertices under every row once the map is
open (an administrative area under the buildings), for `hover`.

The edits of many rows select `held` rows (the time to select them is an
input) or work on `members` rows: `moveSelected` drags the rows selected as
the select mode drags them (every row written in every frame of a drag of
10 frames, then the end; the bytes uploaded show what a move costs, and
`moveFrom` sets the number of rows held from which the rows moved are
drawn by their state instead of written), `panSelected` pans the map with the
rows selected, `group` groups and ungroups the rows, `toLayer` puts them
in another layer and back, `order1` and `orderMany` bring one row or the
rows to the front and send them to the back (each timed to the frame
nothing is left to build, with the longest key of the order of the rows
moved), and `undoRedo` undoes and redoes an edit of the rows (moved and
colored) with a history of the page: the Store has no history of its own,
so the values before and after are written back through the Store
(`applyRows` for rows, `updateMany` for features), and the bytes that
history holds are shown. `boxHeld` draws a box with Shift from the
center of the map, grown to its corner and shrunk, a move of the pointer
per rep, each move timed (the rows in the box are marked while it is
drawn; zoom so that it meets about `held` rows), and lets it go at the
last rep.

The edits of every feature selected are the same in both modes, so that
`mode=table` (the features selected in bulk past 2,000) is compared with
`mode=store` (every feature selected one by one): each selects every
feature shown with `draw.selection.setAll` (an input) and fits the map to
them. `selectAll` selects them and clears the selection, each time timed
to the frame nothing is left to build. `bulkMove` drags them from a
building selected, `bulkRotate` from the rotation handle of their frame (a
quarter turn around its center) and `bulkResize` from its north east
corner, as the select mode drags them (the events of the mouse sent to the
canvas): a drag of 10 frames, each move of the pointer an input, then the
release, whose time to the frame nothing is left to build is noted
(`released`). `bulkColor` writes a color to all of them with
`draw.selection.update`, each an input to the frame nothing is left to
build. For the rows of the stage of many features selected (all of them
selected and moved, rotated, resized, colored), run them at `n=100000`
in both modes, with `reps=100`: the frames of the run, its longest task
and the JS heap and GPU memory before and after are the measures. A drag
notes whether it wrote the features (`written yes`, `turned yes` for the
rotation), so that a press beside the handle is seen.

The work of one of these edits without a browser (the rows of the page
held by the in-memory Store of rows, the drags written at once and in
steps, and the colors) is printed by
`BULK_WORK=100000 npx vitest run --config bench/vitest.config.ts
table-bulk-work --pool=forks --execArgv=--expose-gc`: the time of each, the
longest step of a write in steps, and the memory before, at its end and
after a collection. `BULK_WORK_PROFILE=<directory>` writes the CPU profile
of each there.

The changes of others are written in place
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
