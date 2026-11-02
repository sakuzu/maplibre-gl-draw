// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Verification of the structure of the pixel shader of the analytic drape
 *
 * GLSL cannot be run on its own, so only the structure that must be kept is
 * watched at the level of the string. Just one thing is pinned down here: the
 * convention that the selection highlight is composed outside the scan (at the end
 * of the pixel).
 *
 * Composing it inside the scan buries the highlight under the fill of the features
 * stacked above the selected one. It actually showed up in the form where
 * selecting a prefecture and zooming in makes the municipalities appear and the
 * red disappear. The immediate mode always overpainted the selection last, so the
 * drape is aligned with that convention too.
 */

import { describe, expect, it } from 'vitest';
import { TERRAIN_ATLAS_TEXTURE_UNIT } from '../state.js';
import {
  DRAPE_EDGE_START_UNIT,
  DRAPE_FRAGMENT_SOURCE,
  DRAPE_RANK_UNIT,
  EDGE_UNITS,
  ROWS_DRAPE_FRAGMENT_SOURCE,
} from './renderer.js';

/** The starting position of the scan (the run loop) */
const loopStart = DRAPE_FRAGMENT_SOURCE.indexOf('for (int r = 0');

/** The position where the selection highlight is actually composed */
const blendAt = DRAPE_FRAGMENT_SOURCE.indexOf('acc = over(acc, u_selection_color');

describe('the pixel shader of the drape', () => {
  it('does not compose the selection highlight inside the scan', () => {
    expect(loopStart).toBeGreaterThan(0);
    expect(blendAt).toBeGreaterThan(0);

    // What is accumulated inside the scan is only the coverage (max)
    const loopBody = DRAPE_FRAGMENT_SOURCE.slice(loopStart, blendAt);
    expect(loopBody).toContain('selFill = max(');
    expect(loopBody).toContain('selStroke = max(');
    expect(loopBody).not.toContain('acc = over(acc, u_selection_color');
  });

  it('composes the selection highlight after the fill and the outline', () => {
    const fillAt = DRAPE_FRAGMENT_SOURCE.indexOf('acc = over(acc, fill.rgb');
    const strokeAt = DRAPE_FRAGMENT_SOURCE.indexOf('acc = over(acc, stroke.rgb');
    expect(fillAt).toBeGreaterThan(0);
    expect(strokeAt).toBeGreaterThan(0);
    expect(blendAt).toBeGreaterThan(fillAt);
    expect(blendAt).toBeGreaterThan(strokeAt);
  });

  it('reads the selection mark from the selection texel of the style table', () => {
    expect(DRAPE_FRAGMENT_SOURCE).toContain('bool selected');
    expect(DRAPE_FRAGMENT_SOURCE).toContain('u_selection_stroke_extra');
  });

  it('range drawing: fill and outline inside the range, selection coverage from outside', () => {
    // The composition of the fill and the outline is gated by paints
    expect(DRAPE_FRAGMENT_SOURCE).toContain('if (paints && ');
    expect(DRAPE_FRAGMENT_SOURCE).toContain('if (paints && halfWidth > 0.0');
    // Even outside the range, selected elements are not skipped (to accumulate the
    // coverage)
    expect(DRAPE_FRAGMENT_SOURCE).toContain('if (!paints && !selected) continue;');
    // Only the final segment composes the selection highlight
    expect(DRAPE_FRAGMENT_SOURCE).toContain('u_emit_selection > 0.5 && selFill > 0.0');
    expect(DRAPE_FRAGMENT_SOURCE).toContain('u_emit_selection > 0.5 && selStroke > 0.0');
  });
});

describe('the texture units of the edge DEMs', () => {
  it('does not collide with the resident unit of the DEM atlas', () => {
    // The DEM atlas is bound at the head of the frame and stays resident on unit 6,
    // and every renderer of the vertex displacement path reads it. Overwriting it
    // makes whatever is drawn after the drape rendering (such as a preview being
    // drawn) fly off screen with a broken elevation
    for (const unit of Object.values(EDGE_UNITS)) {
      expect(unit).not.toBe(TERRAIN_ATLAS_TEXTURE_UNIT);
    }
  });

  it('does not duplicate between the edges either', () => {
    const units = Object.values(EDGE_UNITS);
    expect(new Set(units).size).toBe(units.length);
  });

  it('leaves a unit of its own to the starts of the edges along their paths', () => {
    // Units 0 to 4 hold the DEM of the tile and the tables of the index
    const taken = [0, 1, 2, 3, 4, TERRAIN_ATLAS_TEXTURE_UNIT, ...Object.values(EDGE_UNITS)];
    expect(taken).not.toContain(DRAPE_EDGE_START_UNIT);
    // WebGL2 guarantees 16 units to a fragment shader
    expect(DRAPE_EDGE_START_UNIT).toBeLessThan(16);
  });
});

describe('the drape of the rows', () => {
  it('keeps the units of the fragment within 12, the table of the ranks on a unit of its own', () => {
    const taken = [
      0,
      1,
      2,
      3,
      4,
      TERRAIN_ATLAS_TEXTURE_UNIT,
      ...Object.values(EDGE_UNITS),
      DRAPE_EDGE_START_UNIT,
    ];
    expect(taken).not.toContain(DRAPE_RANK_UNIT);
    const units = new Set([...taken, DRAPE_RANK_UNIT]);
    expect(units.size).toBe(12);
    expect(Math.max(...units)).toBeLessThan(12);
  });

  it('reads a run as a copy: its state hides it, its rank ends the draw', () => {
    expect(ROWS_DRAPE_FRAGMENT_SOURCE.split('\n')[1]).toBe('#define ROWS_DRAPE');
    const rows = ROWS_DRAPE_FRAGMENT_SOURCE.slice(
      ROWS_DRAPE_FRAGMENT_SOURCE.indexOf('#ifdef ROWS_DRAPE\n// The moving partitions'),
      ROWS_DRAPE_FRAGMENT_SOURCE.lastIndexOf('#else'),
    );
    // The state (hidden) and the rank are read from the texel of the copy, not from the index
    expect(rows).toContain('u_rank_base[copyRange] + copy');
    expect(rows).toContain('& 1) != 0) continue;');
    // The runs of a cell are in the order of the drape: the draw is done past its ranks
    expect(rows).toContain('if (!rankLess(rank.xyz, u_paint_to)) break;');
    // The style of a copy is read from the region of its range
    expect(rows).toContain('u_style_base[copyRange] + copy');
    // The moving partitions are merged with the cell by rank
    expect(rows).toContain('rankLess(heads[l].xyz, heads[best].xyz)');
  });
});
