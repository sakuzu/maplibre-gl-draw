<!--
  SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
  SPDX-License-Identifier: AGPL-3.0-only
-->
<script lang="ts">
  import MapIcon from '@lucide/svelte/icons/map';
  import PenLine from '@lucide/svelte/icons/pen-line';
  import {
    Button,
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
    DATASET_ICON,
    formatCount,
    indexNodes,
    isSelectable,
    type LayerTreeNode,
    type RowKind,
    selectedIds,
    selectionOf,
  } from '../layers/tree.js';
  import { fillWord, type Messages } from '../messages.js';
  import { type Box, follow } from '../store.js';
  import type { LayerPanelDraw } from '../types.js';

  // LayerPanel: kata's LayerTree of the stack from the front: the layers, their groups and their
  // features, and the datasets in their place among the layers.
  //
  // It keeps nothing of the drawing. The nodes are built from draw again on document.changed,
  // hidden.changed, options.changed, dataset.added, dataset.removed, dataset.reordered and the
  // `changed` of a dataset (its visibility, its rows); the selected rows are draw.selection.get(),
  // read again on selection.changed, and the active layer is draw.layers.getActive(). Every action
  // calls the public API of draw: the eye `update({ visible })` (and shows again what this client
  // hid) or a dataset's `setVisible`, the lock `update({ locked })`, renaming the name
  // (`properties.name` for a feature), a drop `layers.reorder`, `groups.move` or `features.move`,
  // a press `selection.set` (and `layers.setActive` for a layer), the add menu `layers.create` and
  // `selection.group`.
  //
  // A dataset is a row of the stack, not an item of the document: it has the eye and no lock, it
  // is not renamed, and a press on it does nothing (the selection stays). It is dragged among the
  // layers when it is placed among them (`layer-order`); in front of or behind every layer it
  // stays. A layer of more features than the limit lists none: its one child counts them, and has
  // no eye, no lock and no grip, and a press on it does nothing. The eye and the
  // lock are drawn here (LayerTree's `actions`), for each kind its own.
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
    datasets = true,
    add = true,
    reorder = true,
    basemaps = null,
  }: {
    draw: LayerPanelDraw;
    messages: Box<Messages>;
    /**
     * The features under the layers and the groups: true for up to FEATURE_LIMIT in a layer, a
     * number for that many, false for none
     */
    features?: boolean | number;
    /** Whether the datasets show as rows of the stack */
    datasets?: boolean;
    /** Whether the add menu shows */
    add?: boolean;
    /** Whether the rows can be dragged */
    reorder?: boolean;
    /** The basemaps of the last row, or null for no row */
    basemaps?: BasemapControl | null;
  } = $props();

  const m = $derived(messages.get());
  // The most features a layer lists by default: each row costs its drawing (about a
  // third of a millisecond), so a thousand rows stay well under a second
  const FEATURE_LIMIT = 1000;
  const tree = $derived(
    // options.changed: the default look of each type gives the color of the marks
    follow(
      draw,
      [
        'document.changed',
        'hidden.changed',
        'options.changed',
        'dataset.added',
        'dataset.removed',
        'dataset.reordered',
      ],
      () =>
        buildNodes(draw, messages.get(), {
          features: features !== false,
          limit: features === true ? FEATURE_LIMIT : features === false ? 0 : features,
          datasets,
        }),
    ),
  );
  // A dataset tells of a change of its visibility and of its rows on itself
  const datasetList = $derived(
    follow(draw, ['dataset.added', 'dataset.removed'], () =>
      datasets ? draw.datasets.list() : [],
    ),
  );
  $effect(() => {
    const refresh = tree.refresh;
    const offs = datasetList.get().map((dataset) =>
      dataset.on('changed', ({ reason }) => {
        if (reason === 'visibility' || reason === 'rows') refresh();
      }),
    );
    return () => {
      for (const off of offs) off();
    };
  });
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

  const rowKind = (id: string) => index.get(id)?.node.kind as RowKind | undefined;
  /** The kind of a row that is selected, or undefined */
  const kindOf = (id: string) => {
    const kind = rowKind(id);
    return isSelectable(kind) ? kind : undefined;
  };

  // The kind of the row pressed last, read before the tree reports the new selection
  let pressed: { id: string; kind: RowKind } | undefined;
  function onclickcapture(e: MouseEvent) {
    const item = (e.target as Element | null)?.closest?.('[data-sortable-item]');
    const id = item?.getAttribute('data-id');
    const kind = id ? rowKind(id) : undefined;
    pressed = id && kind ? { id, kind } : undefined;
  }

  function onselect(ids: string[]) {
    const last = pressed;
    pressed = undefined;
    // A row that is not selected (a dataset) leaves the selection as it is
    if (last && !isSelectable(last.kind)) return;
    const next = selectionOf(ids, kindOf, isSelectable(last?.kind) ? last.kind : undefined);
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
    const kind = rowKind(id);
    if (!kind) return;
    if (kind === 'dataset') {
      const dataset = draw.datasets.get(id);
      if (dataset && dataset.visible !== visible) dataset.setVisible(visible);
      return;
    }
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
  {@const own = node as LayerTreeNode}
  {#if own.kind === 'dataset'}
    <!-- Not renamed: the name is plain text. Placed in front of or behind every layer, it is not
         dragged, and shows no grip -->
    <span
      class="mark"
      role="img"
      aria-label={m.datasets}
      title={m.datasets}
      data-fixed={canDropInto(own, null) ? undefined : ''}
    >
      <Markbox><Icon name={DATASET_ICON} /></Markbox>
    </span>
    <Text clamp>{own.name}</Text>
    <span class="count"><Text muted tabular>{fillWord(m.rows, { count: formatCount(own.count ?? 0) })}</Text></span>
  {:else if own.kind === 'count'}
    <!-- The features a layer holds when it lists none: not pressed, not dragged -->
    <span class="many" data-fixed><Text muted clamp>{own.name}</Text></span>
  {:else}
    {#if own.icon}
      <Markbox>
        {#if own.iconColor}
          <Swatch shape="icon" icon={own.icon} color={own.iconColor} />
        {:else}
          <Icon name={own.icon} />
        {/if}
      </Markbox>
    {/if}
    {@render name(own)}
    {#if own.kind === 'layer' && own.id === activeId}
      <span class="active" role="img" aria-label={m.activeLayer} title={m.activeLayer}>
        <Icon name={ACTIVE_ICON} tone="blue" />
      </span>
    {/if}
  {/if}
{/snippet}

<!-- The eye and the lock of a row, as LayerTree draws them: an action in a state other than its
     default (hidden, locked) keeps showing. A dataset has the eye alone -->
{#snippet actions(node: TreeNode)}
  {#if node.kind !== 'count'}
    <Button
      variant="ghost"
      icon
      aria-label={node.visible ? m.hide : m.show}
      data-keep={node.visible ? undefined : ''}
      onclick={(e: MouseEvent) => {
        e.stopPropagation();
        onvisible(node.id, !node.visible);
      }}><Icon name={node.visible ? 'eye' : 'eye-off'} /></Button
    >
  {/if}
  {#if isSelectable(node.kind)}
    <Button
      variant="ghost"
      icon
      aria-label={node.locked ? m.unlock : m.lock}
      data-keep={node.locked ? '' : undefined}
      onclick={(e: MouseEvent) => {
        e.stopPropagation();
        onlock(node.id, !node.locked);
      }}><Icon name={node.locked ? 'lock' : 'lock-open'} /></Button
    >
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
    {onrename}
    onmove={reorder ? onmove : undefined}
    canDrop={canDropInto}
    {addMenu}
    {onadd}
    addLabel={m.add}
    {row}
    {actions}
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
  .active,
  .mark,
  .count {
    display: inline-flex;
    flex: none;
  }
  .many {
    display: flex;
    min-width: 0;
  }
  /* A row that is not dragged shows no grip (kata's TreeRow shows it on every row of a tree that
     is reordered) */
  .layer-panel :global([role='treeitem']:has([data-fixed]) [data-grip]) {
    display: none;
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
