// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests of style rule evaluation and legend derivation
 *
 * The evaluation consists of pure functions and can be verified on its own without
 * depending on the Store or WebGL. These tests confirm that a missing attribute or a type
 * mismatch falls back to other rather than to the default color, and that the boundary
 * values, the clamping and the interpolation follow the specification.
 */

import { describe, expect, it } from 'vitest';
import { MESSAGES_EN } from '../messages.js';
import { geometryFromCoordinates } from '../shared/utils/coordinates.js';
import type { Feature, FeatureStyle, StyleRule } from '../store/types.js';
import {
  applyRuleColor,
  deriveLegend,
  evaluateStyleRule,
  getStyleRuleChannel,
  resolveFeatureStyle,
  resolveRuleColor,
} from './style-rule.js';

function makeFeature(
  properties: Record<string, unknown>,
  style?: FeatureStyle,
  type: Feature['type'] = 'Polygon',
): Feature {
  return {
    id: 'f1',
    type,
    geometry: geometryFromCoordinates(type, [
      [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 0],
      ],
    ]),
    layerId: 'layer-1',
    properties,
    style: style ?? {},
    locked: false,
    visible: true,
  };
}

describe('evaluateStyleRule single', () => {
  const rule: StyleRule = { kind: 'single', color: '#112233' };

  it('returns the same color regardless of the attributes', () => {
    expect(evaluateStyleRule(rule, {})).toBe('#112233');
    expect(evaluateStyleRule(rule, { pop: 100 })).toBe('#112233');
  });

  it('returns a color even without attributes', () => {
    expect(evaluateStyleRule(rule, undefined)).toBe('#112233');
  });
});

describe('evaluateStyleRule categorical', () => {
  const rule: StyleRule = {
    kind: 'categorical',
    property: 'type',
    map: { residential: '#ff0000', commercial: '#00ff00', '1': '#0000ff', true: '#ffff00' },
    other: '#888888',
  };

  it('returns the color of the matching key', () => {
    expect(evaluateStyleRule(rule, { type: 'residential' })).toBe('#ff0000');
    expect(evaluateStyleRule(rule, { type: 'commercial' })).toBe('#00ff00');
  });

  it('numbers and booleans are turned into strings and matched', () => {
    expect(evaluateStyleRule(rule, { type: 1 })).toBe('#0000ff');
    expect(evaluateStyleRule(rule, { type: true })).toBe('#ffff00');
  });

  it('becomes other when the attribute is missing', () => {
    expect(evaluateStyleRule(rule, {})).toBe('#888888');
    expect(evaluateStyleRule(rule, undefined)).toBe('#888888');
  });

  it('a value not in the map becomes other', () => {
    expect(evaluateStyleRule(rule, { type: 'industrial' })).toBe('#888888');
  });

  it('types that cannot be matched (objects, null) become other', () => {
    expect(evaluateStyleRule(rule, { type: { a: 1 } })).toBe('#888888');
    expect(evaluateStyleRule(rule, { type: null })).toBe('#888888');
    expect(evaluateStyleRule(rule, { type: [1, 2] })).toBe('#888888');
  });
});

describe('evaluateStyleRule graduated', () => {
  const rule: StyleRule = {
    kind: 'graduated',
    property: 'pop',
    breaks: [10, 20, 30],
    colors: ['#000001', '#000002', '#000003', '#000004'],
    other: '#888888',
  };

  it('a value below a boundary takes the color of the previous class', () => {
    expect(evaluateStyleRule(rule, { pop: 0 })).toBe('#000001');
    expect(evaluateStyleRule(rule, { pop: 9.999 })).toBe('#000001');
    expect(evaluateStyleRule(rule, { pop: 15 })).toBe('#000002');
    expect(evaluateStyleRule(rule, { pop: 25 })).toBe('#000003');
  });

  it('a value exactly on a boundary enters the next class', () => {
    expect(evaluateStyleRule(rule, { pop: 10 })).toBe('#000002');
    expect(evaluateStyleRule(rule, { pop: 20 })).toBe('#000003');
    expect(evaluateStyleRule(rule, { pop: 30 })).toBe('#000004');
  });

  it('a value at or above the largest boundary takes the last color', () => {
    expect(evaluateStyleRule(rule, { pop: 1000 })).toBe('#000004');
  });

  it('negative values are classified by the boundaries too', () => {
    expect(evaluateStyleRule(rule, { pop: -5 })).toBe('#000001');
  });

  it('a missing attribute or a non-numeric value becomes other', () => {
    expect(evaluateStyleRule(rule, {})).toBe('#888888');
    // A numeric string is not converted either, and becomes other
    expect(evaluateStyleRule(rule, { pop: '15' })).toBe('#888888');
    expect(evaluateStyleRule(rule, { pop: null })).toBe('#888888');
    expect(evaluateStyleRule(rule, { pop: Number.NaN })).toBe('#888888');
    expect(evaluateStyleRule(rule, { pop: Number.POSITIVE_INFINITY })).toBe('#888888');
  });

  it('a rule whose colors fall short of breaks + 1 falls back to other', () => {
    const broken: StyleRule = { ...rule, colors: ['#000001'] };
    expect(evaluateStyleRule(broken, { pop: 0 })).toBe('#000001');
    expect(evaluateStyleRule(broken, { pop: 100 })).toBe('#888888');
  });
});

describe('evaluateStyleRule continuous', () => {
  const rule: StyleRule = {
    kind: 'continuous',
    property: 'ratio',
    min: 0,
    max: 100,
    ramp: ['#000000', '#ffffff'],
    other: '#888888',
  };

  it('both ends are the 2 colors of the ramp', () => {
    expect(evaluateStyleRule(rule, { ratio: 0 })).toBe('#000000');
    expect(evaluateStyleRule(rule, { ratio: 100 })).toBe('#ffffff');
  });

  it('the middle is interpolated in the OKLab space', () => {
    // The middle of black (L=0) -> white (L=1) is L=0.5 in OKLab. The coefficients of each
    // row of the inverse matrix sum to 1, so l=m=s=0.5^3=0.125 -> linear sRGB is 0.125 too,
    // and the sRGB transfer function 1.055*0.125^(1/2.4)-0.055 = 0.3886 -> 99 = 0x63.
    expect(evaluateStyleRule(rule, { ratio: 50 })).toBe('#636363');
    // Likewise t=0.25 is L=0.25 -> linear 0.25^3=0.015625 -> 0.1315 -> 34 = 0x22.
    expect(evaluateStyleRule(rule, { ratio: 25 })).toBe('#222222');
  });

  it('the perceptual middle color is darker than #808080, the middle of RGB interpolation', () => {
    // L=0.5 in OKLab has a linear luminance of 0.125, which is darker than the RGB midpoint
    // #808080 (linear 0.216). Rather than pinning the numbers down, this only confirms that
    // it is not RGB interpolation.
    const mid = evaluateStyleRule(rule, { ratio: 50 });
    expect(mid).not.toBe('#808080');
    expect(Number.parseInt(mid.slice(1, 3), 16)).toBeLessThan(0x80);
  });

  it('out-of-range values are clamped', () => {
    expect(evaluateStyleRule(rule, { ratio: -50 })).toBe('#000000');
    expect(evaluateStyleRule(rule, { ratio: 1000 })).toBe('#ffffff');
  });

  it('interpolation across hues is also done per OKLab component', () => {
    // The value obtained by inverse-transforming the midpoint (0.53998, 0.09620, -0.09284)
    // of red OKLab(0.62796, 0.22486, 0.12585) and blue OKLab(0.45201, -0.03246, -0.31153)
    // (computed with the coefficients of the original source). It becomes a purple brighter
    // and more vivid than #800080, the result of RGB interpolation.
    const colored: StyleRule = { ...rule, ramp: ['#ff0000', '#0000ff'] };
    expect(evaluateStyleRule(colored, { ratio: 50 })).toBe('#8c53a2');
  });

  it('a missing attribute or a non-numeric value becomes other', () => {
    expect(evaluateStyleRule(rule, {})).toBe('#888888');
    expect(evaluateStyleRule(rule, { ratio: '50' })).toBe('#888888');
    expect(evaluateStyleRule(rule, { ratio: Number.NaN })).toBe('#888888');
  });

  it('a degenerate rule with min >= max returns the start point of the ramp', () => {
    const degenerate: StyleRule = { ...rule, min: 100, max: 100 };
    expect(evaluateStyleRule(degenerate, { ratio: 100 })).toBe('#000000');
  });
});

describe('the priority of resolveRuleColor / applyRuleColor', () => {
  const rule: StyleRule = {
    kind: 'categorical',
    property: 'type',
    map: { a: '#ff0000' },
    other: '#888888',
  };

  it('returns null when there is no rule', () => {
    expect(resolveRuleColor(makeFeature({ type: 'a' }), undefined)).toBeNull();
  });

  it('returns the evaluation result when there is a rule', () => {
    expect(resolveRuleColor(makeFeature({ type: 'a' }), rule)).toBe('#ff0000');
  });

  it('a feature that has its own color beats the rule', () => {
    const style = resolveFeatureStyle(
      makeFeature({ type: 'a' }, { fillColor: '#0000ff' }),
      rule,
      'fill',
    );
    expect(style?.fillColor).toBe('#0000ff');
  });

  it('a feature style other than color does not get in the way of the rule', () => {
    const style = resolveFeatureStyle(makeFeature({ type: 'a' }, { strokeWidth: 3 }), rule, 'fill');
    expect(style?.fillColor).toBe('#ff0000');
    expect(style?.strokeWidth).toBe(3);
  });

  it('the color property that is set changes per channel', () => {
    const feature = makeFeature({ type: 'a' });
    expect(resolveFeatureStyle(feature, rule, 'point')?.pointColor).toBe('#ff0000');
    expect(resolveFeatureStyle(feature, rule, 'stroke')?.strokeColor).toBe('#ff0000');
    expect(resolveFeatureStyle(feature, rule, 'fill')?.fillColor).toBe('#ff0000');
  });

  it('an own color on another channel does not get in the way of the rule', () => {
    // Even for a feature where only the fill is specified individually, the rule color of
    // the stroke takes effect
    const feature = makeFeature({ type: 'a' }, { fillColor: '#0000ff' });
    expect(resolveFeatureStyle(feature, rule, 'stroke')?.strokeColor).toBe('#ff0000');
  });

  it('returns the original style as is when the rule color is null', () => {
    const style: FeatureStyle = { strokeWidth: 2 };
    expect(applyRuleColor(style, null, 'fill')).toBe(style);
    expect(applyRuleColor(undefined, null, 'fill')).toBeUndefined();
  });

  it('does not destroy the original style', () => {
    const style: FeatureStyle = { strokeWidth: 2 };
    applyRuleColor(style, '#ff0000', 'fill');
    expect(style.fillColor).toBeUndefined();
  });
});

describe('getStyleRuleChannel', () => {
  it('the point family is point', () => {
    expect(getStyleRuleChannel('Point')).toBe('point');
    expect(getStyleRuleChannel('MultiPoint')).toBe('point');
  });

  it('the line family is stroke', () => {
    expect(getStyleRuleChannel('LineString')).toBe('stroke');
    expect(getStyleRuleChannel('MultiLineString')).toBe('stroke');
    expect(getStyleRuleChannel('Freehand')).toBe('stroke');
  });

  it('the polygon family and everything else is fill', () => {
    expect(getStyleRuleChannel('Polygon')).toBe('fill');
    expect(getStyleRuleChannel('MultiPolygon')).toBe('fill');
    expect(getStyleRuleChannel('Circle')).toBe('fill');
    expect(getStyleRuleChannel('Marker')).toBe('fill');
  });
});

describe('deriveLegend', () => {
  it('single gives 1 entry, labeled in English by default', () => {
    expect(deriveLegend({ kind: 'single', color: '#112233' })).toEqual([
      { label: 'All', color: '#112233' },
    ]);
  });

  it('categorical returns the keys in declaration order plus the other entry', () => {
    const entries = deriveLegend({
      kind: 'categorical',
      property: 'type',
      map: { residential: '#ff0000', commercial: '#00ff00' },
      other: '#888888',
    });

    expect(entries).toEqual([
      { label: 'residential', color: '#ff0000' },
      { label: 'commercial', color: '#00ff00' },
      { label: 'Other', color: '#888888' },
    ]);
  });

  it('graduated returns the boundary notation plus the other entry', () => {
    const entries = deriveLegend({
      kind: 'graduated',
      property: 'pop',
      breaks: [10, 20],
      colors: ['#000001', '#000002', '#000003'],
      other: '#888888',
    });

    expect(entries).toEqual([
      { label: 'Below 10', color: '#000001' },
      { label: '10 to below 20', color: '#000002' },
      { label: '20 or more', color: '#000003' },
      { label: 'Other', color: '#888888' },
    ]);
  });

  it('graduated with 1 boundary gives 2 classes', () => {
    const entries = deriveLegend({
      kind: 'graduated',
      property: 'pop',
      breaks: [10],
      colors: ['#000001', '#000002'],
      other: '#888888',
    });

    expect(entries.map((e) => e.label)).toEqual(['Below 10', '10 or more', 'Other']);
  });

  it('continuous returns the 2 end points min / max plus the other entry', () => {
    const entries = deriveLegend({
      kind: 'continuous',
      property: 'ratio',
      min: 0,
      max: 100,
      ramp: ['#000000', '#ffffff'],
      other: '#888888',
    });

    expect(entries).toEqual([
      { label: '0', color: '#000000' },
      { label: '100', color: '#ffffff' },
      { label: 'Other', color: '#888888' },
    ]);
  });

  it('the other label appears in every one of the 4 kinds of rule that has other', () => {
    const rules: StyleRule[] = [
      { kind: 'categorical', property: 'p', map: {}, other: '#888888' },
      { kind: 'graduated', property: 'p', breaks: [1], colors: ['#1', '#2'], other: '#888888' },
      {
        kind: 'continuous',
        property: 'p',
        min: 0,
        max: 1,
        ramp: ['#000000', '#ffffff'],
        other: '#888888',
      },
    ];

    for (const rule of rules) {
      const entries = deriveLegend(rule);
      expect(entries[entries.length - 1]).toEqual({
        label: 'Other',
        color: '#888888',
      });
    }
  });

  it('takes its labels from the messages table given to it', () => {
    const messages = {
      legendAll: 'すべて',
      legendOther: 'その他',
      legendBelow: (upper: string) => `${upper} 未満`,
      legendAtLeast: (lower: string) => `${lower} 以上`,
      legendRange: (lower: string, upper: string) => `${lower} 以上 ${upper} 未満`,
    };

    expect(deriveLegend({ kind: 'single', color: '#112233' }, messages)).toEqual([
      { label: 'すべて', color: '#112233' },
    ]);
    const graduated = deriveLegend(
      {
        kind: 'graduated',
        property: 'pop',
        breaks: [10, 20],
        colors: ['#000001', '#000002', '#000003'],
        other: '#888888',
      },
      messages,
    );
    expect(graduated.map((e) => e.label)).toEqual([
      '10 未満',
      '10 以上 20 未満',
      '20 以上',
      'その他',
    ]);
  });

  it('falls back to the English default for the entries a partial table leaves out', () => {
    const entries = deriveLegend(
      { kind: 'categorical', property: 'p', map: {}, other: '#888888' },
      { legendAll: 'Everything' },
    );

    expect(entries).toEqual([{ label: MESSAGES_EN.legendOther, color: '#888888' }]);
  });
});
