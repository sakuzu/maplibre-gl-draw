<!--
  SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
  SPDX-License-Identifier: AGPL-3.0-only
-->
<script lang="ts">
  import { Button, Footer, Row, SelectionSummary } from '@sakuzu/kata/svelte';
  import type { Feature, FeatureStyleResolved } from '@sakuzu/maplibre-gl-draw';
  import { applicableOperations, type OperationId, runOperation } from '../inspector/operations.js';
  import type {
    InspectorDraw,
    InspectorSectionSpec,
    InspectorSettings,
  } from '../inspector/types.js';
  import { kindCounts } from '../inspector/view.js';
  import { fillWord, type Messages } from '../messages.js';
  import BufferDialog from './BufferDialog.svelte';
  import StyleFields from './StyleFields.svelte';

  // SelectionInspector: several features in kata's SelectionSummary. It counts them by type,
  // shows the fields of the style they share (a field whose values differ is mixed) and the
  // sections of the application that apply to all of them, and offers the operations that apply
  // and grouping. Delete is in the lead of the foot, as in the inspector of one feature.
  let {
    draw,
    features,
    applied,
    editable,
    readOnly,
    m,
    settings,
    sections = [],
    onclose,
  }: {
    draw: InspectorDraw;
    features: Feature[];
    applied: (FeatureStyleResolved | undefined)[];
    editable: boolean;
    readOnly: boolean;
    m: Messages;
    settings: InspectorSettings;
    sections?: InspectorSectionSpec[];
    onclose?: () => void;
  } = $props();

  const operations = $derived(settings.operations ? applicableOperations(features) : []);
  const oneLayer = $derived(features.every((f) => f.layerId === features[0]?.layerId));
  let bufferOpen = $state(false);

  const LABELS: Record<OperationId, keyof Messages> = {
    union: 'opUnion',
    intersection: 'opIntersection',
    difference: 'opDifference',
    split: 'opSplit',
    buffer: 'opBuffer',
  };

  function run(op: OperationId) {
    if (op === 'buffer') {
      bufferOpen = true;
      return;
    }
    try {
      runOperation(draw, op, features);
    } catch (error) {
      console.error(error);
    }
  }
</script>

{#snippet fields()}
  <StyleFields {draw} {features} {applied} {editable} {m} {sections} />
{/snippet}

{#snippet actions()}
  <Row wrap>
    {#each operations as op (op)}
      <Button disabled={!editable} onclick={() => run(op)}>{m[LABELS[op]]}</Button>
    {/each}
    <Button disabled={readOnly || !oneLayer} onclick={() => draw.selection.group()}>
      {m.groupAction}
    </Button>
  </Row>
{/snippet}

{#snippet foot()}
  <Footer>
    {#snippet lead()}
      <Button variant="danger" disabled={readOnly} onclick={() => draw.selection.delete()}>
        {m.delete}
      </Button>
    {/snippet}
  </Footer>
{/snippet}

<SelectionSummary
  count={features.length}
  kinds={kindCounts(features, m)}
  title={fillWord(m.selectedCount, { count: features.length })}
  {fields}
  {actions}
  {foot}
  {onclose}
/>

{#if operations.includes('buffer')}
  <BufferDialog bind:open={bufferOpen} {draw} {features} units={settings.units} {m} />
{/if}
