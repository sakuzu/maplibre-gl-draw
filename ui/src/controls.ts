// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// maplibre-gl's own controls on the map, and the bottom corners of the map kept clear of the
// toolbar.
//
// - mapControls() adds the controls as maplibre-gl draws them: at the bottom right, from the top,
//   the globe, the compass (with the pitch) and the zoom; at the bottom left, the scale. Their look
//   is maplibre-gl's style sheet, which the page imports
// - cornerLift() lifts a bottom corner of the map (its controls and the attribution) above the
//   toolbar while the toolbar reaches it, as it does on a narrow map. The toolbar floats over the
//   map at the bottom centre, above the corners

import {
  type ControlPosition,
  GlobeControl,
  type IControl,
  NavigationControl,
  ScaleControl,
} from 'maplibre-gl';
import type { MapControlsOptions } from './types.js';

/** The members of the map the controls use */
export interface ControlsMap {
  addControl(control: IControl, position?: ControlPosition): unknown;
  removeControl(control: IControl): unknown;
}

/** The controls added to a map, to remove */
export interface MapControls {
  /** Removes the controls from the map. A second call does nothing */
  destroy(): void;
}

/**
 * Adds maplibre-gl's controls to a map: all four with `true` or `undefined`, none with `false`,
 * those not set to false with an object.
 *
 * maplibre-gl puts a control added to a bottom corner above those already there, so the controls
 * of the bottom right are added from the bottom: the zoom, the compass, then the globe.
 */
export function mapControls(
  map: ControlsMap,
  option: boolean | MapControlsOptions | undefined,
): MapControls {
  const want: MapControlsOptions | null =
    option === false ? null : option === true || option === undefined ? {} : option;
  const added: IControl[] = [];
  const add = (control: IControl, position: ControlPosition) => {
    map.addControl(control, position);
    added.push(control);
  };
  if (want) {
    if (want.zoom !== false) {
      add(new NavigationControl({ showZoom: true, showCompass: false }), 'bottom-right');
    }
    if (want.compass !== false) {
      add(
        new NavigationControl({ showZoom: false, showCompass: true, visualizePitch: true }),
        'bottom-right',
      );
    }
    if (want.globe !== false) add(new GlobeControl(), 'bottom-right');
    if (want.scale !== false) add(new ScaleControl(), 'bottom-left');
  }
  let destroyed = false;
  return {
    destroy() {
      if (destroyed) return;
      destroyed = true;
      for (const control of added) {
        try {
          map.removeControl(control);
        } catch {
          // The map is gone
        }
      }
      added.length = 0;
    },
  };
}

/** The attribute on the map's container while the interface lifts its bottom corners */
export const LIFT_ATTRIBUTE = 'data-mgd-ui-lift';

/** The bottom corners of the map, lifted above the toolbar while it reaches them */
export interface CornerLift {
  /** Measures again after the toolbar came, went or changed */
  update(): void;
  /** Stops following and puts the corners back */
  destroy(): void;
}

/**
 * Lifts the bottom corners of maplibre-gl's controls in `container` (the map's container) above
 * the toolbar of the interface in `root`, each while the toolbar reaches it across: by the
 * distance from the top of the toolbar to the bottom of the map. root.css moves the corners by
 * the custom properties this sets on the container (--mgd-ui-lift-left and --mgd-ui-lift-right).
 */
export function cornerLift(container: HTMLElement, root: HTMLElement): CornerLift {
  let destroyed = false;
  let observer: ResizeObserver | undefined;
  let observed: Element[] = [];
  let last = '';
  container.setAttribute(LIFT_ATTRIBUTE, '');

  const corner = (side: 'left' | 'right') =>
    container.querySelector<HTMLElement>(
      `:scope > .maplibregl-control-container > .maplibregl-ctrl-bottom-${side}`,
    );
  const bar = () => root.querySelector<HTMLElement>('[data-region="bottom"] [data-role="drawbar"]');

  function set(left: number, right: number) {
    const key = `${left} ${right}`;
    if (key === last) return;
    last = key;
    container.style.setProperty('--mgd-ui-lift-left', `${left}px`);
    container.style.setProperty('--mgd-ui-lift-right', `${right}px`);
  }

  function apply() {
    if (destroyed) return;
    const toolbar = bar();
    if (!toolbar || !container.isConnected) {
      set(0, 0);
      return;
    }
    const box = container.getBoundingClientRect();
    const b = toolbar.getBoundingClientRect();
    if (b.width === 0 || b.height === 0) {
      set(0, 0);
      return;
    }
    const band = Math.round(Math.max(0, Math.min(box.bottom - b.top, box.height)));
    // A transform moves a corner up and down only, so across it stays where it is measured
    const reaches = (side: 'left' | 'right') => {
      const el = corner(side);
      if (!el) return false;
      const r = el.getBoundingClientRect();
      if (r.width === 0) return false;
      return side === 'left' ? r.right > b.left : r.left < b.right;
    };
    set(reaches('left') ? band : 0, reaches('right') ? band : 0);
  }

  function follow() {
    const next = [container, bar(), corner('left'), corner('right')].filter(
      (el): el is HTMLElement => !!el,
    );
    if (next.length === observed.length && next.every((el, i) => el === observed[i])) return;
    observer?.disconnect();
    observed = next;
    if (typeof ResizeObserver === 'undefined') return;
    observer ??= new ResizeObserver(apply);
    for (const el of observed) observer.observe(el);
  }

  return {
    update() {
      if (destroyed) return;
      follow();
      apply();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      observer?.disconnect();
      observer = undefined;
      observed = [];
      container.removeAttribute(LIFT_ATTRIBUTE);
      container.style.removeProperty('--mgd-ui-lift-left');
      container.style.removeProperty('--mgd-ui-lift-right');
    },
  };
}
