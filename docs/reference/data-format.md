# Data format

The two formats that `draw.document` writes and `draw.open` and
`tx.import` read: the native format, which keeps everything, and GeoJSON,
which other GIS tools read. It also lists the geometry and the properties
of each feature type and the checks a read performs. For how to save and
load in an application, see [Saving and loading](../guides/save-load.md).
For the fields of
[`Feature`](../api/maplibre-gl-draw/interfaces/Feature.md),
[`Layer`](../api/maplibre-gl-draw/type-aliases/Layer.md) and
[`Group`](../api/maplibre-gl-draw/type-aliases/Group.md) one by one, see
the [generated API reference](../api/index.md).

```ts
const native = draw.document.toJSON(); // DrawDocument, the native format
const geojson = draw.document.toGeoJSON(); // a GeoJSON FeatureCollection

await draw.open(JSON.stringify(native)); // replaces the document
await draw.write((tx) => tx.import(geojson)); // adds the features
```

## Principles

- GeoJSON as it is. A feature is a GeoJSON Feature: its `geometry` is a
  GeoJSON geometry, and its `properties` are the GeoJSON properties. Both
  formats write it in that one shape
- One coordinate system. Every position is WGS84 `[longitude, latitude]` in
  degrees. There is no elevation; a third element in the input is dropped
- One prefix. The values of the library in `properties` are under keys that
  start with `maplibre-gl-draw:`, its layer, group, type, style, visibility
  and lock among them. A key whose value is the default is left out. Every
  other key is an attribute of yours
- Order is array order. At every level, the end of the array is the front.
  There is no `zIndex`
- One file. The native format carries the title, the description, the
  values of the applications, the layers, the stacking order, the groups,
  the features and the embedded images together

## The document model

A document has a title, a description, the values of the applications
(`metadata`), layers, a stacking order, groups and features.
Every feature belongs to exactly one layer, and optionally to one group in
that layer.

```text
layerOrder[]: layer IDs and entries of the application, the last is the
              front

layers
  Layer { id, name, visible, locked, opacity, items[], styleRule?, metadata? }
    items[]: feature IDs and group IDs, the last is the front

groups
  Group { id, layerId, name, visible, locked, featureIds[] }
    featureIds[]: the last is the front

features
  Feature { type: 'Feature', id, geometry, properties }
    properties: your attributes, and maplibre-gl-draw:layerId, groupId?,
                featureType?, style?, visible?, locked? and the other
                values of the library
```

### Draw order

The same rule holds at three levels.

1. Between layers: the stacking order (`layerOrder`), the last is the front
2. Inside a layer: `layer.items`, a mix of feature IDs and group IDs, the
   last is the front
3. Inside a group: `group.featureIds`, the last is the front

A group takes one place in `layer.items`, and its features are drawn there
in the order of `featureIds`. The draw order of the whole document is
therefore: for each layer in order, for each item of `layer.items`, the
feature itself or the features of the group.

```ts
import type { DrawDocument, Feature } from '@sakuzu/maplibre-gl-draw';

function orderedFeatures(doc: DrawDocument): Feature[] {
  const features = new Map(doc.features.map((f) => [f.id, f]));
  const groups = new Map((doc.groups ?? []).map((g) => [g.id, g]));
  const layers = new Map((doc.layers ?? []).map((l) => [l.id, l]));
  const result: Feature[] = [];
  for (const entry of doc.layerOrder) {
    const layer = layers.get(entry);
    if (!layer) continue; // an entry of the application
    for (const itemId of layer.items) {
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

`draw.features.list()` returns the features in the same order.
`tx.features.place` and `tx.groups.place` change `items` and `featureIds`,
which are read-only on the objects the instance returns. How grouping and
ungrouping move items in the order is described in
[Layers](../guides/layers.md).

### The stacking order

The stacking order is part of the document: the native format saves it
and a replaced Store holds it. It lists every layer once, and it can
also hold entries of the application that are not layers: the ID of a
dataset with `order: 'layer-order'`, drawn at that position, and the
entries for which the `isExternalEntry` option returns true, which divide
the stacking order so that MapLibre's own layers can go between the
divisions. The meaning of such an entry is the application's. The library
keeps its position and nothing more.

- The entries are distinct non-empty strings
- A new layer is added at the front
- Deleting a layer takes its ID out. `tx.layers.place` moves a layer, or
  another entry that is on the order, next to another, and leaves every
  other entry where it is
- An entry that names nothing is skipped when drawing and hit testing
- A layer that is not on the order is not drawn

`draw.getStore().getLayerOrder()` reads the whole order, entries of the
application included. The notifications of the Store report its changes
(`DocumentChange.layers.orderChanged`), and `change` lists the layers
whose place in it changed (`layers.placed`).

### Containment

Every feature is listed in exactly one place: in `group.featureIds` when it
has a `maplibre-gl-draw:groupId`, otherwise in `layer.items` of its layer.
A group lists only features of its own layer. The library keeps this on
every change, and a feature whose `maplibre-gl-draw:layerId` or `groupId`
names something that does not exist cannot be stored.

## Feature types

The type a feature is drawn as is `maplibre-gl-draw:featureType`, or the
type of its geometry when the key is absent; `readFeature(feature)` reads
it as `featureType`. The built-in types that GeoJSON has hold their own
kind and need no key; the others hold the kind that has their shape and
name their type in the key.

| Type | `geometry` |
| --- | --- |
| `Point` | `Point` |
| `Circle` | `Point`, the center |
| `Image` | `Point`, the anchor |
| `LineString` | `LineString` |
| `Freehand` | `LineString` |
| `Polygon` | `Polygon` |
| `MultiPoint` | `MultiPoint` |
| `MultiLineString` | `MultiLineString` |
| `MultiPolygon` | `MultiPolygon` |

A custom type declares the one kind its features hold in its
`FeatureTypeDefinition` (see
[Custom feature types](../guides/custom-types.md)). A `GeometryCollection`
is never the geometry of a feature.

### Point

```json
{ "type": "Point", "coordinates": [139.6917, 35.6895] }
```

The library draws a point as a marker. A renderer of your own that draws
it otherwise can keep what it needs in style keys of its own (see
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
at least four positions, and its first and last positions are equal.

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

- A hit on any part hits the feature, and its selection box covers every
  part
- Move, resize and rotate apply to every part together
- Vertices are edited per part. The `part` of a `VertexRef` names the
  part. In a MultiPoint each position is one part, so there are vertex
  handles but no midpoint handles
- No drawing mode creates them. They come from reading data, from
  `tx.features.create` and from the results of the operations on areas

### Image

An image placed at a point. The pixels are stored once in the files of the
document and named by ID.

```json
{
  "type": "Feature",
  "id": "01J9Z8K3ZQ4M5T6V7W8X9Y0A1B",
  "geometry": { "type": "Point", "coordinates": [139.6917, 35.6895] },
  "properties": {
    "name": "Image 1",
    "maplibre-gl-draw:layerId": "layer-1",
    "maplibre-gl-draw:featureType": "Image",
    "maplibre-gl-draw:imageFileId": "01J9Z8K3ZQ4M5T6V7W8X9Y0A1C",
    "maplibre-gl-draw:imageWidth": 200,
    "maplibre-gl-draw:imageHeight": 150,
    "maplibre-gl-draw:createdZoom": 14,
    "maplibre-gl-draw:rotation": 0,
    "maplibre-gl-draw:scale": 1,
    "maplibre-gl-draw:style": { "imageOpacity": 0.8 }
  }
}
```

The image is drawn at its size in pixels at `createdZoom`, turned by
`rotation` and grown by `scale`. Its opacity is `imageOpacity` of the
style.

### Circle

A circle with a radius in meters, drawn as a true circle on the ground.

```json
{
  "type": "Feature",
  "geometry": { "type": "Point", "coordinates": [139.6917, 35.6895] },
  "properties": {
    "maplibre-gl-draw:featureType": "Circle",
    "maplibre-gl-draw:radiusMeters": 1000,
    "maplibre-gl-draw:radiusHandleAngle": 135,
    "maplibre-gl-draw:createdZoom": 14
  }
}
```

`maplibre-gl-draw:radiusMeters` is the radius. `radiusHandleAngle` is the
direction, in degrees, in which the radius handle is shown.

### Freehand

A line drawn by dragging. Its geometry is a LineString; the type keeps it
apart so that it is drawn and edited as a freehand stroke.

```json
{
  "type": "Feature",
  "geometry": {
    "type": "LineString",
    "coordinates": [[139.690, 35.680], [139.691, 35.681], [139.693, 35.681]]
  },
  "properties": { "maplibre-gl-draw:featureType": "Freehand" }
}
```

## Properties and style

### properties

`feature.properties` holds your attributes, free-form, and the values of
the library under keys with the `maplibre-gl-draw:` prefix
([`DRAW_PROPERTY_PREFIX`](../api/maplibre-gl-draw/variables/DRAW_PROPERTY_PREFIX.md)).
Both formats write the keys as they are.

| Key (after the prefix) | Type | Meaning |
| --- | --- | --- |
| `layerId` | string | The layer it is in |
| `groupId` | string | The group it is in; absent when in none |
| `featureType` | string | Its type; absent for the type of its geometry |
| `style` | object | Its own look; absent when it has none |
| `visible` | `false` | Hidden in the document; absent when visible |
| `locked` | `true` | Locked; absent when not |
| `createdZoom` | number | The reference zoom, where the feature was drawn |
| `rotation` | number | The rotation in degrees; 0 when absent |
| `scale` | number | The scale factor of a resize; 1 when absent |
| `radiusMeters` | number | The radius of a Circle, in meters |
| `radiusHandleAngle` | number | Where the radius handle points, in degrees |
| `imageFileId` | string | The ID of the file of an Image |
| `imageWidth` | number | The width of an Image, in pixels |
| `imageHeight` | number | The height of an Image, in pixels |

The full key is the prefix followed by the name in the table, such as
`maplibre-gl-draw:createdZoom`.
[`readFeature(feature)`](../api/maplibre-gl-draw/functions/readFeature.md)
reads them under the short names, the defaults filled in (`visible`
true, `locked` false, `groupId` null, `style` `{}`). The place of a
feature (`layerId`, `groupId`) and its `featureType` are not changed by
an update: `tx.features.place` puts a feature elsewhere.

The resize and the rotation of the selection write `scale` and
`rotation` of an Image, and of a feature of another built-in type that
has them. A feature of a custom type has the fields its type declares
instead (`angleDegreesKey` and `scaleKey` of `transformFields` of its
definition), under the keys it names. A custom type names keys of its
own, without the `maplibre-gl-draw:` prefix, such as `boardAngle`: the
prefix is the library's, whose keys mean what this table says for every
type.

The library reads `name` and `description` as the name and the
description of a feature; they are plain keys, which other tools read too.
New features get a name from the `autoName` option.

[`isDrawProperty(key)`](../api/maplibre-gl-draw/functions/isDrawProperty.md)
tells the two kinds of key apart, so that an attribute panel can leave out
the values of the library:

```ts
import { isDrawProperty } from '@sakuzu/maplibre-gl-draw';

const attributes = Object.entries(feature.properties).filter(
  ([key]) => !isDrawProperty(key),
);
```

### style

`properties['maplibre-gl-draw:style']` is a
[`FeatureStyle`](../api/maplibre-gl-draw/interfaces/FeatureStyle.md),
absent when the feature has no look of its own (`readFeature` reads it as
`{}`). A key that is not set takes the
color of the style rule of its layer, or the look its custom type
declares (`defaultStyle` of its definition), or the default of the
instance (the `style` option). Which keys apply depends on the type.

- Point and MultiPoint: `pointColor`, `pointRadius`, `pointShape`,
  `pointOpacity`, `pointStrokeColor` and `pointStrokeWidth` (the outline
  of the marker, white and 2 pixels by default)
- LineString, MultiLineString and Freehand: `strokeColor`,
  `strokeOpacity`, `strokeWidth`, `lineStyle`
- Polygon, MultiPolygon and Circle: the stroke keys, `fillColor`,
  `fillOpacity`
- Image: `imageOpacity`

Colors are CSS color strings: `#rgb`, `#rrggbb`, the forms with alpha,
`rgb()`, `hsl()` and the named colors.

A key that `FeatureStyle` does not define is kept and written back
unchanged, whatever its value, so an extension or an application can store
keys of its own in the style. The library does not check or read them; the
code that reads such a key checks its value, because a value can also reach
a feature through `tx.features.update` or a replaced Store. In TypeScript, add
the keys to the `FeatureStyle` interface with declaration merging.

The color that the `styleRule` of a layer gives a feature, and the look its
custom type declares, are applied when drawing and are not written into
the style of the feature.
`draw.features.getAppliedStyle(id)` returns the look a feature is drawn
with. See [Styles](../guides/styles.md).

## Native format

The native format keeps the whole document, including the layers, groups,
style rules and images, so that `draw.open` gives back exactly what was
written. `draw.document.toJSON()` returns it as a
[`DrawDocument`](../api/maplibre-gl-draw/interfaces/DrawDocument.md);
serialize it with `JSON.stringify` and store it as `application/json`.

```json
{
  "version": "4.0.0",
  "created": "2026-01-05T12:00:00.000Z",
  "modified": "2026-01-05T12:00:00.000Z",
  "title": "Survey",
  "description": "Field notes",
  "metadata": { "app:basemap": "streets" },
  "layerOrder": ["parcels", "layer-1"],
  "layers": [
    {
      "id": "layer-1",
      "name": "Layer 1",
      "visible": true,
      "locked": false,
      "opacity": 1,
      "items": ["feature-1", "group-1"],
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
      "layerId": "layer-1",
      "name": "Group 1",
      "featureIds": ["feature-2", "feature-3"],
      "visible": true,
      "locked": false
    }
  ],
  "features": [
    {
      "type": "Feature",
      "id": "feature-1",
      "geometry": { "type": "Point", "coordinates": [139.6917, 35.6895] },
      "properties": {
        "type": "residential",
        "maplibre-gl-draw:layerId": "layer-1",
        "maplibre-gl-draw:style": { "pointRadius": 8 }
      }
    }
  ]
}
```

- `created` and `modified` are the time of the call that wrote it
- `title` and `description` are fields of the document, left out when
  there is none
- `metadata` holds the values an application or an extension keeps on the
  document, each under a key of its own prefix (`app:basemap`); they are
  written and read back as they are. A key without a prefix is not kept.
  `metadata` and `files` are left out when they are empty
- `features` are GeoJSON Features, in the shape `draw.features.get` reads
  them: the layer of each in `maplibre-gl-draw:layerId`, which every
  feature of a document names, and the other values of the library under
  their keys
- `files` maps an ID to `{ id, mimeType, dataURL }`. Only the files that an
  Image of the document uses are written
- `layerOrder` is the whole stacking order, entries of the application
  included (see [The stacking order](#the-stacking-order)). In the
  example, `parcels` is a dataset drawn behind `layer-1`. The order of the
  `layers` array has no meaning
- `styleRule` and `metadata` of a layer that has none are `undefined`, so
  `JSON.stringify` leaves them out. The `metadata` of a layer holds keys of
  a prefix too

### Version

`version` follows semantic versioning. The current version is `4.0.0`.

- A minor version only adds fields. Data of an older minor version is read
  as it is. Data of a newer minor version is read with a warning on the
  console, and the fields it adds are kept but not interpreted
- Data of another major version (`3.0.0` and earlier included), or a
  `version` that is not `major.minor.patch`, is rejected: no earlier
  version is upgraded

### Opening

`draw.open` of the native format replaces the whole document; `tx.import`
refuses it with `invalid-input`. Everything is checked before anything is
changed, and the first problem rejects the open: the promise rejects with a
`DrawError` whose code is `invalid-input` (or `unsupported-format` for an
image the browser cannot encode, see [Embedded images](#embedded-images)),
and the document stays as it was.

- `version` passes [Version](#version), `features` is an array, and
  `metadata`, when present, is an object
- Every layer has a non-empty string `id`, a string `name`, boolean
  `visible` and `locked`, a finite `opacity` and an `items` array of
  strings. `styleRule` and `metadata`, when present, are objects. Layer IDs
  are unique
- `layerOrder` is an array of distinct non-empty strings that lists every
  layer of the data
- Every group has a non-empty string `id`, strings `name` and `layerId`,
  boolean `visible` and `locked`, and a `featureIds` array of strings
- Every feature is a GeoJSON Feature (`type: 'Feature'`) with a non-empty
  string `id`, a `geometry` that passes
  [Geometry checks](#geometry-checks) for its type and a `properties`
  object. Feature IDs and group IDs are unique across both, because
  `layer.items` mixes them
- The `maplibre-gl-draw:layerId` of a feature is a layer of the data (or
  `default-layer`, when the document has it). A `maplibre-gl-draw:groupId`
  is a group of the data
- Every entry of `files` has an `id` equal to its key and an image that
  passes [Embedded images](#embedded-images)
- `maplibre-gl-draw:style` is an object. Its keys are checked one by one
  as in [Style checks](#style-checks); a bad key is dropped rather than
  rejecting the open

The stacking order is replaced as a whole with `layerOrder`, so no entry of
the previous document is left on it. `default-layer`, when the document has
it, is kept and goes to the back when `layerOrder` does not list it.

The open is one commit, told by `change` with the source `'open'`, and the
steps of undo are dropped. The result has the number of features read.

## GeoJSON

GeoJSON is for exchange with other tools. It carries the features with
their properties, and the keys of the library, so that a GeoJSON written
by this library is read back with its IDs, layers, groups, visibility,
lock state, style and images.

### Export

`draw.document.toGeoJSON()` returns a FeatureCollection.

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
        "maplibre-gl-draw:createdZoom": 14,
        "maplibre-gl-draw:layerId": "layer-1",
        "maplibre-gl-draw:style": { "pointRadius": 8 }
      }
    }
  ]
}
```

The output follows RFC 7946. The stored features are not changed by an
export.

- A feature is written as `draw.features.get` reads it, with the values of
  the library under their prefix; the export adds the keys below
- Polygon rings follow the right-hand rule: the outer ring is
  counter-clockwise and holes are clockwise, as the document holds them
- Positions are rounded to 7 decimal places (about 1 cm)
- The FeatureCollection has a `bbox` (`[west, south, east, north]`), except
  when it is empty
- Longitudes are brought into -180 to 180. A shape drawn across the
  antimeridian is stored with longitudes slightly beyond 180 and written
  with them wrapped. It is not cut at the line, so a reader that does not
  handle the antimeridian may draw such a shape the long way round
- Features come in draw order, and hidden features follow at the end, so
  their visibility survives a round trip
- Layers, groups and style rules are not written. Use the native format
  when you need them

A reader that wants only your attributes drops the keys for which
`isDrawProperty(key)` is true.

A feature of `draw.features.get` is GeoJSON as it is, so some features
are written by putting them in a FeatureCollection. Unlike the export,
their longitudes are as held, and an Image has no pixels.

### Keys added to properties

The keys of the library are written as a feature holds them
(`maplibre-gl-draw:layerId`, and `groupId`, `style`, `visible`, `locked`
and `featureType` when they are not the default). The export adds the
pixels of an Image.

| Key | Written |
| --- | --- |
| `maplibre-gl-draw:imageData` | Image: the pixels as a data URL |
| `maplibre-gl-draw:imageMimeType` | Image: for example `image/webp` |

### Types that GeoJSON does not have

Image, Circle, Freehand and custom types are written with their geometry,
and the type name goes into `maplibre-gl-draw:featureType` as it is. An
Image and a Circle become a `Point`, and a Freehand becomes a
`LineString`.

On read, a feature with the marker gets its type back, whatever the kind
of its geometry: the marker wins over the kind. The marker is ignored,
and the kind of the geometry kept, when it is not a non-empty string,
when it names a GeoJSON geometry type in any letter case, or when it
names a built-in type of another kind (`Image` on a `LineString`, for
example).

### Import

`tx.import(geojson)` adds the features to the document; `draw.open` of
GeoJSON deletes the features and groups that were there before and keeps
the layers. The input is a FeatureCollection, as an object, a JSON string
or a `.json` or `.geojson` file. Every feature is checked and converted
before anything is written.

- A feature that cannot be used is left out and reported in `skipped` as
  `{ index, error }`, and the others are imported. It is left out when it
  is not an object, when `properties` is neither an object nor `null`,
  when `geometry` is missing or `null`, when the geometry type is unknown,
  or when the coordinates fail the [Geometry checks](#geometry-checks)
- Positions are cut to two elements. Rings are put in the right-hand rule
- The ID is the `id` of the feature, else a new one. A numeric ID becomes
  a string. An ID already used in the document, or earlier in the same
  file, is replaced with a new one (`duplicateIds: 'renew'`), so an export
  can be imported back into the same document
- The layer is the `layer` option when it is given (an ID, or a layer it
  creates); otherwise `maplibre-gl-draw:layerId` when it names a layer of
  the document, or else the active layer. With the `group` option, every
  feature goes into one layer: the given or created one, else the active
  layer
- `groupId`, `visible`, `locked` and `style` are restored from their
  prefixed keys. A `groupId` naming a group the document does not have, or
  a group of another layer, is dropped, and so is every `groupId` with
  `draw.open` or with the `group` option, which puts the features into the
  group it creates. The style is checked as in
  [Style checks](#style-checks)
- The values of the library are kept under their prefixed keys; the other
  prefixed keys are read as above and not stored. Every other key is copied
  as an attribute, as an own property, so a key such as `__proto__` stays
  an ordinary key
- A feature without `name` gets one from the `autoName` option
- A Circle whose `radiusMeters` and `radiusHandleAngle` are written without
  the prefix has them read as the values of the library. An Image whose
  style carries `width`, `height`, `rotation` or `opacity` has them moved
  to the prefixed keys and `imageOpacity`
- When `maplibre-gl-draw:style` is absent, the simplestyle keys are copied
  into the style: `stroke` to `strokeColor`, `stroke-width` to
  `strokeWidth`, `stroke-opacity` to `strokeOpacity`, `fill` to
  `fillColor`, `fill-opacity` to `fillOpacity`, `marker-color` to
  `pointColor`. Simplestyle has no key for the outline of a marker. They
  also stay in `properties`. Export does not write simplestyle
- An embedded image is accepted only on a `Point` whose marker is `Image`,
  and only in the form of [Embedded images](#embedded-images). An image
  that cannot be imported rejects the whole read: a bad one means the file
  was altered, and one the browser cannot encode would be lost

`tx.import` is one commit with the other writes of its transaction.
`draw.open` deletes every feature and group of the document and keeps the
layers in the same commit, so an ID of the file may be one of the
features it replaces. `tx.import` gives the number of the new features,
their layer, how many got a new ID and `skipped` with the features left
out.

```ts
const result = await draw.write((tx) => tx.import(geojson));
for (const { index, error } of result.skipped) {
  console.warn(`feature ${index} was skipped: ${error.message}`);
}
```

### Multi geometries and GeometryCollection

A Multi geometry becomes one Multi feature with one set of attributes, and
is exported unchanged, so the round trip loses nothing. `parseGeoJSON`
with `flattenMulti: true` makes each part a feature of its own with a new
ID instead.

A `GeometryCollection` is folded by kind when it is read.

- Geometries of one kind are gathered into one Multi feature (three
  Polygons become one MultiPolygon)
- Mixed kinds become at most three features, one per kind (points, lines,
  polygons)
- The folded features get new IDs, and each gets a copy of the attributes
- A nested `GeometryCollection` is folded into the same features
- When any of its geometries fails the checks, the whole feature is left
  out

## Checks on read

### Geometry checks

Both formats check geometries with the same rules.

- The geometry is an object of one of the six kinds with `coordinates`:
  `Point`, `LineString`, `Polygon`, `MultiPoint`, `MultiLineString` or
  `MultiPolygon`
- A built-in type holds its own kind (see [Feature types](#feature-types))
- Coordinates are nested arrays. A position is two finite numbers. No array
  is empty, and the depth matches the kind
- A line (a LineString, each part of a MultiLineString) has at least two
  positions
- A ring (of a Polygon, of each part of a MultiPolygon) has at least four
  positions, and its first and last positions are equal

### Style checks

A style read from a file (`maplibre-gl-draw:style` in both formats, and
the simplestyle keys in GeoJSON) is checked key
by key. A key that fails is dropped; the rest of the style and the feature
are kept.

| Key | Accepted value |
| --- | --- |
| `fillColor`, `strokeColor`, `pointColor` | A CSS color |
| `pointStrokeColor` | A CSS color |
| `fillOpacity`, `strokeOpacity` | A number from 0 to 1 |
| `pointOpacity`, `imageOpacity` | A number from 0 to 1 |
| `strokeWidth`, `pointRadius` | A finite number, 0 or more |
| `pointStrokeWidth` | A finite number, 0 or more |
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
  the same as when the image mode places one. When the browser cannot encode
  WebP, it is stored as JPEG if none of its pixels is transparent, and
  otherwise in the format the browser returns (such as PNG)
- An image that breaks one of the rules above, or whose pixels cannot be
  decoded, fails with `invalid-input`. An image to scale down that the
  browser returns in another type fails with `unsupported-format`. A read
  rejects with that code; `parseGeoJSON` and
  `parseNative` leave the feature out and list it in `skipped` with it

## Image files

An image file is placed by the image mode, `draw_image`, which asks the
application for it through the option `requestImage` and adds one Image
feature where the mode was entered, in the active layer, with the zoom of
the map as `createdZoom` (see
[Drawing and editing](../guides/drawing.md#images)). Code places an image
with `tx.import`, as a GeoJSON feature of the type `Image` that carries
the picture in `maplibre-gl-draw:imageData` and its type in
`maplibre-gl-draw:imageMimeType`. The image is converted to WebP and
scaled down when it is larger than 4096 px. When the browser cannot
encode WebP, an image with no transparent pixel is converted to JPEG, and
one with a transparent pixel is kept in the format the browser returns
(such as PNG).
