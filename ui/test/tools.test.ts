// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { en } from '../src/locales/en.js';
import {
  BUILTIN_TOOLS,
  drawbarTools,
  insertTool,
  markupIcon,
  normalizeTools,
  specIcon,
  TOOL_IDS,
  toSpec,
} from '../src/tools.js';
import type { ToolSpec } from '../src/types.js';

const SVG = '<svg viewBox="0 0 24 24"><path d="M4 4h16" stroke="currentColor"/></svg>';
const hexagon: ToolSpec = {
  id: 'hexagon',
  mode: 'draw_hexagon',
  label: 'Hexagon',
  icon: SVG,
  group: 'shapes',
};

describe('the built-in tools', () => {
  it('map one to one to the built-in modes of core', () => {
    expect(Object.fromEntries(TOOL_IDS.map((id) => [id, BUILTIN_TOOLS[id].mode]))).toEqual({
      select: 'select',
      point: 'draw_point',
      line: 'draw_line',
      polygon: 'draw_polygon',
      circle: 'draw_circle',
      freehand: 'draw_freehand',
      image: 'draw_image',
    });
  });

  it('have the keys V P L A C F I', () => {
    expect(TOOL_IDS.map((id) => BUILTIN_TOOLS[id].shortcut).join('')).toBe('VPLACFI');
  });

  it('are all seven when the options name none', () => {
    expect(normalizeTools()).toEqual([...TOOL_IDS]);
  });

  it('put select alone and the drawing tools together in the Drawbar', () => {
    const specs = normalizeTools().map((entry) => toSpec(entry, en));
    const groups = drawbarTools(specs, false).map((t) => t.group);
    expect(groups).toEqual(['select', 'draw', 'draw', 'draw', 'draw', 'draw', 'draw']);
  });

  it('show their keys in the tooltips only when the shortcuts are on', () => {
    const specs = normalizeTools(['select', 'polygon']).map((entry) => toSpec(entry, en));
    expect(drawbarTools(specs, true).map((t) => t.kbd)).toEqual(['V', 'A']);
    expect(drawbarTools(specs, false).map((t) => t.kbd)).toEqual([undefined, undefined]);
  });

  it('take their names from the words', () => {
    expect(toSpec('polygon', { ...en, polygon: 'Area' })).toEqual({
      id: 'polygon',
      mode: 'draw_polygon',
      label: 'Area',
      icon: 'polygon',
      shortcut: 'A',
      group: 'draw',
    });
  });
});

describe('the tools of the options', () => {
  it('keep the order given', () => {
    expect(normalizeTools(['polygon', 'select'])).toEqual(['polygon', 'select']);
  });

  it('refuse a name that is not a built-in tool', () => {
    expect(() => normalizeTools(['heptagon' as never])).toThrow(/no built-in tool "heptagon"/);
  });

  it('refuse two tools with one ID', () => {
    expect(() => normalizeTools(['select', { ...hexagon, id: 'select' }])).toThrow(/Two tools/);
  });

  it('refuse a tool without a mode, or with an icon that is neither markup nor a name', () => {
    expect(() => normalizeTools([{ ...hexagon, mode: '' }])).toThrow(/needs a mode/);
    expect(() => normalizeTools([{ ...hexagon, icon: 'star' }])).toThrow(/neither SVG markup/);
  });

  it('refuse the IDs of the delete button and the snapping switch', () => {
    expect(() => normalizeTools([{ ...hexagon, id: 'delete' }])).toThrow(/kept for the toolbar/);
  });
});

describe('an added tool', () => {
  it('goes after the last tool of its group', () => {
    const next = insertTool(['select', 'point', 'line', 'image'], { ...hexagon, group: 'draw' });
    expect(next.map((e) => (typeof e === 'string' ? e : e.id))).toEqual([
      'select',
      'point',
      'line',
      'image',
      'hexagon',
    ]);
    const between = insertTool(['select', 'point'], { ...hexagon, group: 'select' });
    expect(between.map((e) => (typeof e === 'string' ? e : e.id))).toEqual([
      'select',
      'hexagon',
      'point',
    ]);
  });

  it('goes at the end, in a group of its own, when no tool is in its group', () => {
    const next = insertTool(['select', 'point'], hexagon);
    expect(next.at(-1)).toEqual(hexagon);
    const specs = next.map((entry) => toSpec(entry, en));
    expect(drawbarTools(specs, false).map((t) => t.group)).toEqual(['select', 'draw', 'shapes']);
  });

  it('draws its markup with one component for each markup', () => {
    expect(specIcon(hexagon)).toBe(markupIcon(SVG));
    expect(typeof specIcon(hexagon)).toBe('function');
    expect(specIcon({ ...hexagon, icon: 'polygon' })).toBe('polygon');
  });
});
