<!--
  SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
  SPDX-License-Identifier: AGPL-3.0-only
-->
<script lang="ts">
  import { FieldList, InspectorSection } from '@sakuzu/kata/svelte';
  import type { Feature } from '@sakuzu/maplibre-gl-draw';
  import type { Attachment } from 'svelte/attachments';
  import type { InspectorField, InspectorSectionSpec } from '../inspector/types.js';

  // CustomSection: a section the application added. Its fields are drawn by kata's FieldList
  // and their changes go to the section's onchange; what render draws goes under them. render
  // runs again with the features whenever they change, after the function it returned is called.
  let {
    spec,
    features,
    editable,
  }: {
    spec: InspectorSectionSpec;
    features: Feature[];
    /** Whether the features can be edited now; the fields are disabled when they cannot */
    editable: boolean;
  } = $props();

  const fields = $derived.by((): InspectorField[] => {
    let out: InspectorField[] = [];
    try {
      out = spec.fields?.(features) ?? [];
    } catch (error) {
      console.error(`The inspector section "${spec.id}" failed to give its fields`, error);
    }
    return editable ? out : out.map((f) => ({ ...f, disabled: true }));
  });

  function draw(spec: InspectorSectionSpec, features: Feature[]): Attachment<HTMLElement> {
    return (element) => spec.render?.(element, features);
  }
</script>

<InspectorSection title={spec.title}>
  {#if fields.length > 0}
    <FieldList {fields} onchange={(key, value) => spec.onchange?.(key, value, features)} />
  {/if}
  {#if spec.render}
    <div data-section={spec.id} {@attach draw(spec, features)}></div>
  {/if}
</InspectorSection>
