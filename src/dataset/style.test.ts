// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the style resolution of a dataset (DisplayFeatureStyler)
 */

import { describe, expect, it } from 'vitest';
import type { Feature, StyleRule } from '../shared/types/model.js';
import { displayFeature } from '../test-utils.js';
import { DisplayFeatureStyler } from './style.js';

const RULE: StyleRule = {
  kind: 'categorical',
  property: 'kind',
  map: { a: '#ff0000' },
  other: '#00ff00',
};

function line(id: string, style?: Feature['style']): Feature {
  return displayFeature({
    id,
    type: 'LineString',
    coordinates: [
      [0, 0],
      [1, 1],
    ],
    properties: { kind: 'a' },
    style,
  });
}

describe('DisplayFeatureStyler', () => {
  it('without a rule or a base style the features are returned as they are', () => {
    const styler = new DisplayFeatureStyler(undefined, undefined);
    const features = [line('a')];
    expect(styler.isStyled).toBe(false);
    expect(styler.prepareAll(features)).toBe(features);
    expect(styler.prepareIfStyled(features[0])).toBe(features[0]);
  });

  it('the rule color goes on the feature and the base style goes underneath', () => {
    const styler = new DisplayFeatureStyler(RULE, { stroke: { strokeWidth: 5 } });
    const prepared = styler.prepare(line('a'));
    expect(prepared.style?.strokeColor).toBe('#ff0000');
    expect(prepared.style?.strokeWidth).toBe(5);
  });

  it('the individual style of a feature wins over the rule and the base style', () => {
    const styler = new DisplayFeatureStyler(RULE, { stroke: { strokeWidth: 5 } });
    const prepared = styler.prepare(line('a', { strokeColor: '#0000ff', strokeWidth: 1 }));
    expect(prepared.style?.strokeColor).toBe('#0000ff');
    expect(prepared.style?.strokeWidth).toBe(1);
  });

  it('the prepared feature is reused until the caches are cleared', () => {
    const styler = new DisplayFeatureStyler(RULE, undefined);
    const feature = line('a');
    const first = styler.prepare(feature);
    expect(styler.prepare(feature)).toBe(first);

    styler.clear();
    expect(styler.prepare(feature)).not.toBe(first);
  });

  it('replacing the rule or the base style discards what was prepared', () => {
    const styler = new DisplayFeatureStyler(RULE, undefined);
    const feature = line('a');
    styler.prepare(feature);

    styler.setRule(undefined);
    expect(styler.prepare(feature)).toBe(feature);

    styler.setBase({ stroke: { strokeWidth: 7 } });
    expect(styler.base).toEqual({ stroke: { strokeWidth: 7 } });
    expect(styler.prepare(feature).style?.strokeWidth).toBe(7);
  });
});
