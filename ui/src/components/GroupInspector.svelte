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
  } from '@sakuzu/kata/svelte';
  import type { Group, Layer } from '@sakuzu/maplibre-gl-draw';
  import type { InspectorDraw } from '../inspector/types.js';
  import type { Messages } from '../messages.js';

  // GroupInspector: a group in kata's InspectorFrame: its name, changed where it stands, whether
  // it is visible and whether it is locked. The foot takes its features out of it (the group
  // goes) or deletes it with its features. The fields have no title: the subtitle of the head
  // already says it is a group.
  let {
    draw,
    group,
    layer,
    readOnly,
    m,
    onclose,
  }: {
    draw: InspectorDraw;
    group: Group;
    /** The layer it is in */
    layer: Layer | undefined;
    readOnly: boolean;
    m: Messages;
    onclose?: () => void;
  } = $props();

  const lockedHere = $derived(group.locked || layer?.locked === true);
  const fields = $derived<FieldSpec[]>([
    {
      key: 'visible',
      kind: 'toggle',
      label: m.visibleField,
      value: group.visible,
      disabled: readOnly,
    },
    {
      key: 'locked',
      kind: 'toggle',
      label: m.lockedField,
      value: group.locked,
      disabled: readOnly,
    },
  ]);

  function onchange(key: string, value: unknown) {
    if (key === 'visible' || key === 'locked') {
      draw.groups.update(group.id, { [key]: value === true });
    }
  }

  function rename(name: string) {
    if (name !== '') draw.groups.update(group.id, { name });
  }
</script>

{#snippet foot()}
  <Footer>
    {#snippet lead()}
      <Button
        variant="danger"
        disabled={readOnly || lockedHere}
        onclick={() => draw.selection.delete()}
      >
        {m.delete}
      </Button>
    {/snippet}
    {#snippet secondary()}
      <Button disabled={readOnly} onclick={() => draw.selection.ungroup()}>
        {m.ungroupAction}
      </Button>
    {/snippet}
  </Footer>
{/snippet}

<InspectorFrame
  title={group.name}
  ontitle={readOnly || lockedHere ? undefined : rename}
  subtitle={[m.typeGroup, layer?.name].filter(Boolean).join(' · ')}
  {onclose}
  end={foot}
>
  <Block><FieldList {fields} {onchange} /></Block>
</InspectorFrame>
