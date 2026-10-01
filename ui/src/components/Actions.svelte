<!--
  SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
  SPDX-License-Identifier: AGPL-3.0-only
-->
<script lang="ts">
  import {
    Button,
    Floating,
    formatShortcut,
    Icon,
    Kbd,
    SectionHeader,
    Text,
    Toggle,
  } from '@sakuzu/kata/svelte';
  import { type ActionsState, normalizeKey, runAction } from '../actions.js';
  import type { Messages } from '../messages.js';
  import type { ActionSpec } from '../types.js';

  // Actions: the card of the actions of the application at the bottom left of the map. A small
  // head with the title and a button that folds the card, then a row for each action: a switch
  // (toggle) whose state is checked(), or a button (action), each with its key at the end and its
  // hint, if any, as a caption under it. The rows read checked() and disabled() again whenever the
  // version changes (after each run, and on refresh()).
  //
  // Folded, the card is one button with the title that opens it again. Below 48rem (the shell's
  // narrow band) it starts folded, so that it does not cover the map.
  //
  // It stands gap-md from the left (from the left region, while it stands beside the map) and
  // gap-md above maplibre-gl's controls of the bottom left corner (the scale), whose height is
  // measured. Where the card or the corner reaches the toolbar across, as on a narrow map, it goes
  // above the toolbar as well. The room it takes at the bottom is set on the root
  // (--mgd-ui-actions-reserve), and the layer panel floating at the left ends gap-md above it.
  let {
    actions,
    messages,
    title,
    keys = true,
    narrow = false,
    startOpen = true,
    corner,
    beside = false,
  }: {
    actions: ActionsState;
    messages: Messages;
    /** The title of the card */
    title: string;
    /** Whether the keys are shown (only when the shortcuts are on) */
    keys?: boolean;
    /** Whether the map is in the shell's narrow band (below 48rem) */
    narrow?: boolean;
    /** Whether the card starts unfolded where the band allows it */
    startOpen?: boolean;
    /** The element whose bottom left corner holds maplibre-gl's controls (the map's container) */
    corner?: HTMLElement | null;
    /** Whether the left region stands beside the map, open: the card goes to its right */
    beside?: boolean;
  } = $props();

  /** The custom property on the root with the room the card takes at the bottom (root.css) */
  const RESERVE = '--mgd-ui-actions-reserve';

  const list = $derived(actions.list.get());
  const version = $derived(actions.version.get());

  // Folded below 48rem, open above unless the application asks for it folded; a press changes
  // it until the band changes
  let open = $state(true);
  $effect(() => {
    open = !narrow && startOpen;
  });

  const read = (spec: ActionSpec, what: 'checked' | 'disabled'): boolean => {
    void version;
    return spec[what]?.() === true;
  };
  const kbd = (spec: ActionSpec) =>
    keys && spec.shortcut ? formatShortcut(normalizeKey(spec.shortcut)) : undefined;

  // ---- The place ----
  let card = $state<HTMLElement>();
  // The height above the bottom of the map that the card stands on (gap-md is added in the style)
  let bottom = $state(0);

  /** The floating element of the card */
  const floating = () => card?.querySelector<HTMLElement>(':scope > [data-role="floating"]');
  const bottomLeft = () =>
    corner?.querySelector<HTMLElement>(
      ':scope > .maplibregl-control-container > .maplibregl-ctrl-bottom-left',
    ) ?? null;
  const toolbar = (root: HTMLElement) =>
    root.querySelector<HTMLElement>('[data-region="bottom"] [data-role="drawbar"]');

  function place() {
    const root = card?.parentElement;
    const el = floating();
    if (!root || !el) return;
    const box = root.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const scale = bottomLeft();
    // The corner's height from the bottom of the map, without the lift that moves its look
    const cornerHeight = scale ? scale.offsetHeight : 0;
    const b = toolbar(root)?.getBoundingClientRect();
    let next = cornerHeight;
    if (b && b.width > 0 && b.height > 0) {
      const band = Math.max(0, box.bottom - b.top);
      const s = scale?.getBoundingClientRect();
      const cornerReaches = !!s && s.width > 0 && cornerHeight > 0 && s.right > b.left;
      const cardReaches = r.right > b.left && r.left < b.right;
      if (cornerReaches) next = band + cornerHeight;
      else if (cardReaches) next = Math.max(band, cornerHeight);
    }
    // The room the card takes at the bottom, which a panel floating at the left keeps clear of:
    // its height and its distance from the bottom, with the place it is moving to
    const reserve = `${Math.max(0, Math.round(r.height + (box.bottom - r.bottom) + (next - bottom)))}px`;
    if (root.style.getPropertyValue(RESERVE) !== reserve) root.style.setProperty(RESERVE, reserve);
    bottom = next;
  }

  $effect(() => {
    const el = card && floating();
    const root = card?.parentElement;
    if (!el || !root) return;
    void open;
    void list;
    void beside;
    if (typeof ResizeObserver === 'undefined') {
      place();
      return () => root.style.removeProperty(RESERVE);
    }
    const observer = new ResizeObserver(() => place());
    let bar: HTMLElement | null = null;
    const watch = () => {
      bar = toolbar(root);
      observer.disconnect();
      for (const target of [root, el, bar, bottomLeft()]) {
        if (target) observer.observe(target);
      }
    };
    watch();
    // The toolbar comes and goes with the shell's regions: look for it again when they change
    const shell = root.querySelector('[data-role="shell"]');
    const mutations =
      typeof MutationObserver === 'undefined' || !shell
        ? null
        : new MutationObserver(() => {
            if (toolbar(root) === bar) return;
            watch();
            place();
          });
    mutations?.observe(shell as Node, { childList: true, subtree: true });
    place();
    return () => {
      observer.disconnect();
      mutations?.disconnect();
      root.style.removeProperty(RESERVE);
    };
  });
</script>

<svelte:window onresize={place} />

{#snippet head()}
  <Button
    variant="ghost"
    icon
    aria-label={messages.collapse}
    aria-expanded="true"
    onclick={() => {
      open = false;
    }}
  >
    <Icon name="chevron-down" />
  </Button>
{/snippet}

<!-- Outside the shell's regions: the root gives it the pointer (data-role="actions") -->
<div data-role="actions" bind:this={card}>
  <Floating
    left={beside ? 'calc(var(--kata-width-panel) + var(--kata-gap-md))' : 'md'}
    bottom={`calc(var(--kata-gap-md) + ${bottom}px)`}
  >
    {#if open}
      <div class="card">
        <SectionHeader label={title} actions={head}>
          {#each list as spec (spec.id)}
            {@const key = kbd(spec)}
            <div class="item" data-action={spec.id}>
              <div class="row">
                <div class="control">
                  {#if spec.kind === 'toggle'}
                    <Toggle
                      between
                      label={spec.label}
                      disabled={read(spec, 'disabled')}
                      bind:checked={() => read(spec, 'checked'), () => runAction(actions, spec)}
                    />
                  {:else}
                    <Button
                      block
                      disabled={read(spec, 'disabled')}
                      onclick={() => runAction(actions, spec)}
                    >
                      {spec.label}
                    </Button>
                  {/if}
                </div>
                {#if key}<Kbd bare>{key}</Kbd>{/if}
              </div>
              {#if spec.hint}<Text role="caption" muted>{spec.hint}</Text>{/if}
            </div>
          {/each}
        </SectionHeader>
      </div>
    {:else}
      <!-- The floating card gives it its line, as to the icon buttons floating over the map -->
      <Button
        variant="ghost"
        aria-expanded="false"
        onclick={() => {
          open = true;
        }}
      >
        {title}
      </Button>
    {/if}
  </Floating>
</div>

<style>
  .card {
    min-width: var(--kata-width-rail);
    max-width: var(--kata-width-panel);
  }
  .item {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .row {
    display: flex;
    align-items: center;
    gap: var(--kata-gap-sm);
    min-width: 0;
  }
  /* The rows are as high as a switch: their buttons are small buttons, as in a list */
  .control {
    flex: 1 1 auto;
    min-width: 0;
    --kata-box: var(--kata-height-button-sm);
  }
</style>
