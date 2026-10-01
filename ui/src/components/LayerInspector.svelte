<!--
  SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
  SPDX-License-Identifier: AGPL-3.0-only
-->
<script lang="ts">
  import {
    Block,
    Button,
    FieldList,
    type FieldSpec,
    Footer,
    InspectorFrame,
    InspectorRow,
    InspectorSection,
    ReadValue,
  } from '@sakuzu/kata/svelte';
  import type { Layer, StyleRule } from '@sakuzu/maplibre-gl-draw';
  import type { InspectorDraw } from '../inspector/types.js';
  import type { Messages } from '../messages.js';

  // LayerInspector: a layer in kata's InspectorFrame: its name, changed where it stands, its
  // opacity, whether it is visible and whether it is locked. Its style rule is shown and not
  // edited here (an application sets it with draw.layers.update). The foot deletes it, unless it
  // is the only layer. Its own fields have no title (the subtitle of the head already says it is
  // a layer); the style rule follows as a titled section.
  let {
    draw,
    layer,
    onlyLayer,
    readOnly,
    m,
    onclose,
  }: {
    draw: InspectorDraw;
    layer: Layer;
    /** Whether it is the only layer of the document, which is not deleted */
    onlyLayer: boolean;
    readOnly: boolean;
    m: Messages;
    onclose?: () => void;
  } = $props();

  const fields = $derived<FieldSpec[]>([
    {
      key: 'opacity',
      kind: 'slider',
      label: m.opacityField,
      value: Math.round(layer.opacity * 100),
      min: 0,
      max: 100,
      step: 1,
      unit: '%',
      disabled: readOnly || layer.locked,
    },
    {
      key: 'visible',
      kind: 'toggle',
      label: m.visibleField,
      value: layer.visible,
      disabled: readOnly,
    },
    {
      key: 'locked',
      kind: 'toggle',
      label: m.lockedField,
      value: layer.locked,
      disabled: readOnly,
    },
  ]);

  const RULES: Record<StyleRule['kind'], keyof Messages> = {
    single: 'ruleSingle',
    categorical: 'ruleCategorical',
    graduated: 'ruleGraduated',
    continuous: 'ruleContinuous',
  };
  const rule = $derived(layer.styleRule);

  function onchange(key: string, value: unknown) {
    if (key === 'opacity' && typeof value === 'number') {
      draw.layers.update(layer.id, { opacity: Math.min(1, Math.max(0, value / 100)) });
    } else if (key === 'visible' || key === 'locked') {
      draw.layers.update(layer.id, { [key]: value === true });
    }
  }

  function rename(name: string) {
    if (name !== '') draw.layers.update(layer.id, { name });
  }
</script>

{#snippet foot()}
  <Footer>
    {#snippet lead()}
      <Button
        variant="danger"
        disabled={readOnly || onlyLayer || layer.locked}
        onclick={() => draw.selection.delete()}
      >
        {m.deleteLayer}
      </Button>
    {/snippet}
  </Footer>
{/snippet}

<InspectorFrame
  title={layer.name}
  ontitle={readOnly || layer.locked ? undefined : rename}
  subtitle={m.typeLayer}
  {onclose}
  end={foot}
>
  <Block><FieldList {fields} {onchange} /></Block>
  <InspectorSection title={m.styleRule}>
    <InspectorRow label={m.ruleKind} hint={m.ruleHint}>
      <ReadValue value={rule ? m[RULES[rule.kind]] : m.ruleNone} muted={!rule} />
    </InspectorRow>
    {#if rule && rule.kind !== 'single'}
      <InspectorRow label={m.ruleProperty}>
        <ReadValue value={rule.property} mono />
      </InspectorRow>
    {/if}
  </InspectorSection>
</InspectorFrame>
