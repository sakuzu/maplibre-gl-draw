<!--
  SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
  SPDX-License-Identifier: AGPL-3.0-only
-->
<script lang="ts">
  import { Shell, type Shortcut } from '@sakuzu/kata/svelte';
  import type { Messages } from '../messages.js';
  import { fromMapCanvas, toolbarShortcuts } from '../shortcuts.js';
  import type { Box } from '../store.js';
  import { toSpec } from '../tools.js';
  import type {
    DrawUIDraw,
    LayerPanelDraw,
    LeftSettings,
    LegendDraw,
    ToolbarSettings,
    ToolEntry,
  } from '../types.js';
  import LeftPanel from './LeftPanel.svelte';
  import Toolbar from './Toolbar.svelte';

  // DrawUI: kata's Shell laid over the map. The stage is left empty, so the map shows through
  // and keeps its own pointer and keys; the regions of the shell (the toolbar at the bottom) take
  // the pointer where they are. The keyboard shortcuts are those of the toolbar's buttons.
  let {
    draw,
    tools,
    messages,
    toolbar,
    left,
    shortcuts = true,
  }: {
    draw: DrawUIDraw & LayerPanelDraw & LegendDraw;
    tools: Box<ToolEntry[]>;
    messages: Box<Messages>;
    toolbar: Box<ToolbarSettings | null>;
    /** The left region: the layer panel and the legend */
    left: Box<LeftSettings | null>;
    /** Whether the keyboard shortcuts are on */
    shortcuts?: boolean;
  } = $props();

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
  const side = $derived(left.get());
  // The left region is open at first; the shell closes it (Escape, the scrim, the sheet's close
  // button) and Shift+L opens and closes it
  let leftOpen = $state(true);
  const leftKeys = $derived<Shortcut[]>(
    shortcuts && side
      ? [
          {
            key: 'shift+l',
            label: m.toggleLayers,
            group: m.panelsGroup,
            run: () => {
              leftOpen = !leftOpen;
            },
          },
        ]
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

{#snippet leftRegion()}
  {#if side}
    <LeftPanel {draw} {messages} settings={side} />
  {/if}
{/snippet}

<Shell
  bind:leftOpen
  leftLabel={m.layers}
  shortcuts={[...keys, ...leftKeys]}
  {onescape}
  left={side ? leftRegion : undefined}
  bottom={bar ? bottom : undefined}
/>
