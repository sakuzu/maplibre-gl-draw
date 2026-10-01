<!--
  SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
  SPDX-License-Identifier: AGPL-3.0-only
-->
<script lang="ts">
  import Layers from '@lucide/svelte/icons/layers';
  import {
    Button,
    Floating,
    formatShortcut,
    Icon,
    type IconComponent,
    Shell,
    type ShellLayout,
    type Shortcut,
  } from '@sakuzu/kata/svelte';
  import { tick } from 'svelte';
  import type {
    InspectorDraw,
    InspectorSectionSpec,
    InspectorSettings,
  } from '../inspector/types.js';
  import type { Messages } from '../messages.js';
  import type { Beside } from '../padding.js';
  import { fromMapCanvas, toolbarShortcuts } from '../shortcuts.js';
  import { type Box, follow } from '../store.js';
  import { toSpec } from '../tools.js';
  import type {
    DrawUIDraw,
    LayerPanelDraw,
    LeftSettings,
    LegendDraw,
    ToolbarSettings,
    ToolEntry,
  } from '../types.js';
  import Inspector from './Inspector.svelte';
  import LeftPanel from './LeftPanel.svelte';
  import Toolbar from './Toolbar.svelte';

  // DrawUI: kata's Shell laid over the map (overlay). The stage is left empty, so the map shows
  // through and keeps its own pointer and keys; the regions of the shell take the pointer where
  // they are. The keyboard shortcuts are those of the toolbar's buttons. onbeside reports which
  // side regions stand beside the stage, open, once the shell has drawn them, so that the map's
  // padding can follow them. While the left region is closed, a small button floats at the top
  // left of the map to open it again.
  let {
    draw,
    tools,
    messages,
    toolbar,
    left,
    shortcuts = true,
    inspector,
    sections,
    onbeside,
    side: sideMode = 'floating',
  }: {
    draw: DrawUIDraw & LayerPanelDraw & LegendDraw & InspectorDraw;
    tools: Box<ToolEntry[]>;
    messages: Box<Messages>;
    toolbar: Box<ToolbarSettings | null>;
    /** The left region: the layer panel and the legend */
    left: Box<LeftSettings | null>;
    /** Whether the keyboard shortcuts are on */
    shortcuts?: boolean;
    /** The inspector on the right, or null when there is none */
    inspector: Box<InspectorSettings | null>;
    /** The sections the application added to the inspector */
    sections: Box<InspectorSectionSpec[]>;
    /** Called with the side regions beside the stage after the layout or the open panes change */
    onbeside?: (beside: Beside) => void;
    /** Where the side regions go on a wide map: floating over it or beside it */
    side?: 'floating' | 'beside';
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
  const side = $derived(left.get());
  // The left region is open at first; the shell closes it (Escape, the scrim, the sheet's close
  // button) and Shift+L opens and closes it
  let leftOpen = $state(true);
  const LAYERS_ICON = Layers as unknown as IconComponent;
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

  // Where the shell puts the side regions (beside the stage, floating or sheets), by its width
  let layout = $state<ShellLayout | null>(null);
  $effect(() => {
    const now: Beside = {
      left: !!side && leftOpen && layout?.leftMode === 'beside',
      right: !!inspectorSettings && selected.get() && layout?.rightMode === 'beside',
    };
    // Also when the toolbar comes or goes
    void bar;
    if (!onbeside) return;
    const report = onbeside;
    // After the shell has drawn the regions
    tick().then(() => report(now));
  });

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

{#snippet right()}
  {#if inspectorSettings}
    <Inspector {draw} {messages} settings={inspectorSettings} {sections} />
  {/if}
{/snippet}

<Shell
  overlay
  side={sideMode}
  bind:leftOpen
  bind:rightOpen={() => selected.get(), closeInspector}
  leftLabel={m.layers}
  rightLabel={m.inspector}
  shortcuts={[...keys, ...leftKeys]}
  {onescape}
  onlayout={(next) => {
    layout = next;
  }}
  left={side ? leftRegion : undefined}
  right={inspectorSettings ? right : undefined}
  bottom={bar ? bottom : undefined}
/>

{#if side && !leftOpen}
  <!-- Outside the shell's regions: the root gives it the pointer (data-role="reopen") -->
  <div data-role="reopen">
    <Floating left="md" top="md">
      <Button
        variant="ghost"
        icon
        aria-label={m.layers}
        shortcut={shortcuts ? formatShortcut('shift+l') : undefined}
        onclick={() => {
          leftOpen = true;
        }}
      >
        <Icon name={LAYERS_ICON} />
      </Button>
    </Floating>
  </div>
{/if}
