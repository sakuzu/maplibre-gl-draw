<!--
  SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
  SPDX-License-Identifier: AGPL-3.0-only
-->
<script lang="ts">
  import { Divider, Popover, Text, Toggle } from '@sakuzu/kata/svelte';
  import type { RuntimeOptions, SnappingOptions } from '@sakuzu/maplibre-gl-draw';
  import { fillWord, type Messages } from '../messages.js';
  import { follow } from '../store.js';
  import type { ToolbarDraw } from '../types.js';

  // SnappingSettings: the popover the magnet of the toolbar opens, with a switch for snapping,
  // one for each kind of target under it, one for the rows of datasets, one for tracing and one
  // for moving shared vertices together, and below them the key that pauses snapping.
  //
  // It keeps nothing: every switch shows draw.options.get(), read again on options.changed, so a
  // change made by code shows too, and writes through draw.options.update.
  //
  // kata's Drawbar draws its buttons itself and a Popover draws its own trigger, so the popover
  // cannot hang from the magnet. It hangs from a box of its own, laid across the bar over the
  // magnet when it opens (along the top edge of the bar when the magnet is folded into the More
  // menu). While it is open the box takes the press on the magnet, so that the press closes it
  // instead of reaching the button, which would open it again. The toolbar calls toggle() when the
  // magnet is pressed.
  let {
    draw,
    messages,
    label,
  }: {
    draw: ToolbarDraw;
    messages: Messages;
    /** The name of the magnet, which finds it in the bar */
    label: string;
  } = $props();

  type Kind = keyof NonNullable<SnappingOptions['kinds']>;
  const KINDS: readonly { kind: Kind; word: keyof Messages }[] = [
    { kind: 'vertex', word: 'snapVertex' },
    { kind: 'edge', word: 'snapEdge' },
    { kind: 'intersection', word: 'snapIntersection' },
    { kind: 'guide', word: 'snapGuide' },
  ];

  const options = $derived(follow(draw, ['options.changed'], () => draw.options.get()));
  const now = $derived(options.get());
  const snapping = $derived(now.snapping ?? {});
  const enabled = $derived(snapping.enabled !== false);

  // The name of the key that pauses snapping, as the keyboard has it
  const mac =
    typeof navigator !== 'undefined' &&
    /mac|iphone|ipad|ipod/i.test(
      (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData
        ?.platform ??
        navigator.platform ??
        '',
    );
  const KEY_NAMES: Record<string, string> = mac
    ? { alt: 'Option', shift: 'Shift', ctrl: 'Control', meta: 'Command' }
    : { alt: 'Alt', shift: 'Shift', ctrl: 'Ctrl', meta: 'Meta' };
  const pauseKey = $derived(KEY_NAMES[snapping.disableKey ?? 'alt']);

  function update(patch: Partial<RuntimeOptions>) {
    draw.options.update(patch);
  }

  // The box the popover hangs from, in the coordinates of the element both it and the bar are
  // placed in
  let place = $state<HTMLElement>();
  let box = $state({ left: 0, top: 0, width: 0, height: 0 });
  let open = $state(false);
  let toggleOpen: (() => void) | undefined;

  function measure() {
    const bar = place?.parentElement?.querySelector<HTMLElement>(':scope > [data-role="drawbar"]');
    if (!place || !bar) return;
    const magnet = [...bar.querySelectorAll<HTMLElement>('button')]
      .filter((b) => b.getAttribute('aria-label') === label)
      .at(-1);
    const base = (place.offsetParent ?? place.parentElement) as HTMLElement;
    const from = base.getBoundingClientRect();
    // Across the bar from top to bottom, so that the popover keeps clear of the bar, and as wide
    // as the magnet
    const b = bar.getBoundingClientRect();
    const r = (magnet ?? bar).getBoundingClientRect();
    box = {
      left: r.left - from.left - base.clientLeft,
      top: b.top - from.top - base.clientTop,
      width: r.width,
      height: magnet ? b.height : 0,
    };
  }

  /** Opens the popover, or closes it when it is open */
  export function toggle() {
    if (!open) measure();
    toggleOpen?.();
  }

  // The popover's trigger hands over its toggle function and whether it is open
  function hold(toggleFn: () => void, isOpen: boolean) {
    return () => {
      toggleOpen = toggleFn;
      open = isOpen;
    };
  }
</script>

<svelte:window onresize={() => open && measure()} />

<div
  class="place"
  data-role="snapping"
  bind:this={place}
  style:left={`${box.left}px`}
  style:top={`${box.top}px`}
>
  <Popover align="end">
    {#snippet anchor(toggleFn, isOpen)}
      <span
        class="cover"
        class:open={isOpen}
        aria-hidden="true"
        style:width={`${box.width}px`}
        style:height={`${box.height}px`}
        onclick={toggleFn}
        {@attach hold(toggleFn, isOpen)}
      ></span>
    {/snippet}
    <Toggle
      between
      label={messages.snapping}
      checked={enabled}
      onchange={(on) => update({ snapping: { enabled: on } })}
    />
    {#each KINDS as { kind, word } (kind)}
      <Toggle
        between
        indent
        label={messages[word]}
        checked={snapping.kinds?.[kind] !== false}
        disabled={!enabled}
        onchange={(on) => update({ snapping: { kinds: { [kind]: on } } })}
      />
    {/each}
    <Divider />
    <Toggle
      between
      label={messages.snapDatasets}
      checked={snapping.datasets !== false}
      onchange={(on) => update({ snapping: { datasets: on } })}
    />
    <Toggle
      between
      label={messages.traceEdges}
      checked={now.tracing?.enabled !== false}
      onchange={(on) => update({ tracing: { enabled: on } })}
    />
    <Toggle
      between
      label={messages.sharedVertexDrag}
      checked={now.topology?.sharedVertexDrag === true}
      onchange={(on) => update({ topology: { sharedVertexDrag: on } })}
    />
    {#if pauseKey}
      <Text role="caption" muted>{fillWord(messages.snapPauseKey, { key: pauseKey })}</Text>
    {/if}
  </Popover>
</div>

<style>
  /* Placed over the magnet, above the bar (on its layer, after it); it lets the pointer through
     but on the popover, and on the box while the popover is open */
  .place {
    position: absolute;
    z-index: var(--kata-z-floating);
    pointer-events: none;
  }
  .place :global([data-role='popover']) {
    pointer-events: auto;
  }
  .cover {
    display: block;
  }
  .cover.open {
    pointer-events: auto;
  }
</style>
