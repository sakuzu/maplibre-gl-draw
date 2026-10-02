<!--
  SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
  SPDX-License-Identifier: AGPL-3.0-only
-->
<script lang="ts">
  import {
    AttributeList,
    Block,
    Button,
    Footer,
    InlineEdit,
    InspectorFrame,
    InspectorSection,
    Kv,
    Pair,
    Row,
  } from '@sakuzu/kata/svelte';
  import type { FeaturePatch } from '@sakuzu/maplibre-gl-draw';
  import {
    attributeAdd,
    attributePatch,
    attributeRemove,
    attributeRows,
    descriptionPatch,
    featureName,
    namePatch,
  } from '../inspector/attributes.js';
  import type { MeasureKey } from '../inspector/measure.js';
  import type {
    InspectorDraw,
    InspectorSectionSpec,
    InspectorSettings,
    InspectorTab,
  } from '../inspector/types.js';
  import { type FeatureView, featureLayout, typeLabel } from '../inspector/view.js';
  import type { Messages } from '../messages.js';
  import BufferDialog from './BufferDialog.svelte';
  import StyleFields from './StyleFields.svelte';

  // FeatureInspector: the inspector of one feature in kata's InspectorFrame, laid out as
  // featureLayout gives it. The head is its name (properties.name), changed where it stands, and
  // a subtitle (its type, its layer and whether this client hides it). Under the head are its
  // measurements (InspectorFrame's underHead, which stays while the content scrolls), then the
  // tabs (InspectorFrame's tabs). The content starts with its description
  // (properties.description), changed where it stands, on every tab; then Style has the fields
  // of its style (with no title: the tab names them), the sections of the application and the
  // buffer, and Attributes the list of its other attributes. The foot deletes it, locks or
  // unlocks it, and hides or shows it in this client.
  let {
    draw,
    view,
    m,
    settings,
    sections = [],
    tab = $bindable(),
    onclose,
  }: {
    draw: InspectorDraw;
    view: FeatureView;
    m: Messages;
    settings: InspectorSettings;
    /** The sections of the application that apply to the feature */
    sections?: InspectorSectionSpec[];
    /**
     * The tab chosen last, kept while the selection changes; the first tab opens while none is
     * chosen or the chosen one is not shown
     */
    tab?: InspectorTab;
    onclose?: () => void;
  } = $props();

  const feature = $derived(view.feature);
  const editable = $derived(view.editable);
  const layout = $derived(featureLayout(view, settings, sections.length, m.numberLocale));
  const tabs = $derived(
    layout.tabs.map((id) => ({ id, label: id === 'style' ? m.styleTab : m.attributesTab })),
  );
  const current = $derived(tabs.some((t) => t.id === tab) ? tab : tabs[0]?.id);
  // The tabs show when there are two
  const shownTabs = $derived(tabs.length > 1 ? tabs : []);
  const subtitle = $derived(
    [typeLabel(feature.type, m), view.layer?.name, view.hidden ? m.hiddenState : '']
      .filter(Boolean)
      .join(' · '),
  );
  const name = $derived(featureName(feature));
  const attributes = $derived(attributeRows(feature));
  let bufferOpen = $state(false);

  const MEASURE_LABELS: Record<MeasureKey, keyof Messages> = {
    longitude: 'measureLongitude',
    latitude: 'measureLatitude',
    length: 'measureLength',
    area: 'measureArea',
    perimeter: 'measurePerimeter',
    radius: 'measureRadius',
    points: 'measurePoints',
  };
  const measurements = $derived(
    layout.measurements.map((row) => ({ k: m[MEASURE_LABELS[row.key]], v: row.value, mono: true })),
  );

  function update(patch: FeaturePatch | null) {
    if (patch) draw.features.update(feature.id, patch);
  }

  function toggleHidden() {
    if (view.hidden) draw.hidden.remove(feature.id);
    else draw.hidden.add(feature.id);
  }
</script>

{#snippet measured()}
  <Block><Kv items={measurements} /></Block>
{/snippet}

{#snippet panel()}
  {#if current === 'style'}
    <StyleFields
      {draw}
      features={[feature]}
      applied={[view.applied]}
      {editable}
      {m}
      {sections}
    />
    {#if layout.buffer}
      <InspectorSection title={m.operations}>
        <Row wrap>
          <Button disabled={!editable} onclick={() => (bufferOpen = true)}>{m.opBuffer}</Button>
        </Row>
      </InspectorSection>
    {/if}
  {:else if current === 'attributes'}
    <AttributeList
      items={attributes}
      readonly={!editable}
      onchange={(index, item) => update(attributePatch(feature, index, item))}
      onadd={editable ? (item) => update(attributeAdd(feature, item)) : undefined}
      onremove={editable ? (index) => update(attributeRemove(feature, index)) : undefined}
    />
  {/if}
{/snippet}

{#snippet foot()}
  <Footer>
    {#snippet lead()}
      <Button variant="danger" disabled={!editable} onclick={() => draw.selection.delete()}>
        {m.delete}
      </Button>
    {/snippet}
    {#snippet secondary()}
      <Button
        disabled={view.readOnly}
        onclick={() => draw.features.update(feature.id, { locked: !feature.locked })}
      >
        {feature.locked ? m.unlock : m.lock}
      </Button>
      <Button onclick={toggleHidden}>{view.hidden ? m.show : m.hide}</Button>
    {/snippet}
  </Footer>
{/snippet}

<InspectorFrame
  title={editable ? name : name || typeLabel(feature.type, m)}
  ontitle={editable ? (next) => update(namePatch(next)) : undefined}
  {subtitle}
  {onclose}
  tabs={shownTabs}
  current={current ?? ''}
  onselect={(id) => (tab = id as InspectorTab)}
  underHead={measurements.length > 0 ? measured : undefined}
  end={foot}
>
  {#if layout.description}
    <Block>
      <Pair label={m.description} top>
        <InlineEdit
          value={layout.description.text}
          placeholder={m.addDescription}
          label={layout.description.text ? m.description : m.addDescription}
          multiline
          editable={layout.description.editable}
          onCommit={(next) => update(descriptionPatch(next))}
        />
      </Pair>
    </Block>
  {/if}
  {@render panel()}
</InspectorFrame>

{#if layout.buffer}
  <BufferDialog bind:open={bufferOpen} {draw} features={[feature]} units={settings.units} {m} />
{/if}
