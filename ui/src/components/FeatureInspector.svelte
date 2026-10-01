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
    Stack,
    Tabs,
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
  // a subtitle (its type, its layer and whether this client hides it). Under the head, with no
  // tab, are its measurements and its description (properties.description), changed where it
  // stands. Then the tabs: Style has the fields of its style, the sections of the application and
  // the buffer; Attributes the list of its other attributes. The foot deletes it, locks or
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
  const subtitle = $derived(
    [typeLabel(feature.type, m), view.layer?.name, view.hidden ? m.hiddenState : '']
      .filter(Boolean)
      .join(' · '),
  );
  const name = $derived(featureName(feature));
  const attributes = $derived(attributeRows(feature));
  const both = $derived(`${m.styleTab}, ${m.attributesTab}`);
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
  end={foot}
>
  {#if measurements.length > 0 || layout.description}
    <Block>
      <Stack gap="sm">
        {#if measurements.length > 0}
          <Kv items={measurements} />
        {/if}
        {#if layout.description}
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
        {/if}
      </Stack>
    </Block>
  {/if}
  {#if tabs.length > 1 && current}
    <Tabs {tabs} {current} label={both} onselect={(id) => (tab = id as InspectorTab)} />
  {/if}
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
</InspectorFrame>

{#if layout.buffer}
  <BufferDialog bind:open={bufferOpen} {draw} features={[feature]} units={settings.units} {m} />
{/if}
