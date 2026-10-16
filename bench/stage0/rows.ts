// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The rows of a decoded segment as the builder of the row blocks takes them
 * (`createRowBlockBuilder`): the tables take an id and a key of the order per row as strings, so
 * they are made here from the runs of the segment.
 *
 * - The id of a row is its client in Crockford's base 32 (13 characters) and its serial in
 *   decimal, joined by a hyphen
 * - The key of a row is the key of the head of its run and its number in the run, padded to a
 *   fixed width, so that the keys compare in the order of the rows
 */

import type { RowInput } from '@sakuzu/maplibre-gl-draw/kasane';
import type { ItemId, SegmentRows } from './codec.ts';

const CROCKFORD = '0123456789abcdefghjkmnpqrstvwxyz';

/** A client of 16 hex digits in Crockford's base 32 (13 characters) */
export function clientText(client: string): string {
  let v = BigInt(`0x${client}`);
  let out = '';
  for (let i = 0; i < 13; i++) {
    out = CROCKFORD[Number(v & 31n)] + out;
    v >>= 5n;
  }
  return out;
}

/** The id of an item as text */
export function idText(id: ItemId, clientTexts?: Map<string, string>): string {
  let c = clientTexts?.get(id.client);
  if (c === undefined) {
    c = clientText(id.client);
    clientTexts?.set(id.client, c);
  }
  return `${c}-${id.serial}`;
}

/** The digits of the number of a row in its key (10^9 rows in a run) */
const ROW_DIGITS = 9;

/** The key of the order of the row `row` of the run of the head `head` */
export function rowKey(head: string, row: number): string {
  return head + String(row).padStart(ROW_DIGITS, '0');
}

/** The rows of a segment for the builder (the deleted rows are kept, flagged) */
export function rowInputsOf(segment: SegmentRows, clientTexts = new Map<string, string>()) {
  const out: RowInput[] = new Array(segment.ids.length);
  const { head, firstRow } = segment.place;
  for (let i = 0; i < out.length; i++) {
    const geometry = segment.geometries[i];
    out[i] = {
      id: idText(segment.ids[i], clientTexts),
      type: geometry?.type ?? 'Point',
      geometry,
      order: rowKey(head, firstRow + i),
      style: segment.styles[i],
      properties: segment.properties[i],
      ...(segment.deleted[i] && { deleted: true }),
    };
  }
  return out;
}
