<!--
  SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
  SPDX-License-Identifier: AGPL-3.0-only
-->
<script lang="ts">
  import { Button, FieldList, Icon, InspectorSection } from '@sakuzu/kata/svelte';
  import type { Feature, FeatureStyleResolved } from '@sakuzu/maplibre-gl-draw';
  import {
    applyStyle,
    ownStyleKeys,
    resetPatch,
    styleFields,
    stylePatch,
  } from '../inspector/style.js';
  import type { InspectorDraw, InspectorSectionSpec } from '../inspector/types.js';
  import type { Messages } from '../messages.js';
  import CustomSection from './CustomSection.svelte';

  // StyleFields: the section of the style of features, and the sections the application added
  // that apply to them. The fields are those the features share, with the values they are drawn
  // with; a change is written into the style of every feature in one transaction, and the reset
  // removes the keys the features set themselves.
  let {
    draw,
    features,
    applied,
    editable,
    m,
    sections = [],
  }: {
    draw: InspectorDraw;
    features: Feature[];
    /** The look of each feature, in the order of features */
    applied: (FeatureStyleResolved | undefined)[];
    /** Whether the features can be edited now */
    editable: boolean;
    m: Messages;
    /** The sections of the application that apply to the features */
    sections?: InspectorSectionSpec[];
  } = $props();

  const fields = $derived.by(() => {
    const looks = new Map(features.map((f, i) => [f.id, applied[i]]));
    return styleFields(features, (id) => looks.get(id), m, !editable);
  });
  const own = $derived(ownStyleKeys(features));
  const ids = $derived(features.map((f) => f.id));

  function onchange(key: string, value: unknown) {
    applyStyle(draw, ids, stylePatch(key, value));
  }

  function reset() {
    applyStyle(draw, ids, resetPatch(own));
  }
</script>

{#snippet resetButton()}
  <Button variant="ghost" icon aria-label={m.resetStyle} onclick={reset}>
    <Icon name="undo-2" />
  </Button>
{/snippet}

{#if fields.length > 0}
  <InspectorSection
    title={m.styleTab}
    end={editable && own.length > 0 ? resetButton : undefined}
  >
    <FieldList {fields} {onchange} />
  </InspectorSection>
{/if}
{#each sections as spec (spec.id)}
  <CustomSection {spec} {features} {editable} />
{/each}
