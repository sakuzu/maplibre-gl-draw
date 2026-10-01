---
aside: false
---

# Columnar data in a Worker

A table of 200,000 rows read in a Worker and handed to a dataset as its
columns, without a copy and without an object per row.

```example
columnar-data-in-a-worker
```

The points arrive from the Worker shortly after the page opens; the
browser console says how long the Worker took, how long until they
arrived and how long the dataset took to take them. The page stays
responsive meanwhile. Click a point: its row is logged, with values read
from the columns. As in [Datasets](datasets.md), the rows are shown, not
edited, so the panel on the right stays closed.

## Code

The dataset starts empty (1). The Worker builds the table as typed
arrays in the layout of GeoArrow, as a reader of GeoParquet or Arrow
hands it over, and prepares it with `prepareTable` from
`@sakuzu/maplibre-gl-draw/table`, which imports neither maplibre nor
WebGL. `transferList` moves its arrays to the page without a copy (2).
`setTable` takes the prepared table as it arrives (3). A click gives the
index of the row, and the page reads its values from the columns it
holds (4).

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
