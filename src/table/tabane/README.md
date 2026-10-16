# Tabane

Tabane is a format of rows: rows written as blocks of columns, each block named
by the SHA-256 of its content, and a manifest that lists the blocks of a set of
rows. A block read gives groups of rows whose columns are those of the blocks of
rows of the tables (`RowBlock`), so a reader copies them into the tables without
making an object per row.

Status: version 1, a draft. This folder holds the format for now; it is to move
to Kasane, the library of the tables, with its document and its test vectors. An
implementation in Go follows the same document and passes the same vectors.

## 1. Overview

- A row is an id, a type, a geometry (one of the six GeoJSON types, or none), a
  style (an object), attributes (an object of values), and optionally a deleted
  flag, what made it and the revisions of its cells
- A group is about a thousand rows of one run, written as columns
- A block is a run of rows under one parent, cut into groups. Its content is a
  head and its groups; its file is its content cut into frames, each compressed
  on its own
- A manifest lists the blocks of a set of rows: their names, their sizes, the
  box of their coordinates, the runs of their ids and the keys of their first
  and last rows
- The name of a block or a manifest is the SHA-256 of its content in lowercase
  hex. It does not depend on how the content was cut into frames or compressed,
  so two writers of the same rows give the same name, and a store may compress a
  file again without renaming it

Nothing is rounded: a block reads back to the same coordinates, bit for bit, and
the same values. A writer makes every choice from the rows alone, so the same
rows always give the same bytes in every implementation.

## 2. Bytes

- `byte`: one byte
- `uint`: an unsigned integer, 7 bits per byte, the lowest first, 0x80 on every
  byte but the last, in the fewest bytes, at most 2^53 - 1
- `int`: a signed integer: the sign in 0x40 of the first byte with the 6 lowest
  bits of the magnitude, 0x80 on every byte but the last, then 7 bits per byte,
  in the fewest bytes, at most 2^53 - 1 in magnitude; -0 is not written (the
  signed integer of the canonical bytes of a value)
- `string`: a `uint` of the number of bytes, then the UTF-8
- `run`: a `uint` of the number of bytes, then the bytes
- `floats`: a run of float64 values written as the XOR of each with the one
  before (section 2.2)
- Canonical bytes of a value: the canonical form of the values of the tables
  (`canonical-value.ts`): one byte of the kind (0 null, 1 false, 2 true, 3
  integer, 4 float64, 5 string, 6 array, 7 object) and its contents, an object's
  keys in the order of their UTF-8

A reader refuses what a writer never writes: an integer not in its fewest bytes
or above 2^53 - 1, UTF-8 that is not well formed, bytes that end early or are
left over, an index out of its table, a bit set past the rows.

### 2.1 Ids and keys

An id is an origin and a number. The origin is a 64-bit number that names where
ids are made; each origin numbers its ids from 1 and never uses a number twice.
The number is from 1 to 2^53 - 1. As text, an id is the origin in 13 digits of
Crockford's base 32 (`0123456789ABCDEFGHJKMNPQRSTVWXYZ`, uppercase, most
significant first, the first digit holding the top 4 bits so it is `0` to `F`),
`-`, and the number in base 32 without leading zeros: `1AAAAAAAAAAAA-1A`. In a
group, an origin is 8 bytes, big-endian.

The rows of a run have no key of their own. Row `i` of a run that follows the
key `head` has the key `head` followed by the suffix of `i`: one digit for the
number of digits of `i` in base 61, then those digits, written with `1` to `z`
of the digits `0-9A-Za-z` (`1` for 0, `z` for 60). A suffix never holds a `0`,
and a larger `i` gives a larger suffix (0 is `11`, 60 is `1z`, 61 is `221`, 3721
is `3211`).

### 2.2 Floats by XOR

The 64 bits of each value (its IEEE 754 bits as an integer) are XORed with the
bits of the value before it (0 before the first). The bits are written highest
first, the last byte padded with 0 bits:

- `0`: the XOR is 0
- `10`: there was a window before and the XOR has at least its number of leading
  and of trailing 0 bits: the `64 - lead - trail` bits of that window
- `11`: a new window: `lead` (the number of leading 0 bits, at most 31) in 5
  bits, the number of meaningful bits minus 1 in 6 bits, then those bits
  (`64 - lead - trail` of them, `trail` the number of trailing 0 bits). It
  becomes the window

### 2.3 Decimal coordinates

A value `v` is decimal at `d` digits (0 to 13) when the integer `k` nearest to
`v × 10^d` has at most 2^51 in magnitude and `k / 10^d` is `v`, bit for bit.
`x = v × 10^d` is one float64 product; `k` is `floor(x)`, plus 1 when
`x - floor(x) >= 0.5`; `k / 10^d` is one float64 division; `10^d` is the float64
of the power (exact). -0, NaN and the infinities are never decimal. The fewest
digits of `v` is the smallest `d` it is decimal at.

## 3. A group

A group holds `n` rows (1 to 2^20) of one run. Its bytes, in order:

1. `uint` `n`
2. The origins: `uint` count, then 8 bytes each. They are numbered in the order
   they are first named by the ids, then by what made the rows, then by the
   revisions (in the order of the rows, then of the names of the cells)
3. The ids: `uint` count of runs, then per run `uint` origin, `uint` first
   number, `uint` count (at least 1). The runs cover the rows in order; a run is
   as long as the numbers follow each other
4. The place: `string` parent (the empty string for none), `byte` form of the
   keys (0: from a head), `string` head, `uint` the number of the first row of
   the group in its run. Row `r` has the key of row `first + r` of the run
5. What made the rows: `byte` 0 (none: what added the group made them) or 1,
   then `uint` count of runs and per run `uint` sequence, `uint` origin, `uint`
   step, `uint` count. A run is as long as the revision is the same
6. The deleted rows: `byte` 0 (none) or 1, then `ceil(n / 8)` bytes, row `r` at
   bit `r % 8` of byte `r / 8`
7. The types: `uint` count (1 to 255) and the names (`string`) in the order of
   their first row; when more than one, `n` bytes, the type of each row
8. The geometry (section 3.1)
9. The fills: `byte` 0 (none) or 1, then the fills (section 3.2)
10. The styles: `uint` count (at least 1) and each style's canonical bytes
    (`run`, an object) in the order of their first row; when more than one, `n`
    `uint`, the style of each row
11. The attributes (section 3.3)
12. The revisions of the cells (section 3.4)

### 3.1 The geometry

- `byte` the dimensions: 0 `xy`, 1 `xyz`, 2 `xym`, 3 `xyzm`. Every coordinate
  has their number of values; a position of fewer values gets NaN for the
  others, one of more is refused
- `uint` the number of columns of geometry, then a `byte` type of each, in the
  order of their first row: 0 Point, 1 LineString, 2 Polygon, 3 MultiPoint, 4
  MultiLineString, 5 MultiPolygon
- When there is a column, `n` bytes: the column of each row plus 1 (0 for no
  geometry)
- Each column, in order: the counts of its levels, then its coordinates

The counts of the levels, outermost first, each a `run` of `uint`, one per entry
of the level above, over the rows of the column:

| Type | Levels |
| --- | --- |
| Point | none (one coordinate per row) |
| LineString, MultiPoint | coordinates per row |
| Polygon, MultiLineString | rings (parts) per row; coordinates per ring |
| MultiPolygon | polygons per row; rings per polygon; coordinates per ring |

The coordinates of a column:

- `int` the scale: the largest of the fewest digits of the rows whose values are
  all decimal (the fewest digits of a row is the largest of the fewest digits of
  its values), or -1 when no row is
- When the scale is not -1: `ceil(rows / 8)` bytes, a bit per row of the column,
  set when every value of the row is decimal at the scale; then one `run` per
  dimension of `int`: the difference of each `k` from the one before in that
  dimension (0 before the first of the column), over the coordinates of the rows
  of the bit
- One `run` per dimension of `floats`: the values of that dimension of the other
  rows

### 3.2 The fills

The fills of the rows of type Polygon and MultiPolygon, in the order of the
rows: a `run` of `uint`, two per such row (the number of vertices of its fill,
the number of pairs), then a `run` of `uint`, the 4 indices of each pair into
the vertices of the fill. The vertices of a fill are the rings of each polygon
in turn without their closing coordinate, a ring of fewer than 3 coordinates
left out (and a polygon whose outer ring is). A pair `(a, b, c, d)` is the
triangles `(a, b, c)` and `(c, b, d)`; a triangle alone is `(a, b, c, c)`.

The fills are a copy of what a reader would make, kept to save the time of
making them. A writer that cannot make them writes none, and a reader makes
them.

### 3.3 The attributes

`uint` the number of columns, then each column in the order of the UTF-8 of its
key: the key (`string`), then:

- `byte` the form: 0 dense (an entry per row) when twice the number of rows that
  hold the key is at least `n`, else 1 sparse (an entry per row that holds it)
- Sparse: `uint` the number of entries, then per entry `uint` its row minus the
  row before minus 1 (the first: its row)
- A `byte` tag per entry: 0 absent (dense only), 1 null, 2 false, 3 true, 4
  float, 5 string, 6 nested, 7 integer. A number is an integer when it is an
  integer from -(2^53 - 1) to 2^53 - 1 and not -0, otherwise a float
- A `run` of `int`: the integers; a `run` of `floats`: the floats
- A `run` of `uint`: per string or nested entry, its index in the dictionary
- The dictionary: `uint` count, then each entry (`run`): the UTF-8 of a string
  or the canonical bytes of a nested value (an array or an object). Each
  different run of bytes is one entry, in the order of the first entry that
  names it

### 3.4 The revisions of the cells

The cells of a row changed after the row was made, each with its revision. A
cell is a name the user of the format gives (a field, an element of a geometry);
the format does not read it.

- `uint` the number of names, then each (`string`), in the order of their UTF-8
- `uint` the number of entries, in the order of their rows, then of their names;
  per entry `uint` its row minus the row of the entry before (the first: its
  row), `uint` the name, `uint` sequence, `uint` origin, `uint` step

A revision is three numbers the user of the format gives meaning to: `sequence`
orders the changes of a set of rows, `origin` names where a change was made,
`step` counts the changes of that origin.

## 4. A block

The content of a block:

1. The magic `TBNB` (`54 42 4E 42`)
2. `uint` the version (1)
3. `uint` the number of groups (at least 1), then per group `uint` its rows and
   `uint` its bytes
4. The bytes of each group

A writer cuts the rows into groups in their order: a group takes rows while it
has fewer than `groupRows` (1,000 when not given) and, unless it is empty, the
coordinates of the next row do not make it more than `groupVertices` (40,000
when not given). The coordinates of a row are its positions.

A writer of a long run cuts it into blocks in the order of its groups: a block
takes groups while the bytes of its groups stay within `blockBytes` (4 MiB when
not given), and takes at least one. Block `j` has the head of the run followed
by the suffix of `j` (section 2.1), and its rows are numbered from 0: the key of
row `i` of block `j` is the head, the suffix of `j`, the suffix of `i`. A group
is written for the block it goes in.

## 5. A file

A file holds a content cut into frames:

1. The magic `TBNF` (`54 42 4E 46`)
2. `uint` the number of frames, then per frame `byte` method (0 stored, 1 zstd),
   `uint` the bytes of its content, `uint` the bytes stored
3. The stored bytes of each frame

The content is the contents of the frames put together. A writer of a block puts
the head of the block (its magic to the bytes of its groups) in one frame and
each group in a frame of its own, so a reader decompresses and reads the groups
one at a time. A frame is compressed when the writer has a compressor and it
gets smaller, else stored. A reader reads the groups a frame at a time when the
frames are those of the groups, else reads the whole content.

## 6. A manifest

The content of a manifest is the magic `TBNM` (`54 42 4E 4D`) and the canonical
bytes of one object:

- `tabane`: 1
- `coordinates`: `{system, dimensions}`: the convention of the coordinates of
  every block. The system is a name the writer and the reader agree on
  (`lnglat`: longitude and latitude in degrees; `plane`: a plane without bounds)
- `partition`: `{kind}`: how the rows were cut into blocks. In version 1 only
  `order`: each block is a run of rows in the order of their keys. A reader
  refuses a kind it does not know
- `blocks`: an entry per block, in the order of the rows
- `extra` (optional): an object of values the user of the format keeps with the
  manifest, which the format does not read

An entry of a block:

- `name`, `rows`, `bytes` (the length of its content)
- `box`: per dimension `[min, max]` over the values of that dimension of every
  coordinate of its rows, NaN left out (null for a dimension of none); null for
  a block without coordinates. The first value of a dimension is both; a later
  value replaces the min when smaller, else the max when larger
- `ids`: the runs of its ids, `[origin, first, count]`, a run as long as the
  numbers follow each other across its groups
- `order`: `{parent, first, last}`: the parent of its rows and the keys of its
  first and last row

Later versions add other partitions (cells of space, overviews of a geometric
error) with the fields their entries need. The box has any number of dimensions,
so the same manifest serves coordinates on the earth, on a plane or with time.

## 7. Reading into the tables

A group is a block of rows of the tables (`tabaneRowBlock`): the geometry, the
types, the styles and the attributes are taken as they are; the reader makes the
ids and the keys as text from their runs, the hashes of the ids, the flags, the
bbox of every row and the spatial index (they depend on the system of
coordinates of the reader), and the fills of the rows that draw a ring around
their point (they depend on the types of the reader). The fills of the polygons
are copied when the group holds them, and made when it does not.

## 8. Test vectors

`vectors/` holds one file per case: its `input` (the parent, the head, the
dimensions, the cutting, the rows), the `blocks` it gives (`name`, `rows`,
`cuts`, the `content` in hex, the file of stored frames `stored` and a file of
zstd frames `zstd`), the `rows` read back, and for some a `manifest` (its input,
its `entries`, its `content` and `name`). A float that JSON cannot write (-0,
NaN) is `{"$f64": "<16 hex digits of its bits, big-endian>"}`. A polygon row of
an input whose fills are written gives its `fill`, so an implementation that
does not make fills writes the same bytes.

An implementation writes the `content` of every block (and of the manifest) from
the input, reads the `rows` back from it, and reads the content back from both
files. The bytes of zstd depend on the compressor, so `zstd` is read, never
written to be compared.

`TABANE_VECTORS_WRITE=1 npx vitest run src/table/tabane/vectors.test.ts`, then
`npx biome format --write src/table/tabane/vectors`, writes them again from the
scenarios of `vectors.test.ts`.
