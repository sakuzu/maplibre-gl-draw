// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * AutoNameGenerator
 *
 * A utility that automatically generates a name with a sequential number when a Feature is
 * newly created.
 */

import type { Feature, FeatureType, Group, Layer, StateChanges } from '../types/model.js';

/**
 * What the generator reads from the Store: the current contents and the change notifications.
 * The Store satisfies it; declaring only this keeps shared/ below store/. The constructor
 * spells the same shape out, because AutoNameGenerator is public and this name is not.
 */
interface NameSource {
  getAllFeatures(): Feature[];
  getAllLayers(): Layer[];
  getAllGroups(): Group[];
  subscribe(listener: (changes: StateChanges) => void): () => void;
}

/**
 * What automatic naming names: a feature type, a layer or a group
 */
export type AutoNameType = FeatureType | 'Layer' | 'Group';

/**
 * How new features, layers and groups are named automatically ("Point 1", "Layer 2")
 *
 * Give it through the `autoName` option of `createMapLibreGLDraw` (`true`, the default, turns
 * it on with these defaults, and `false` turns it off). Each type counts on its own, and a
 * number is never reused: after "Point 1" and "Point 2" are created and "Point 2" is deleted,
 * the next point is "Point 3". Existing names of the form "<word> <number>" move the count on
 * as well, however they arrived (a load, an import).
 *
 * @example
 * ```ts
 * const draw = createMapLibreGLDraw(map, {
 *   autoName: {
 *     enabled: true,
 *     typeNames: { Point: 'Pin', Layer: 'Sheet' },
 *     formatter: (typeName, n) => `${typeName} #${n}`,
 *   },
 * });
 * // The first point is named "Pin #1"
 * ```
 */
export interface AutoNameConfig {
  /**
   * Whether names are generated
   *
   * @defaultValue `true`
   */
  enabled: boolean;
  /**
   * The word used for each type in the name
   *
   * @defaultValue the name of the type (`'Point'`, `'Layer'`, `'Group'`, or the custom type)
   */
  typeNames?: Partial<Record<AutoNameType, string>>;
  /**
   * Builds the name from the word of the type and the number
   *
   * @defaultValue `` (typeName, number) => `${typeName} ${number}` ``
   */
  formatter?: (typeName: string, number: number) => string;
}

/**
 * Default mapping of type names
 */
const DEFAULT_TYPE_NAMES: Record<string, string> = {
  Point: 'Point',
  LineString: 'LineString',
  Polygon: 'Polygon',
  Image: 'Image',
};

/**
 * Default Layer/Group names
 */
const DEFAULT_LAYER_NAME = 'Layer';
const DEFAULT_GROUP_NAME = 'Group';

/**
 * Counter keys of Layer/Group
 *
 * They share the same Map / Set as the counter keys of Feature (FeatureType).
 */
const LAYER_COUNTER_KEY = 'Layer';
const GROUP_COUNTER_KEY = 'Group';

/**
 * Default formatter
 */
function defaultFormatter(typeName: string, number: number): string {
  return `${typeName} ${number}`;
}

/**
 * Extracts the number from a name
 */
function extractNumberFromName(name: string, typeName: string): number | null {
  // Escape the special characters
  const escapedTypeName = typeName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`^${escapedTypeName}\\s*(\\d+)$`);
  const match = name.match(regex);
  return match ? parseInt(match[1], 10) : null;
}

/**
 * Normalizes an AutoNameConfig
 */
export function normalizeAutoNameConfig(
  config: AutoNameConfig | boolean | undefined,
): AutoNameConfig {
  if (config === undefined || config === true) {
    return { enabled: true };
  }
  if (config === false) {
    return { enabled: false };
  }
  return config;
}

/**
 * AutoNameGenerator
 *
 * A class that generates sequential numbers per Feature type.
 * It accounts for the numbers of existing Features and starts from the next number.
 * A number that has been used once is not reused even after deletion (it leaves gaps).
 *
 * The existing numbers are taken in with a single full scan per type, and after that only the
 * increments are taken in by subscribing to the Store. Scanning everything on every call would
 * make the case of generating one at a time, as in a bulk import, O(n^2).
 *
 * With this incremental approach, the number of a name that was added and then deleted before
 * any generation happened is also recorded (with the old approach it could be reused after the
 * deletion). This is an extension of the "a number used once is not reused" policy, and it can
 * only work in the direction of increasing the gaps.
 */
export class AutoNameGenerator {
  private readonly store: NameSource;
  private readonly config: AutoNameConfig;
  /** Counter that remembers the largest number already generated per type */
  private readonly counters: Map<string, number> = new Map();
  /** Counter keys whose full scan is done (Layer/Group go into the same Set) */
  private readonly scannedTypes = new Set<string>();
  /** Unsubscribe function of the Store subscription (null when not subscribed) */
  private unsubscribe: (() => void) | null = null;

  constructor(
    store: {
      getAllFeatures(): Feature[];
      getAllLayers(): Layer[];
      getAllGroups(): Group[];
      subscribe(listener: (changes: StateChanges) => void): () => void;
    },
    config: AutoNameConfig | boolean = true,
  ) {
    this.store = store;
    this.config = normalizeAutoNameConfig(config);

    // When disabled, no name is generated, so there is no need to maintain the counters
    if (this.config.enabled) {
      this.unsubscribe = store.subscribe((changes) => {
        this.observeChanges(changes);
      });
    }
  }

  /**
   * Returns whether it is enabled
   */
  isEnabled(): boolean {
    return this.config.enabled;
  }

  /**
   * Unsubscribes from the Store
   */
  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /**
   * Generates an automatic name for the given type
   *
   * @returns The generated name, or undefined when it is disabled
   */
  generateName(featureType: FeatureType): string | undefined {
    if (!this.config.enabled) {
      return undefined;
    }

    const typeName = this.getTypeName(featureType);
    const nextNumber = this.findNextNumber(featureType, typeName);
    const formatter = this.config.formatter ?? defaultFormatter;

    return formatter(typeName, nextNumber);
  }

  /**
   * Gets the type name
   */
  private getTypeName(featureType: FeatureType): string {
    // Use a custom type name if there is one
    if (this.config.typeNames && featureType in this.config.typeNames) {
      return (
        this.config.typeNames[featureType as keyof typeof this.config.typeNames] ?? featureType
      );
    }
    // Default type name
    return DEFAULT_TYPE_NAMES[featureType] ?? featureType;
  }

  /**
   * Gets the next number
   *
   * Increments the counter by 1 and returns it. The counter holds the largest existing number
   * (the first full scan plus the increments after it), so the number of a deleted Feature is
   * not reused and a gap appears.
   */
  private findNextNumber(featureType: FeatureType, typeName: string): number {
    this.scanOnce(featureType, () => this.getMaxNumberFromFeatures(featureType, typeName));

    const nextNumber = (this.counters.get(featureType) ?? 0) + 1;
    this.counters.set(featureType, nextNumber);

    return nextNumber;
  }

  /**
   * Takes in the largest existing number only the first time a generation happens for that
   * counter key
   *
   * From the second time onward the counter is maintained incrementally, so it does not scan.
   */
  private scanOnce(counterKey: string, scan: () => number): void {
    if (this.scannedTypes.has(counterKey)) return;
    this.scannedTypes.add(counterKey);
    this.recordNumber(counterKey, scan());
  }

  /**
   * Raises the counter up to number (a smaller value does not lower it)
   */
  private recordNumber(counterKey: string, number: number): void {
    if (number > (this.counters.get(counterKey) ?? 0)) {
      this.counters.set(counterKey, number);
    }
  }

  /**
   * Takes in the numbers of names from the changes of the Store
   *
   * The path that keeps the cost proportional to the number of changes and avoids scanning
   * everything on every generation.
   * Deletions are ignored (because a number used once is not reused).
   */
  private observeChanges(changes: StateChanges): void {
    for (const feature of changes.features?.created ?? []) {
      this.observeFeatureName(feature);
    }
    for (const { feature } of changes.features?.updated ?? []) {
      this.observeFeatureName(feature);
    }

    const layerTypeName = this.getLayerTypeName();
    for (const layer of changes.layers?.created ?? []) {
      this.observeName(LAYER_COUNTER_KEY, layerTypeName, layer.name);
    }
    for (const { layer } of changes.layers?.updated ?? []) {
      this.observeName(LAYER_COUNTER_KEY, layerTypeName, layer.name);
    }

    const groupTypeName = this.getGroupTypeName();
    for (const group of changes.groups?.created ?? []) {
      this.observeName(GROUP_COUNTER_KEY, groupTypeName, group.name);
    }
    for (const { group } of changes.groups?.updated ?? []) {
      this.observeName(GROUP_COUNTER_KEY, groupTypeName, group.name);
    }
  }

  /**
   * Takes in the number from the name of a Feature
   */
  private observeFeatureName(feature: Feature): void {
    const name = feature.properties?.name;
    if (typeof name !== 'string') return;
    this.observeName(feature.type, this.getTypeName(feature.type), name);
  }

  /**
   * Extracts the number from a name and takes it into the counter
   */
  private observeName(counterKey: string, typeName: string, name: string): void {
    const number = extractNumberFromName(name, typeName);
    if (number !== null) this.recordNumber(counterKey, number);
  }

  /**
   * Gets the type name of Layer
   */
  private getLayerTypeName(): string {
    return this.config.typeNames?.Layer ?? DEFAULT_LAYER_NAME;
  }

  /**
   * Gets the type name of Group
   */
  private getGroupTypeName(): string {
    return this.config.typeNames?.Group ?? DEFAULT_GROUP_NAME;
  }

  /**
   * Gets the largest number from the existing Features
   */
  private getMaxNumberFromFeatures(featureType: FeatureType, typeName: string): number {
    const features = this.store.getAllFeatures();
    let maxNumber = 0;

    for (const feature of features) {
      // Only features of the same type are considered
      if (feature.type !== featureType) {
        continue;
      }

      // Get the name property
      const name = feature.properties?.name;
      if (typeof name !== 'string') {
        continue;
      }

      // Extract the number
      const number = extractNumberFromName(name, typeName);
      if (number !== null && number > maxNumber) {
        maxNumber = number;
      }
    }

    return maxNumber;
  }

  /**
   * Automatically generates a Layer name
   *
   * @returns The generated name, or undefined when it is disabled
   */
  generateLayerName(): string | undefined {
    if (!this.config.enabled) {
      return undefined;
    }

    const typeName = this.getLayerTypeName();
    const nextNumber = this.findNextLayerNumber(typeName);
    const formatter = this.config.formatter ?? defaultFormatter;

    return formatter(typeName, nextNumber);
  }

  /**
   * Gets the next Layer number
   */
  private findNextLayerNumber(typeName: string): number {
    this.scanOnce(LAYER_COUNTER_KEY, () => {
      let maxNumber = 0;
      for (const layer of this.store.getAllLayers()) {
        const number = extractNumberFromName(layer.name, typeName);
        if (number !== null && number > maxNumber) {
          maxNumber = number;
        }
      }
      return maxNumber;
    });

    const nextNumber = (this.counters.get(LAYER_COUNTER_KEY) ?? 0) + 1;
    this.counters.set(LAYER_COUNTER_KEY, nextNumber);

    return nextNumber;
  }

  /**
   * Automatically generates a Group name
   *
   * @returns The generated name, or undefined when it is disabled
   */
  generateGroupName(): string | undefined {
    if (!this.config.enabled) {
      return undefined;
    }

    const typeName = this.getGroupTypeName();
    const nextNumber = this.findNextGroupNumber(typeName);
    const formatter = this.config.formatter ?? defaultFormatter;

    return formatter(typeName, nextNumber);
  }

  /**
   * Gets the next Group number
   */
  private findNextGroupNumber(typeName: string): number {
    this.scanOnce(GROUP_COUNTER_KEY, () => {
      let maxNumber = 0;
      for (const group of this.store.getAllGroups()) {
        const number = extractNumberFromName(group.name, typeName);
        if (number !== null && number > maxNumber) {
          maxNumber = number;
        }
      }
      return maxNumber;
    });

    const nextNumber = (this.counters.get(GROUP_COUNTER_KEY) ?? 0) + 1;
    this.counters.set(GROUP_COUNTER_KEY, nextNumber);

    return nextNumber;
  }
}
