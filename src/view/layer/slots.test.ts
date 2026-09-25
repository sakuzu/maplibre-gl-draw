// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { partitionLayerOrder, renderSlotLayerId, sameSegments } from './slots.js';

const isExternal = (id: string): boolean => id.startsWith('ext:');

describe('partitionLayerOrder', () => {
  it('the whole list becomes one segment when no predicate is given (as before)', () => {
    expect(partitionLayerOrder(['a', 'ext:x', 'b'])).toEqual([{ from: 0, to: 3 }]);
  });

  it('one segment when there is no separator', () => {
    expect(partitionLayerOrder(['a', 'b'], isExternal)).toEqual([{ from: 0, to: 2 }]);
  });

  it('splits per run between separators (a separator belongs to no segment)', () => {
    expect(partitionLayerOrder(['ext:x', 'a', 'ext:y', 'b', 'c', 'ext:z'], isExternal)).toEqual([
      { from: 1, to: 2 },
      { from: 3, to: 5 },
    ]);
  });

  it('creates no segment where separators are adjacent', () => {
    expect(partitionLayerOrder(['a', 'ext:x', 'ext:y', 'b'], isExternal)).toEqual([
      { from: 0, to: 1 },
      { from: 3, to: 4 },
    ]);
  });

  it('returns one empty segment even when nothing is drawn by us', () => {
    expect(partitionLayerOrder(['ext:x', 'ext:y'], isExternal)).toEqual([{ from: 0, to: 0 }]);
    expect(partitionLayerOrder([], isExternal)).toEqual([{ from: 0, to: 0 }]);
  });
});

describe('renderSlotLayerId / sameSegments', () => {
  it('the first slot keeps the previous id and later ones are numbered', () => {
    expect(renderSlotLayerId(0)).toBe('maplibre-gl-draw-layer');
    expect(renderSlotLayerId(2)).toBe('maplibre-gl-draw-layer:2');
  });

  it('equality of segment lists', () => {
    expect(sameSegments([{ from: 0, to: 1 }], [{ from: 0, to: 1 }])).toBe(true);
    expect(sameSegments([{ from: 0, to: 1 }], [{ from: 0, to: 2 }])).toBe(false);
    expect(sameSegments([], [{ from: 0, to: 0 }])).toBe(false);
  });
});
