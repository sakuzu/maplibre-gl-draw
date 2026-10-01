<!--
  SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
  SPDX-License-Identifier: AGPL-3.0-only
-->
<script lang="ts">
  import PenLine from '@lucide/svelte/icons/pen-line';
  import {
    Icon,
    type IconComponent,
    LayerTree,
    Markbox,
    type MenuModel,
    Swatch,
    type TreeMove,
    type TreeNode,
  } from '@sakuzu/kata/svelte';
  import type { Feature } from '@sakuzu/maplibre-gl-draw';
  import type { Snippet } from 'svelte';
  import { planMove } from '../layers/move.js';
  import {
    buildNodes,
    canDropInto,
    canGroup,
    indexNodes,
    type NodeKind,
    selectedIds,
    selectionOf,
  } from '../layers/tree.js';
  import type { Messages } from '../messages.js';
  import { type Box, follow } from '../store.js';
  import type { LayerPanelDraw } from '../types.js';

  // LayerPanel: kata's LayerTree of the layers, their groups and their features, from the front.
  //
  // It keeps nothing of the drawing. The nodes are built from draw again on document.changed and
  // hidden.changed, the selected rows are draw.selection.get(), read again on selection.changed,
  // and the active layer is draw.layers.getActive(). Every action calls the public API of draw:
  // the eye `update({ visible })` (and shows again what this client hid), the lock
  // `update({ locked })`, renaming the name (`properties.name` for a feature), a drop
  // `layers.reorder`, `groups.move` or `features.move`, a press `selection.set` (and
  // `layers.setActive` for a layer), the add menu `layers.create` and `selection.group`.
  let {
    draw,
    messages,
    features = true,
    add = true,
    reorder = true,
  }: {
    draw: LayerPanelDraw;
    messages: Box<Messages>;
    /** Whether the features show under the layers and the groups */
    features?: boolean;
    /** Whether the add menu shows */
    add?: boolean;
    /** Whether the rows can be dragged */
    reorder?: boolean;
  } = $props();

  const m = $derived(messages.get());
  const tree = $derived(
    follow(draw, ['document.changed', 'hidden.changed'], () =>
      buildNodes(draw, messages.get(), { features }),
    ),
  );
  const selection = $derived(follow(draw, ['selection.changed'], () => draw.selection.get()));
  // Core has no event for a change of the active layer alone: it is read again on a change of the
  // document, and after the panel changes it
  const active = $derived(
    follow(draw, ['document.changed'], () => draw.layers.getActive()?.id ?? null),
  );

  const nodes = $derived(tree.get());
  const index = $derived(indexNodes(nodes));
  const selected = $derived(selectedIds(selection.get()));
  const activeId = $derived(active.get());

  // The groups that are closed; every other group is open, so a new layer opens
  let collapsed = $state<string[]>([]);
  const expanded = $derived(
    [...index.values()]
      .filter(({ node }) => node.children && !collapsed.includes(node.id))
      .map(({ node }) => node.id),
  );
  function setExpanded(ids: string[]) {
    const open = new Set(ids);
    collapsed = [...index.values()]
      .filter(({ node }) => node.children && !open.has(node.id))
      .map(({ node }) => node.id);
  }
  // What is selected elsewhere (on the map) shows: the groups around it open
  $effect(() => {
    const around = new Set<string>();
    for (const id of selected) {
      for (let p = index.get(id)?.parentId ?? null; p; p = index.get(p)?.parentId ?? null) {
        around.add(p);
      }
    }
    if (around.size === 0) return;
    const next = collapsed.filter((id) => !around.has(id));
    if (next.length !== collapsed.length) collapsed = next;
  });

  const addMenu = $derived<MenuModel[] | undefined>(
    add
      ? [
          { id: 'layer', label: m.newLayer },
          {
            id: 'group',
            label: m.newGroup,
            disabled: !canGroup(selection.get(), (id) => draw.features.get(id)),
          },
        ]
      : undefined,
  );

  const kindOf = (id: string) => index.get(id)?.node.kind as NodeKind | undefined;

  // The kind of the row pressed last, read before the tree reports the new selection
  let pressed: { id: string; kind: NodeKind } | undefined;
  function onclickcapture(e: MouseEvent) {
    const item = (e.target as Element | null)?.closest?.('[data-sortable-item]');
    const id = item?.getAttribute('data-id');
    const kind = id ? kindOf(id) : undefined;
    pressed = id && kind ? { id, kind } : undefined;
  }

  function onselect(ids: string[]) {
    const last = pressed;
    pressed = undefined;
    const next = selectionOf(ids, kindOf, last?.kind);
    if (!next) {
      draw.selection.clear();
      return;
    }
    draw.selection.set(next.type, next.ids);
    if (next.type === 'layer') {
      const layerId = last?.kind === 'layer' ? last.id : next.ids[next.ids.length - 1];
      draw.layers.setActive(layerId);
      active.refresh();
    }
  }

  function onvisible(id: string, visible: boolean) {
    const kind = kindOf(id);
    if (!kind) return;
    if (visible && draw.hidden.has(id)) draw.hidden.remove(id);
    const entity = index.get(id)?.node.data as { visible: boolean } | undefined;
    if (entity?.visible === visible) return;
    if (kind === 'layer') draw.layers.update(id, { visible });
    else if (kind === 'group') draw.groups.update(id, { visible });
    else draw.features.update(id, { visible });
  }

  function onlock(id: string, locked: boolean) {
    const kind = kindOf(id);
    if (kind === 'layer') draw.layers.update(id, { locked });
    else if (kind === 'group') draw.groups.update(id, { locked });
    else if (kind === 'feature') draw.features.update(id, { locked });
  }

  function onrename(id: string, value: string) {
    const kind = kindOf(id);
    const name = value.trim();
    if (kind === 'feature') {
      // An empty name removes it: the feature is named by its type again
      const feature = index.get(id)?.node.data as Feature;
      if ((feature.properties?.name ?? '') === name) return;
      draw.features.update(id, { properties: { name: name === '' ? undefined : name } });
      return;
    }
    if (name === '') return;
    if (kind === 'layer') draw.layers.update(id, { name });
    else if (kind === 'group') draw.groups.update(id, { name });
  }

  function onmove(move: TreeMove) {
    const plan = planMove(move, nodes);
    if (!plan) return;
    if (plan.kind === 'layers') draw.layers.reorder(plan.order);
    else if (plan.kind === 'group') draw.groups.move(plan.id, plan.to);
    else draw.features.move(plan.id, plan.to);
  }

  function onadd(id: string) {
    if (id === 'layer') {
      const layer = draw.layers.create({});
      if (layer) {
        draw.layers.setActive(layer.id);
        active.refresh();
      }
    } else if (id === 'group') {
      draw.selection.group();
    }
  }

  const ACTIVE_ICON = PenLine as unknown as IconComponent;
</script>

{#snippet row(node: TreeNode, name: Snippet<[TreeNode]>)}
  {#if node.icon}
    <Markbox>
      {#if node.iconColor}
        <Swatch shape="icon" icon={node.icon} color={node.iconColor} />
      {:else}
        <Icon name={node.icon} />
      {/if}
    </Markbox>
  {/if}
  {@render name(node)}
  {#if node.kind === 'layer' && node.id === activeId}
    <span class="active" role="img" aria-label={m.activeLayer} title={m.activeLayer}>
      <Icon name={ACTIVE_ICON} tone="blue" />
    </span>
  {/if}
{/snippet}

<div class="layer-panel" data-role="layer-panel" onclickcapture={onclickcapture}>
  <LayerTree
    label={m.layers}
    {nodes}
    head={add}
    bind:expanded={() => expanded, setExpanded}
    bind:selected={() => selected, () => {}}
    {onselect}
    {onvisible}
    {onlock}
    {onrename}
    onmove={reorder ? onmove : undefined}
    canDrop={canDropInto}
    {addMenu}
    {onadd}
    addLabel={m.add}
    {row}
  />
</div>

<style>
  .layer-panel {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .active {
    display: inline-flex;
    flex: none;
  }
</style>
