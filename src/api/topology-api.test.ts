// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the Topology API (draw.topology)
 *
 * Verifies that simultaneous movement of shared vertices can be toggled at run time from
 * the public API, that the toggle reaches the topology configuration of the Context (the
 * very object the drag-handler of the select mode looks at), and that it does not pollute
 * the object holding the defaults.
 */

import type { Map as MapLibreMap } from 'maplibre-gl';
import { describe, expect, it } from 'vitest';
import { DEFAULT_TOPOLOGY_CONFIG } from '../shared/config/topology.js';
import { createContext } from './context.js';
import { createTopologyApi } from './topology-api.js';

/** createContext only keeps the map, so an empty object is enough */
const DUMMY_MAP = {} as MapLibreMap;

describe('draw.topology', () => {
  it('is disabled by default (the default of core is shared vertices off)', () => {
    const { topology } = createTopologyApi({ topology: { sharedVertexDrag: false } });
    expect(topology.isSharedVertexDrag()).toBe(false);
  });

  it('can be toggled with setSharedVertexDrag', () => {
    const config = { sharedVertexDrag: false };
    const { topology } = createTopologyApi({ topology: config });

    topology.setSharedVertexDrag(true);
    expect(topology.isSharedVertexDrag()).toBe(true);

    topology.setSharedVertexDrag(false);
    expect(topology.isSharedVertexDrag()).toBe(false);
  });

  it('writes the toggle into the very topology configuration object of the Context', () => {
    const context = createContext(DUMMY_MAP);
    const { topology } = createTopologyApi({ topology: context.topology });

    topology.setSharedVertexDrag(true);
    // The object handed to the mode is the same one, so it takes effect from the next drag
    expect(context.topology.sharedVertexDrag).toBe(true);
  });

  it('does not pollute the object holding the defaults even with no option given', () => {
    const context = createContext(DUMMY_MAP);
    createTopologyApi({ topology: context.topology }).topology.setSharedVertexDrag(true);

    expect(DEFAULT_TOPOLOGY_CONFIG.sharedVertexDrag).toBe(false);
    // Another instance is not affected
    expect(createContext(DUMMY_MAP).topology.sharedVertexDrag).toBe(false);
  });

  it('inherits the initial value of options.topology', () => {
    const context = createContext(DUMMY_MAP, { topology: { sharedVertexDrag: true } });
    const { topology } = createTopologyApi({ topology: context.topology });

    expect(topology.isSharedVertexDrag()).toBe(true);
  });
});
