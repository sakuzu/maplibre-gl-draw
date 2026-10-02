<!--
  SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
  SPDX-License-Identifier: AGPL-3.0-only
-->
<script lang="ts">
  import { Button, Panel, Row, SelectionSummary, State } from '@sakuzu/kata/svelte';
  import type { Feature } from '@sakuzu/maplibre-gl-draw';
  import { applicableSections } from '../inspector/sections.js';
  import type {
    InspectorDraw,
    InspectorSectionSpec,
    InspectorSettings,
    InspectorTab,
  } from '../inspector/types.js';
  import { INSPECTOR_EVENTS, readView } from '../inspector/view.js';
  import { fillWord, type Messages } from '../messages.js';
  import { type Box, follow } from '../store.js';
  import FeatureInspector from './FeatureInspector.svelte';
  import GroupInspector from './GroupInspector.svelte';
  import LayerInspector from './LayerInspector.svelte';
  import SelectionInspector from './SelectionInspector.svelte';

  // Inspector: the panel of what is selected. It keeps nothing of the drawing: what it shows is
  // read from the draw instance (readView) again after each change of the selection, of the
  // document, of what this client hides and of read-only, so a change made anywhere shows at
  // once. Nothing selected shows an empty state; one feature its inspector, several features a
  // summary, a layer or a group theirs. Every change calls the public API of the draw instance.
  // In a sheet (a narrow map) the panel takes the sheet's width; the width of a panel is for a
  // side pane.
  let {
    draw,
    messages,
    settings,
    sections,
    onclose,
    sheet = false,
  }: {
    draw: InspectorDraw;
    messages: Box<Messages>;
    settings: InspectorSettings;
    /** The sections the application added */
    sections: Box<InspectorSectionSpec[]>;
    /** Called by the close button; clears the selection when left out */
    onclose?: () => void;
    /** Whether it is in a sheet, whose width the panel takes */
    sheet?: boolean;
  } = $props();

  const view = $derived(follow(draw, INSPECTOR_EVENTS, () => readView(draw)));
  const v = $derived(view.get());
  const m = $derived(messages.get());
  // The tab chosen last, kept from one feature to the next; none until one is chosen, so the
  // first tab of the options opens
  let tab = $state<InspectorTab | undefined>();

  const close = () => (onclose ? onclose() : draw.selection.clear());
  const applying = (features: Feature[]) => applicableSections(sections.get(), features);
</script>

<div class="inspector" data-role="inspector" data-sheet={sheet ? '' : undefined}>
  {#if v.kind === 'feature'}
    <FeatureInspector
      {draw}
      view={v}
      {m}
      {settings}
      sections={applying([v.feature])}
      bind:tab
      onclose={close}
    />
  {:else if v.kind === 'features'}
    <SelectionInspector
      {draw}
      features={v.features}
      applied={v.applied}
      editable={v.editable}
      readOnly={v.readOnly}
      {m}
      {settings}
      sections={applying(v.features)}
      onclose={close}
    />
  {:else if v.kind === 'layer'}
    <LayerInspector
      {draw}
      layer={v.layer}
      onlyLayer={v.onlyLayer}
      readOnly={v.readOnly}
      {m}
      onclose={close}
    />
  {:else if v.kind === 'group'}
    <GroupInspector {draw} group={v.group} layer={v.layer} readOnly={v.readOnly} {m} onclose={close} />
  {:else if v.kind === 'items'}
    {@const label = v.type === 'layer' ? m.typeLayer : m.typeGroup}
    <SelectionSummary
      count={v.count}
      kinds={[{ label, count: v.count }]}
      title={fillWord(m.selectedCount, { count: v.count })}
      onclose={close}
    >
      {#snippet actions()}
        <Row wrap>
          <Button variant="danger" disabled={v.readOnly} onclick={() => draw.selection.delete()}>
            {m.delete}
          </Button>
        </Row>
      {/snippet}
    </SelectionSummary>
  {:else}
    <Panel label={m.inspector}>
      <State text={m.nothingSelected} note={m.nothingSelectedNote} />
    </Panel>
  {/if}
</div>

<style>
  .inspector {
    display: flex;
    min-width: 0;
    min-height: 0;
    height: 100%;
    max-height: 100%;
  }
  .inspector[data-sheet] > :global([data-role='panel']) {
    width: 100%;
  }
</style>
