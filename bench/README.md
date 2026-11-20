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

## edit.html

The scenes of an edit on a document of `n` features, run one at a time,
on a map with a background layer only (no network), in a fixed 1280 x 800
map. The features are made in the page (`edit-document.ts`), the same on
every visit: one per cell of a square grid, half of them polygons (one in
five a regular 24-gon), three in ten lines and the rest points, in one
layer.

| Parameter | Meaning | Default |
| --- | --- | --- |
| `n` | Number of features (1 to 250,000) | `1000` |

The page links to 1,000, 10,000 and 100,000 features; start with the
fewest. Nothing runs until a scene is asked for. A button, or
`window.runEditBench(name)`, runs one scene once. The scene first puts
the page in the state it starts from (the document opened, the selection
made, the camera over the whole grid), which is not measured. Then it
makes the edit while every frame is drawn (`triggerRepaint` in every
animation frame), until the drawing has nothing left to do. A scene stops
after 20 seconds, preparation included, and nothing runs after it: an
edit written in parts is stopped at its next part (the page makes the
instance read-only, and writable again after the scene).

| Scene | What it does |
| --- | --- |
| `open` | `draw.document.load` of a document of the library |
| `pan` | Pans the map 6 px a frame, 90 frames right and 90 back |
| `selectAll` | Selects every feature with `draw.selection.set` |
| `boxSelect` | Draws a box over the view with Shift, a move a frame |
| `drag` | Drags every feature selected, a move a frame |
| `translateAll` | Moves every feature selected 100 m east (`translate`) |
| `rotateAll` | Turns every feature selected 90 degrees (`rotate`) |
| `scaleAll` | Scales every feature selected by 2 (`scale`) |
| `translateLayer` | Moves every feature of the layer 100 m east, nothing selected |
| `delete` | Deletes every feature selected with `draw.selection.delete` |
| `import` | `draw.document.load` of a GeoJSON `File` into the layer |
| `export` | `draw.document.toJSON` and `JSON.stringify` of the document |

`open` and `import` start from a document with the layer and no
features. The box and the drag are made with the events of the mouse sent
to the canvas, as the select mode takes them from a hand; the drag starts
in the middle of the map. Each scene gives:

- the longest task: the longest time the main thread could do nothing
  else, the longest of the long tasks the browser reports (50 ms or more),
  the calls the scene timed and the drawings of the frames
- the frames: the median and the worst of their intervals, and of the time
  the map took to draw each one, read until the GPU had finished it (a
  pixel is read back after each drawing), which shows differences below
  the refresh of the display
- the calls timed (how many, the longest), and for an edit done in parts,
  the number of parts and the longest one
- what the scene noted (the features selected, loaded or left, the bytes
  written)

The result of the last run of each scene is shown on the page and kept in
`window.editResults`, by the name of the scene. `window.editReady` settles
once the map is loaded. A scene is a name and two functions in
`edit-scenes.ts` (`prepare`, not measured, and `run`); a new scene is a
new entry of its list. The parts of the page that run without a map (the
documents and the list of the scenes) are tested with
`npx vitest run --root bench`.

## Test data

`npm run generate -w bench` writes native files of 1,000 and 10,000
random features around Tokyo into `bench/test-data/` (not committed).
Load them in the playground to try the editor on a large Store.
