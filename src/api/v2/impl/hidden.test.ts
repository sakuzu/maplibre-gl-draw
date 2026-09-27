// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for draw.hidden: hiding in this client only
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryStore } from '../../../store/memory.js';
import type { StateChanges } from '../../../store/types.js';
import { DrawError } from '../errors.js';
import type { HiddenCollection } from '../hidden.js';
import { createHidden } from './hidden.js';

let store: MemoryStore;
let hidden: HiddenCollection;
let notifications: StateChanges[];

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    if (error instanceof DrawError) return error.code;
    throw error;
  }
  return undefined;
}

beforeEach(() => {
  store = new MemoryStore();
  store.createLayer({
    id: 'l1',
    name: 'l1',
    visible: true,
    locked: false,
    opacity: 1,
    items: [],
    styleRule: undefined,
    metadata: undefined,
  });
  for (const id of ['a', 'b']) {
    store.createFeature({
      id,
      type: 'Point',
      geometry: { type: 'Point', coordinates: [0, 0] },
      layerId: 'l1',
      groupId: undefined,
      properties: {},
      style: {},
      visible: true,
      locked: false,
    });
  }
  hidden = createHidden({ store });
  notifications = [];
  store.subscribe((changes) => notifications.push(changes));
});

describe('draw.hidden', () => {
  it('hides a feature or a layer, and reads it back', () => {
    hidden.add('a');
    hidden.add('l1');
    expect(hidden.get('a')).toBe(true);
    expect(hidden.has('l1')).toBe(true);
    expect(hidden.get('b')).toBe(false);
    expect([...hidden.list()].sort()).toEqual(['a', 'l1']);
    expect(hidden.count()).toBe(2);
    expect(store.getFeature('a')?.visible).toBe(true);
  });

  it('throws not-found for an ID that is not in the document', () => {
    expect(codeOf(() => hidden.add('x'))).toBe('not-found');
    expect(codeOf(() => hidden.addMany(['a', 'x']))).toBe('not-found');
    expect(codeOf(() => hidden.remove('x'))).toBe('not-found');
    expect(hidden.count()).toBe(0);
  });

  it('hides several in one notification', () => {
    hidden.addMany(['a', 'b']);
    expect(hidden.count()).toBe(2);
    expect(notifications).toHaveLength(1);
  });

  it('shows what it hid, and returns false for what it did not hide', () => {
    hidden.addMany(['a', 'b']);
    expect(hidden.remove('a')).toBe(true);
    expect(hidden.remove('a')).toBe(false);
    expect(hidden.removeMany(['a', 'l1'])).toBe(false);
    expect(hidden.removeMany(['a', 'b'])).toBe(true);
    expect(hidden.count()).toBe(0);
  });

  it('clears everything, and still hides while read-only', () => {
    store.setReadOnly(true);
    hidden.addMany(['a', 'l1']);
    expect(hidden.count()).toBe(2);
    hidden.clear();
    expect(hidden.list()).toEqual([]);
  });
});
