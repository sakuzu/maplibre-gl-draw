# Notes on the 2.0 document model

These notes record how the document model of 1.0 maps onto the model of
2.0: the geometry of each feature type, the keys the library keeps in
`properties`, and the order of the items of a layer. The 2.0 shapes are
declared in `src/api/model.ts`; the internal types in
`src/shared/types/model.ts` follow them.

## Feature types and their geometry

In 1.0 a feature held `coordinates`, nested as deep as its type needed. In
2.0 it holds a GeoJSON `geometry`. The feature type stays as it was, and
it decides the kind of the geometry.

| Feature type | Coordinates in 1.0 | Geometry in 2.0 |
| --- | --- | --- |
| `Point` | `[lng, lat]` | `Point` |
| `Circle` | `[lng, lat]`, the center | `Point`, the center |
| `Image` | `[lng, lat]`, the anchor | `Point`, the anchor |
| `LineString` | `[lng, lat][]` | `LineString` |
| `Freehand` | `[lng, lat][]` | `LineString` |
| `Polygon` | `[lng, lat][][]`, the rings | `Polygon` |
| `MultiPoint` | `[lng, lat][]` | `MultiPoint` |
| `MultiLineString` | `[lng, lat][][]` | `MultiLineString` |
| `MultiPolygon` | `[lng, lat][][][]` | `MultiPolygon` |
| a custom type | any regular nesting | by the depth of the nesting |

A custom type registered from outside does not declare the kind of its
geometry in 1.0, so the kind is read from the coordinates as they come:
a single position is a `Point`, a list of positions a `LineString`, a
list of lists a `Polygon` and one level deeper a `MultiPolygon`. The
helper `geometryFromCoordinates` in `src/shared/utils/coordinates.ts`
applies this table, and `coordinatesOf` reads the coordinates back from a
geometry. A `GeometryCollection` has no coordinates of its own, and no
feature type produces one.

The radius of a circle is not part of its geometry. It stays in
`properties` (see below), as the size, the rotation and the scale of an
image do.

## Keys of properties

Every value the library owns is stored under a key that starts with
`maplibre-gl-draw:` (`DRAW_PROPERTY_PREFIX`). Every other key is an
attribute of the user. The code reads and writes the values of the library
only through the accessors of `src/shared/properties.ts`
(`getDrawProperty`, `setDrawProperty`, `drawProperties` and the key
constants), never through string literals.

The table lists every key of `properties` that the library itself reads or
writes, and the decision for each.

| Key in 1.0 | Who reads or writes it | Decision |
| --- | --- | --- |
| `createdZoom` | drawing modes, image import, renderers, hit tests | prefixed |
| `rotation` | rotate, image rendering and hit tests | prefixed |
| `scale` | resize, image rendering and hit tests | prefixed |
| `radiusMeters` | circle mode, radius drag, resize, buffer | prefixed |
| `radiusHandleAngle` | circle mode, radius drag | prefixed |
| `imageFileId` | image import, image rendering, exports | prefixed |
| `imageWidth` | image import, image rendering and hit tests | prefixed |
| `imageHeight` | image import, image rendering and hit tests | prefixed |
| `name` | automatic names, GeoJSON readers | user data, unprefixed |
| `description` | GeoJSON readers | user data, unprefixed |
| `width`, `height` | resize of a custom type | the extension's, unprefixed |
| the key a style rule names | style rules | user data, unprefixed |
| simplestyle keys (`stroke`, `fill`) | GeoJSON import | user data, unprefixed |

`width` and `height` are written by core only when the resize calculator
of a custom type returns them, and only that type reads them. The keys of
simplestyle are read on GeoJSON import as a fallback style, and kept as
attributes. They belong
to the extension, not to the library, so they keep their names.

The GeoJSON export also writes `maplibre-gl-draw:id`, `layerId`,
`groupId`, `visible`, `locked`, `style`, `featureType`, `imageData` and
`imageMimeType`. These are fields of the feature or the document, not
values in `properties`: the export writes them, and the import reads them
back into the fields and drops them from `properties`.

In 1.0 the native format stored the values of the library without the
prefix and the GeoJSON export added it, except for `radiusMeters` and
`radiusHandleAngle`, which were written as plain keys. In 2.0 both formats
carry `properties` as they are, so the GeoJSON export writes them with
their prefix. The GeoJSON import still reads the plain `radiusMeters` and
`radiusHandleAngle` of a `Circle` written by 1.0.

## Layers and groups

`Layer.order` becomes `Layer.items`, with the same content: the IDs of the
standalone features and of the groups in the layer, from the back.

`Group` gains `layerId`, the layer whose `items` list the group. The store
keeps it: when a group is created it takes the layer that lists it (or the
layer of its first member), and when a write lists a group in the items of
another layer, the group is updated to that layer.

## Styles

`Feature.style` is always present, `{}` when the feature has no style of
its own, and is a `FeatureStyle`. `ImageStyle` is gone: the keys it added
to the style of an Image are folded into the model.

| Key of `ImageStyle` in 1.0 | In 2.0 |
| --- | --- |
| `width`, `height` | `maplibre-gl-draw:imageWidth`, `imageHeight` |
| `rotation` | added to `maplibre-gl-draw:rotation` |
| `opacity` | `imageOpacity`, when the style has none |

`imageWidth` and `imageHeight` are the size the image is drawn at, at the
created zoom. The renderer falls back to the size of the decoded image
when they are absent. The fold (`legacy-image-style.ts`) runs on the
native data of version 2 and on the GeoJSON import of an Image.

`pointOpacity` is new: the point renderer multiplies it into the opacity
of the fill and of the outline of the marker (1 when unset).

## The native format

The version of the native format goes from `2.0.0` to `3.0.0`. Data of
version 2 is upgraded on load (`src/api/impl/import-export/native-upgrade.ts`):
`coordinates` becomes `geometry`, the values of the library in
`properties` get their prefix, the style keys of an Image are folded (see
above), `order` becomes `items`, and each group gets the `layerId` of the
layer that lists it (or of its first member).
Data of version 1 is still rejected, as before.

## GeoJSON

The GeoJSON export writes the geometry of a feature and its `properties`
as they are, with the positions rounded and the rings oriented as before.
A feature whose type is not the type of its geometry (an Image, a Circle,
a Freehand or a custom type) carries the `featureType` marker. In 1.0 a
custom type whose coordinates were neither a position nor a list of
positions was left out of the export; it is now written with its
geometry and the marker, and the import reads it back as the geometry
type, since the marker is read only on a Point or a LineString.
