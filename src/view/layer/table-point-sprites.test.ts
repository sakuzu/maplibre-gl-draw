// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The built-in points a sheet of pictures gives a picture, among the rows of a layer
 *
 * A point a sheet gives a picture is drawn with it in the place of its marker: among the rows in
 * one draw (`rows`, the sheet its source of pictures), at once in the drawing by kind. The first
 * active sheet that gives a picture wins; a point no sheet gives one keeps its marker. Packed, the
 * row is an instance of a sprite whose style holds the rectangle, the half size, no bearing and
 * whether the picture turns; the texel of the style of a row that turns holds its rotation.
 */

import { ValueStringCache } from '@sakuzu/tabane';
import { describe, expect, it } from 'vitest';
import type { LayerTableView } from '../../api/tables.js';
import { drawPropertyKey } from '../../shared/properties.js';
import type { Feature } from '../../shared/types/model.js';
import { createTestDrawer, feature, tablesOfFeatures } from '../../test-utils.js';
import { createFeatureCompanionRegistry } from '../feature-companion.js';
import { pointAngleSteps } from '../renderers/point/point-sdf.js';
import {
  type PointSprite,
  type PointSpriteSheetSource,
  PointSpriteSheets,
} from '../renderers/point/point-sprites.js';
import {
  ROWS_KIND,
  ROWS_STYLE_FLOATS,
  RowsPalette,
  readRowsInstance,
} from '../renderers/rows/rows-format.js';
import { TerrainContext } from '../terrain/context.js';
import {
  collectRow,
  ROWS_LAYOUT,
  RowStyleSlots,
  RowsDraft,
  type RowsPackContext,
  RowsStyles,
} from './table-collect.js';
import { classifyRow, type RowPictureSource } from './table-partition.js';

const ORIGIN: [number, number] = [Math.fround(139.5), Math.fround(35.5)];
const ROTATION = drawPropertyKey('rotation');

/** A sheet that gives the pictures of a map of ids */
function sheetOf(
  pictures: ReadonlyMap<string, PointSprite>,
  idOf: (row: number) => string,
  active = true,
): PointSpriteSheetSource {
  return {
    texture: null,
    active,
    spriteOfRow: (_view: LayerTableView, row: number) => pictures.get(idOf(row)) ?? null,
    spriteOfFeature: (f) => pictures.get(f.id) ?? null,
    onAdd: () => {},
    onRemove: () => {},
    beginFrame: () => {},
  };
}

const FLAG: PointSprite = { uv: [0.25, 0, 0.5, 0.5], halfWidth: 12, halfHeight: 8, rotates: false };
const ARROW: PointSprite = { uv: [0, 0.5, 0.5, 1], halfWidth: 10, halfHeight: 10, rotates: true };

function setup(
  features: Feature[],
  make: (idOf: (row: number) => string) => PointSpriteSheetSource[],
) {
  const { internals, table, tables } = tablesOfFeatures('layer', features);
  const group = table.groupAt(0);
  const view = tables.get('layer') as LayerTableView;
  const idOf = (row: number) => tables.getRowId(row) as string;
  const sheets = new PointSpriteSheets();
  const added = make(idOf);
  for (const sheet of added) sheets.add(sheet);
  const slots = new RowStyleSlots(createTestDrawer(), internals.styles, undefined);
  const classify = (row: number, oneDraw: boolean) => {
    let source: RowPictureSource | undefined;
    const kind = classifyRow(group, row, {
      slots,
      customTypes: new Map(),
      companions: createFeatureCompanionRegistry(),
      featureOf: () => {
        throw new Error('no feature is made');
      },
      view,
      oneDraw,
      pointSprites: sheets,
      onSprite: (_r, found) => {
        source = found;
      },
    });
    return { kind, source };
  };
  const palette = new RowsPalette();
  const sources = new Map<number, RowPictureSource>();
  for (let row = 0; row < group.data.length; row++) {
    const { source } = classify(row, true);
    if (source) sources.set(row, source);
  }
  const context: RowsPackContext = {
    slots,
    strings: new ValueStringCache(),
    pixelRatio: 1,
    terrain: new TerrainContext(),
    view,
    rowsStyles: new RowsStyles(slots, palette, 1),
    spriteSourceOf: (row) => sources.get(row),
  };
  const pack = () => {
    const rows = group.data.length;
    const draft = new RowsDraft(rows, 0);
    for (let row = 0; row < rows; row++) collectRow(group, row, row, draft, ORIGIN, context);
    return draft.finish(ORIGIN, palette, null);
  };
  return { group, sheets, added, classify, context, pack, sources, idOf };
}

describe('the classification of the points a sheet gives a picture', () => {
  const features = [
    feature('flag', 'Point', [139.7, 35.6]),
    feature('plain', 'Point', [139.71, 35.61]),
    feature('many', 'MultiPoint', [
      [139.72, 35.62],
      [139.73, 35.63],
    ]),
  ];
  const pictures = new Map([
    ['flag', FLAG],
    ['many', ARROW],
  ]);

  it('draws them among the rows in one draw, with the sheet as their source', () => {
    const { classify, added } = setup(features, (idOf) => [sheetOf(pictures, idOf)]);
    expect(classify(0, true)).toEqual({ kind: 'rows', source: added[0] });
    expect(classify(1, true)).toEqual({ kind: 'rows', source: undefined });
    expect(classify(2, true)).toEqual({ kind: 'rows', source: added[0] });
  });

  it('draws them at once in the drawing by kind', () => {
    const { classify } = setup(features, (idOf) => [sheetOf(pictures, idOf)]);
    expect(classify(0, false).kind).toBe('immediate');
    expect(classify(1, false).kind).toBe('point');
    expect(classify(2, false).kind).toBe('immediate');
  });

  it('takes the first active sheet that gives a picture', () => {
    const { classify, added } = setup(features, (idOf) => [
      sheetOf(new Map([['flag', FLAG]]), idOf, false),
      sheetOf(new Map([['plain', FLAG]]), idOf),
      sheetOf(pictures, idOf),
    ]);
    expect(classify(0, true).source).toBe(added[2]);
    expect(classify(1, true).source).toBe(added[1]);
  });

  it('keeps the markers once the sheet is taken out', () => {
    const { classify, sheets, idOf } = setup(features, () => []);
    const before = sheets.generation();
    const remove = sheets.add(sheetOf(pictures, idOf));
    expect(classify(0, true).source).toBeDefined();
    remove();
    expect(classify(0, true)).toEqual({ kind: 'rows', source: undefined });
    expect(classify(0, false).kind).toBe('point');
    // Every change of the sheets changes the generation the rows are classified again by
    expect(sheets.generation()).toBe(before + 2);
  });
});

describe('the packing of the points a sheet gives a picture', () => {
  it('packs a sprite whose style holds the picture, and its rotation when it turns', () => {
    const features = [
      feature('flag', 'Point', [139.7, 35.6], { properties: { [ROTATION]: 30 } }),
      feature('arrow', 'Point', [139.71, 35.61], { properties: { [ROTATION]: 30 } }),
      feature('plain', 'Point', [139.72, 35.62], { properties: { [ROTATION]: 30 } }),
    ];
    const { pack, context } = setup(features, (idOf) => [
      sheetOf(
        new Map([
          ['flag', FLAG],
          ['arrow', ARROW],
        ]),
        idOf,
      ),
    ]);
    const data = pack();
    const kinds = [0, 1, 2].map((i) => readRowsInstance(data.instances, i).kind);
    expect(kinds).toEqual([ROWS_KIND.sprite, ROWS_KIND.sprite, ROWS_KIND.point]);
    const style = (row: number, texel: number) => {
      const n = data.rowStyles[row * 4];
      const at = n * ROWS_STYLE_FLOATS + texel * 4;
      return Array.from(data.palette.values.subarray(at, at + 4));
    };
    expect(style(0, 0)).toEqual([0.25, 0, 0.5, 0.5]);
    expect(style(0, 1)).toEqual([12, 8, -1, 0]);
    expect(style(1, 0)).toEqual([0, 0.5, 0.5, 1]);
    expect(style(1, 1)).toEqual([10, 10, -1, 1]);
    // The rotation of the row is held where the picture turns, as for a marker
    const steps = pointAngleSteps(30);
    expect(data.rowStyles[0 * 4 + 3]).toBe(0);
    expect(data.rowStyles[1 * 4 + 3]).toBe(steps);
    expect(data.rowStyles[2 * 4 + 3]).toBe(steps);
    // A picture that turns is told by its layout
    const layout = (row: number) => context.rowsStyles.layoutOf(data.rowStyles[row * 4]);
    expect(layout(0)).toBe(ROWS_LAYOUT.sprite);
    expect(layout(1)).toBe(ROWS_LAYOUT.sprite | ROWS_LAYOUT.turns);
    expect(data.pointCount).toBe(3);
  });

  it('gives two rows of the same picture one style', () => {
    const features = [feature('a', 'Point', [139.7, 35.6]), feature('b', 'Point', [139.71, 35.61])];
    const { pack } = setup(features, (idOf) => [
      sheetOf(
        new Map([
          ['a', FLAG],
          ['b', { ...FLAG }],
        ]),
        idOf,
      ),
    ]);
    const data = pack();
    expect(data.rowStyles[0]).toBe(data.rowStyles[4]);
  });
});
