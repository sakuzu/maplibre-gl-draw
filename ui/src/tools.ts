// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// The tools of the toolbar: the seven built-in tools, one for each built-in mode of core, and
// the tools an application adds. A tool only calls `draw.setMode` with its mode; the mode itself
// belongs to core (a mode an application adds is registered with `draw.extensions.modes.add`
// before its tool is added).

import Circle from '@lucide/svelte/icons/circle';
import Magnet from '@lucide/svelte/icons/magnet';
import MousePointer2 from '@lucide/svelte/icons/mouse-pointer-2';
import {
  type DrawbarTool,
  formatShortcut,
  type IconComponent,
  type IconSource,
} from '@sakuzu/kata/svelte';
import type { Mode } from '@sakuzu/maplibre-gl-draw';
import MarkupIcon from './components/MarkupIcon.svelte';
import type { Messages } from './messages.js';
import type { ToolEntry, ToolId, ToolSpec } from './types.js';

/** The built-in tools, in the order of the toolbar */
export const TOOL_IDS: readonly ToolId[] = Object.freeze([
  'select',
  'point',
  'line',
  'polygon',
  'circle',
  'freehand',
  'image',
]);

/** The mode, the key and the group of each built-in tool */
export const BUILTIN_TOOLS: Readonly<
  Record<ToolId, { mode: Mode; shortcut: string; group: string }>
> = Object.freeze({
  select: { mode: 'select', shortcut: 'V', group: 'select' },
  point: { mode: 'draw_point', shortcut: 'P', group: 'draw' },
  line: { mode: 'draw_line', shortcut: 'L', group: 'draw' },
  polygon: { mode: 'draw_polygon', shortcut: 'A', group: 'draw' },
  circle: { mode: 'draw_circle', shortcut: 'C', group: 'draw' },
  freehand: { mode: 'draw_freehand', shortcut: 'F', group: 'draw' },
  image: { mode: 'draw_image', shortcut: 'I', group: 'draw' },
});

/** The IDs that the toolbar keeps for its own buttons */
export const DELETE_ID = 'delete';
export const SNAPPING_ID = 'snapping';

/** The built-in icons, by name: kata's icons where it has them, Lucide's for the rest */
export const BUILTIN_ICONS: Readonly<Record<string, IconSource>> = Object.freeze({
  select: MousePointer2 as unknown as IconComponent,
  point: 'point',
  line: 'polyline',
  polygon: 'polygon',
  circle: Circle as unknown as IconComponent,
  freehand: 'pencil',
  image: 'image',
  [DELETE_ID]: 'trash-2',
  [SNAPPING_ID]: Magnet as unknown as IconComponent,
});

/** Whether a name is the ID of a built-in tool */
export function isToolId(value: unknown): value is ToolId {
  return typeof value === 'string' && (TOOL_IDS as readonly string[]).includes(value);
}

/** Whether an icon is SVG markup rather than the name of a built-in icon */
function isMarkup(icon: string): boolean {
  return icon.trimStart().startsWith('<');
}

/**
 * Checks a tool of the application
 *
 * @throws Error when a field is missing or has the wrong type, or the icon is neither markup
 *   nor the name of a built-in icon
 */
export function checkSpec(spec: ToolSpec): void {
  for (const key of ['id', 'mode', 'label', 'icon'] as const) {
    if (typeof spec?.[key] !== 'string' || spec[key] === '') {
      throw new Error(`A tool needs a ${key} (a string that is not empty)`);
    }
  }
  if (spec.id === DELETE_ID || spec.id === SNAPPING_ID) {
    throw new Error(`The tool ID "${spec.id}" is kept for the toolbar's own button`);
  }
  if (!isMarkup(spec.icon) && !(spec.icon in BUILTIN_ICONS)) {
    throw new Error(`The icon of the tool "${spec.id}" is neither SVG markup nor a built-in icon`);
  }
}

/**
 * The tools of the options, checked
 *
 * @throws Error when a name is not a built-in tool, a tool is not valid, or two tools share an ID
 */
export function normalizeTools(tools: readonly ToolEntry[] = TOOL_IDS): ToolEntry[] {
  const out: ToolEntry[] = [];
  const ids = new Set<string>();
  for (const entry of tools) {
    if (typeof entry === 'string') {
      if (!isToolId(entry)) throw new Error(`There is no built-in tool "${entry}"`);
    } else {
      checkSpec(entry);
    }
    const id = entryId(entry);
    if (ids.has(id)) throw new Error(`Two tools have the ID "${id}"`);
    ids.add(id);
    out.push(typeof entry === 'string' ? entry : { ...entry });
  }
  return out;
}

/** The ID of a tool */
export function entryId(entry: ToolEntry): string {
  return typeof entry === 'string' ? entry : entry.id;
}

/** The group of a tool; a tool without one is in a group named after its ID */
function entryGroup(entry: ToolEntry): string {
  if (typeof entry === 'string') return BUILTIN_TOOLS[entry].group;
  return entry.group ?? `tool:${entry.id}`;
}

/**
 * The tools with one more: after the last tool of its group, or at the end when no tool is in
 * its group
 */
export function insertTool(entries: readonly ToolEntry[], spec: ToolSpec): ToolEntry[] {
  const group = entryGroup(spec);
  let at = entries.length;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entryGroup(entries[i]) === group) {
      at = i + 1;
      break;
    }
  }
  return [...entries.slice(0, at), { ...spec }, ...entries.slice(at)];
}

/** A tool as `tools.list()` returns it: a built-in tool with its words and the name of its icon */
export function toSpec(entry: ToolEntry, messages: Messages): ToolSpec {
  if (typeof entry !== 'string') return { ...entry };
  const { mode, shortcut, group } = BUILTIN_TOOLS[entry];
  return { id: entry, mode, label: messages[entry], icon: entry, shortcut, group };
}

const markupIcons = new Map<string, IconComponent>();

/**
 * An icon component that draws SVG markup, made once for each markup. It receives the class of
 * kata's icons and passes it on, so the markup is sized like the built-in icons
 */
export function markupIcon(svg: string): IconComponent {
  let icon = markupIcons.get(svg);
  if (!icon) {
    icon = ((internals, props) =>
      MarkupIcon(internals, {
        svg,
        get class() {
          return props.class;
        },
      })) as IconComponent;
    markupIcons.set(svg, icon);
  }
  return icon;
}

/** The icon of a tool */
export function specIcon(spec: ToolSpec): IconSource {
  return isMarkup(spec.icon) ? markupIcon(spec.icon) : (BUILTIN_ICONS[spec.icon] ?? 'circle-alert');
}

/** The key of a shortcut as kata writes it: modifiers and keys in lowercase */
export function shortcutKey(shortcut: string): string {
  return shortcut.toLowerCase();
}

/**
 * The tools of the Drawbar of kata
 *
 * @param keys Whether the keys are shown in the tooltips (only when the shortcuts are on)
 */
export function drawbarTools(specs: readonly ToolSpec[], keys: boolean): DrawbarTool[] {
  return specs.map((spec) => ({
    id: spec.id,
    label: spec.label,
    icon: specIcon(spec),
    kbd: keys && spec.shortcut ? formatShortcut(shortcutKey(spec.shortcut)) : undefined,
    group: spec.group ?? `tool:${spec.id}`,
  }));
}
