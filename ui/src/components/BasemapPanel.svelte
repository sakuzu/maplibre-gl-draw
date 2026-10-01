<!--
  SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
  SPDX-License-Identifier: AGPL-3.0-only
-->
<script lang="ts">
  import { Button, Icon, List, ListItem, Panel, Stack, Text, Toolbar } from '@sakuzu/kata/svelte';
  import type { BasemapControl } from '../basemaps.js';
  import type { Messages } from '../messages.js';
  import type { Box } from '../store.js';

  // BasemapPanel: the basemaps to choose from, which the basemap row of the layer panel opens. A
  // Panel whose head is the title and a close button, over a List of the basemaps: each row is
  // the preview of the basemap (its `preview`, a CSS image, gradient or color; a neutral square
  // without one), its label, and a check on the current one. Choosing one switches the basemap
  // through the control (`map.setStyle`) and leaves the panel open. The close button and Escape
  // call onclose.
  let {
    basemaps,
    messages,
    onclose,
  }: {
    basemaps: BasemapControl;
    messages: Box<Messages>;
    /** Called by the close button */
    onclose: () => void;
  } = $props();

  const m = $derived(messages.get());
  const current = $derived(basemaps.current.get());
</script>

{#snippet close()}
  <Button variant="ghost" icon aria-label={m.close} onclick={onclose}>
    <Icon name="x" />
  </Button>
{/snippet}

{#snippet head()}
  <Toolbar rule tail title={m.basemap} end={close} />
{/snippet}

<!-- Escape closes it, before anything around it hears the key -->
<div
  class="basemap-panel"
  data-role="basemap-panel"
  role="none"
  onkeydown={(e) => {
    if (e.key !== 'Escape' || e.defaultPrevented) return;
    e.preventDefault();
    onclose();
  }}
>
  <Panel label={m.basemap} {head}>
    <Stack gap={0}>
      <List label={m.basemap}>
        {#each basemaps.list as item (item.id)}
          <ListItem
            sel={item.id === current}
            columns="auto minmax(0, 1fr) auto"
            aria-current={item.id === current ? 'true' : undefined}
            data-id={item.id}
            onclick={() => basemaps.set(item.id)}
          >
            <span class="preview" style:--preview={item.preview} aria-hidden="true"></span>
            <Text clamp>{item.label}</Text>
            {#if item.id === current}<Icon name="check" />{:else}<span></span>{/if}
          </ListItem>
        {/each}
      </List>
    </Stack>
  </Panel>
</div>

<style>
  .basemap-panel {
    display: flex;
    min-width: 0;
    min-height: 0;
    height: 100%;
    max-height: 100%;
  }
  /* The preview of a basemap: a square of a badge's height, painted by its `preview` (--preview,
     any value of background), neutral without one, and edged so that a white one shows on the
     panel */
  .preview {
    display: inline-block;
    flex: none;
    width: var(--kata-height-badge);
    height: var(--kata-height-badge);
    background: var(--preview, var(--kata-color-fill));
    background-size: cover;
    box-shadow: inset 0 0 0 var(--kata-border-width) var(--kata-color-line);
  }
</style>
