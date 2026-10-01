<!--
  SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
  SPDX-License-Identifier: AGPL-3.0-only
-->
<script lang="ts">
  import { Shell, type Shortcut } from '@sakuzu/kata/svelte';
  import type {
    InspectorDraw,
    InspectorSectionSpec,
    InspectorSettings,
  } from '../inspector/types.js';
  import type { Messages } from '../messages.js';
  import { fromMapCanvas, toolbarShortcuts } from '../shortcuts.js';
  import { type Box, follow } from '../store.js';
  import { toSpec } from '../tools.js';
  import type { DrawUIDraw, ToolbarSettings, ToolEntry } from '../types.js';
  import Inspector from './Inspector.svelte';
  import Toolbar from './Toolbar.svelte';

  // DrawUI: kata's Shell laid over the map. The stage is left empty, so the map shows through
  // and keeps its own pointer and keys; the regions of the shell (the toolbar at the bottom) take
  // the pointer where they are. The keyboard shortcuts are those of the toolbar's buttons.
  let {
    draw,
    tools,
    messages,
    toolbar,
    shortcuts = true,
    inspector,
    sections,
  }: {
    draw: DrawUIDraw & InspectorDraw;
    tools: Box<ToolEntry[]>;
    messages: Box<Messages>;
    toolbar: Box<ToolbarSettings | null>;
    /** Whether the keyboard shortcuts are on */
    shortcuts?: boolean;
    /** The inspector on the right, or null when there is none */
    inspector: Box<InspectorSettings | null>;
    /** The sections the application added to the inspector */
    sections: Box<InspectorSectionSpec[]>;
  } = $props();

  // The inspector is open while something is selected; closing it clears the selection
  const inspectorSettings = $derived(inspector.get());
  const selected = $derived(
    follow(draw, ['selection.changed'], () => draw.selection.get().ids.length > 0),
  );

  function closeInspector(open: boolean) {
    if (!open) draw.selection.clear();
  }

  const m = $derived(messages.get());
  const bar = $derived(toolbar.get());
  const keys = $derived<Shortcut[]>(
    shortcuts && bar
      ? toolbarShortcuts(
          draw,
          tools.get().map((entry) => toSpec(entry, m)),
          m,
          bar.deletable,
        )
      : [],
  );

  // Escape on the canvas is core's (it cancels the drawing or clears the selection). Elsewhere,
  // with no pane to close, it clears the selection
  function onescape(e: KeyboardEvent) {
    if (fromMapCanvas(draw, e) || draw.selection.get().ids.length === 0) return false;
    draw.selection.clear();
  }
</script>

{#snippet bottom()}
  {#if bar}
    <Toolbar
      {draw}
      {tools}
      {messages}
      deletable={bar.deletable}
      snapping={bar.snapping}
      keys={shortcuts}
    />
  {/if}
{/snippet}

{#snippet right()}
  {#if inspectorSettings}
    <Inspector {draw} {messages} settings={inspectorSettings} {sections} />
  {/if}
{/snippet}

<Shell
  leftOpen={false}
  bind:rightOpen={() => selected.get(), closeInspector}
  rightLabel={m.inspector}
  shortcuts={keys}
  {onescape}
  right={inspectorSettings ? right : undefined}
  bottom={bar ? bottom : undefined}
/>
