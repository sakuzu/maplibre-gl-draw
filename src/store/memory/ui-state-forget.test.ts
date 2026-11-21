// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The state of this client lets go of a set of IDs at once (`ClientState.forgetAll`, what the end
 * of a deletion written in parts calls): the IDs that no longer name anything leave the
 * selection, the editing and the hidden items in one change of each, and the work is that of the
 * IDs held and given, not of the one times the other
 */

import { describe, expect, it } from 'vitest';
import type { IdSet } from '../../api/model.js';
import { WORK_SIZES } from '../../test-utils.js';
import type { Feature, Group, Layer } from '../types.js';
import { type ClientChange, ClientState } from './ui-state.js';

/** A set of IDs, in order, each once, as the layer the state is attached to makes them */
function setOf(ids: Iterable<string>): IdSet {
  const list = [...new Set(ids)];
  const lookup = new Set(list);
  return {
    count: () => list.length,
    has: (id) => lookup.has(id),
    iterate: () => list[Symbol.iterator](),
    toArray: () => [...list],
  };
}

/** A state of this client over a document of the IDs given, which counts what it is asked */
function stateOver(ids: Set<string>) {
  const asked = { count: 0 };
  const state = new ClientState();
  const document = {
    getFeature: (id: string) => {
      asked.count += 1;
      return ids.has(id) ? ({ id, layerId: 'l', visible: true } as unknown as Feature) : undefined;
    },
    getGroup: (_id: string): Group | undefined => undefined,
    getLayer: (id: string) =>
      id === 'l' ? ({ id: 'l', visible: true, locked: false } as unknown as Layer) : undefined,
    listLayers: () => [{ id: 'l', visible: true, locked: false } as unknown as Layer],
    idSetOf: (_type: string, given: Iterable<string> | IdSet) =>
      setOf(Symbol.iterator in given ? given : given.iterate()),
    idSetWithout: (_type: string, set: IdSet, leaves: (id: string) => boolean) =>
      setOf([...set.iterate()].filter((id) => !leaves(id))),
    shownFeatureSetOf: (set: IdSet) => set,
  };
  const told: ClientChange[] = [];
  state.attach({
    document: document as never,
    merge: () => {},
    transact: (fn) => fn(),
  });
  state.subscribe((change) => told.push(change));
  return { state, asked, told };
}

describe('ClientState.forgetAll', () => {
  it('takes the IDs that name nothing out of the selection, the editing and the hidden items, in one change', () => {
    const alive = new Set(['a', 'b', 'c', 'd']);
    const { state, told } = stateOver(alive);
    state.setSelection('feature', ['a', 'b', 'c']);
    state.startEditing(['a', 'c']);
    state.setLocallyHidden('d', true);
    told.length = 0;
    alive.delete('a');
    alive.delete('d');
    // `b` is given but still there: it stays
    state.forgetAll(new Set(['a', 'b', 'd']));
    expect({ type: state.getSelection().type, ids: state.getSelection().ids.toArray() }).toEqual({
      type: 'feature',
      ids: ['b', 'c'],
    });
    expect(state.getEditingIds()).toEqual(['c']);
    expect(state.isHidden('d')).toBe(false);
    expect(told).toHaveLength(1);
    expect(told[0].selection?.ids.toArray()).toEqual(['b', 'c']);
  });

  it('asks of the document as many IDs as it holds and is given, for 10,000 selected and deleted as for 1,000', () => {
    const asked: number[] = [];
    for (const size of [WORK_SIZES.small, WORK_SIZES.large]) {
      const ids = Array.from({ length: size }, (_, i) => `f${i}`);
      const alive = new Set(ids);
      const { state, asked: count, told } = stateOver(alive);
      state.setSelection('feature', ids);
      told.length = 0;
      alive.clear();
      count.count = 0;
      state.forgetAll(new Set(ids));
      expect(state.getSelection().ids.toArray()).toEqual([]);
      expect(told).toHaveLength(1);
      asked.push(count.count);
    }
    // In proportion to the IDs: 10 times as many IDs, at most twice 10 times as many questions
    const sizes = WORK_SIZES.large / WORK_SIZES.small;
    expect(asked[1] / asked[0]).toBeLessThan(sizes * 2);
    expect(asked[0]).toBeLessThanOrEqual(WORK_SIZES.small * 2);
  });
});
