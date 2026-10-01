<!--
  SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
  SPDX-License-Identifier: AGPL-3.0-only
-->
<script lang="ts">
  import {
    AttributeList,
    Button,
    Footer,
    InspectorFrame,
    InspectorRow,
    InspectorSection,
    ReadValue,
    Row,
    Textarea,
  } from '@sakuzu/kata/svelte';
  import type { FeaturePatch } from '@sakuzu/maplibre-gl-draw';
  import {
    attributeAdd,
    attributePatch,
    attributeRemove,
    attributeRows,
    descriptionPatch,
    featureDescription,
    featureName,
    namePatch,
  } from '../inspector/attributes.js';
  import { type MeasureKey, measure } from '../inspector/measure.js';
  import { applicableOperations } from '../inspector/operations.js';
  import { sharedStyleKeys } from '../inspector/style.js';
  import type {
    InspectorDraw,
    InspectorSectionSpec,
    InspectorSettings,
    InspectorTab,
  } from '../inspector/types.js';
  import { type FeatureView, typeLabel } from '../inspector/view.js';
  import type { Messages } from '../messages.js';
  import BufferDialog from './BufferDialog.svelte';
  import StyleFields from './StyleFields.svelte';

  // FeatureInspector: the inspector of one feature in kata's InspectorFrame. The title is its
  // name (properties.name), changed where it stands; the subtitle its type, its layer and whether
  // this client hides it. The Style tab has the fields of its style, the sections of the
  // application, its measurements and the buffer; the Attributes tab its description
  // (properties.description) and its other attributes. The foot deletes it, locks or unlocks it,
  // and hides or shows it in this client.
  let {
    draw,
    view,
    m,
    settings,
    sections = [],
    tab = $bindable('style'),
    onclose,
  }: {
    draw: InspectorDraw;
    view: FeatureView;
    m: Messages;
    settings: InspectorSettings;
    /** The sections of the application that apply to the feature */
    sections?: InspectorSectionSpec[];
    /** The tab chosen last, kept while the selection changes */
    tab?: InspectorTab;
    onclose?: () => void;
  } = $props();

  const uid = $props.id();
  const feature = $derived(view.feature);
  const editable = $derived(view.editable);
  const rows = $derived(
    settings.measurements ? measure(feature, settings.units, m.numberLocale) : [],
  );
  const buffer = $derived(
    settings.operations && applicableOperations([feature]).includes('buffer'),
  );
  const hasStyle = $derived(
    sharedStyleKeys([feature]).length > 0 || sections.length > 0 || rows.length > 0 || buffer,
  );
  const tabs = $derived(
    settings.tabs
      .filter((t) => t !== 'style' || hasStyle)
      .map((id) => ({ id, label: id === 'style' ? m.styleTab : m.attributesTab })),
  );
  const current = $derived(tabs.some((t) => t.id === tab) ? tab : tabs[0]?.id);
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
        {feature.locked ? m.unlockAction : m.lockAction}
      </Button>
      <Button onclick={toggleHidden}>{view.hidden ? m.showAction : m.hideAction}</Button>
    {/snippet}
  </Footer>
{/snippet}

<InspectorFrame
  title={editable ? name : name || typeLabel(feature.type, m)}
  ontitle={editable ? (next) => update(namePatch(next)) : undefined}
  {subtitle}
  tabs={tabs.length > 1 ? tabs : []}
  {current}
  onselect={(id) => (tab = id as InspectorTab)}
  {onclose}
  end={foot}
>
  {#if current === 'style'}
    <StyleFields
      {draw}
      features={[feature]}
      applied={[view.applied]}
      {editable}
      {m}
      {sections}
    />
    {#if rows.length > 0}
      <InspectorSection title={m.measurements}>
        {#each rows as row (row.key)}
          <InspectorRow label={m[MEASURE_LABELS[row.key]]}>
            <ReadValue value={row.value} mono />
          </InspectorRow>
        {/each}
      </InspectorSection>
    {/if}
    {#if buffer}
      <InspectorSection title={m.operations}>
        <Row wrap>
          <Button disabled={!editable} onclick={() => (bufferOpen = true)}>{m.opBuffer}</Button>
        </Row>
      </InspectorSection>
    {/if}
  {:else if current === 'attributes'}
    <InspectorSection title={m.details}>
      <InspectorRow label={m.description} for="{uid}-description">
        <Textarea
          id="{uid}-description"
          value={featureDescription(feature)}
          disabled={!editable}
          onchange={(e) => update(descriptionPatch(e.currentTarget.value))}
        />
      </InspectorRow>
    </InspectorSection>
    <InspectorSection title={m.attributesTab} flush>
      <AttributeList
        items={attributes}
        readonly={!editable}
        onchange={(index, item) => update(attributePatch(feature, index, item))}
        onadd={editable ? (item) => update(attributeAdd(feature, item)) : undefined}
        onremove={editable ? (index) => update(attributeRemove(feature, index)) : undefined}
      />
    </InspectorSection>
  {/if}
</InspectorFrame>

{#if buffer}
  <BufferDialog bind:open={bufferOpen} {draw} features={[feature]} units={settings.units} {m} />
{/if}
