<!--
  SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
  SPDX-License-Identifier: AGPL-3.0-only
-->
<script lang="ts">
  import { Panel, Tabs, Toolbar } from '@sakuzu/kata/svelte';
  import type { Messages } from '../messages.js';
  import type { Box } from '../store.js';
  import type { LayerPanelDraw, LeftSettings, LegendDraw } from '../types.js';
  import LayerPanel from './LayerPanel.svelte';
  import Legend from './Legend.svelte';

  // LeftPanel: the left region of the interface, a Panel with the layer panel and the legend in
  // two tabs (Tabs in the Toolbar of its head). With one of them only, the head is its title.
  let {
    draw,
    messages,
    settings,
  }: {
    draw: LayerPanelDraw & LegendDraw;
    messages: Box<Messages>;
    settings: LeftSettings;
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
  const titled = $derived(tabs.length > 1 || current !== 'layers' || !settings.layers?.add);
</script>

{#snippet head()}
  {#if tabs.length > 1}
    <Toolbar rule>
      <Tabs {tabs} {current} label={both} onselect={(id) => (chosen = id)} />
    </Toolbar>
  {:else}
    <Toolbar title={tabs[0]?.label} rule />
  {/if}
{/snippet}

<Panel label={tabs.length === 1 ? tabs[0].label : both} head={titled ? head : undefined}>
  {#if current === 'layers' && settings.layers}
    <LayerPanel {draw} {messages} {...settings.layers} />
  {:else if current === 'legend'}
    <Legend {draw} {messages} />
  {/if}
</Panel>
