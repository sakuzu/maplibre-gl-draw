<!--
  SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
  SPDX-License-Identifier: AGPL-3.0-only
-->
<script lang="ts">
  import { List, ListItem, SectionHeader, Stack, State, Swatch, Text } from '@sakuzu/kata/svelte';
  import { legendBlocks } from '../layers/legend.js';
  import type { Messages } from '../messages.js';
  import { type Box, follow } from '../store.js';
  import type { LegendDraw } from '../types.js';

  // Legend: for each layer with a style rule, from the front, its name and the rows core derives
  // from the rule (deriveLegend), each a Swatch and a label. It only reads: the rules are changed
  // with draw.layers.update. It is built again on document.changed.
  let {
    draw,
    messages,
  }: {
    draw: LegendDraw;
    messages: Box<Messages>;
  } = $props();

  const m = $derived(messages.get());
  const legend = $derived(
    follow(draw, ['document.changed'], () => legendBlocks(draw, messages.get())),
  );
  const blocks = $derived(legend.get());
</script>

<div class="legend" data-role="legend">
  {#if blocks.length === 0}
    <State text={m.noLegend} />
  {:else}
    <Stack gap={0}>
      {#each blocks as block (block.layerId)}
        <SectionHeader label={block.name} flush>
          <List label={block.name}>
            {#each block.entries as entry, i (i)}
              <ListItem columns="auto minmax(0, 1fr)" plain>
                <Swatch shape={block.shape} color={entry.color} />
                <Text clamp>{entry.label}</Text>
              </ListItem>
            {/each}
          </List>
        </SectionHeader>
      {/each}
    </Stack>
  {/if}
</div>

<style>
  .legend {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
</style>
