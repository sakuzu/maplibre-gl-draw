# Sample data

The buildings and the places of central Tokyo east of the station
(Marunouchi, Nihonbashi, Kyobashi, Ginza and Tsukiji), from Overture
Maps, for the examples. `scripts/fetch-overture-sample.mjs` writes every
file of this folder (`npm run data:overture`).

## Source

- Overture Maps Foundation, <https://overturemaps.org>
- Release: 2026-09-23.1
- Fetched: 2026-10-01
- Box: longitude 139.766 to 139.79, latitude 35.666 to 35.69

The south edge was moved from 35.665 to 35.666 to keep the files
under 8 MB.

## Files

| File | Rows | Size |
| --- | --- | --- |
| `tokyo-buildings.geojson` | 10,477 buildings | 3,469 KB |
| `tokyo-places.geojson` | 17,558 places | 3,861 KB |
| `tokyo-buildings.parquet` | 10,477 buildings | 700 KB |

The buildings are those whose center is in the box, from the theme
`buildings` (type `building`), and the places those in the box, from
the theme `places` (type `place`). The coordinates are rounded to 6
decimals, and the rings follow the right-hand rule of RFC 7946. The
Parquet file is GeoParquet (WKB geometry, ZSTD) with the rows and the
coordinates of the GeoJSON file. A value Overture does not give is
`null`.

The properties of a building:

- `height`: the height in metres, or `null`. Overture gives it for
  few buildings of this area, so a building with a number of floors and
  no height takes 3 m per floor. 695 buildings have a height,
  631 of them from their floors
- `floors`: the number of floors above ground (`num_floors`)
- `subtype` and `class`: the kind of building (562 have a class)
- `name`: the primary name
- `area`: the area of the footprint in square metres, rounded to whole
  square metres, computed on the spheroid of WGS 84 (`ST_Area_Spheroid`
  of DuckDB) from the geometry Overture gives. Its quartiles are
  38, 70 and 160 m²; the largest is 17,533 m²

The properties of a place:

- `name`: the primary name
- `category`: the basic category (`basic_category`)
- `confidence`: how sure Overture is that the place exists, from 0 to 1

## Licenses

Attribution: © OpenStreetMap contributors, Overture Maps Foundation.

The buildings are under the Open Database License 1.0 (ODbL), as a
database derived from OpenStreetMap and other sources:
<https://opendatacommons.org/licenses/odbl/1-0/>. Their sources in this
sample:

| Dataset | License | Rows |
| --- | --- | --- |
| OpenStreetMap | ODbL-1.0 | 10,325 |
| doi:10.5281/zenodo.8174931 | CC-BY-4.0 | 121 |
| Microsoft ML Buildings | ODbL-1.0 | 31 |

The rows of doi:10.5281/zenodo.8174931 come from Qian Shi, et al., A
First High-quality Vector Data of Buildings in East Asian Countries
Based on a Comprehensive Large-scale Mapping Framework, Zenodo, 22 July
2023, under CC BY 4.0.

The places are under the Community Data License Agreement Permissive
2.0 (CDLA Permissive 2.0): <https://cdla.dev/permissive-2-0/>. Some of
their sources have licenses of their own: Foursquare data is under the
Apache License 2.0 (Copyright 2024 Foursquare Labs, Inc.), and
AllThePlaces data under CC0 1.0. Their sources in this sample:

| Dataset | License | Rows |
| --- | --- | --- |
| Overture | CDLA-Permissive-2.0 | 17,558 |
| meta | CDLA-Permissive-2.0 | 13,349 |
| Foursquare | Apache-2.0 | 2,934 |
| AllThePlaces | CC0-1.0 | 740 |
| Microsoft | CDLA-Permissive-2.0 | 532 |
| PinMeTo | CDLA-Permissive-2.0 | 2 |
| DAC | CDLA-Permissive-2.0 | 1 |

The terms and the attribution of every source are on
<https://docs.overturemaps.org/attribution/>.
