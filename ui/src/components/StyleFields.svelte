<!--
  SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
  SPDX-License-Identifier: AGPL-3.0-only
-->
<script lang="ts">
  import { Block, FieldList, LinkAction, Stack } from '@sakuzu/kata/svelte';
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

  // StyleFields: the fields of the style of features, and the sections the application added that
  // apply to them. The fields are those the features share, with the values they are drawn with; a
  // change is written into the style of every feature in one transaction, and the reset removes the
  // keys the features set themselves. The fields have no title of their own: they come first, under
  // the Style tab or the head that already names them, in a Block (the content of a panel has no
  // padding), and the reset is a text action after them. The sections of the application follow
  // with their titles.
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

{#if fields.length > 0}
  <Block>
    <Stack gap="sm">
      <FieldList {fields} {onchange} />
      {#if editable && own.length > 0}
        <LinkAction icon="undo-2" onclick={reset}>{m.resetStyle}</LinkAction>
      {/if}
    </Stack>
  </Block>
{/if}
{#each sections as spec (spec.id)}
  <CustomSection {spec} {features} {editable} />
{/each}
