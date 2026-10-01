---
aside: false
---

# Columnar data in a Worker

The 10,477 buildings of a GeoParquet file read in a Worker and handed to
a dataset as columns: no GeoJSON, no object per row, and no copy on the
way to the page.

```example
columnar-data-in-a-worker
```

The buildings arrive from the Worker shortly after the page opens,
colored by their height. The browser console says how long each step
took: fetching the file, reading its columns, building the table and
preparing it, and the time from the request to the first frame that
draws the rows. The page stays responsive meanwhile. Click a building:
its row is logged, with values read from the columns. As in
[Datasets](datasets.md), the rows are shown, not edited, so the panel on
the right stays closed.

## Code

The dataset starts empty (1). The Worker fetches the file and reads its
columns with [hyparquet](https://github.com/hyparam/hyparquet), a reader
of Parquet in plain JavaScript, and [fzstd](https://github.com/101arrowz/fzstd)
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
(4).

::: code-group
<<< @/../examples/columnar-data-in-a-worker/main.ts
<<< @/../examples/columnar-data-in-a-worker/worker.ts
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
