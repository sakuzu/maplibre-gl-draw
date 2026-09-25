// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Layer Panel type definitions
 */

// Feature type (the same definition as in core)
export type FeatureType = 'Point' | 'LineString' | 'Polygon' | 'Image' | (string & {});

/**
 * Tree item
 */
export interface TreeItem {
  type: 'layer' | 'group' | 'feature';
  id: string;
  name: string;
  visible: boolean;
  locked: boolean;
  expanded?: boolean;
  selected?: boolean;
  active?: boolean; // Active layer (where new features are added)
  parentId?: string; // Layer ID or group ID
  children?: TreeItem[];
  featureType?: FeatureType;
}

/**
 * Drag state
 */
export interface DragState {
  itemId: string;
  itemType: 'layer' | 'group' | 'feature';
  parentId?: string | null; // Layer ID or group ID
  sourceLayerId?: string;
  sourceGroupId?: string;
}

/**
 * Drop position
 */
export type DropPosition = 'before' | 'after' | 'inside';

/**
 * Drop target
 */
export interface DropTarget {
  targetId: string;
  targetType: 'layer' | 'group' | 'feature';
  position: DropPosition;
  parentId?: string;
}

/**
 * Selection type
 */
export type SelectionType = 'layer' | 'group' | 'feature' | null;
