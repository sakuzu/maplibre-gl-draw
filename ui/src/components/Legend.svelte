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

  // Legend: for each layer and each dataset with a style rule, in the order of the stack from the
  // front, its name and the rows core derives from the rule (deriveLegend), each a Swatch and a
  // label. It only reads: the rules are changed with draw.layers.update and a dataset's
  // setStyleRule. It is built again on document.changed (a rule of a layer, the stacking order),
  // dataset.added, dataset.removed and dataset.reordered, and on the `changed` of a dataset with
  // the reason `style` (its rule) or `rows` (the shape of its swatches follows its rows).
  let {
    draw,
    messages,
  }: {
    draw: LegendDraw;
    messages: Box<Messages>;
  } = $props();

  const m = $derived(messages.get());
  const legend = $derived(
    follow(
      draw,
      ['document.changed', 'dataset.added', 'dataset.removed', 'dataset.reordered'],
      () => legendBlocks(draw, messages.get()),
    ),
  );
  // A dataset tells of a change of its rule and of its rows on itself
  const datasetList = $derived(
    follow(draw, ['dataset.added', 'dataset.removed'], () => draw.datasets.list()),
  );
  $effect(() => {
    const refresh = legend.refresh;
    const offs = datasetList.get().map((dataset) =>
      dataset.on('changed', ({ reason }) => {
        if (reason === 'style' || reason === 'rows') refresh();
      }),
    );
    return () => {
      for (const off of offs) off();
    };
  });
  const blocks = $derived(legend.get());
</script>

<div class="legend" data-role="legend">
  {#if blocks.length === 0}
    <State text={m.noLegend} />
  {:else}
    <Stack gap={0}>
      {#each blocks as block (`${block.kind}:${block.id}`)}
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
