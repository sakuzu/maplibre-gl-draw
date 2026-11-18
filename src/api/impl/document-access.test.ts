// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The layer over the Store takes no other path for another kind of Store: every row of the table
 * of what the instance does (src/parity/) keeps its record when each instance of a scene that
 * gives no Store of its own is given, in place of the in-memory Store of core, a Store of the
 * application made by spreading the members of the in-memory document Store into a plain object.
 */

import type { Map as MapLibreMap } from 'maplibre-gl';
import { describe, expect, it, vi } from 'vitest';
import type { Store as PublicStore } from '../extension/store.js';
import type { DrawOptions } from '../options.js';

/** The instances of the scenes that were given the spread Store */
const given = vi.hoisted(() => ({ count: 0 }));

vi.mock('../draw.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../draw.js')>();
  const { MemoryContractStore } = await import('../../store/memory.js');
  /** The in-memory document Store, its members spread into a plain object */
  const spreadStore = (): PublicStore => {
    const inner = new MemoryContractStore();
    const members = Object.getOwnPropertyNames(MemoryContractStore.prototype)
      .filter((key) => key !== 'constructor')
      .map((key) => {
        const member = (inner as unknown as Record<string, (...args: unknown[]) => unknown>)[key];
        return [key, member.bind(inner)] as const;
      });
    return { ...Object.fromEntries(members) } as unknown as PublicStore;
  };
  return {
    ...actual,
    createDraw: (map: MapLibreMap, options: DrawOptions = {}) => {
      if (options.store !== undefined) return actual.createDraw(map, options);
      given.count += 1;
      return actual.createDraw(map, { ...options, store: spreadStore() });
    },
  };
});

if (process.env.PARITY_RECORD === '1') {
  // The records are written by the table itself, over the in-memory Store of core
  describe('the table over a spread Store', () => {
    it('is compared with the records, not recorded', () => {
      expect(process.env.PARITY_RECORD).toBe('1');
    });
  });
} else {
  await import('../../parity/reads.test.js');
  await import('../../parity/writes.test.js');
  await import('../../parity/selection.test.js');
  await import('../../parity/hits.test.js');
  await import('../../parity/snapping.test.js');
  await import('../../parity/drag.test.js');
  await import('../../parity/events.test.js');
  await import('../../parity/client.test.js');
  await import('../../parity/extension.test.js');

  describe('the table over a spread Store', () => {
    it('gave the spread Store to the instances of the scenes', () => {
      expect(given.count).toBeGreaterThan(0);
    });
  });
}
