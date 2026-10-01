<!--
  SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
  SPDX-License-Identifier: AGPL-3.0-only
-->
<script lang="ts">
  import Globe from '@lucide/svelte/icons/globe';
  import {
    Button,
    Icon,
    type IconComponent,
    LayerTree,
    Markbox,
    type MenuModel,
    SectionHeader,
    Stack,
    Swatch,
    Text,
    Tree,
    type TreeMove,
    type TreeNode,
    TreeRow,
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
  import BasemapPanel from './BasemapPanel.svelte';

  // LayerPanel: kata's LayerTree of the stack from the front: the layers, their groups and their
  // features, and the datasets in their place among the layers.
  //
  // It keeps nothing of the drawing. The nodes are built from draw again on document.changed,
  // hidden.changed, options.changed, dataset.added, dataset.removed, dataset.reordered and the
  // `changed` of a dataset (its visibility, its rows); the selected rows are draw.selection.get(),
  // read again on selection.changed. Every action
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
  // The panel is a Stack of two sections. The first, Stack, is the tree, with the add menu in its
  // head. The second, Basemap, is the back of the stack: one row, apart from the tree as it is no
  // layer (it is not dragged, hidden, locked or selected), with the name of the basemap the map
  // shows. With two or more basemaps, a press on it opens the basemaps to choose from: through
  // `onopenbasemap` (the interface opens them on the right, in the place of the inspector), or,
  // without it (the panel put alone), in the place of the sections until they are closed.
  let {
    draw,
    messages,
    features = true,
    datasets = true,
    add = true,
    reorder = true,
    basemaps = null,
    basemapOpen = false,
    onopenbasemap,
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
    /** The basemaps of the basemap row */
    basemaps?: BasemapControl | null;
    /** Whether the basemaps to choose from are open (with `onopenbasemap`) */
    basemapOpen?: boolean;
    /** Opens the basemaps to choose from; the panel opens them itself when left out */
    onopenbasemap?: () => void;
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

  const nodes = $derived(tree.get());
  const index = $derived(indexNodes(nodes));
  const selected = $derived(selectedIds(selection.get()));

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
      }
    } else if (id === 'group') {
      draw.selection.group();
    }
  }

  const GLOBE_ICON = Globe as unknown as IconComponent;
  // The name of the basemap the map shows, else the word for it
  const basemapName = $derived(basemaps?.name() ?? m.basemap);
  // A basemap to choose: two or more
  const choosable = $derived(!!basemaps && basemaps.list.length >= 2);
  // The basemaps opened by the panel itself, put alone
  let ownOpen = $state(false);
  const choosing = $derived(choosable && (onopenbasemap ? basemapOpen : ownOpen));
  function openBasemaps() {
    if (onopenbasemap) onopenbasemap();
    else ownOpen = true;
  }
</script>

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
  {#if basemaps && choosing && !onopenbasemap}
    <BasemapPanel {basemaps} {messages} onclose={() => (ownOpen = false)} />
  {:else}
    <Stack gap={0}>
      <LayerTree
        label={m.stack}
        {nodes}
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
      <SectionHeader label={m.basemap} flush>
        <Tree label={m.basemap}>
          <TreeRow
            grip={false}
            sel={choosing}
            onclick={choosable ? openBasemaps : undefined}
            data-role="basemap"
          >
            <Markbox><Icon name={GLOBE_ICON} /></Markbox>
            <Text clamp>{basemapName}</Text>
          </TreeRow>
        </Tree>
      </SectionHeader>
    </Stack>
  {/if}
</div>

<style>
  .layer-panel {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
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
</style>
