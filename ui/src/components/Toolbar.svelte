<!--
  SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
  SPDX-License-Identifier: AGPL-3.0-only
-->
<script lang="ts">
  import {
    Drawbar,
    type DrawbarToggle,
    type DrawbarTool,
    formatShortcut,
  } from '@sakuzu/kata/svelte';
  import type { Messages } from '../messages.js';
  import { type Box, follow } from '../store.js';
  import { BUILTIN_ICONS, DELETE_ID, drawbarTools, SNAPPING_ID, toSpec } from '../tools.js';
  import type { ToolbarDraw, ToolEntry } from '../types.js';
  import SnappingSettings from './SnappingSettings.svelte';

  // Toolbar: kata's Drawbar with the tools, the delete button and the magnet of snapping.
  //
  // It keeps nothing of the drawing: the current tool is the one whose mode is draw.getMode(),
  // read again on mode.changed; the delete button is off while draw.selection.get() is empty,
  // read again on selection.changed; the magnet is on while snapping is, read again on
  // options.changed. Pressing a tool calls draw.setMode and delete calls draw.selection.delete.
  // The magnet is one of the Drawbar's switches, so that it looks like one, but pressing it opens
  // the snapping settings rather than switching snapping (SnappingSettings, which writes through
  // draw.options.update).
  let {
    draw,
    tools,
    messages,
    deletable = true,
    snapping = true,
    keys = false,
  }: {
    draw: ToolbarDraw;
    /** The tools, in order */
    tools: Box<ToolEntry[]>;
    messages: Box<Messages>;
    /** Whether the delete button shows */
    deletable?: boolean;
    /** Whether the magnet of snapping shows */
    snapping?: boolean;
    /** Whether the tooltips show the keys (when the keyboard shortcuts are on) */
    keys?: boolean;
  } = $props();

  const mode = $derived(follow(draw, ['mode.changed'], () => draw.getMode()));
  const selected = $derived(
    follow(draw, ['selection.changed'], () => draw.selection.get().ids.length),
  );
  const snapOn = $derived(
    follow(draw, ['options.changed'], () => draw.options.get().snapping?.enabled !== false),
  );
  let settings = $state<SnappingSettings>();

  const m = $derived(messages.get());
  const specs = $derived(tools.get().map((entry) => toSpec(entry, m)));
  const current = $derived.by(() => {
    const now = mode.get();
    return specs.find((spec) => spec.mode === now)?.id;
  });
  const barTools = $derived<DrawbarTool[]>([
    ...drawbarTools(specs, keys),
    ...(deletable
      ? [
          {
            id: DELETE_ID,
            label: m.delete,
            icon: BUILTIN_ICONS[DELETE_ID],
            kbd: keys ? formatShortcut('delete') : undefined,
            group: DELETE_ID,
            tone: 'danger' as const,
            disabled: selected.get() === 0,
          },
        ]
      : []),
  ]);
  const toggles = $derived<DrawbarToggle[]>(
    snapping
      ? [
          {
            id: SNAPPING_ID,
            label: m.snapping,
            icon: BUILTIN_ICONS[SNAPPING_ID],
            on: snapOn.get(),
            onchange: () => settings?.toggle(),
          },
        ]
      : [],
  );

  function onselect(id: string) {
    if (deletable && id === DELETE_ID) {
      draw.selection.delete();
      return;
    }
    const spec = specs.find((s) => s.id === id);
    if (spec) draw.setMode(spec.mode);
  }
</script>

<Drawbar label={m.toolbar} tools={barTools} {toggles} {current} {onselect} />
{#if snapping}
  <SnappingSettings bind:this={settings} {draw} messages={m} label={m.snapping} />
{/if}
