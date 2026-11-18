// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The tables of the built-in Store as the Store hands them out (`FeatureTables`, and a
 * `LayerTableView` per layer): the reads of the rows of the tables of the document, in the words
 * of the features.
 *
 * Each read reads only what it is asked for, from the rows it is given or finds: no feature, and
 * no object per row, is made. A row is named by its reference, which the tables give it and keep
 * whatever group, layer or place it moves to. The numbers of the work count the rows each read
 * touches and the objects it hands out.
 *
 * An error of the tables is thrown as a `DrawError` of the same code.
 *
 * @internal
 */

import { KasaneError, type RowField, type TableView } from '@sakuzu/kasane';
import type { FeatureStyle, FeatureType } from '../../api/model.js';
import { DrawError } from '../../shared/errors.js';
import { countWork } from '../../shared/work-counts.js';
import { layerOfParent, positionsOf, type StoreDocument } from './document.js';
import { geometryColumnOf } from './geometry-column.js';
import type {
  FeatureRowField,
  FeatureTables,
  ItemRefs,
  LayerTableView,
  RowCursor,
  RowRef,
  RowValues,
  TableScanOptions,
} from './types.js';

/** The fields of a row read as they are named in the tables, by their names here */
const PLAIN_FIELDS: ReadonlyMap<string, string> = new Map([
  ['type', 'type'],
  ['locked', 'locked'],
  ['style', 'style'],
  ['parent', 'parent'],
  ['orderKey', 'key'],
]);

/** The start of the fields of the attributes */
const PROPERTY_FIELD = 'properties:';

/** The start of the fields of the keys of the style */
const STYLE_KEY_FIELD = 'style:';

/**
 * Runs a read of the tables, throwing an error of the tables as a `DrawError` of the same code
 */
function read<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    if (error instanceof KasaneError) throw new DrawError(error.code, error.message, error);
    throw error;
  }
}

/**
 * The tables of the rows of a document, as the Store hands them out
 *
 * @internal
 */
export function featureTablesOf(document: StoreDocument): FeatureTables {
  const { rows, rowWrites, counts } = document;
  const views = new WeakMap<TableView, LayerTableView>();

  /** The values of fields of one row, read alone, with the layer it is in */
  const readRow = (ref: RowRef, fields: readonly RowField[], geometry = false) => {
    const values = rows.readValues(
      Int32Array.of(ref),
      ['parent', ...fields],
      geometry ? { shapes: 'columns' } : undefined,
    );
    countWork(counts, 'rowsTouched');
    return { layerId: layerOfParent(document, values.fields.get('parent')?.[0]), values };
  };

  const viewOf = (view: TableView): LayerTableView => {
    const layerId = view.tableId;
    const touched = (refs: Int32Array): Int32Array => {
      countWork(counts, 'rowsTouched', refs.length);
      return refs;
    };
    return {
      layerId,
      get rowCount() {
        return read(() => view.rowCount);
      },
      get itemCount() {
        return read(() => view.itemCount);
      },
      listDrawnRows: (bbox) => read(() => touched(view.listVisibleRows(bbox))),
      getDrawnRowsRevision: () => read(() => view.getVisibleRowsVersion()),
      getRowBBox: (ref) =>
        read(() => {
          countWork(counts, 'rowsTouched');
          return view.getRowBBox(ref);
        }),
      getRowType: (ref) =>
        read(() => {
          const row = readRow(ref, ['type']);
          if (row.layerId !== layerId) return null;
          return (row.values.fields.get('type')?.[0] as FeatureType | undefined) ?? null;
        }),
      getPointPosition: (ref) =>
        read(() => {
          const row = readRow(ref, ['geometry'], true);
          const shapes = row.values.shapes?.get('geometry');
          if (row.layerId !== layerId || !shapes || shapes.formIndex[0] < 0) return null;
          const form = shapes.forms[shapes.formIndex[0]];
          if (form.name !== 'Point' || form.depth !== 0) return null;
          const at = shapes.formRow[0] * shapes.dimensions.length;
          return [form.points[at], form.points[at + 1]];
        }),
      getRowProperty: (ref, key) =>
        read(() => {
          const field = `${PROPERTY_FIELD}${key}`;
          const row = readRow(ref, [field]);
          return row.layerId === layerId ? row.values.fields.get(field)?.[0] : undefined;
        }),
      getRowStyle: (ref) =>
        read(() => {
          const row = readRow(ref, ['style']);
          if (row.layerId !== layerId) return undefined;
          return row.values.fields.get('style')?.[0] as Readonly<FeatureStyle> | undefined;
        }),
      listRowRefs: (start, count) => read(() => touched(view.listRowRefs(start, count))),
      listItemRefs: (start, count): ItemRefs =>
        read(() => {
          const items = view.listItems(start, count);
          countWork(counts, 'rowsTouched', items.refs.length);
          countWork(counts, 'objectsCreated');
          return { kinds: items.types, refs: items.refs };
        }),
      countGroupMembers: (groupRef) => read(() => view.countGroupMembers(groupRef)),
      listGroupMembers: (groupRef, start, count) =>
        read(() => touched(view.listGroupMembers(groupRef, start, count))),
    };
  };

  const readValues: FeatureTables['readValues'] = (refs, fields, options) =>
    read(() => {
      // The fields of the tables, in the order asked, and how each is read back
      const asked: string[] = [];
      let geometry = false;
      for (const field of fields) {
        const plain = PLAIN_FIELDS.get(field);
        if (plain !== undefined) asked.push(plain);
        else if (field === 'visible') asked.push('hidden');
        else if (field === 'geometry') geometry = true;
        else if (field.startsWith(PROPERTY_FIELD) && field.length > PROPERTY_FIELD.length) {
          asked.push(field);
        } else if (field.startsWith(STYLE_KEY_FIELD)) {
          throw new DrawError(
            'invalidInput',
            `${JSON.stringify(field)}: a key of the style is not read on its own; read the field style`,
          );
        } else {
          throw new DrawError('invalidInput', `${JSON.stringify(field)} is not a field of a row`);
        }
      }
      const found = rows.readValues(
        refs,
        [
          'parent',
          ...asked,
          ...(geometry ? ['geometry'] : []),
          ...(options?.deleted ? ['deleted'] : []),
        ],
        geometry ? { shapes: 'columns' } : undefined,
      );
      countWork(counts, 'rowsTouched', refs.length);

      // The rows are those of one layer
      let layerId: string | undefined;
      const parents = found.fields.get('parent') ?? [];
      for (let i = 0; i < parents.length; i++) {
        const layer = layerOfParent(document, parents[i]);
        if (layer === undefined) continue;
        if (layerId === undefined) layerId = layer;
        else if (layer !== layerId) {
          throw new DrawError(
            'invalidInput',
            `readValues: the rows are in more than one layer (${JSON.stringify(layerId)} and ${JSON.stringify(layer)})`,
          );
        }
      }

      const out = new Map<FeatureRowField, readonly unknown[]>();
      for (const field of fields) {
        if (field === 'geometry' || out.has(field)) continue;
        if (field === 'visible') {
          const hidden = found.fields.get('hidden') ?? [];
          const visible = new Array<unknown>(hidden.length);
          for (let i = 0; i < hidden.length; i++) {
            visible[i] = hidden[i] === undefined ? undefined : hidden[i] !== true;
          }
          out.set(field, visible);
        } else {
          out.set(field, found.fields.get(PLAIN_FIELDS.get(field) ?? field) ?? []);
        }
      }
      const valuesPerPosition =
        layerId === undefined ? 2 : positionsOf(document, layerId).valuesPerPosition;
      const values: RowValues = {
        rows: found.rows,
        fields: out,
        ...(geometry && {
          geometry: geometryColumnOf(found.shapes?.get('geometry'), refs.length, valuesPerPosition),
        }),
        ...(found.deleted && { deleted: found.deleted }),
      };
      // The values, the map of the fields and an array per field; the geometry and its arrays
      countWork(counts, 'objectsCreated', 2 + out.size + (geometry ? 6 : 0));
      return values;
    });

  return {
    get: (layerId) =>
      read(() => {
        const view = rows.get(layerId);
        if (!view) return undefined;
        let out = views.get(view);
        if (!out) {
          out = viewOf(view);
          views.set(view, out);
        }
        return out;
      }),
    getRowRef: (id) => read(() => rows.getRowRef(id)),
    findRow: (id) =>
      read(() => {
        const row = rowWrites.lookup(id);
        return row ? { ref: row.row, deleted: row.deleted } : undefined;
      }),
    getRowId: (ref) => read(() => rows.getRowId(ref)),
    findGroup: (id) => read(() => rows.getGroupRef(id)),
    getGroupId: (groupRef) => read(() => rows.getGroupId(groupRef)),
    getValuesPerPosition: (layerId) =>
      document.layers.has(layerId) ? positionsOf(document, layerId).valuesPerPosition : undefined,
    getThirdValue: (layerId) => {
      if (!document.layers.has(layerId)) return undefined;
      const positions = positionsOf(document, layerId);
      if (positions.valuesPerPosition === 2) return undefined;
      return positions.valuesPerPosition === 4 ? 'height' : positions.thirdValue;
    },
    scan: (options?: TableScanOptions): RowCursor =>
      read(() => {
        const batches = rows.scan({
          ...(options?.layerIds && { tableIds: options.layerIds }),
          ...(options?.bbox && { bbox: options.bbox }),
          ...(options?.batchSize !== undefined && { batchSize: options.batchSize }),
        });
        return {
          next: () =>
            read(() => {
              const batch = batches.next();
              if (batch.done) return null;
              countWork(counts, 'rowsTouched', batch.value.length);
              return batch.value;
            }),
        };
      }),
    readValues,
  };
}
