// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it } from 'vitest';
import { check, digestOfValue, rowDigests } from '../parity-records.mjs';
import { cleanUp, tree, write } from './fixture.mjs';

afterEach(cleanUp);

/** The lines of a record file: a scene and its rows */
const lines = (scene, rows) =>
  `${[
    JSON.stringify({ scene, uses: ['FeaturesCollection.get'] }),
    ...Object.entries(rows).map(([view, value]) =>
      JSON.stringify({ row: `${scene} | ${view}`, value }),
    ),
  ].join('\n')}\n`;

const RECORDED = {
  'features.get pt': { value: { id: 'pt', visible: true }, events: [] },
  'features.get ln': { value: { id: 'ln', visible: true }, events: [['feature.updated']] },
};

const records = (scenes) =>
  Object.entries(scenes)
    .map(([scene, rows]) => lines(scene, rows))
    .join('');

describe('the gate of the records of the table', () => {
  const base = () =>
    tree({
      'scripts/gates/parity-baseline.json': {
        commit: 'abc',
        rows: { reads: Object.fromEntries(rowDigests(records(RECORDED))) },
      },
      'src/parity/marks.json': {
        marks: {
          reads: {
            'features.get ln | value': { changes: [30], after: '30: the value after the change' },
          },
        },
      },
      'src/parity/records/reads.jsonl': records(RECORDED),
    });

  it('passes on the records of the baseline, and on rows added to them', () => {
    const root = base();
    expect(check({ root }).errors).toEqual([]);
    write(root, {
      'src/parity/records/reads.jsonl': records({
        ...RECORDED,
        'features.get pg': { value: { id: 'pg' } },
      }),
    });
    expect(check({ root }).errors).toEqual([]);
  });

  it('reads a value whatever the order of its keys', () => {
    expect(digestOfValue({ a: 1, b: [2, { c: 3, d: 4 }] })).toBe(
      digestOfValue({ b: [2, { d: 4, c: 3 }], a: 1 }),
    );
    expect(digestOfValue([1, 2])).not.toBe(digestOfValue([2, 1]));
  });

  it('fails when the value of a row without a mark changes', () => {
    const root = base();
    write(root, {
      'src/parity/records/reads.jsonl': records({
        ...RECORDED,
        'features.get pt': { value: { id: 'pt', visible: false }, events: [] },
      }),
    });
    expect(check({ root }).errors).toEqual([
      'src/parity/records/reads.jsonl: the value of the row "features.get pt | value" is not the one of scripts/gates/parity-baseline.json, and src/parity/marks.json has no mark for it',
    ]);
  });

  it('fails when a row without a mark is removed', () => {
    const root = base();
    write(root, {
      'src/parity/records/reads.jsonl': records({
        'features.get pt': { value: { id: 'pt', visible: true } },
        'features.get ln': RECORDED['features.get ln'],
      }),
    });
    expect(check({ root }).errors).toEqual([
      'src/parity/records/reads.jsonl no longer records the row "features.get pt | events" of scripts/gates/parity-baseline.json',
    ]);
  });

  it('passes when the value of a row with a mark changes', () => {
    const root = base();
    write(root, {
      'src/parity/records/reads.jsonl': records({
        ...RECORDED,
        'features.get ln': { value: { id: 'ln' }, events: [['feature.updated']] },
      }),
    });
    const r = check({ root });
    expect(r.errors).toEqual([]);
    expect(r.notes).toEqual(['1 marked rows have a value of their change']);
  });
});
