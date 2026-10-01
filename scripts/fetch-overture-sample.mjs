// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Fetches the sample data of the examples from Overture Maps (examples/public/data/)
 *
 * The buildings and the places of a box of central Tokyo, east of the station (Marunouchi,
 * Nihonbashi, Kyobashi, Ginza and Tsukiji), from the latest release of Overture Maps, read
 * with the DuckDB command line (its spatial and httpfs extensions) straight from the public
 * bucket of Overture, without credentials. It writes:
 *
 * - tokyo-buildings.geojson: the buildings whose center is in the box (`height`, `floors`,
 *   `subtype`, `class`, `name` and `area`, the area of the footprint in square metres)
 * - tokyo-places.geojson: the places in the box (`name`, `category` and `confidence`)
 * - tokyo-buildings.parquet: the same buildings as GeoParquet (WKB geometry, ZSTD)
 * - README.md: the source, the release, the licenses, the box and the counts
 *
 * The coordinates are rounded to 6 decimals (about 0.1 m) and the rings follow the right-hand
 * rule of RFC 7946. Overture gives a height to few buildings of this part of Tokyo and the
 * number of floors to more, so a building with floors and no height takes 3 m per floor; the
 * README says how many. The area is computed on the spheroid of WGS 84 (`ST_Area_Spheroid`)
 * from the geometry Overture gives, and rounded to whole square metres. When the files exceed
 * 8 MB, the south edge of the box moves north until they fit.
 *
 * Usage: npm run data:overture [-- --release <id>]   (the latest release when none is given)
 *
 * It needs the DuckDB command line in ~/.local/bin/duckdb, or the path in $DUCKDB, and the
 * network.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(root, 'examples/public/data');
const DUCKDB = process.env.DUCKDB ?? join(homedir(), '.local/bin/duckdb');
const BUCKET = 'overturemaps-us-west-2';
/** The box, in degrees: nothing west of 139.766, which keeps clear of the Imperial Palace */
const BOX = { west: 139.766, south: 35.665, east: 139.79, north: 35.69 };
/** The most the files may weigh together */
const LIMIT = 8 * 1024 * 1024;
/**
 * The licenses of the sources whose rows name none, from the attribution page of Overture
 * (https://docs.overturemaps.org/attribution/)
 */
const LICENSES = { 'doi:10.5281/zenodo.8174931': 'CC-BY-4.0' };
/** The height of a floor, for a building with floors and no height (m) */
const FLOOR_HEIGHT = 3;

/** The latest release, the last of the folders of release/ in the bucket */
async function latestRelease() {
  const url = `https://${BUCKET}.s3.us-west-2.amazonaws.com/?list-type=2&prefix=release/&delimiter=/`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Listing the releases failed: ${response.status}`);
  const text = await response.text();
  const releases = [...text.matchAll(/<Prefix>release\/([^/<]+)\/<\/Prefix>/g)].map((m) => m[1]);
  if (releases.length === 0) throw new Error('The bucket lists no release');
  return releases.sort().at(-1);
}

/** Runs SQL in DuckDB (in memory) and returns what it prints */
function duckdb(sql) {
  const setup = 'INSTALL spatial; LOAD spatial; INSTALL httpfs; LOAD httpfs;';
  return execFileSync(DUCKDB, ['-noheader', '-list', '-c', `${setup}\n${sql}`], {
    encoding: 'utf8',
    maxBuffer: 256 << 20,
  });
}

/** A number rounded to `digits` decimals */
function round(value, digits) {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

/** Twice the signed area of a ring (positive when counterclockwise) */
function signedArea(ring) {
  let sum = 0;
  for (let i = 0; i + 1 < ring.length; i++) {
    sum += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  }
  return sum;
}

/**
 * A ring rounded to 6 decimals without repeated positions, counterclockwise for the exterior
 * and clockwise for a hole, or null when the rounding leaves no area
 */
function roundRing(ring, exterior) {
  const out = [];
  for (const [x, y] of ring) {
    const p = [round(x, 6), round(y, 6)];
    const last = out.at(-1);
    if (!last || last[0] !== p[0] || last[1] !== p[1]) out.push(p);
  }
  const [first, last] = [out[0], out.at(-1)];
  if (first[0] !== last[0] || first[1] !== last[1]) out.push([...first]);
  const area = signedArea(out);
  if (out.length < 4 || area === 0) return null;
  return area > 0 === exterior ? out : out.reverse();
}

/** A polygon rounded ring by ring, or null when its exterior leaves no area */
function roundPolygon(rings) {
  const exterior = roundRing(rings[0], true);
  if (!exterior) return null;
  const holes = rings.slice(1).map((ring) => roundRing(ring, false));
  return [exterior, ...holes.filter((ring) => ring !== null)];
}

/** A Polygon or a MultiPolygon rounded, or null when nothing is left */
function roundGeometry(geometry) {
  if (geometry.type === 'Polygon') {
    const coordinates = roundPolygon(geometry.coordinates);
    return coordinates && { type: 'Polygon', coordinates };
  }
  if (geometry.type === 'MultiPolygon') {
    const polygons = geometry.coordinates.map(roundPolygon).filter((p) => p !== null);
    if (polygons.length === 0) return null;
    if (polygons.length === 1) return { type: 'Polygon', coordinates: polygons[0] };
    return { type: 'MultiPolygon', coordinates: polygons };
  }
  if (geometry.type === 'Point') {
    return { type: 'Point', coordinates: geometry.coordinates.map((v) => round(v, 6)) };
  }
  return null;
}

/** Reads the lines of JSON DuckDB wrote */
function readLines(file) {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line));
}

/** A FeatureCollection with one feature per line, so that a change reads well in a diff */
function featureCollection(features) {
  const lines = features.map((feature) => JSON.stringify(feature));
  return `{"type":"FeatureCollection","features":[\n${lines.join(',\n')}\n]}\n`;
}

/** The sizes of the written files, in bytes */
function sizeOf(name) {
  return statSync(join(OUT, name)).size;
}

/** The SQL string of a path */
function sqlString(text) {
  return `'${text.replaceAll("'", "''")}'`;
}

const releaseArg = process.argv.indexOf('--release');
const release = releaseArg > 0 ? process.argv[releaseArg + 1] : await latestRelease();
const fetched = new Date().toISOString().slice(0, 10);
console.log(`Overture release ${release}`);

const tmp = mkdtempSync(join(tmpdir(), 'overture-'));
try {
  // 1. The rows whose extent meets the box, kept in a local file so that a smaller box needs
  // no second download
  const theme = (path) => sqlString(`s3://${BUCKET}/release/${release}/${path}/*`);
  const meets = `bbox.xmin < ${BOX.east} AND bbox.xmax > ${BOX.west}
    AND bbox.ymin < ${BOX.north} AND bbox.ymax > ${BOX.south}`;
  const rawBuildings = join(tmp, 'buildings.parquet');
  const rawPlaces = join(tmp, 'places.parquet');
  duckdb(`SET s3_region='us-west-2';
COPY (
  SELECT id, geometry, height, num_floors, subtype, class, names.primary AS name, sources
  FROM read_parquet(${theme('theme=buildings/type=building')})
  WHERE ${meets}
) TO ${sqlString(rawBuildings)} (FORMAT PARQUET);
COPY (
  SELECT id, geometry, names.primary AS name, basic_category AS category, confidence, sources
  FROM read_parquet(${theme('theme=places/type=place')})
  WHERE ${meets}
) TO ${sqlString(rawPlaces)} (FORMAT PARQUET);`);

  let south = BOX.south;
  for (;;) {
    // 2. The buildings whose center is in the box and the places in it, in the order of a
    // Hilbert curve over the box (neighbors on the map are neighbors in the file)
    const box = `{min_x: ${BOX.west}, min_y: ${south}, max_x: ${BOX.east}, max_y: ${BOX.north}}::BOX_2D`;
    const inBox = (point) =>
      `ST_X(${point}) BETWEEN ${BOX.west} AND ${BOX.east} AND ST_Y(${point}) BETWEEN ${south} AND ${BOX.north}`;
    const buildingsJson = join(tmp, 'buildings.json');
    const placesJson = join(tmp, 'places.json');
    const sourcesJson = join(tmp, 'sources.json');
    // The area on the spheroid reads the coordinates as longitude and latitude
    duckdb(`SET geometry_always_xy = true;
CREATE TABLE b AS SELECT * FROM read_parquet(${sqlString(rawBuildings)})
  WHERE ${inBox('ST_Centroid(geometry)')};
CREATE TABLE p AS SELECT * FROM read_parquet(${sqlString(rawPlaces)}) WHERE ${inBox('geometry')};
COPY (
  SELECT id, ST_AsGeoJSON(geometry) AS geometry, height, num_floors AS floors, subtype, class, name,
    round(ST_Area_Spheroid(geometry))::INTEGER AS area
  FROM b ORDER BY ST_Hilbert(ST_Centroid(geometry), ${box}), id
) TO ${sqlString(buildingsJson)} (FORMAT JSON);
COPY (
  SELECT id, ST_AsGeoJSON(geometry) AS geometry, name, category, confidence
  FROM p ORDER BY ST_Hilbert(geometry, ${box}), id
) TO ${sqlString(placesJson)} (FORMAT JSON);
COPY (
  SELECT 'buildings' AS theme, s.dataset AS dataset, s.license AS license, count(*) AS rows
  FROM (SELECT unnest(sources) AS s FROM b) GROUP BY ALL
  UNION ALL
  SELECT 'places', s.dataset, s.license, count(*)
  FROM (SELECT unnest(sources) AS s FROM p) GROUP BY ALL
  ORDER BY theme, rows DESC
) TO ${sqlString(sourcesJson)} (FORMAT JSON);`);

    // 3. GeoJSON, rounded, with the height taken from the floors where Overture has none
    let estimated = 0;
    const buildings = [];
    for (const row of readLines(buildingsJson)) {
      const geometry = roundGeometry(row.geometry);
      if (!geometry) continue;
      let height = row.height ?? null;
      if (height === null && row.floors !== null) {
        height = row.floors * FLOOR_HEIGHT;
        estimated++;
      }
      buildings.push({
        type: 'Feature',
        id: row.id,
        geometry,
        properties: {
          height: height === null ? null : round(height, 1),
          floors: row.floors ?? null,
          subtype: row.subtype ?? null,
          class: row.class ?? null,
          name: row.name ?? null,
          area: row.area ?? null,
        },
      });
    }
    const places = [];
    for (const row of readLines(placesJson)) {
      places.push({
        type: 'Feature',
        id: row.id,
        geometry: roundGeometry(row.geometry),
        properties: {
          name: row.name ?? null,
          category: row.category ?? null,
          confidence: row.confidence === null ? null : round(row.confidence, 2),
        },
      });
    }
    writeFileSync(join(OUT, 'tokyo-buildings.geojson'), featureCollection(buildings));
    writeFileSync(join(OUT, 'tokyo-places.geojson'), featureCollection(places));

    // 4. GeoParquet of the same buildings, read back from the GeoJSON so that the two hold the
    // same rows and the same coordinates. DuckDB writes the GeoParquet metadata of a GEOMETRY
    // column itself
    const parquet = join(OUT, 'tokyo-buildings.parquet');
    duckdb(`
COPY (
  SELECT f.id::VARCHAR AS id, ST_GeomFromGeoJSON(f.geometry::JSON) AS geometry,
    f.properties.height::DOUBLE AS height, f.properties.floors::INTEGER AS floors,
    f.properties.subtype::VARCHAR AS subtype, f.properties.class::VARCHAR AS class,
    f.properties.name::VARCHAR AS name, f.properties.area::INTEGER AS area
  FROM (
    SELECT unnest(features) AS f
    FROM read_json(${sqlString(join(OUT, 'tokyo-buildings.geojson'))}, maximum_object_size = 268435456)
  )
) TO ${sqlString(parquet)} (FORMAT PARQUET, COMPRESSION ZSTD);`);

    const names = ['tokyo-buildings.geojson', 'tokyo-places.geojson', 'tokyo-buildings.parquet'];
    const total = names.reduce((sum, name) => sum + sizeOf(name), 0);
    if (total > LIMIT) {
      south = round(south + 0.001, 3);
      console.log(`${(total / 1048576).toFixed(1)} MB: the south edge moves to ${south}`);
      continue;
    }

    // 5. The README of the data
    const sources = readLines(sourcesJson);
    const withHeight = buildings.filter((b) => b.properties.height !== null).length;
    const withClass = buildings.filter((b) => b.properties.class !== null).length;
    writeFileSync(
      join(OUT, 'README.md'),
      readme({
        release,
        fetched,
        south,
        buildings,
        places,
        withHeight,
        withClass,
        estimated,
        sources,
      }),
    );
    for (const name of names) {
      console.log(`${name}: ${(sizeOf(name) / 1024).toFixed(0)} KB`);
    }
    console.log(
      `${buildings.length} buildings (${withHeight} with a height, ${estimated} of them from the floors) and ${places.length} places`,
    );
    break;
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

/** The README of the data folder */
function readme({
  release,
  fetched,
  south,
  buildings,
  places,
  withHeight,
  withClass,
  estimated,
  sources,
}) {
  const areas = buildings
    .map((b) => b.properties.area)
    .filter((a) => a !== null)
    .sort((a, b) => a - b);
  const quantile = (q) => areas[Math.min(areas.length - 1, Math.floor(q * areas.length))] ?? 0;
  const kb = (name) => `${Math.round(sizeOf(name) / 1024).toLocaleString('en')} KB`;
  const n = (value) => value.toLocaleString('en');
  const sourceRows = (theme) =>
    sources
      .filter((s) => s.theme === theme)
      .map(
        (s) =>
          `| ${s.dataset} | ${s.license ?? LICENSES[s.dataset] ?? 'not given'} | ${n(s.rows)} |`,
      )
      .join('\n');
  const shi = sources.some((s) => s.dataset === 'doi:10.5281/zenodo.8174931')
    ? `
The rows of doi:10.5281/zenodo.8174931 come from Qian Shi, et al., A
First High-quality Vector Data of Buildings in East Asian Countries
Based on a Comprehensive Large-scale Mapping Framework, Zenodo, 22 July
2023, under CC BY 4.0.
`
    : '';
  const moved =
    south === BOX.south
      ? ''
      : `\nThe south edge was moved from ${BOX.south} to ${south} to keep the files\nunder 8 MB.\n`;
  return `# Sample data

The buildings and the places of central Tokyo east of the station
(Marunouchi, Nihonbashi, Kyobashi, Ginza and Tsukiji), from Overture
Maps, for the examples. \`scripts/fetch-overture-sample.mjs\` writes every
file of this folder (\`npm run data:overture\`).

## Source

- Overture Maps Foundation, <https://overturemaps.org>
- Release: ${release}
- Fetched: ${fetched}
- Box: longitude ${BOX.west} to ${BOX.east}, latitude ${south} to ${BOX.north}
${moved}
## Files

| File | Rows | Size |
| --- | --- | --- |
| \`tokyo-buildings.geojson\` | ${n(buildings.length)} buildings | ${kb('tokyo-buildings.geojson')} |
| \`tokyo-places.geojson\` | ${n(places.length)} places | ${kb('tokyo-places.geojson')} |
| \`tokyo-buildings.parquet\` | ${n(buildings.length)} buildings | ${kb('tokyo-buildings.parquet')} |

The buildings are those whose center is in the box, from the theme
\`buildings\` (type \`building\`), and the places those in the box, from
the theme \`places\` (type \`place\`). The coordinates are rounded to 6
decimals, and the rings follow the right-hand rule of RFC 7946. The
Parquet file is GeoParquet (WKB geometry, ZSTD) with the rows and the
coordinates of the GeoJSON file. A value Overture does not give is
\`null\`.

The properties of a building:

- \`height\`: the height in metres, or \`null\`. Overture gives it for
  few buildings of this area, so a building with a number of floors and
  no height takes ${FLOOR_HEIGHT} m per floor. ${n(withHeight)} buildings have a height,
  ${n(estimated)} of them from their floors
- \`floors\`: the number of floors above ground (\`num_floors\`)
- \`subtype\` and \`class\`: the kind of building (${n(withClass)} have a class)
- \`name\`: the primary name
- \`area\`: the area of the footprint in square metres, rounded to whole
  square metres, computed on the spheroid of WGS 84 (\`ST_Area_Spheroid\`
  of DuckDB) from the geometry Overture gives. Its quartiles are
  ${n(quantile(0.25))}, ${n(quantile(0.5))} and ${n(quantile(0.75))} m²; the largest is ${n(quantile(1))} m²

The properties of a place:

- \`name\`: the primary name
- \`category\`: the basic category (\`basic_category\`)
- \`confidence\`: how sure Overture is that the place exists, from 0 to 1

## Licenses

Attribution: © OpenStreetMap contributors, Overture Maps Foundation.

The buildings are under the Open Database License 1.0 (ODbL), as a
database derived from OpenStreetMap and other sources:
<https://opendatacommons.org/licenses/odbl/1-0/>. Their sources in this
sample:

| Dataset | License | Rows |
| --- | --- | --- |
${sourceRows('buildings')}
${shi}
The places are under the Community Data License Agreement Permissive
2.0 (CDLA Permissive 2.0): <https://cdla.dev/permissive-2-0/>. Some of
their sources have licenses of their own: Foursquare data is under the
Apache License 2.0 (Copyright 2024 Foursquare Labs, Inc.), and
AllThePlaces data under CC0 1.0. Their sources in this sample:

| Dataset | License | Rows |
| --- | --- | --- |
${sourceRows('places')}

The terms and the attribution of every source are on
<https://docs.overturemaps.org/attribution/>.
`;
}
