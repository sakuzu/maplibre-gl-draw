<!--
  SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
  SPDX-License-Identifier: AGPL-3.0-only
-->
<script lang="ts">
  // MarkupIcon: an icon given as SVG markup by the application (the icon of a tool it adds),
  // drawn at the size of kata's icons. The markup is the application's own and is inserted as it
  // is.
  let { svg, class: className }: { svg: string; class?: string } = $props();
</script>

<span class={['markup', className]} aria-hidden="true">{@html svg}</span>

<style>
  .markup {
    display: block;
    flex: none;
    width: var(--kata-height-icon);
    height: var(--kata-height-icon);
  }
  .markup > :global(svg) {
    display: block;
    width: 100%;
    height: 100%;
  }
</style>
