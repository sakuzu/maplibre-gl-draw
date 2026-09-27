// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/// <reference types="node" />

/**
 * Public surface check
 *
 * Confirms that the subpath entry exports exactly the public functions and constants, and
 * nothing of the internal helpers. Running in a node environment without a DOM is itself the
 * guarantee of being independent of maplibre and the DOM.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as geometry from './index.js';

/** The values the entry exports, by section */
const EXPECTED_VALUES = [
  // Measure
  'distance',
  'bearing',
  'destination',
  'midpoint',
  'along',
  'nearestPointOnLine',
  'length',
  'area',
  'perimeter',
  'centroid',
  'pointOnSurface',
  // Create
  'circle',
  'buffer',
  // Combine
  'union',
  'intersection',
  'difference',
  'split',
  // Test
  'pointInPolygon',
  'overlaps',
  'contains',
  'bboxIntersects',
  'bboxContains',
  // Repair
  'makeValid',
  'rewind',
  'simplify',
  // Bounds and units
  'bbox',
  'metersToDegrees',
  // Types and errors
  'EARTH_RADIUS_METERS',
  'GeometryError',
];

/** The types the entry exports */
const EXPECTED_TYPES = ['BBox', 'GeometryErrorCode'];

/** The names in the export statements of the entry, types included */
function exportedNames(): string[] {
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'index.ts'), 'utf8');
  const names: string[] = [];
  for (const match of source.matchAll(/^export (?:type )?\{([^}]*)\} from/gm)) {
    names.push(
      ...match[1]
        .split(',')
        .map((name) => name.trim())
        .filter((name) => name.length > 0),
    );
  }
  return names;
}

describe('public surface of geometry', () => {
  it('exports exactly the public values', () => {
    expect(Object.keys(geometry).sort()).toEqual([...EXPECTED_VALUES].sort());
  });

  it('exports exactly the public names, types included', () => {
    const expected = [...EXPECTED_VALUES, ...EXPECTED_TYPES].sort();
    expect(exportedNames().sort()).toEqual(expected);
    expect(expected).toHaveLength(31);
  });

  it('can compute without using the DOM', () => {
    expect(typeof globalThis.document).toBe('undefined');
    const result = geometry.buffer({ type: 'Point', coordinates: [139.7, 35.6] }, 100);
    expect(result?.type).toBe('Polygon');
  });
});
