<!--
  SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
  SPDX-License-Identifier: AGPL-3.0-only
-->
<script lang="ts">
  import { Button, Icon, Panel, Tabs, Toolbar } from '@sakuzu/kata/svelte';
  import type { BasemapControl } from '../basemaps.js';
  import type { Messages } from '../messages.js';
  import type { Box } from '../store.js';
  import type { LayerPanelDraw, LeftSettings, LegendDraw } from '../types.js';
  import LayerPanel from './LayerPanel.svelte';
  import Legend from './Legend.svelte';

  // LeftPanel: the left region of the interface, a Panel with the layer panel and the legend in
  // two tabs (Tabs in the Toolbar of its head). With one of them only, the head is its title.
  // The basemap is the last row of the layer panel.
  let {
    draw,
    messages,
    settings,
    basemaps = null,
    onclose,
  }: {
    draw: LayerPanelDraw & LegendDraw;
    messages: Box<Messages>;
    settings: LeftSettings;
    /** The basemaps of the last row of the layer panel */
    basemaps?: BasemapControl | null;
    /** Shows a close button at the end of the head; called when it is pressed */
    onclose?: () => void;
  } = $props();

  const m = $derived(messages.get());
  const tabs = $derived([
    ...(settings.layers ? [{ id: 'layers', label: m.layers }] : []),
    ...(settings.legend ? [{ id: 'legend', label: m.legend }] : []),
  ]);
  // The tab shown; the first one when the one chosen is gone
  let chosen = $state('layers');
  const current = $derived(tabs.some((t) => t.id === chosen) ? chosen : (tabs[0]?.id ?? ''));
  const both = $derived(`${m.layers}, ${m.legend}`);
  // The head: the tabs, or the title of the one view. The layer tree has a head of its own (its
  // title and the add menu), which then stands for the title
  // title. A close button needs the head whatever the view
  const titled = $derived(
    !!onclose || tabs.length > 1 || current !== 'layers' || !settings.layers?.add,
  );
</script>

{#snippet close()}
  {#if onclose}
    <Button variant="ghost" icon aria-label={m.close} onclick={onclose}>
      <Icon name="x" />
    </Button>
  {/if}
{/snippet}

{#snippet head()}
  {#if tabs.length > 1}
    <Toolbar rule tail={!!onclose} end={onclose ? close : undefined}>
      <Tabs {tabs} {current} label={both} onselect={(id) => (chosen = id)} />
    </Toolbar>
  {:else}
    <Toolbar title={tabs[0]?.label} rule tail={!!onclose} end={onclose ? close : undefined} />
  {/if}
{/snippet}

<Panel label={tabs.length === 1 ? tabs[0].label : both} head={titled ? head : undefined}>
  {#if current === 'layers' && settings.layers}
    <LayerPanel {draw} {messages} {...settings.layers} {basemaps} />
  {:else if current === 'legend'}
    <Legend {draw} {messages} />
  {/if}
</Panel>
