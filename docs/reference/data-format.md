# Data format

The two file formats that `draw.export()` writes and `draw.load()` reads:
the native format, which keeps everything, and GeoJSON, which other GIS
tools read. It also lists the coordinates and properties of each feature
type and the checks a load performs. For how to save and load in an
application, see [Saving and loading](../guides/save-load.md). For the
fields of `Feature`, `Layer` and `Group` one by one, see the
[generated API reference](./api/index.html).

## Principles

- GeoJSON first. A feature is a GeoJSON feature with a few extra fields,
  and every built-in type can be written as GeoJSON
- One coordinate system. Every position is WGS84 `[longitude, latitude]` in
  degrees. There is no elevation; a third element in the input is dropped
- One prefix. Keys that belong to this library carry `maplibre-gl-draw:` in
  GeoJSON, so they never collide with your attributes
- Order is array order. At every level, the end of the array is the
  foreground. There is no `zIndex`
- One file. The native format carries the metadata, the layers, the
  stacking order, the groups, the features and the embedded images together

## The document model

A document has metadata, layers, a stacking order, groups and features.
Every feature belongs to exactly one layer, and optionally to one group in
that layer.

```text
layerOrder[]: layer ids and entries of the application, the last is the
              foreground

layers
  Layer { id, name, visible, locked, opacity, order[], styleRule? }
    order[]: feature ids and group ids, the last is the foreground

groups
  Group { id, name, visible, locked, featureIds[] }
    featureIds[]: the last is the foreground

features
  Feature { id, type, coordinates, layerId, groupId?,
            properties, style?, visible, locked }
```

### Draw order

The same rule holds at three levels.

1. Between layers: the stacking order (`layerOrder`, read with
   `draw.getLayerOrder()`), the last is the foreground
2. Inside a layer: `layer.order`, a mix of feature ids and group ids, the
   last is the foreground
3. Inside a group: `group.featureIds`, the last is the foreground

A group occupies one place in `layer.order`, and its features are drawn
there in the order of `featureIds`. The draw order of the whole document is
therefore: for each layer in order, for each item of `layer.order`, the
feature itself or the features of the group.

```typescript
function orderedFeatures(doc: Data): Feature[] {
  const features = new Map(doc.features.map((f) => [f.id, f]));
  const groups = new Map((doc.groups ?? []).map((g) => [g.id, g]));
  const layers = new Map((doc.layers ?? []).map((l) => [l.id, l]));
  const result: Feature[] = [];
  for (const entry of doc.layerOrder) {
    const layer = layers.get(entry);
    if (!layer) continue; // an entry of the application
    for (const itemId of layer.order) {
      const group = groups.get(itemId);
      const ids = group ? group.featureIds : [itemId];
      for (const id of ids) {
        const feature = features.get(id);
        if (feature) result.push(feature);
      }
    }
  }
  return result;
}
```

`draw.getOrderedFeatures()` returns the same order and also skips what is
hidden at any of the three levels. How grouping and ungrouping move items
in the order is described in [Layers](../guides/layers.md).

### The stacking order

The stacking order is part of the document: the native format saves it
and a replaced store holds it. It lists every layer once, and it can
also hold entries of the application that are not layers: the id of a
dataset with `order: 'layer-order'`, drawn at that
position, and separators for MapLibre's own layers (the `isExternalEntry`
option). The meaning of such an entry is the application's. The library
keeps its position and nothing more.

- The entries are distinct non-empty strings. `setLayerOrder` drops
  anything else and keeps a repeated entry at its first position
- A new layer is appended at the front, unless the order already holds
  its id
- Deleting a layer takes its id out. No other operation adds or removes
  an entry, so an entry of the application stays until the application
  sets an order without it
- An entry that names nothing is skipped when drawing and hit testing
- A layer that is not on the order is not drawn

### Containment

Every feature is listed in exactly one container: in `group.featureIds`
when it has a `groupId`, otherwise in `layer.order` of its layer. The Store
keeps this on every change, and a load rejects data that breaks it. A
feature whose `layerId` or `groupId` names something that does not exist
cannot be stored.

## Feature types

`type` decides the shape of `coordinates`. The nesting depth of the array is
the structure of the geometry.

| Type | `coordinates` |
| --- | --- |
| `Point`, `Image`, `Circle` | `[lng, lat]` |
| `LineString`, `Freehand`, `MultiPoint` | `[lng, lat][]` |
| `Polygon` | rings: `[lng, lat][][]` |
| `MultiLineString` | parts: `[lng, lat][][]` |
| `MultiPolygon` | parts of rings: `[lng, lat][][][]` |

A custom type registered with `registerFeatureHandler()` may use any
regular depth (see [Custom feature types](../guides/custom-types.md)).

### Point

```json
{ "type": "Point", "coordinates": [139.6917, 35.6895] }
```

core draws a point as a marker. It does not draw labels or icons; a
renderer of your own can keep what it needs in style keys of its own (see
[style](#style)).

### LineString

```json
{
  "type": "LineString",
  "coordinates": [[139.69, 35.68], [139.70, 35.69], [139.71, 35.69]]
}
```

At least two positions.

### Polygon

```json
{
  "type": "Polygon",
  "coordinates": [
    [[139.69, 35.68], [139.71, 35.68], [139.71, 35.70], [139.69, 35.68]],
    [[139.70, 35.685], [139.705, 35.685], [139.705, 35.69], [139.70, 35.685]]
  ]
}
```

The first ring is the outer ring and the others are holes. Every ring has
at least four positions and its first and last positions are equal.

### MultiPoint, MultiLineString, MultiPolygon

A Multi feature holds several parts with one set of properties and one
style. A MultiPolygon part has the same rings as a Polygon, one level
deeper.

```json
{
  "type": "MultiPolygon",
  "coordinates": [
    [[[139.69, 35.68], [139.70, 35.68], [139.70, 35.69], [139.69, 35.68]]],
    [[[139.72, 35.68], [139.73, 35.68], [139.73, 35.69], [139.72, 35.68]]]
  ]
}
```

- A hit on any part hits the feature, and its bounding box covers every
  part
- Move, scale and rotate apply to every part together
- Vertices are edited per part. The `part` field of `VertexRef` names the
  part. In a MultiPoint each position is one part, so there are vertex
  handles but no midpoint handles
- No drawing mode creates them. They come from loading data and from the
  results of geometry operations

### Image

An image placed at a point. The pixels are stored once in the document's
files and referenced by id.

```json
{
  "type": "Image",
  "coordinates": [139.6917, 35.6895],
  "properties": {
    "imageFileId": "01J9Z8K3...",
    "imageWidth": 200,
    "imageHeight": 150,
    "createdZoom": 14,
    "rotation": 0,
    "scale": 1
  }
}
```

| Property | Meaning |
| --- | --- |
| `imageFileId` | Id of the entry in `files` |
| `imageWidth`, `imageHeight` | Size of the image in pixels |
| `createdZoom` | Zoom at which it is drawn at its pixel size |
| `rotation` | Rotation in degrees (default 0) |
| `scale` | Scale factor (default 1) |

### Circle

A circle with a radius in meters, drawn as a true circle on the ground.

```json
{
  "type": "Circle",
  "coordinates": [139.6917, 35.6895],
  "properties": {
    "radiusMeters": 1000,
    "radiusHandleAngle": 135,
    "createdZoom": 14
  }
}
```

`radiusMeters` is required. `radiusHandleAngle` is the direction, in
degrees, in which the radius handle is shown.

### Freehand

A line drawn by dragging. Its coordinates have the shape of a LineString;
the type keeps it apart so that it is drawn and edited as a freehand
stroke.

```json
{
  "type": "Freehand",
  "coordinates": [[139.690, 35.680], [139.691, 35.681], [139.693, 35.681]]
}
```

## Properties and style

### properties

`feature.properties` holds your attributes, free-form. core reads and
writes a few keys of its own there, without a prefix.

- `name` and `description`
- `createdZoom`, `rotation`, `scale`
- `radiusMeters`, `radiusHandleAngle` of a Circle
- `imageFileId`, `imageWidth`, `imageHeight` of an Image

Only in GeoJSON output do `createdZoom`, `rotation`, `scale` and the Image
keys get the `maplibre-gl-draw:` prefix. `name` and `description` are
always written as plain keys, which other tools read as the name and the
description.

### style

`feature.style` is a `FeatureStyle` object (an `ImageStyle` for an Image).
A key that is not set takes the default of the draw instance (the `style`
option). Which keys apply depends on the type.

- Point and MultiPoint: `pointColor`, `pointRadius`, `pointShape`
- LineString, MultiLineString and Freehand: `strokeColor`,
  `strokeOpacity`, `strokeWidth`, `lineStyle`
- Polygon, MultiPolygon and Circle: the stroke keys, `fillColor`,
  `fillOpacity`
- Image: `imageOpacity`

A key that `FeatureStyle` does not define is kept and written back
unchanged, whatever its value, so an extension or an application can store
keys of its own in the style. core does not check or read them; the code
that reads such a key checks its value, because a value can also reach a
feature through `updateFeature` or a replaced store. In TypeScript, add the
keys to the `FeatureStyle` interface with declaration merging.

The color that a layer's `styleRule` gives a feature is computed when
drawing and is not written into `feature.style`. See
[Styles](../guides/styles.md).

## Native format

The native format keeps the whole document, including the layers, groups,
style rules and images, so that a load gives back exactly what was
exported. Its MIME type is `application/json`.

```json
{
  "version": "1.2.0",
  "created": "2026-01-05T12:00:00.000Z",
  "modified": "2026-01-05T12:00:00.000Z",
  "metadata": { "title": "Survey", "description": "Field notes" },
  "layerOrder": ["parcels", "layer-1"],
  "layers": [
    {
      "id": "layer-1",
      "name": "Layer 1",
      "visible": true,
      "locked": false,
      "opacity": 1,
      "order": ["feature-1", "group-1"],
      "styleRule": {
        "kind": "categorical",
        "property": "type",
        "map": { "residential": "#ff0000", "commercial": "#00aa00" },
        "other": "#cccccc"
      }
    }
  ],
  "groups": [
    {
      "id": "group-1",
      "name": "Group 1",
      "featureIds": ["feature-2", "feature-3"],
      "visible": true,
      "locked": false
    }
  ],
  "features": [
    {
      "id": "feature-1",
      "type": "Point",
      "coordinates": [139.6917, 35.6895],
      "layerId": "layer-1",
      "properties": { "type": "residential" },
      "style": { "pointRadius": 8 },
      "visible": true,
      "locked": false
    }
  ],
  "files": {}
}
```

- `metadata` and `files` are left out when they are empty
- `metadata` declares `title` and `description`. An application can keep
  keys of its own there, such as the basemap it shows; they are written and
  read back as they are. In TypeScript, add them to the `Metadata`
  interface with declaration merging
- `files` maps an id to `{ id, mimeType, dataURL }`. Only the files that an
  exported Image uses are written
- `layerOrder` is the whole stacking order, entries of the application
  included (see [The stacking order](#the-stacking-order)). In the
  example, `parcels` is a dataset drawn behind `layer-1`.
  The order of the `layers` array has no meaning
- `export('native', { featureIds })` or `{ layerIds }` writes only those
  features, but all layers, groups and the whole stacking order

### Version

`version` follows semantic versioning. The current version is `2.0.0`,
which made `layerOrder` required. Data of version 1 is not read.

- A minor version only adds fields. Data of an older minor version loads as
  it is. Data of a newer minor version loads with a warning on the console,
  and the fields it adds are kept but not interpreted
- Data of another major version, or a `version` that is not
  `major.minor.patch`, is rejected

### Loading

Loading the native format replaces the whole document. Everything is
checked before anything is changed, and the first problem rejects the load
(the promise rejects and the document stays as it was).

- Every layer has a string `id` and `name`, boolean `visible` and
  `locked`, a finite `opacity` and an `order` array of strings. Layer ids
  are unique
- `layerOrder` is an array of distinct non-empty strings that lists every
  layer of the data
- Every group has a string `id` and `name`, boolean `visible` and `locked`
  and a `featureIds` array of strings
- Every feature has a string `id` and `type`, a `properties` object and
  boolean `visible` and `locked`. Feature ids and group ids are unique
  across both, because `layer.order` mixes them
- `coordinates` follow the rules of [Geometry checks](#geometry-checks)
- The `layerId` of a feature is a layer of the data (or `default-layer`,
  which the Store always keeps). A `groupId` is a group of the data
- The containment rule holds
- Every entry of `files` has an `id` equal to its key and an image that
  passes [Embedded images](#embedded-images)
- `style` is an object. Its keys are checked one by one as in
  [Style checks](#style-checks); a bad key is dropped rather than rejecting
  the load

The stacking order is replaced as a whole with `layerOrder`, so no entry of
the previous document is left on it. `default-layer`, which the Store
keeps, goes to the back when `layerOrder` does not list it.

The result has `format: 'native'` and `replaced: true`.

## GeoJSON

GeoJSON is for exchange with other tools. It carries the features with their
attributes, and enough extra keys that a GeoJSON exported by this library
loads back with its ids, layers, groups, visibility, lock state, style and
images.

### Export

```json
{
  "type": "FeatureCollection",
  "bbox": [139.6917, 35.6895, 139.6917, 35.6895],
  "features": [
    {
      "type": "Feature",
      "id": "feature-1",
      "geometry": { "type": "Point", "coordinates": [139.6917, 35.6895] },
      "properties": {
        "name": "City hall",
        "type": "residential",
        "maplibre-gl-draw:id": "feature-1",
        "maplibre-gl-draw:layerId": "layer-1",
        "maplibre-gl-draw:style": { "pointRadius": 8 }
      }
    }
  ]
}
```

The output follows RFC 7946. The stored features are not changed by an
export.

- Polygon rings follow the right-hand rule: the outer ring is
  counter-clockwise and holes are clockwise, however they were drawn
- Positions are rounded to 7 decimal places (about 1 cm)
- The FeatureCollection has a `bbox` (`[west, south, east, north]`), except when
  it is empty
- Longitudes are brought into -180 to 180. A shape drawn across the
  antimeridian is stored with longitudes slightly beyond 180 and written with
  them wrapped. It is not cut at the line, so a reader that does not handle
  the antimeridian may draw such a shape the long way round
- Features come in draw order, and hidden features follow at the end, so
  their visibility survives a round trip
- Layers, groups and style rules are not written. Use the native format
  when you need them

### Keys added to properties

| Key | Written |
| --- | --- |
| `maplibre-gl-draw:id` | Always (the feature's `id` has the same value) |
| `maplibre-gl-draw:layerId` | Always |
| `maplibre-gl-draw:groupId` | When the feature is in a group |
| `maplibre-gl-draw:style` | When the feature has a style |
| `maplibre-gl-draw:visible` | `false`, only when hidden |
| `maplibre-gl-draw:locked` | `true`, only when locked |
| `maplibre-gl-draw:featureType` | For a type GeoJSON does not have |
| `maplibre-gl-draw:createdZoom` | When set |
| `maplibre-gl-draw:rotation` | When set |
| `maplibre-gl-draw:scale` | When set |
| `maplibre-gl-draw:imageFileId` | Image |
| `maplibre-gl-draw:imageWidth` | Image |
| `maplibre-gl-draw:imageHeight` | Image |
| `maplibre-gl-draw:imageData` | Image: the pixels as a data URL |
| `maplibre-gl-draw:imageMimeType` | Image: for example `image/webp` |

`radiusMeters` and `radiusHandleAngle` of a Circle, and all your own
attributes, are written without a prefix.

### Types that GeoJSON does not have

Image, Circle, Freehand and custom types have no GeoJSON geometry. They
are written by the shape of their coordinates, and the type name goes into
`maplibre-gl-draw:featureType` as it is.

| Coordinates | Geometry written |
| --- | --- |
| One position | `Point` |
| A sequence of positions | `LineString` |
| Anything else | Not written (a console warning) |

So an Image and a Circle become a `Point`, and a Freehand becomes a
`LineString`. On load, a `Point` or `LineString` with the marker gets its
type back. The marker is ignored, and the geometry type kept, when it is
not a non-empty string, when it names a GeoJSON geometry type, or when it
names a type whose coordinates have another shape (`Image` on a
`LineString`, for example). A lower-case marker is also read: `image`,
`circle` and `freehand` name the built-in types, and any other name gets its
first letter capitalized.

### Import

A GeoJSON load adds to the document; it does not replace it. The input is a
FeatureCollection (a `.json` or `.geojson` file, or the parsed object).
Every feature is checked and converted before anything is written.

- A feature that cannot be used is left out and reported in
  `LoadResult.skipped` as `{ index, reason }`, and the others are imported.
  It is left out when it is not an object, when `properties` is neither an
  object nor `null`, when `geometry` is missing or `null`, when the
  geometry type is unknown, or when the coordinates fail the
  [Geometry checks](#geometry-checks)
- Positions are cut to two elements. Ring orientation is kept as given
- The id is `maplibre-gl-draw:id`, else the feature's `id`, else a new
  one. A numeric id becomes a string. An id already used in the document,
  or earlier in the same file, is replaced with a new one, so an export can
  be loaded back into the same document
- `maplibre-gl-draw:layerId` is used when it names a layer of the document;
  otherwise the feature goes into the active layer
- `groupId`, `visible`, `locked` and `style` are restored from their
  prefixed keys. A `groupId` naming a group the document does not have is
  dropped. The style is checked as in [Style checks](#style-checks)
- `name` and `description` are read from the plain keys, and from
  `maplibre-gl-draw:name` and `maplibre-gl-draw:description` when the plain
  key is absent
- Your attributes are copied as own properties, so a key such as
  `__proto__` stays an ordinary key
- When `maplibre-gl-draw:style` is absent, the simplestyle keys are copied
  into the style: `stroke` to `strokeColor`, `stroke-width` to
  `strokeWidth`, `stroke-opacity` to `strokeOpacity`, `fill` to
  `fillColor`, `fill-opacity` to `fillOpacity`, `marker-color` to
  `pointColor`. They also stay in `properties`. Export does not write
  simplestyle
- An embedded image is accepted only on a `Point` whose marker is `Image`,
  and only in the form of [Embedded images](#embedded-images). A bad image
  rejects the whole load, because only an altered file can carry one

The result has `format: 'geojson'`, `replaced: false`, the ids of the new
features and `skipped` when anything was left out.

```typescript
const result = await draw.load(geojson);
for (const { index, reason } of result.skipped ?? []) {
  console.warn(`feature ${index} was skipped: ${reason}`);
}
```

### Multi geometries and GeometryCollection

A Multi geometry becomes one Multi feature with one set of attributes, and
is exported unchanged, so the round trip loses nothing. With
`load(source, { flattenMulti: true })` each part becomes a feature of its
own with a new id instead.

A `GeometryCollection` is folded by type when it is loaded.

- Geometries of one kind are gathered into one Multi feature (three
  Polygons become one MultiPolygon)
- Mixed kinds become at most three features, one per kind (points, lines,
  polygons)
- The folded features get new ids, and each gets a copy of the attributes
- A nested `GeometryCollection` is folded into the same features
- When any of its geometries fails the checks, the whole dataset is
  left out

## Checks on load

### Geometry checks

Both formats check coordinates with the same rules.

- Coordinates are nested arrays. A position is two finite numbers. No array
  is empty
- The depth matches the type (see [Feature types](#feature-types)). A
  custom type may use any regular depth
- A line (LineString, Freehand, each part of a MultiLineString) has at
  least two positions
- A ring (of a Polygon, of each part of a MultiPolygon) has at least four
  positions, and its first and last positions are equal

### Style checks

A style read from a file (`style` in the native format,
`maplibre-gl-draw:style` and the simplestyle keys in GeoJSON) is checked key
by key. A key that fails is dropped; the rest of the style and the feature
are kept.

| Key | Accepted value |
| --- | --- |
| `fillColor`, `strokeColor`, `pointColor` | `#rgb` or `#rrggbb` |
| `fillOpacity`, `strokeOpacity`, `imageOpacity` | A number from 0 to 1 |
| `strokeWidth`, `pointRadius` | A finite number, 0 or more |
| `lineStyle` | `solid`, `dashed` or `dotted` |
| `pointShape` | `circle`, `square`, `triangle` or `star` |

A key that `FeatureStyle` does not define is kept unchanged, without a
check.

### Embedded images

The pixels of an Image travel as a data URL: in `files[].dataURL` of the
native format and in `maplibre-gl-draw:imageData` of GeoJSON.

- Only `data:image/png`, `image/jpeg`, `image/webp` and `image/gif` with
  base64 are accepted
- The decoded bytes must match the declared MIME type (`mimeType`, or
  `maplibre-gl-draw:imageMimeType`)
- Any other URL (`http:`, `https:`, `blob:`) and SVG are rejected, so
  opening a file never makes the viewer send a request
- An image wider or taller than 4096 px is scaled down and stored as WebP,
  the same as when an image file is loaded

## Image files

`draw.load(file, { coordinate, zoom, layerId })` with an image file adds one
Image feature at `coordinate`. `coordinate` is required; `zoom` becomes
`createdZoom` (1 when omitted) and `layerId` defaults to the active layer.
`draw.image.request` gives you all three (see [Events](./events.md)). The
image is converted to WebP and scaled down when it is larger than 4096 px.
The result has `format: 'image'` and `replaced: false`.
