<!--
  SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
  SPDX-License-Identifier: AGPL-3.0-only
-->
<script lang="ts">
  import Layers from '@lucide/svelte/icons/layers';
  import Moon from '@lucide/svelte/icons/moon';
  import Sun from '@lucide/svelte/icons/sun';
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
  import { type ActionsState, actionShortcuts } from '../actions.js';
  import type { BasemapControl } from '../basemaps.js';
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
  import Actions from './Actions.svelte';
  import BasemapPanel from './BasemapPanel.svelte';
  import Inspector from './Inspector.svelte';
  import LeftPanel from './LeftPanel.svelte';
  import Toolbar from './Toolbar.svelte';

  // DrawUI: kata's Shell laid over the map (overlay). The stage is left empty, so the map shows
  // through and keeps its own pointer and keys; the regions of the shell take the pointer where
  // they are. The keyboard shortcuts are those of the toolbar's buttons. onbeside reports which
  // side regions stand beside the stage, open, once the shell has drawn them, so that the map's
  // padding can follow them. While the left region is closed, a small button floats at the top
  // left of the map to open it again. At the top right, a button switches the theme to the look
  // that is not shown now (light reads the look the root shows, which the theme control keeps).
  //
  // The right region shows the inspector while something is selected, or the basemaps to choose
  // from, which the basemap row of the layer panel opens (with two or more basemaps). Opening
  // them clears the selection, and a selection made anywhere closes them, so the two never show
  // at once; their close button and Escape close them.
  //
  // At the bottom left, above maplibre-gl's scale, the card of the actions of the application
  // shows while there are any; their keys are shortcuts of the shell, listed under its title.
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
    light,
    themeToggle = true,
    ontheme,
    basemaps,
    actions,
    actionsTitle,
    corner,
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
    /** Whether the root shows the light look now */
    light: Box<boolean>;
    /** Whether the button that switches the theme shows */
    themeToggle?: boolean;
    /** Called with the theme the button switches to */
    ontheme?: (theme: 'light' | 'dark') => void;
    /** The basemaps of the basemap row of the layer panel */
    basemaps?: BasemapControl | null;
    /** The actions of the application, in the card at the bottom left */
    actions: ActionsState;
    /** The title of the card of the actions; the word for actions when left out */
    actionsTitle?: string;
    /** The element whose bottom left corner holds maplibre-gl's controls (the map's container) */
    corner?: HTMLElement | null;
  } = $props();

  // The inspector is open while something is selected; closing it clears the selection
  const inspectorSettings = $derived(inspector.get());
  const selected = $derived(
    follow(draw, ['selection.changed'], () => draw.selection.get().ids.length > 0),
  );

  // The basemaps to choose from, on the right in the place of the inspector
  const choosable = $derived(!!basemaps && basemaps.list.length >= 2);
  let basemapOpen = $state(false);
  function openBasemaps() {
    draw.selection.clear();
    basemapOpen = true;
  }
  $effect(() =>
    draw.on('selection.changed', ({ selection }) => {
      if (selection.ids.length > 0) basemapOpen = false;
    }),
  );
  const rightShown = $derived(
    (choosable && basemapOpen) || (!!inspectorSettings && selected.get()),
  );

  function closeRight(open: boolean) {
    if (open) return;
    basemapOpen = false;
    draw.selection.clear();
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

  // The card of the actions and their keys
  const actionList = $derived(actions.list.get());
  const cardTitle = $derived(actionsTitle ?? m.actions);
  const actionKeys = $derived<Shortcut[]>(
    shortcuts && actionList.length > 0 ? actionShortcuts(actions, cardTitle) : [],
  );

  // Where the shell puts the side regions (beside the stage, floating or sheets), by its width
  let layout = $state<ShellLayout | null>(null);
  $effect(() => {
    const now: Beside = {
      left: !!side && leftOpen && layout?.leftMode === 'beside',
      right: rightShown && layout?.rightMode === 'beside',
    };
    // Also when the toolbar comes or goes
    void bar;
    if (!onbeside) return;
    const report = onbeside;
    // After the shell has drawn the regions
    tick().then(() => report(now));
  });

  // The theme button: the look it switches to, and its place. While the inspector is open
  // floating or beside the map, it sits to the left of the inspector's pane, gap-md from it (the
  // pane is gap-md from the right and a panel wide, or a panel wide at the right edge); a sheet
  // comes from the bottom and leaves it at the corner
  const SUN_ICON = Sun as unknown as IconComponent;
  const MOON_ICON = Moon as unknown as IconComponent;
  const isLight = $derived(light.get());
  const besideInspector = $derived(rightShown && !!layout && layout.rightMode !== 'sheet');

  // Escape closes the basemaps to choose from. On the canvas it is core's too (it cancels the
  // drawing or clears the selection). Elsewhere, with no pane to close, it clears the selection
  function onescape(e: KeyboardEvent) {
    if (choosable && basemapOpen) {
      basemapOpen = false;
      return fromMapCanvas(draw, e) ? false : undefined;
    }
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
    <LeftPanel
      {draw}
      {messages}
      settings={side}
      {basemaps}
      basemapOpen={choosable && basemapOpen}
      onopenbasemap={choosable ? openBasemaps : undefined}
      onclose={() => {
        leftOpen = false;
      }}
    />
  {/if}
{/snippet}

{#snippet right()}
  {#if basemaps && choosable && basemapOpen}
    <BasemapPanel
      {basemaps}
      {messages}
      onclose={() => {
        basemapOpen = false;
      }}
    />
  {:else if inspectorSettings}
    <Inspector {draw} {messages} settings={inspectorSettings} {sections} />
  {/if}
{/snippet}

<Shell
  overlay
  side={sideMode}
  bind:leftOpen
  bind:rightOpen={() => rightShown, closeRight}
  leftLabel={m.layers}
  rightLabel={choosable && basemapOpen ? m.basemap : m.inspector}
  shortcuts={[...keys, ...leftKeys, ...actionKeys]}
  {onescape}
  onlayout={(next) => {
    layout = next;
  }}
  left={side ? leftRegion : undefined}
  right={inspectorSettings || choosable ? right : undefined}
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

{#if actionList.length > 0}
  <Actions
    {actions}
    messages={m}
    title={cardTitle}
    keys={shortcuts}
    narrow={layout?.width === 'narrow'}
    {corner}
    beside={!!side && leftOpen && layout?.leftMode === 'beside'}
  />
{/if}

{#if themeToggle}
  <!-- Outside the shell's regions: the root gives it the pointer (data-role="theme") -->
  <div data-role="theme">
    <Floating
      right={besideInspector ? 'calc(var(--kata-width-panel) + var(--kata-gap-md) * 2)' : 'md'}
      top="md"
    >
      <Button
        variant="ghost"
        icon
        aria-label={isLight ? m.toDark : m.toLight}
        onclick={() => ontheme?.(isLight ? 'dark' : 'light')}
      >
        <Icon name={isLight ? MOON_ICON : SUN_ICON} />
      </Button>
    </Floating>
  </div>
{/if}
