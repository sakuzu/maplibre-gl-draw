// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The reading of a selection of many features from the rows of the Store
 *
 * When more features are selected than the layer keeps features of (`FEATURES_KEPT`), the
 * selection UI is drawn from the rows: the frames of the rows on the GPU (`bulk-frames.ts`), and
 * the frame of all of them with its handles as for several features. This reads what that frame
 * needs from the rows selected, without making a feature of a row drawn by the drawing of the
 * rows: the box of all of them (the boxes of the rows, and the boxes of the features of the rows
 * framed from their features), whether one of them has an area (the handles are drawn only
 * then), whether one of them is locked (no handle is drawn then), and the row groups that hold
 * them.
 *
 * It is read again only when the selection changes, when the rows of the Store change, when the
 * rows are classified again, and when a layer or a group of the rows selected changes (its lock);
 * a frame that changes nothing reads nothing. The features made are those of the rows framed from
 * their features, once a reading.
 *
 * @internal
 */

import { type DrawnRows, pageRowBox, type RowGroup } from '../../store/built-in/drawn-rows.js';
import type { DocumentAccess } from '../../store/document-access.js';
import type { Feature, Group, Layer, Selection } from '../../store/types.js';
import type { BoundingBoxCoords, SelectionExtensionRegistry } from './selection-ui/index.js';
import { computeBoundingBox, hasZeroArea } from './selection-ui/index.js';

/**
 * What the frame of a selection of many features is drawn with
 *
 * @internal
 */
export interface ManySelection {
  /** The box of every feature selected (as `computeCombinedBoundingBox`), null for none */
  readonly bbox: BoundingBoxCoords | null;
  /** Whether a feature selected has a box with an area (the handles are drawn only then) */
  readonly hasArea: boolean;
  /** Whether a feature selected is locked, by itself, by its group or by its layer */
  readonly locked: boolean;
  /** The row groups (and the parts of the deltas) that hold a row selected */
  readonly groups: ReadonlySet<RowGroup>;
  /** The longest side of the box of a row selected, in Mercator units */
  readonly longestSide: number;
}

/**
 * What the reading asks of the drawing: which rows are framed from their features
 *
 * @internal
 */
export interface ManySelectionRows {
  readonly reader: DrawnRows;
  /** Whether the frame of a row of a type is drawn from its feature */
  framedByFeature(type: string, group: RowGroup, row: number): boolean;
  /** The layer of a row group drawn (undefined for a group not drawn) */
  layerOf(group: RowGroup): string | undefined;
  /** Changes whenever the rows are classified again (which rows are framed from their features) */
  readonly classification: string;
  /** The registrations of the selection UI (the boxes of the custom types) */
  readonly extensions: SelectionExtensionRegistry;
}

/** What a reading was made from, to tell whether it is still the reading of the frame */
interface ReadKey {
  readonly type: Selection['type'];
  readonly ids: unknown;
  readonly revision: number;
  readonly classification: string;
  /** The layers and the groups of the rows selected, as they were read */
  readonly layers: ReadonlyMap<string, Layer | undefined>;
  readonly groups: ReadonlyMap<string, Group | undefined>;
}

/**
 * The reading of the selection of an instance: the number of features selected, and what the
 * frame of a selection of many features is drawn with, kept while nothing they come from changes
 *
 * @internal
 */
export class SelectedRows {
  #count: { type: Selection['type']; ids: unknown; revision: number; count: number } | null = null;
  #read: { key: ReadKey; value: ManySelection } | null = null;
  /** The readings made, counted for the tests */
  readings = 0;

  /**
   * The number of features selected: the IDs of a selection of features, the members of the
   * groups or the rows of the layers selected (read once per selection and change of the rows)
   */
  countOf(store: DocumentAccess, reader: DrawnRows): number {
    const selection = store.getSelection();
    const known = this.#count;
    if (
      known &&
      known.type === selection.type &&
      known.ids === selection.ids &&
      known.revision === reader.revision
    ) {
      return known.count;
    }
    let count = 0;
    switch (selection.type) {
      case 'feature':
        count = selection.ids.count();
        break;
      case 'group':
        for (const id of selection.ids.iterate()) {
          count += store.getGroup(id)?.featureIds?.length ?? 0;
        }
        break;
      case 'layer':
        for (const id of selection.ids.iterate()) count += reader.table(id)?.rowCount ?? 0;
        break;
      default:
        break;
    }
    this.#count = { type: selection.type, ids: selection.ids, revision: reader.revision, count };
    return count;
  }

  /** What the frame of the selection of many features is drawn with (read again on a change) */
  read(store: DocumentAccess, rows: ManySelectionRows): ManySelection {
    const selection = store.getSelection();
    const kept = this.#read;
    if (kept && this.#same(kept.key, store, selection, rows)) return kept.value;
    const read = readSelectedRows(store, selection, rows);
    this.readings++;
    this.#read = read;
    return read.value;
  }

  /** Forgets what was read */
  clear(): void {
    this.#count = null;
    this.#read = null;
  }

  #same(key: ReadKey, store: DocumentAccess, selection: Selection, rows: ManySelectionRows) {
    if (key.type !== selection.type || key.ids !== selection.ids) return false;
    if (key.revision !== rows.reader.revision || key.classification !== rows.classification) {
      return false;
    }
    for (const [id, layer] of key.layers) if (store.getLayer(id) !== layer) return false;
    for (const [id, group] of key.groups) if (store.getGroup(id) !== group) return false;
    return true;
  }
}

/** Reads the rows selected */
function readSelectedRows(
  store: DocumentAccess,
  selection: Selection,
  rows: ManySelectionRows,
): { key: ReadKey; value: ManySelection } {
  const reader = rows.reader;
  const layers = new Map<string, Layer | undefined>();
  const groupsRead = new Map<string, Group | undefined>();
  const groups = new Set<RowGroup>();
  const box = new Float64Array(4);
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let hasArea = false;
  let locked = false;
  let longestSide = 0;
  const widen = (x0: number, y0: number, x1: number, y1: number): void => {
    if (x0 < minX) minX = x0;
    if (y0 < minY) minY = y0;
    if (x1 > maxX) maxX = x1;
    if (y1 > maxY) maxY = y1;
  };
  const layerLocked = (layerId: string | undefined): boolean => {
    if (layerId === undefined) return false;
    if (!layers.has(layerId)) layers.set(layerId, store.getLayer(layerId));
    return layers.get(layerId)?.locked === true;
  };
  const groupLocked = (groupId: string | undefined): boolean => {
    if (groupId === undefined) return false;
    if (!groupsRead.has(groupId)) groupsRead.set(groupId, store.getGroup(groupId));
    return groupsRead.get(groupId)?.locked === true;
  };
  const visit = (group: RowGroup, row: number, layerId: string | undefined): void => {
    if (reader.notDrawn(group, row) || !reader.hasGeometry(group, row)) return;
    groups.add(group);
    if (!locked) {
      locked =
        reader.lockedOf(group, row) ||
        groupLocked(reader.groupIdOf(group, row)) ||
        layerLocked(layerId ?? rows.layerOf(group));
    }
    const type = reader.typeOf(group, row);
    if (rows.framedByFeature(type, group, row)) {
      const id = reader.idOf(reader.refOf(group, row));
      const feature: Feature | undefined = id === undefined ? undefined : store.getFeature(id);
      const bbox = feature ? computeBoundingBox(feature, rows.extensions) : null;
      if (!bbox) return;
      for (const [x, y] of [bbox.topLeft, bbox.topRight, bbox.bottomRight, bbox.bottomLeft]) {
        widen(x, y, x, y);
      }
      if (!hasZeroArea(bbox)) hasArea = true;
      return;
    }
    if (!pageRowBox(group.data, row, box)) return;
    if (type !== 'Point' && type !== 'Circle' && box.every((value) => value === 0)) return;
    widen(box[0], box[1], box[2], box[3]);
    if (box[0] !== box[2] || box[1] !== box[3]) hasArea = true;
    const width = (box[2] - box[0]) / 360;
    const height = Math.abs(mercatorY(box[3]) - mercatorY(box[1]));
    if (width > longestSide) longestSide = width;
    if (height > longestSide) longestSide = height;
  };
  const visitRef = (ref: number): void => {
    const place = reader.placeOf(ref);
    if (place) visit(place.group, place.row, undefined);
  };

  switch (selection.type) {
    case 'feature': {
      const refs = store.rowsOfFeatureSet(selection.ids);
      for (let i = 0; i < refs.length; i++) visitRef(refs[i]);
      break;
    }
    case 'group':
      for (const id of selection.ids.iterate()) {
        const group = store.getGroup(id);
        if (!group) continue;
        groupsRead.set(id, group);
        layerLocked(group.layerId);
        for (const ref of reader.membersOf(group.layerId, id)) visitRef(ref);
      }
      break;
    case 'layer':
      for (const layerId of selection.ids.iterate()) {
        const table = reader.table(layerId);
        if (!table) continue;
        for (let g = 0; g < table.groupCount; g++) {
          const group = table.groupAt(g);
          for (let row = 0; row < group.data.length; row++) visit(group, row, layerId);
        }
        for (const part of reader.deltaParts(table)) {
          const gone = part.gone;
          for (let row = 0; row < part.group.data.length; row++) {
            if (gone?.[row] === 1) continue;
            visit(part.group, row, layerId);
          }
        }
      }
      break;
    default:
      break;
  }

  const bbox: BoundingBoxCoords | null = Number.isFinite(minX)
    ? {
        topLeft: [minX, maxY],
        topRight: [maxX, maxY],
        bottomRight: [maxX, minY],
        bottomLeft: [minX, minY],
        center: [(minX + maxX) / 2, (minY + maxY) / 2],
      }
    : null;
  return {
    key: {
      type: selection.type,
      ids: selection.ids,
      revision: reader.revision,
      classification: rows.classification,
      layers,
      groups: groupsRead,
    },
    value: { bbox, hasArea, locked, groups, longestSide },
  };
}

/** The Web Mercator y of a latitude (the world is 1 high) */
function mercatorY(lat: number): number {
  const latRad = (lat * Math.PI) / 180;
  return (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2;
}
