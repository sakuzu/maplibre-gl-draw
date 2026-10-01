<!--
  SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
  SPDX-License-Identifier: AGPL-3.0-only
-->
<script lang="ts">
  import { InspectorRow, NativeSelect, NumberInput, ProcessDialog } from '@sakuzu/kata/svelte';
  import type { Feature } from '@sakuzu/maplibre-gl-draw';
  import {
    type DistanceUnit,
    distanceUnits,
    runBuffer,
    toMeters,
  } from '../inspector/operations.js';
  import type { InspectorDraw, Units } from '../inspector/types.js';
  import type { Messages } from '../messages.js';

  // BufferDialog: kata's ProcessDialog that asks the distance of a buffer (a number and a unit of
  // the units of the inspector) and, optionally, the segments of a full circle, then makes the
  // buffers with draw.features.buffer and selects them. Core's error shows in the dialog.
  let {
    open = $bindable(false),
    draw,
    features,
    units,
    m,
  }: {
    open?: boolean;
    draw: InspectorDraw;
    /** The features to surround */
    features: Feature[];
    units: Units;
    m: Messages;
  } = $props();

  const uid = $props.id();
  const unitChoices = $derived(distanceUnits(units));
  let distance = $state<number | null>(null);
  let unit = $state<DistanceUnit | undefined>();
  let segments = $state<number | null>(null);
  let error = $state<string | undefined>();

  const currentUnit = $derived(unit && unitChoices.includes(unit) ? unit : unitChoices[0]);
  const ready = $derived(
    distance !== null &&
      Number.isFinite(distance) &&
      distance !== 0 &&
      (segments === null || segments > 0),
  );

  function run() {
    if (!ready || distance === null) return;
    try {
      const made = runBuffer(
        draw,
        features,
        toMeters(distance, currentUnit),
        segments === null ? undefined : segments,
      );
      if (made === null || made.length === 0) {
        error = m.bufferFailed;
        return;
      }
      error = undefined;
      open = false;
    } catch (e) {
      error = e instanceof Error ? e.message : m.bufferFailed;
    }
  }
</script>

<ProcessDialog
  bind:open
  title={m.opBuffer}
  description={m.bufferDescription}
  runLabel={m.bufferRun}
  {error}
  disabled={!ready}
  onrun={run}
  oncancel={() => (error = undefined)}
  size="sm"
>
  <InspectorRow label={m.bufferDistance} for="{uid}-distance">
    <NumberInput id="{uid}-distance" bind:value={distance} step="any" />
  </InspectorRow>
  <InspectorRow label={m.bufferUnit} for="{uid}-unit">
    <NativeSelect
      id="{uid}-unit"
      options={unitChoices.map((u) => ({ value: u, label: u }))}
      value={currentUnit}
      onchange={(u) => (unit = u)}
    />
  </InspectorRow>
  <InspectorRow label={m.bufferSegments} for="{uid}-segments" hint={m.bufferSegmentsHint}>
    <NumberInput id="{uid}-segments" bind:value={segments} min={1} step={1} />
  </InspectorRow>
</ProcessDialog>
