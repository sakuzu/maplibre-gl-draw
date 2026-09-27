// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Layer Panel
 *
 * A panel that shows layers, groups and features in a tree view.
 *
 * It has an "Underlays" section at the bottom. An underlay is a
 * dataset (Dataset) and takes a path separate from the Store tree.
 * It has no lock; instead it offers toggling visibility, changing the stacking
 * order, switching between in front of and behind the objects, and removing.
 */

import type {
  Draw,
  Group as DrawGroup,
  Layer as DrawLayer,
  MoveTarget,
} from '@sakuzu/maplibre-gl-draw';
import type { UnderlayRegistry } from '../gis/underlay';
import {
  ADD_ICON,
  COLLAPSE_ICON,
  DELETE_ICON,
  EXPAND_ICON,
  GROUP_ICON,
  getFeatureIcon,
  HIDDEN_ICON,
  LAYER_ICON,
  LOCK_ICON,
  UNDERLAY_ICON,
  UNLOCK_ICON,
  VISIBLE_ICON,
} from './icons';
import type { DropPosition, SelectionType, TreeItem } from './types';

/**
 * Drag state
 */
interface DragState {
  itemId: string;
  itemType: 'layer' | 'group' | 'feature';
  parentId: string | null; // Layer ID or group ID
}

/**
 * Drop target
 */
interface DropTarget {
  type: 'feature' | 'group' | 'layer' | 'bottom' | 'group-out';
  id: string;
  position: DropPosition;
  parentId?: string;
}

/**
 * LayerPanel class
 */
export class LayerPanel {
  private container: HTMLElement;
  private draw: Draw;
  private tree: TreeItem[] = [];
  private expandedIds = new Set<string>();
  private selectedLayerId: string | null = null;
  private selectedGroupId: string | null = null;
  private dragState: DragState | null = null;
  private dropTarget: DropTarget | null = null;
  private isDragging = false;
  private renderScheduled = false;
  private underlays: UnderlayRegistry | null;

  constructor(container: HTMLElement, draw: Draw, underlays?: UnderlayRegistry) {
    this.container = container;
    this.draw = draw;
    this.underlays = underlays ?? null;

    // Attach the event listeners just once (event delegation)
    this.attachEventListeners();

    // Initial render
    this.scheduleRender();

    // Subscribe to Store events
    this.subscribeEvents();

    // Expand every layer in the initial state
    for (const layer of this.draw.layers.list()) {
      this.expandedIds.add(layer.id);
    }
  }

  /**
   * Clean up
   */
  destroy(): void {
    this.container.innerHTML = '';
  }

  /**
   * Subscribe to events
   */
  private subscribeEvents(): void {
    const scheduleRender = () => this.scheduleRender();

    // Feature events
    this.draw.on('feature.created', scheduleRender);
    this.draw.on('feature.updated', scheduleRender);
    this.draw.on('feature.deleted', scheduleRender);

    // Layer events
    this.draw.on('layer.created', scheduleRender);
    this.draw.on('layer.updated', scheduleRender);
    this.draw.on('layer.deleted', scheduleRender);
    this.draw.on('layer.reordered', scheduleRender);

    // Group events
    this.draw.on('group.created', scheduleRender);
    this.draw.on('group.updated', scheduleRender);
    this.draw.on('group.deleted', scheduleRender);

    // Selection events
    this.draw.on('selection.changed', scheduleRender);

    // Underlays being added or removed, and visibility toggles
    this.underlays?.onChange(scheduleRender);
  }

  /**
   * Schedule a render
   */
  private scheduleRender(): void {
    if (this.renderScheduled) return;
    this.renderScheduled = true;

    requestAnimationFrame(() => {
      this.renderScheduled = false;
      this.render();
    });
  }

  /**
   * Build the tree
   */
  private buildTree(): TreeItem[] {
    const layers = this.draw.layers.list();
    const groups = this.draw.groups.list();
    const selectedIds = new Set(this.selectedIds());
    const layerOrder = layers.map((layer) => layer.id);
    const activeLayerId = this.draw.layers.getActive()?.id;

    // Convert the groups into a Map
    const groupMap = new Map<string, DrawGroup>();
    for (const group of groups) {
      groupMap.set(group.id, group);
    }

    // Convert the layers into a Map
    const layerMap = new Map<string, DrawLayer>();
    for (const layer of layers) {
      layerMap.set(layer.id, layer);
    }

    // Build the tree (in reverse order: the end of the array is the foreground,
    // so it is shown at the top in the UI)
    const tree: TreeItem[] = [];

    for (let i = layerOrder.length - 1; i >= 0; i--) {
      const layerId = layerOrder[i];
      const layer = layerMap.get(layerId);
      if (!layer) continue;

      const layerItem: TreeItem = {
        type: 'layer',
        id: layer.id,
        name: layer.name,
        visible: layer.visible,
        locked: layer.locked,
        expanded: this.expandedIds.has(layer.id),
        selected: this.selectedLayerId === layer.id,
        active: layer.id === activeLayerId,
        parentId: undefined,
        children: [],
      };

      // Add the items inside the layer in reverse order
      for (let j = layer.items.length - 1; j >= 0; j--) {
        const itemId = layer.items[j];
        const group = groupMap.get(itemId);

        if (group) {
          // Case of a group
          const groupItem: TreeItem = {
            type: 'group',
            id: group.id,
            name: group.name,
            visible: group.visible,
            locked: group.locked,
            expanded: this.expandedIds.has(group.id),
            selected: this.selectedGroupId === group.id,
            parentId: layer.id,
            children: [],
          };

          // Add the features inside the group in reverse order
          // Use draw.features.get() so that hidden features are obtained as well
          for (let k = group.featureIds.length - 1; k >= 0; k--) {
            const featureId = group.featureIds[k];
            const feature = this.draw.features.get(featureId);
            if (feature) {
              groupItem.children!.push({
                type: 'feature',
                id: feature.id,
                name: (feature.properties?.name as string) || `Feature ${feature.id.slice(0, 6)}`,
                visible: feature.visible,
                locked: feature.locked,
                selected: selectedIds.has(feature.id),
                parentId: group.id,
                featureType: feature.type,
              });
            }
          }

          layerItem.children!.push(groupItem);
        } else {
          // Case of a standalone feature
          // Use draw.features.get() so that hidden features are obtained as well
          const feature = this.draw.features.get(itemId);
          if (feature) {
            layerItem.children!.push({
              type: 'feature',
              id: feature.id,
              name: (feature.properties?.name as string) || `Feature ${feature.id.slice(0, 6)}`,
              visible: feature.visible,
              locked: feature.locked,
              selected: selectedIds.has(feature.id),
              parentId: layer.id,
              featureType: feature.type,
            });
          }
        }
      }

      tree.push(layerItem);
    }

    return tree;
  }

  /**
   * Render
   */
  private render(): void {
    this.tree = this.buildTree();

    // Header
    const headerHtml = `
      <div class="layer-panel-header">
        <span class="layer-panel-title">Layers</span>
        <div class="layer-panel-actions">
          <button class="icon-btn" data-action="add-layer" title="Add a layer">
            ${ADD_ICON}
          </button>
          <button class="icon-btn" data-action="create-group" title="Group">
            ${GROUP_ICON}
          </button>
        </div>
      </div>
    `;

    // Tree
    let treeHtml = `<div class="layer-tree${this.isDragging ? ' dragging' : ''}">`;
    for (const item of this.tree) {
      treeHtml += this.renderItem(item, 0);
    }

    // Bottom drop zone (shown only while dragging)
    if (this.isDragging) {
      const isActive = this.dropTarget?.type === 'bottom';
      treeHtml += `
        <div class="drop-zone-bottom${isActive ? ' active' : ''}" data-drop-zone="bottom">
          Move to the back
        </div>
      `;
    }

    treeHtml += '</div>';

    this.container.innerHTML = headerHtml + treeHtml + this.renderUnderlaySection();
  }

  /**
   * Render the "Underlays" section
   *
   * When there is not a single underlay, it returns an empty string and the
   * whole section is left out.
   */
  private renderUnderlaySection(): string {
    const entries = this.underlays?.list() ?? [];
    if (entries.length === 0) return '';

    // list() runs from back to front. The list puts the front on top, so reverse it
    const rows = [...entries]
      .reverse()
      .map((entry) => {
        const hiddenClass = entry.visible ? '' : ' is-hidden';
        const visibilityIcon = entry.visible ? VISIBLE_ICON : HIDDEN_ICON;
        const visibilityTitle = entry.visible ? 'Hide' : 'Show';

        // Position within the same side. At either end it cannot be moved
        const side = entries.filter((other) => other.order === entry.order);
        const index = side.findIndex((other) => other.id === entry.id);
        const atFront = index === side.length - 1;
        const atBack = index === 0;

        const isAbove = entry.order === 'above-store';
        const orderLabel = isAbove ? 'Front' : 'Back';
        const orderTitle = isAbove ? 'Move behind the objects' : 'Move in front of the objects';

        return `
        <div class="underlay-item${hiddenClass}" data-underlay-id="${entry.id}">
          <div class="underlay-item-row">
            <button class="underlay-item-visibility" data-action="toggle-underlay-visibility"
                    data-id="${entry.id}" title="${visibilityTitle}">
              ${visibilityIcon}
            </button>
            <span class="layer-item-icon">${UNDERLAY_ICON}</span>
            <span class="layer-item-name" title="${this.escapeHtml(entry.name)}">
              ${this.escapeHtml(entry.name)}
            </span>
            <span class="underlay-item-count">${entry.count.toLocaleString()}</span>
            <span class="underlay-item-orders">
              <button class="underlay-item-order${isAbove ? ' is-above' : ''}"
                      data-action="toggle-underlay-order"
                      data-id="${entry.id}" title="${orderTitle}">${orderLabel}</button>
              <button class="underlay-item-move" data-action="move-underlay-front"
                      data-id="${entry.id}" title="One step to the front"
                      ${atFront ? 'disabled' : ''}>△</button>
              <button class="underlay-item-move" data-action="move-underlay-back"
                      data-id="${entry.id}" title="One step to the back"
                      ${atBack ? 'disabled' : ''}>▽</button>
            </span>
            <button class="underlay-item-delete" data-action="delete-underlay"
                    data-id="${entry.id}" title="Remove">
              ${DELETE_ICON}
            </button>
          </div>
        </div>
      `;
      })
      .join('');

    return `
      <div class="underlay-section">
        <div class="underlay-header">
          <span class="underlay-title">Underlays</span>
        </div>
        <div class="underlay-list">${rows}</div>
      </div>
    `;
  }

  /**
   * Render an item
   */
  private renderItem(item: TreeItem, depth: number): string {
    const indent = depth * 16;
    const hasChildren = item.children && item.children.length > 0;
    const isExpanded = item.expanded;

    // Expand button
    const expandButton =
      item.type !== 'feature' && hasChildren
        ? `<button class="layer-item-expand" data-action="toggle-expand" data-id="${item.id}">
            ${isExpanded ? EXPAND_ICON : COLLAPSE_ICON}
          </button>`
        : item.type !== 'feature'
          ? '<span class="layer-item-expand-spacer"></span>'
          : '';

    const visibilityIcon = item.visible ? VISIBLE_ICON : HIDDEN_ICON;

    let icon: string;
    if (item.type === 'layer') {
      icon = LAYER_ICON;
    } else if (item.type === 'group') {
      icon = GROUP_ICON;
    } else {
      icon = getFeatureIcon(item.featureType || 'Point');
    }

    const selectedClass = item.selected ? 'selected' : '';
    const activeClass = item.active ? 'active' : '';
    const hiddenClass = !item.visible ? 'is-hidden' : '';
    const draggingClass = this.dragState?.itemId === item.id ? 'dragging' : '';

    // Class for the drop indicator
    let dropClass = '';
    if (this.dropTarget && this.dropTarget.id === item.id && this.dropTarget.type !== 'group-out') {
      if (this.dropTarget.position === 'before') {
        dropClass = 'drop-above';
      } else if (this.dropTarget.position === 'after') {
        dropClass = 'drop-below';
      } else if (this.dropTarget.position === 'inside') {
        dropClass = 'drop-inside';
      }
    }

    let html = `
      <div class="layer-item ${selectedClass} ${activeClass} ${hiddenClass} ${draggingClass}"
           data-type="${item.type}"
           data-id="${item.id}"
           ${item.parentId ? `data-parent-id="${item.parentId}"` : ''}
           draggable="true">
        <div class="layer-item-row ${dropClass}" style="padding-left: ${indent + 8}px">
          ${expandButton}
          <button class="layer-item-visibility" data-action="toggle-visibility" data-id="${item.id}" data-type="${item.type}">
            ${visibilityIcon}
          </button>
          <button class="layer-item-lock" data-action="toggle-lock" data-id="${item.id}" data-type="${item.type}" title="${item.locked ? 'Unlock' : 'Lock'}">
            ${item.locked ? LOCK_ICON : UNLOCK_ICON}
          </button>
          <span class="layer-item-icon">${icon}</span>
          <span class="layer-item-name">${this.escapeHtml(item.name)}</span>
          <button class="layer-item-delete" data-action="delete-item" data-id="${item.id}" data-type="${item.type}" title="Delete">
            ${DELETE_ICON}
          </button>
        </div>
    `;

    // Render the children
    if (hasChildren && isExpanded) {
      html += '<div class="layer-item-children">';
      for (const child of item.children!) {
        html += this.renderItem(child, depth + 1);
      }

      // Inside a group, add a drop zone for moving out of the group
      if (this.isDragging && item.type === 'group' && this.dragState?.itemType === 'feature') {
        const isFromInsideGroup = this.dragState.parentId === item.id;
        const isActive = this.dropTarget?.type === 'group-out' && this.dropTarget.id === item.id;
        const label = isFromInsideGroup ? '↓ Out of the group' : `↓ Below ${item.name}`;
        html += `
          <div class="drop-zone-group-out${isActive ? ' active' : ''}"
               data-drop-zone="group-out"
               data-group-id="${item.id}">
            ${label}
          </div>
        `;
      }

      html += '</div>';
    }

    // For a layer, add a "drop onto this layer" zone
    if (this.isDragging && item.type === 'layer' && this.dragState?.itemType !== 'layer') {
      const isActive =
        this.dropTarget?.type === 'layer' &&
        this.dropTarget.id === item.id &&
        this.dropTarget.position === 'inside';
      html += `
        <div class="drop-zone-layer${isActive ? ' active' : ''}"
             data-drop-zone="layer"
             data-layer-id="${item.id}">
          → Move to ${this.escapeHtml(item.name)}
        </div>
      `;
    }

    html += '</div>';

    return html;
  }

  /**
   * Escape HTML
   */
  private escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  /**
   * Attach the event listeners
   */
  private attachEventListeners(): void {
    // Click events
    this.container.addEventListener('click', this.handleClick.bind(this));

    // Drag and drop events
    this.container.addEventListener('dragstart', this.handleDragStart.bind(this));
    this.container.addEventListener('dragover', this.handleDragOver.bind(this));
    this.container.addEventListener('dragleave', this.handleDragLeave.bind(this));
    this.container.addEventListener('drop', this.handleDrop.bind(this));
    this.container.addEventListener('dragend', this.handleDragEnd.bind(this));

    // Cancel the drag with the Escape key
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.isDragging) {
        this.clearDragState();
        this.scheduleRender();
      }
    });
  }

  /**
   * Click event handler
   */
  private handleClick(e: Event): void {
    const target = e.target as HTMLElement;
    const button = target.closest('button');
    const action = button?.dataset.action;

    if (action === 'add-layer') {
      this.addLayer();
      return;
    }

    if (action === 'create-group') {
      this.createGroup();
      return;
    }

    if (action === 'toggle-expand') {
      const id = button?.dataset.id;
      if (id) {
        this.toggleExpand(id);
      }
      return;
    }

    if (action === 'toggle-visibility') {
      const id = button?.dataset.id;
      const type = button?.dataset.type as SelectionType;
      if (id && type) {
        this.toggleVisibility(id, type);
      }
      return;
    }

    if (action === 'toggle-lock') {
      const id = button?.dataset.id;
      const type = button?.dataset.type as SelectionType;
      if (id && type) {
        this.toggleLock(id, type);
      }
      return;
    }

    if (action === 'toggle-underlay-visibility') {
      const id = button?.dataset.id;
      if (id) {
        this.underlays?.toggleVisible(id);
      }
      return;
    }

    if (action === 'move-underlay-front' || action === 'move-underlay-back') {
      const id = button?.dataset.id;
      if (id) {
        this.underlays?.move(id, action === 'move-underlay-front' ? 1 : -1);
      }
      return;
    }

    if (action === 'toggle-underlay-order') {
      const id = button?.dataset.id;
      if (id) {
        this.underlays?.toggleOrder(id);
      }
      return;
    }

    if (action === 'delete-underlay') {
      const id = button?.dataset.id;
      if (id) {
        this.underlays?.remove(id);
      }
      return;
    }

    if (action === 'delete-item') {
      const id = button?.dataset.id;
      const type = button?.dataset.type as SelectionType;
      if (id && type) {
        this.deleteItem(id, type);
      }
      return;
    }

    // Selecting an item
    const itemRow = target.closest('.layer-item-row');
    if (itemRow) {
      const item = itemRow.closest('.layer-item') as HTMLElement;
      const id = item?.dataset.id;
      const type = item?.dataset.type as SelectionType;

      if (id && type) {
        this.selectItem(id, type, e as MouseEvent);
      }
    }
  }

  /**
   * Add a layer
   */
  private addLayer(): void {
    const name = `Layer ${this.draw.layers.count() + 1}`;
    const layer = this.draw.layers.create({ name });
    // null when the write was refused because the drawing is read-only
    if (layer !== null) this.expandedIds.add(layer.id);
  }

  /**
   * Create a group
   */
  private createGroup(): void {
    const selectedIds = this.selectedIds();
    if (selectedIds.length < 2) {
      console.warn('Select two or more features to group them');
      return;
    }

    // Check whether the selected features belong to the same layer
    const features = selectedIds
      .map((id) => this.draw.features.get(id))
      .filter((f): f is NonNullable<typeof f> => f !== undefined);

    if (features.length === 0) return;

    const layerId = features[0].layerId;
    const allSameLayer = features.every((f) => f.layerId === layerId);

    if (!allSameLayer) {
      console.warn('Features on different layers cannot be grouped');
      return;
    }

    // Check whether any feature belongs to a group that actually exists.
    // When groupId is a stale value pointing at a deleted group, the feature is treated
    // as belonging to no group and regrouping is allowed.
    const hasGroupedFeature = features.some(
      (f) => f.groupId && this.draw.groups.get(f.groupId) !== undefined,
    );
    if (hasGroupedFeature) {
      console.warn('Features that already belong to a group cannot be regrouped');
      return;
    }

    const name = `Group ${this.draw.groups.count() + 1}`;
    const group = this.draw.groups.create({ featureIds: selectedIds, name });
    // null when the write was refused because the drawing is read-only
    if (group !== null) this.expandedIds.add(group.id);
  }

  /**
   * Toggle expanded / collapsed
   */
  private toggleExpand(id: string): void {
    if (this.expandedIds.has(id)) {
      this.expandedIds.delete(id);
    } else {
      this.expandedIds.add(id);
    }
    this.scheduleRender();
  }

  /**
   * Toggle visible / hidden
   */
  private toggleVisibility(id: string, type: SelectionType): void {
    if (type === 'layer') {
      const layer = this.draw.layers.get(id);
      if (layer) {
        this.draw.layers.update(id, { visible: !layer.visible });
      }
    } else if (type === 'group') {
      const group = this.draw.groups.get(id);
      if (group) {
        this.draw.groups.update(id, { visible: !group.visible });
      }
    } else if (type === 'feature') {
      const feature = this.draw.features.get(id);
      if (feature) {
        this.draw.features.update(id, { visible: !feature.visible });
      }
    }
  }

  /**
   * Toggle locked / unlocked
   */
  private toggleLock(id: string, type: SelectionType): void {
    if (type === 'layer') {
      const layer = this.draw.layers.get(id);
      if (layer) {
        this.draw.layers.update(id, { locked: !layer.locked });
      }
    } else if (type === 'group') {
      const group = this.draw.groups.get(id);
      if (group) {
        this.draw.groups.update(id, { locked: !group.locked });
      }
    } else if (type === 'feature') {
      const feature = this.draw.features.get(id);
      if (feature) {
        this.draw.features.update(id, { locked: !feature.locked });
      }
    }
  }

  /**
   * Delete an item (layer / group / feature)
   *
   * - layer: delete the whole layer (the features/groups under it are deleted
   *   as well). At least one layer is kept.
   * - group: delete the contents (features) of the group; a group that has
   *   become empty is deleted automatically.
   * - feature: delete the feature.
   */
  private deleteItem(id: string, type: SelectionType): void {
    if (type === 'layer') {
      if (this.draw.layers.count() <= 1) {
        console.warn('The last layer cannot be deleted');
        return;
      }
      this.draw.layers.delete(id);
      this.expandedIds.delete(id);
      return;
    }

    if (type === 'group') {
      const group = this.draw.groups.get(id);
      if (group) {
        // Delete the contents of the group. The group itself is deleted automatically
        // at the moment the last feature is removed.
        for (const featureId of [...group.featureIds]) {
          this.draw.features.delete(featureId);
        }
        // When an empty group (a group with no contents) was selected, delete the group itself
        if (this.draw.groups.get(id)) {
          this.draw.groups.delete(id);
        }
      }
      this.expandedIds.delete(id);
      return;
    }

    // feature
    this.draw.features.delete(id);
  }

  /**
   * Select an item
   */
  private selectItem(id: string, type: SelectionType, e: MouseEvent): void {
    if (type === 'layer') {
      this.selectedLayerId = id;
      this.selectedGroupId = null;
      this.draw.selection.clear();

      // Set the active layer
      this.draw.layers.setActive(id);

      // Dispatch a custom event
      this.container.dispatchEvent(
        new CustomEvent('layer-panel:layer-selected', {
          bubbles: true,
          detail: { id },
        }),
      );
    } else if (type === 'group') {
      this.selectedLayerId = null;
      this.selectedGroupId = id;

      // Select the features inside the group
      const group = this.draw.groups.get(id);
      if (group && group.featureIds.length > 0) {
        this.draw.selection.set('feature', group.featureIds);
      } else {
        this.draw.selection.clear();
      }

      // Dispatch a custom event
      this.container.dispatchEvent(
        new CustomEvent('layer-panel:group-selected', {
          bubbles: true,
          detail: { id },
        }),
      );
    } else if (type === 'feature') {
      this.selectedLayerId = null;
      this.selectedGroupId = null;

      if (e.shiftKey) {
        // The Shift key toggles multiple selection
        const currentIds = this.selectedIds();
        if (currentIds.includes(id)) {
          this.draw.selection.set(
            'feature',
            currentIds.filter((fid) => fid !== id),
          );
        } else {
          this.draw.selection.set('feature', [...currentIds, id]);
        }
      } else {
        this.draw.selection.set('feature', [id]);
      }
    }

    this.scheduleRender();
  }

  // === Drag & Drop ===

  /**
   * Drag start
   */
  private handleDragStart(e: DragEvent): void {
    const target = e.target as HTMLElement;
    const item = target.closest('.layer-item') as HTMLElement;
    if (!item) return;

    const itemId = item.dataset.id;
    const itemType = item.dataset.type as 'layer' | 'group' | 'feature';
    const parentId = item.dataset.parentId ?? null;

    if (!itemId) return;

    this.dragState = { itemId, itemType, parentId };
    this.isDragging = true;

    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', itemId);
    }

    // Re-render so that the dragging UI is shown
    this.scheduleRender();
  }

  /**
   * Drag over
   */
  private handleDragOver(e: DragEvent): void {
    e.preventDefault();
    if (!this.dragState) return;

    // Check the bottom drop zone
    const bottomDropZone = (e.target as HTMLElement).closest('[data-drop-zone="bottom"]');
    if (bottomDropZone) {
      const newDropTarget: DropTarget = {
        type: 'bottom',
        id: 'bottom',
        position: 'inside',
      };
      if (!this.isDropTargetEqual(newDropTarget)) {
        this.dropTarget = newDropTarget;
        this.scheduleRender();
      }
      if (e.dataTransfer) {
        e.dataTransfer.dropEffect = 'move';
      }
      return;
    }

    // Check the layer drop zone
    const layerDropZone = (e.target as HTMLElement).closest(
      '[data-drop-zone="layer"]',
    ) as HTMLElement | null;
    if (layerDropZone) {
      const layerId = layerDropZone.dataset.layerId;
      if (layerId) {
        const newDropTarget: DropTarget = {
          type: 'layer',
          id: layerId,
          position: 'inside',
        };
        if (!this.isDropTargetEqual(newDropTarget)) {
          this.dropTarget = newDropTarget;
          this.scheduleRender();
        }
        if (e.dataTransfer) {
          e.dataTransfer.dropEffect = 'move';
        }
        return;
      }
    }

    // Check the drop zone for moving out of the group
    const groupOutDropZone = (e.target as HTMLElement).closest(
      '[data-drop-zone="group-out"]',
    ) as HTMLElement | null;
    if (groupOutDropZone) {
      const groupId = groupOutDropZone.dataset.groupId;
      if (groupId) {
        const newDropTarget: DropTarget = {
          type: 'group-out',
          id: groupId,
          position: 'after',
        };
        if (!this.isDropTargetEqual(newDropTarget)) {
          this.dropTarget = newDropTarget;
          this.scheduleRender();
        }
        if (e.dataTransfer) {
          e.dataTransfer.dropEffect = 'move';
        }
        return;
      }
    }

    // Drag over an ordinary item
    const targetItem = this.findDropTargetElement(e.target as HTMLElement);
    if (!targetItem) {
      if (this.dropTarget) {
        this.dropTarget = null;
        this.scheduleRender();
      }
      return;
    }

    const targetId = targetItem.dataset.id;
    const targetType = targetItem.dataset.type as 'feature' | 'group' | 'layer';
    const targetParentId = targetItem.dataset.parentId;

    if (!targetId) return;

    // A drop onto itself is ignored
    if (targetId === this.dragState.itemId) {
      if (this.dropTarget) {
        this.dropTarget = null;
        this.scheduleRender();
      }
      return;
    }

    const position = this.calculateDropPosition(targetItem, targetType, e);

    const newDropTarget: DropTarget = {
      type: targetType,
      id: targetId,
      position,
      parentId: targetParentId,
    };

    if (!this.isDropTargetEqual(newDropTarget)) {
      this.dropTarget = newDropTarget;
      this.scheduleRender();
    }

    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = 'move';
    }
  }

  /**
   * Find the drop target element
   */
  private findDropTargetElement(element: HTMLElement): HTMLElement | null {
    const target = element.closest('.layer-item') as HTMLElement | null;
    if (!target) return null;

    const targetType = target.dataset.type;

    // Case of dragging a layer
    if (this.dragState?.itemType === 'layer') {
      // A layer can only be dropped onto a layer
      if (targetType === 'layer') {
        return target;
      }
      return null;
    }

    // Case of dragging a feature or a group
    return target;
  }

  /**
   * Calculate the drop position
   */
  private calculateDropPosition(
    target: HTMLElement,
    targetType: 'feature' | 'group' | 'layer',
    e: DragEvent,
  ): DropPosition {
    if (!this.dragState) return 'after';

    const row = target.querySelector('.layer-item-row') as HTMLElement | null;
    const rect = row ? row.getBoundingClientRect() : target.getBoundingClientRect();
    const y = e.clientY - rect.top;
    const isUpperHalf = y < rect.height / 2;

    // Case of dragging a layer
    if (this.dragState.itemType === 'layer') {
      if (targetType === 'layer') {
        return isUpperHalf ? 'before' : 'after';
      }
      return 'after';
    }

    // Case of dragging a feature or a group and dropping it onto a layer
    if (targetType === 'layer') {
      return 'inside';
    }

    // Case of dragging a group
    if (this.dragState.itemType === 'group') {
      return isUpperHalf ? 'before' : 'after';
    }

    // Case of dragging a feature
    if (targetType === 'group') {
      // A group is split in three: top → before, middle → inside, bottom → after
      const relativeY = y / rect.height;
      if (relativeY < 0.33) {
        return 'before';
      } else if (relativeY < 0.67) {
        return 'inside';
      } else {
        return 'after';
      }
    }

    // Between features
    return isUpperHalf ? 'before' : 'after';
  }

  /**
   * Check whether the drop target is the same
   */
  private isDropTargetEqual(newTarget: DropTarget): boolean {
    if (!this.dropTarget) return false;
    return (
      this.dropTarget.type === newTarget.type &&
      this.dropTarget.id === newTarget.id &&
      this.dropTarget.position === newTarget.position &&
      this.dropTarget.parentId === newTarget.parentId
    );
  }

  /**
   * Drag leave
   */
  private handleDragLeave(e: DragEvent): void {
    // Clear the drop target only when the pointer has left the container
    const relatedTarget = e.relatedTarget as HTMLElement | null;
    if (!relatedTarget || !this.container.contains(relatedTarget)) {
      if (this.dropTarget) {
        this.dropTarget = null;
        this.scheduleRender();
      }
    }
  }

  /**
   * Drop
   */
  private handleDrop(e: DragEvent): void {
    e.preventDefault();
    if (!this.dragState || !this.dropTarget) {
      this.clearDragState();
      return;
    }

    this.executeMove();
    this.clearDragState();
    this.scheduleRender();
  }

  /**
   * Drag end
   */
  private handleDragEnd(): void {
    this.clearDragState();
    this.scheduleRender();
  }

  /**
   * Clear the drag state
   */
  private clearDragState(): void {
    this.dragState = null;
    this.dropTarget = null;
    this.isDragging = false;
  }

  /**
   * Execute the move
   */
  private executeMove(): void {
    if (!this.dragState || !this.dropTarget) return;

    const { itemId, itemType, parentId: sourceParentId } = this.dragState;
    const { type: targetType, id: targetId, position, parentId: targetParentId } = this.dropTarget;

    // Reordering layers among themselves
    if (itemType === 'layer' && targetType === 'layer') {
      this.moveLayerOrder(itemId, targetId, position);
      return;
    }

    // Drop a feature or a group onto a layer (a move between layers)
    if (targetType === 'layer' && position === 'inside') {
      this.moveItemToLayer(itemId, targetId);
      return;
    }

    // Move to the very bottom
    if (targetType === 'bottom') {
      this.moveToBottom(itemId, itemType, sourceParentId);
      return;
    }

    // Move out of the group
    if (targetType === 'group-out') {
      this.moveOutOfGroup(itemId, targetId);
      return;
    }

    // Put it into the group
    if (position === 'inside' && targetType === 'group') {
      this.moveIntoGroup(itemId, targetId);
      return;
    }

    // Check whether it is a move within the same parent
    const sameParent = this.isSameParentMove(sourceParentId, targetParentId, targetType, targetId);
    if (sameParent) {
      this.moveWithinSameParent(itemId, itemType, sourceParentId, targetId, position);
      return;
    }

    // Move from a group to the top level
    if (this.isGroupToTopLevelMove(sourceParentId, targetParentId, targetType)) {
      this.moveFromGroupToTopLevel(itemId, sourceParentId, targetId, position);
      return;
    }

    // Move from the top level onto a feature inside a group
    if (this.isTopLevelToGroupMove(sourceParentId, targetParentId) && targetParentId) {
      this.moveIntoGroupAtPosition(itemId, targetParentId, targetId, position);
      return;
    }

    // Move a feature between different groups
    if (
      this.isGroupToGroupMove(sourceParentId, targetParentId) &&
      sourceParentId &&
      targetParentId
    ) {
      this.moveGroupToGroup(itemId, sourceParentId, targetParentId, targetId, position);
      return;
    }

    // Move between different layers
    if (this.isCrossLayerMove(sourceParentId, targetParentId) && targetParentId) {
      this.moveCrossLayer(itemId, targetParentId, targetId, position);
      return;
    }
  }

  /**
   * Check whether it is a move within the same parent
   */
  private isSameParentMove(
    sourceParentId: string | null,
    targetParentId: string | undefined,
    targetType: string,
    targetId: string,
  ): boolean {
    // The source is inside a group and the target is inside the same group
    if (sourceParentId && targetParentId && sourceParentId === targetParentId) {
      return true;
    }

    // The source is at the top level (its parent is a layer) and so is the target
    if (sourceParentId && !this.draw.groups.get(sourceParentId)) {
      if (targetType === 'group' || (targetType === 'feature' && !targetParentId)) {
        const layer = this.draw.layers.get(sourceParentId);
        if (layer?.items.includes(targetId)) {
          return true;
        }
      }
      if (targetType === 'feature' && targetParentId === sourceParentId) {
        return true;
      }
    }

    return false;
  }

  /**
   * Check whether it is a move from a group to the top level
   */
  private isGroupToTopLevelMove(
    sourceParentId: string | null,
    targetParentId: string | undefined,
    targetType: string,
  ): boolean {
    if (!sourceParentId) return false;
    const sourceGroup = this.draw.groups.get(sourceParentId);
    if (!sourceGroup) return false;

    if (targetType === 'group') return true;

    if (targetParentId) {
      const targetGroup = this.draw.groups.get(targetParentId);
      return !targetGroup;
    }

    return true;
  }

  /**
   * Check whether it is a move from the top level into a group
   */
  private isTopLevelToGroupMove(
    sourceParentId: string | null,
    targetParentId: string | undefined,
  ): boolean {
    if (!sourceParentId) return false;
    if (!targetParentId) return false;

    const sourceGroup = this.draw.groups.get(sourceParentId);
    const targetGroup = this.draw.groups.get(targetParentId);

    return !sourceGroup && !!targetGroup;
  }

  /**
   * Check whether it is a move between groups
   */
  private isGroupToGroupMove(
    sourceParentId: string | null,
    targetParentId: string | undefined,
  ): boolean {
    if (!sourceParentId) return false;
    if (!targetParentId) return false;

    const sourceGroup = this.draw.groups.get(sourceParentId);
    const targetGroup = this.draw.groups.get(targetParentId);

    return !!sourceGroup && !!targetGroup && sourceParentId !== targetParentId;
  }

  /**
   * Check whether it is a move between different layers
   */
  private isCrossLayerMove(
    sourceParentId: string | null,
    targetParentId: string | undefined,
  ): boolean {
    if (!sourceParentId || !targetParentId) return false;
    const sourceGroup = this.draw.groups.get(sourceParentId);
    const targetGroup = this.draw.groups.get(targetParentId);
    return !sourceGroup && !targetGroup && sourceParentId !== targetParentId;
  }

  /**
   * Find the layer that contains an item
   */
  private findLayerContainingItem(itemId: string): string | null {
    const layers = this.draw.layers.list();
    for (const layer of layers) {
      if (layer.items.includes(itemId)) {
        return layer.id;
      }
    }
    return null;
  }

  /**
   * Change the order of the layers
   */
  private moveLayerOrder(layerId: string, targetLayerId: string, position: DropPosition): void {
    const order = this.draw.layers.list().map((layer) => layer.id);
    const currentIndex = order.indexOf(layerId);
    const targetIndex = order.indexOf(targetLayerId);
    if (currentIndex === -1 || targetIndex === -1) return;

    // The UI shows them in reverse order, so the meaning of before/after is inverted
    order.splice(currentIndex, 1);
    let newIndex: number;
    if (position === 'before') {
      newIndex = currentIndex < targetIndex ? targetIndex : targetIndex + 1;
    } else {
      newIndex = currentIndex < targetIndex ? targetIndex - 1 : targetIndex;
    }
    order.splice(newIndex, 0, layerId);
    this.draw.layers.reorder(order);
  }

  /**
   * Move an item to a layer
   */
  private moveItemToLayer(itemId: string, targetLayerId: string): void {
    this.moveItem(itemId, { layerId: targetLayerId });
    this.expandedIds.add(targetLayerId);
  }

  /**
   * Move to the back
   */
  private moveToBottom(
    itemId: string,
    itemType: 'layer' | 'group' | 'feature',
    sourceParentId: string | null,
  ): void {
    if (itemType === 'layer') {
      const order = this.draw.layers.list().map((layer) => layer.id);
      const currentIndex = order.indexOf(itemId);
      if (currentIndex !== -1) {
        order.splice(currentIndex, 1);
        order.unshift(itemId);
        this.draw.layers.reorder(order);
      }
      return;
    }

    // Case of a move out of a group
    if (sourceParentId) {
      const sourceGroup = this.draw.groups.get(sourceParentId);
      if (sourceGroup) {
        this.draw.features.move(itemId, { groupId: null });
        return;
      }
    }

    // Move an item directly under a layer to the back
    const layerId = sourceParentId ?? this.findLayerContainingItem(itemId);
    if (layerId) {
      this.moveItem(itemId, { layerId: layerId, index: 0 });
    }
  }

  /**
   * Put it into the group
   */
  private moveIntoGroup(itemId: string, targetGroupId: string): void {
    this.draw.features.move(itemId, { groupId: targetGroupId });
    this.expandedIds.add(targetGroupId);
  }

  /**
   * Move out of the group
   */
  private moveOutOfGroup(itemId: string, groupId: string): void {
    const layerId = this.findLayerContainingItem(groupId);
    if (!layerId) return;

    const layer = this.draw.layers.get(layerId);
    if (!layer) return;

    const groupIndex = layer.items.indexOf(groupId);
    if (groupIndex === -1) return;

    // Take the item out of its current group
    const currentGroup = this.draw.groups.get(this.dragState?.parentId ?? '');
    if (currentGroup && currentGroup.id === groupId) {
      // Move a feature that is inside the group out of the group
      this.draw.features.move(itemId, { groupId: null });
    } else {
      // Place a feature from outside the group below the group
      this.moveItem(itemId, { layerId: layerId });
      this.moveItem(itemId, { layerId: layerId, index: groupIndex });
    }
  }

  /**
   * Move to a given position inside a group
   */
  private moveIntoGroupAtPosition(
    itemId: string,
    targetGroupId: string,
    _targetFeatureId: string,
    _position: DropPosition,
  ): void {
    this.draw.features.move(itemId, { groupId: targetGroupId });
    this.expandedIds.add(targetGroupId);
  }

  /**
   * Move a feature between groups
   */
  private moveGroupToGroup(
    itemId: string,
    _sourceGroupId: string,
    targetGroupId: string,
    targetFeatureId: string,
    position: DropPosition,
  ): void {
    const targetGroup = this.draw.groups.get(targetGroupId);
    if (!targetGroup) return;

    // Calculate the insertion index from the position of the target feature
    const targetIndex = targetGroup.featureIds.indexOf(targetFeatureId);
    // The UI shows them in reverse order, so 'before' (above in the UI) inserts later
    // in the array
    const insertIndex =
      targetIndex === -1 ? undefined : position === 'before' ? targetIndex + 1 : targetIndex;

    this.draw.features.move(itemId, { groupId: targetGroupId, index: insertIndex });
    this.expandedIds.add(targetGroupId);
  }

  /**
   * Move within the same parent
   */
  private moveWithinSameParent(
    itemId: string,
    _itemType: 'layer' | 'group' | 'feature',
    parentId: string | null,
    targetId: string,
    position: DropPosition,
  ): void {
    if (!parentId) return;

    const group = this.draw.groups.get(parentId);
    if (group) {
      // Move inside a group
      const targetIndex = group.featureIds.indexOf(targetId);
      if (targetIndex === -1) return;

      const newIndex = position === 'before' ? targetIndex + 1 : targetIndex;
      this.draw.features.move(itemId, { groupId: parentId, index: newIndex });
    } else {
      // Move inside a layer
      const layer = this.draw.layers.get(parentId);
      if (!layer) return;

      const targetIndex = layer.items.indexOf(targetId);
      if (targetIndex === -1) return;

      const newIndex = position === 'before' ? targetIndex + 1 : targetIndex;
      this.moveItem(itemId, { layerId: parentId, index: newIndex });
    }
  }

  /**
   * Move from a group to the top level
   */
  private moveFromGroupToTopLevel(
    itemId: string,
    sourceGroupId: string | null,
    targetId: string,
    position: DropPosition,
  ): void {
    if (!sourceGroupId) return;

    const sourceGroup = this.draw.groups.get(sourceGroupId);
    if (!sourceGroup) return;

    const sourceLayerId = this.findLayerContainingItem(sourceGroupId);
    if (!sourceLayerId) return;

    const targetLayerId = this.findLayerContainingItem(targetId);
    if (!targetLayerId) return;

    if (sourceLayerId === targetLayerId) {
      const layer = this.draw.layers.get(sourceLayerId);
      if (!layer) return;

      const targetIndex = layer.items.indexOf(targetId);
      if (targetIndex === -1) return;

      const insertIndex = position === 'before' ? targetIndex + 1 : targetIndex;
      this.draw.features.move(itemId, { groupId: null });
      this.moveItem(itemId, { layerId: sourceLayerId, index: insertIndex });
    } else {
      this.moveItem(itemId, { layerId: targetLayerId });
      const layer = this.draw.layers.get(targetLayerId);
      if (!layer) return;

      const targetIndex = layer.items.indexOf(targetId);
      if (targetIndex === -1) return;

      const newIndex = position === 'before' ? targetIndex + 1 : targetIndex;
      this.moveItem(itemId, { layerId: targetLayerId, index: newIndex });
    }
  }

  /**
   * Move between different layers
   */
  private moveCrossLayer(
    itemId: string,
    targetLayerId: string,
    targetId: string,
    position: DropPosition,
  ): void {
    this.moveItem(itemId, { layerId: targetLayerId });

    const layer = this.draw.layers.get(targetLayerId);
    if (!layer) return;

    const targetIndex = layer.items.indexOf(targetId);
    if (targetIndex === -1) return;

    const newIndex = position === 'before' ? targetIndex + 1 : targetIndex;
    this.moveItem(itemId, { layerId: targetLayerId, index: newIndex });
    this.expandedIds.add(targetLayerId);
  }

  /**
   * The IDs of the selection
   */
  private selectedIds(): string[] {
    return [...this.draw.selection.get().ids];
  }

  /**
   * Moves a feature or a group to a place in a layer, or a feature into or out of a group
   */
  private moveItem(itemId: string, to: MoveTarget): void {
    if (this.draw.groups.has(itemId)) this.draw.groups.move(itemId, to);
    else this.draw.features.move(itemId, to);
  }
}
