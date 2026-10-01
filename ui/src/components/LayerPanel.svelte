<!--
  SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
  SPDX-License-Identifier: AGPL-3.0-only
-->
<script lang="ts">
  import MapIcon from '@lucide/svelte/icons/map';
  import PenLine from '@lucide/svelte/icons/pen-line';
  import {
    Divider,
    Dropdown,
    Icon,
    type IconComponent,
    LayerTree,
    ListItem,
    Markbox,
    MenuItem,
    type MenuModel,
    Swatch,
    Text,
    type TreeMove,
    type TreeNode,
  } from '@sakuzu/kata/svelte';
  import type { Feature } from '@sakuzu/maplibre-gl-draw';
  import type { Snippet } from 'svelte';
  import type { BasemapControl } from '../basemaps.js';
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
  // It keeps nothing of the drawing. The nodes are built from draw again on document.changed,
  // hidden.changed and options.changed, the selected rows are draw.selection.get(), read again on selection.changed,
  // and the active layer is draw.layers.getActive(). Every action calls the public API of draw:
  // the eye `update({ visible })` (and shows again what this client hid), the lock
  // `update({ locked })`, renaming the name (`properties.name` for a feature), a drop
  // `layers.reorder`, `groups.move` or `features.move`, a press `selection.set` (and
  // `layers.setActive` for a layer), the add menu `layers.create` and `selection.group`.
  //
  // The panel lists the stack from the front, and the basemap is its back: the last row, under the
  // tree, apart from it (a line between them), as it is no layer: it is not dragged, hidden, locked
  // or selected. It is laid out as a row of the tree at the root (the place of the chevron kept,
  // then the mark), so its mark and its label line up with those of the layers. It shows the name
  // of the basemap the map shows, and with two or more basemaps it opens their menu.
  let {
    draw,
    messages,
    features = true,
    add = true,
    reorder = true,
    basemaps = null,
  }: {
    draw: LayerPanelDraw;
    messages: Box<Messages>;
    /** Whether the features show under the layers and the groups */
    features?: boolean;
    /** Whether the add menu shows */
    add?: boolean;
    /** Whether the rows can be dragged */
    reorder?: boolean;
    /** The basemaps of the last row, or null for no row */
    basemaps?: BasemapControl | null;
  } = $props();

  const m = $derived(messages.get());
  const tree = $derived(
    // options.changed: the default look of each type gives the color of the marks
    follow(draw, ['document.changed', 'hidden.changed', 'options.changed'], () =>
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

  const MAP_ICON = MapIcon as unknown as IconComponent;
  const basemapName = $derived(basemaps?.name() ?? null);
  const currentBasemap = $derived(basemaps?.current.get() ?? null);
  const basemapMenu = $derived(!!basemaps && basemaps.list.length >= 2);
  // The place of the chevron, the mark, the label, the name and, with the menu, its chevron
  const basemapColumns = $derived(
    [
      'auto auto',
      basemapName === null ? 'minmax(0, 1fr)' : 'auto minmax(0, 1fr)',
      basemapMenu ? 'auto' : '',
    ]
      .filter(Boolean)
      .join(' '),
  );
</script>

{#snippet basemapCells()}
  <span class="seat" aria-hidden="true"></span>
  <Markbox><Icon name={MAP_ICON} /></Markbox>
  <Text clamp>{m.basemap}</Text>
  {#if basemapName !== null}
    <Text clamp muted>{basemapName}</Text>
  {/if}
  {#if basemapMenu}
    <Icon name="chevron-down" />
  {/if}
{/snippet}

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
  {#if basemaps}
    <Divider />
    <div class="basemap" data-role="basemap">
      {#if basemapMenu}
        <Dropdown menu block>
          {#snippet trigger(toggle, open)}
            <ListItem
              columns={basemapColumns}
              aria-haspopup="menu"
              aria-expanded={open}
              onclick={toggle}
            >
              {@render basemapCells()}
            </ListItem>
          {/snippet}
          {#snippet panel(close)}
            {#each basemaps.list as item (item.id)}
              <MenuItem
                checked={item.id === currentBasemap}
                aria-current={item.id === currentBasemap ? 'true' : undefined}
                data-id={item.id}
                onclick={() => {
                  close();
                  basemaps.set(item.id);
                }}
              >
                {item.label}
              </MenuItem>
            {/each}
          {/snippet}
        </Dropdown>
      {:else}
        <ListItem columns={basemapColumns} plain>
          {@render basemapCells()}
        </ListItem>
      {/if}
    </div>
  {/if}
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
  .basemap {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  /* The place of the chevron of a row of the tree that does not open (TreeRow's seat) */
  .seat {
    width: var(--kata-height-icon-button);
  }
  /* The name of the basemap, after the label, stands at the end of the row */
  .basemap :global([data-role='list-item'] > .kata-text + .kata-text) {
    text-align: end;
  }
</style>
