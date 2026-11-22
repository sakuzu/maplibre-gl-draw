// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests that the tables of the defaults stay as they are while the instances change their
 * configurations in place
 *
 * Every instance on the page reads the same tables of defaults, so an instance created without
 * options gets copies of them, and a change of its options never reaches the tables or the next
 * instance.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_FEATURE_STYLE_CONFIG } from '../../shared/config/feature-style.js';
import { DEFAULT_RENDERING_CONFIG } from '../../shared/config/rendering.js';
import { DEFAULT_SELECTION_CONFIG } from '../../shared/config/selection.js';
import { createMapStub } from '../../test-utils.js';
import { createDraw } from '../draw.js';
import type { Engine } from './engine.js';
import { createEngine } from './engine.js';
import { createOptions } from './options.js';

const engines: Engine[] = [];

/** An engine created without options, and the settings entry of a draw over it */
function withoutOptions() {
  const engine = createEngine(createMapStub().map);
  engines.push(engine);
  const options = createOptions(engine, {}, () => {});
  options.applyCreation();
  return { engine, options };
}

/** A deep copy, to compare a table with what it was */
const copy = <T>(value: T): T => structuredClone(value);

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  for (const engine of engines.splice(0)) engine.destroy();
  vi.useRealTimers();
});

describe('the tables of the defaults', () => {
  it('are frozen at every level, so a write into them throws', () => {
    expect(() => {
      (DEFAULT_FEATURE_STYLE_CONFIG.polygon.fill.color as number[])[3] = 0.9;
    }).toThrow(TypeError);
    expect(() => {
      (DEFAULT_SELECTION_CONFIG.boundingBox.stroke as { width: number }).width = 9;
    }).toThrow(TypeError);
    expect(() => {
      (DEFAULT_RENDERING_CONFIG as { storeRetained: boolean }).storeRetained = false;
    }).toThrow(TypeError);
  });

  it('are copied into an instance created without options', () => {
    const { engine } = withoutOptions();

    expect(engine.context.featureStyle).not.toBe(DEFAULT_FEATURE_STYLE_CONFIG);
    expect(engine.context.featureStyle).toEqual(DEFAULT_FEATURE_STYLE_CONFIG);
    expect(engine.context.selectionStyle).not.toBe(DEFAULT_SELECTION_CONFIG);
    expect(engine.context.selectionStyle).toEqual(DEFAULT_SELECTION_CONFIG);
    expect(engine.context.renderingConfig).not.toBe(DEFAULT_RENDERING_CONFIG);
    expect(engine.context.renderingConfig).toEqual(DEFAULT_RENDERING_CONFIG);
  });

  it('stay as they are when an instance created without options changes its options, and the next instance has the defaults', () => {
    const style = copy(DEFAULT_FEATURE_STYLE_CONFIG);
    const selection = copy(DEFAULT_SELECTION_CONFIG);
    const rendering = copy(DEFAULT_RENDERING_CONFIG);
    const first = withoutOptions();

    first.options.update({
      style: { polygon: { fillColor: 'blue', fillOpacity: 0.5 }, line: { strokeWidth: 7 } },
      selectionStyle: {
        boundingBox: {
          stroke: { width: 3, color: '#ff0000', opacity: 1, lineStyle: 'solid' },
          margin: 4,
        },
      },
    });
    expect(first.engine.context.selectionStyle.boundingBox.stroke.width).toBe(3);
    expect(first.engine.context.featureStyle.polygon.fill.color).toEqual([0, 0, 1, 0.5]);
    expect(first.engine.context.featureStyle.lineString.stroke.width).toBe(7);

    expect(DEFAULT_FEATURE_STYLE_CONFIG).toEqual(style);
    expect(DEFAULT_SELECTION_CONFIG).toEqual(selection);
    expect(DEFAULT_RENDERING_CONFIG).toEqual(rendering);

    const next = withoutOptions();
    expect(next.engine.context.featureStyle).toEqual(style);
    expect(next.engine.context.selectionStyle).toEqual(selection);
    expect(next.engine.context.renderingConfig).toEqual(rendering);
  });

  it('stay as they are when a draw made without options changes its options', () => {
    const style = copy(DEFAULT_FEATURE_STYLE_CONFIG);
    const selection = copy(DEFAULT_SELECTION_CONFIG);
    const draw = createDraw(createMapStub().map as never);
    try {
      draw.options.update({
        style: { polygon: { fillColor: 'blue' } },
        selectionStyle: {
          boundingBox: {
            stroke: { width: 3, color: '#ff0000', opacity: 1, lineStyle: 'solid' },
            margin: 4,
          },
        },
      });
    } finally {
      draw.destroy();
    }

    expect(DEFAULT_FEATURE_STYLE_CONFIG).toEqual(style);
    expect(DEFAULT_SELECTION_CONFIG).toEqual(selection);
  });
});
