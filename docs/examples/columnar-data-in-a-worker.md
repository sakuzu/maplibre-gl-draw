---
aside: false
---

# Columnar data in a Worker

10,477 building footprints read from a GeoParquet file in a Worker and
drawn from its columns, and a million points on the same path: no
GeoJSON, no object per row, and no copy on the way to the page. This is
the path for the readers of Arrow and GeoParquet, which hand over
columns. On a laptop the Worker reads the columns of the file in about
45 ms, builds the table in 5 ms and prepares it in 12 ms, and makes the
million points in about 120 ms and prepares them in about 500 ms, none
of it on the thread of the page.

```example
columnar-data-in-a-worker
```

The footprints arrive from the Worker shortly after the page opens, on
the Dark basemap, colored by their area from magenta for the small to
yellow for the large, in classes cut at 50, 100, 200 and 500 m² (half
the buildings are under 70 m²). The browser console says how many rows
came and how long each step took: fetching the file (700 KB), reading
its columns, building the table and preparing it, and the time from the
request to the first frame that draws the rows. The page stays
responsive meanwhile. Click a building:
its row is logged, with values read from the columns. As in
[Datasets](datasets.md), the rows are shown, not edited, so the panel on
the right stays closed.

Press `M`: the Worker makes 1,000,000 points over the wider Tokyo area,
each a trip that starts there, straight into the typed arrays of a table
in the layout of GeoArrow, prepares the table and moves its arrays to
the page. A second dataset draws them, colored by how the trip is made:
on foot, by bicycle, by car or by train. The console says how long the
Worker took to build the table and to prepare it, how long the transfer
took (under a millisecond, as nothing is copied), how long from handing
the table to the dataset to the first frame that draws it, and how large
the arrays are (88 MB). Where the browser tells the size of the heap of
JavaScript, the console gives it before and after: it does not grow, as
the rows add no object to it. Zoom out to see them all; the pieces of
the dataset are sent to the GPU a few at a time, so they fill in like
tiles arriving. Click a point: its row is logged. Press `M` again to
remove them.

## Keys

| Key | What it does |
| --- | --- |
| `M` | Loads the 1,000,000 points from the Worker, and removes them |

## Code

The dataset starts empty (1). The Worker fetches the file and reads its
columns with [hyparquet](https://github.com/hyparam/hyparquet), a reader
of Parquet in plain JavaScript, with its companion
[hyparquet-compressors](https://github.com/hyparam/hyparquet-compressors)
for the ZSTD compression. The geometry stays WKB, and the Worker decodes
it straight into the typed arrays of a table in the layout of GeoArrow:
the coordinates in one `Float64Array`, and the offsets of the rows, the
polygons and the rings in `Int32Array`s. A text column becomes a
dictionary, as in Arrow, and a column of numbers a `Float64Array`, with
NaN where the file has no value. `prepareTable` from
`@sakuzu/maplibre-gl-draw/table`, which imports neither maplibre nor
WebGL, computes the extents of the rows, the pieces and the index of the
clicks there, and `transferList` moves every array to the page without a
copy (2). `setTable` takes the prepared table as it arrives (3). A click
gives the row, with the properties the dataset reads from the columns
(4). For the million, the Worker writes the points into a table of
points (data.ts): their coordinates in one `Float64Array`, the kind as a
dictionary of `Uint8Array` codes and the minutes in a `Uint8Array`, and
prepares and sends it the same way. `draw.datasets.add` takes the
prepared table as `table`, with a categorical rule on `kind`, and
`draw.datasets.remove` removes it (5).

::: code-group
<<< @/../examples/columnar-data-in-a-worker/main.ts
<<< @/../examples/columnar-data-in-a-worker/worker.ts
<<< @/../examples/columnar-data-in-a-worker/data.ts
<<< @/../examples/columnar-data-in-a-worker/index.html
:::

## Related

- [Reading the table in a Worker](../guides/large-data.md#reading-the-table-in-a-worker)
  and [a table](../guides/large-data.md#a-table) in the guide to large
  data
- [`prepareTable`](../api/table/functions/prepareTable.md),
  [`Table`](../api/table/interfaces/Table.md) and
  [`Dataset.setTable`](../api/maplibre-gl-draw/interfaces/Dataset.md#settable)

Data: [Overture Maps Foundation](https://overturemaps.org), ODbL / CDLA
([the sample data](../../examples/public/data/README.md))
