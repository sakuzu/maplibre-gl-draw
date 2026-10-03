// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

// maplibre-gl's own controls on the map, and the bottom corners of the map kept clear of the
// interface and of the attribution.
//
// - mapControls() adds the controls as maplibre-gl draws them: at the bottom right, from the top,
//   the globe, the compass (with the pitch) and the zoom; at the bottom left, the scale. Their look
//   is maplibre-gl's style sheet, which the page imports. It follows the shell's narrow: a narrow
//   map has no globe and no compass (the zoom stays), and its attribution is folded to its (i)
//   button whenever maplibre-gl builds it open
// - cornerLift() lifts a bottom corner of the map (its controls and the attribution) above the
//   toolbar while the toolbar reaches it, as it does on a narrow map; moves the controls of the
//   bottom right (not the attribution) to the left of the right region while they would be under
//   it; and, but on a narrow map, lifts the bottom left corner (the scale) above the attribution
//   while the attribution's box reaches it across, as a two-line attribution does. It only reads
//   the attribution

import {
  type ControlPosition,
  GlobeControl,
  type IControl,
  NavigationControl,
  ScaleControl,
} from 'maplibre-gl';
import type { ShellInset } from './padding.js';
import type { MapControlsOptions } from './types.js';

/** The members of the map the controls use */
export interface ControlsMap {
  addControl(control: IControl, position?: ControlPosition): unknown;
  removeControl(control: IControl): unknown;
  getContainer(): HTMLElement;
}

/** The controls added to a map, to follow the shell's narrow and to remove */
export interface MapControls {
  /**
   * Follows the shell's narrow: on a narrow map, removes the globe and the compass and folds the
   * attribution; on a wider one, adds the globe and the compass back
   */
  setNarrow(narrow: boolean): void;
  /** Removes the controls from the map and stops following the attribution. A second call does nothing */
  destroy(): void;
}

/** The class of maplibre-gl's compact attribution, and the one it has while it is open */
const COMPACT = 'maplibregl-compact';
const COMPACT_SHOW = 'maplibregl-compact-show';

/**
 * Adds maplibre-gl's controls to a map: all four with `true` or `undefined`, none with `false`,
 * those not set to false with an object.
 *
 * maplibre-gl puts a control added to a bottom corner above those already there, so the controls
 * of the bottom right are added from the bottom: the zoom, the compass, then the globe. The globe
 * and the compass come back the same way, above the zoom.
 *
 * While the map is narrow (`setNarrow`), the globe and the compass are removed, and the
 * attribution is folded to its (i) button: maplibre-gl builds its compact attribution open (until
 * the first drag), when it first fills, when the map's width brings the compact form back, and
 * when a page adds it again; each time, its open class is removed, as maplibre-gl's own fold on a
 * drag does. The (i) button opens it still. With `false`, nothing is added and the attribution is
 * left alone.
 */
export function mapControls(
  map: ControlsMap,
  option: boolean | MapControlsOptions | undefined,
): MapControls {
  const want: MapControlsOptions | null =
    option === false ? null : option === true || option === undefined ? {} : option;
  const added: IControl[] = [];
  // The globe and the compass, which a narrow map leaves out
  let wideOnly: IControl[] = [];
  let narrow = false;
  let destroyed = false;
  const add = (control: IControl, position: ControlPosition) => {
    map.addControl(control, position);
    added.push(control);
    return control;
  };
  const remove = (control: IControl) => {
    const at = added.indexOf(control);
    if (at >= 0) added.splice(at, 1);
    try {
      map.removeControl(control);
    } catch {
      // The map is gone
    }
  };
  const addWideOnly = () => {
    if (!want) return;
    if (want.compass !== false) {
      wideOnly.push(
        add(
          new NavigationControl({ showZoom: false, showCompass: true, visualizePitch: true }),
          'bottom-right',
        ),
      );
    }
    if (want.globe !== false) wideOnly.push(add(new GlobeControl(), 'bottom-right'));
  };
  if (want) {
    if (want.zoom !== false) {
      add(new NavigationControl({ showZoom: true, showCompass: false }), 'bottom-right');
    }
    addWideOnly();
    if (want.scale !== false) add(new ScaleControl(), 'bottom-left');
  }

  // The attribution of the map, folded while the map is narrow
  const container = map.getContainer();
  const watched =
    container.querySelector<HTMLElement>(':scope > .maplibregl-control-container') ?? container;
  const isAttribution = (node: Node): node is Element =>
    node instanceof Element && node.matches('.maplibregl-ctrl-attrib');
  const fold = (el: Element) => {
    if (narrow) el.classList.remove(COMPACT_SHOW);
  };
  /** maplibre-gl built it open: it was added, or it has just become compact */
  const watcher =
    want && typeof MutationObserver !== 'undefined'
      ? new MutationObserver((records) => {
          if (!narrow) return;
          for (const record of records) {
            if (record.type === 'childList') {
              for (const node of record.addedNodes) if (isAttribution(node)) fold(node);
            } else if (
              isAttribution(record.target) &&
              record.target.classList.contains(COMPACT) &&
              !(record.oldValue ?? '').split(/\s+/).includes(COMPACT)
            ) {
              fold(record.target);
            }
          }
        })
      : null;
  watcher?.observe(watched, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['class'],
    attributeOldValue: true,
  });

  return {
    setNarrow(next: boolean) {
      if (destroyed || !want || next === narrow) return;
      narrow = next;
      if (narrow) {
        for (const control of wideOnly) remove(control);
        wideOnly = [];
        for (const el of watched.querySelectorAll('.maplibregl-ctrl-attrib')) fold(el);
      } else {
        addWideOnly();
      }
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      watcher?.disconnect();
      for (const control of [...added]) remove(control);
      wideOnly = [];
    },
  };
}

/** The attribute on the map's container while the interface lifts its bottom corners */
export const LIFT_ATTRIBUTE = 'data-mgd-ui-lift';

/** The bottom corners of the map, kept clear of the interface and of the attribution */
export interface CornerLift {
  /**
   * Measures again after the toolbar came, went or changed, or the regions of the shell moved;
   * with the inset the shell reported and whether it is narrow, which are kept until the next ones
   */
  update(inset?: ShellInset, narrow?: boolean): void;
  /** Stops following and puts the corners back */
  destroy(): void;
}

/** A box on the page, as far as the placing needs it */
interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** A box moved by (dx, dy) */
const moved = (r: Box, dx: number, dy: number): Box => ({
  left: r.left + dx,
  right: r.right + dx,
  top: r.top + dy,
  bottom: r.bottom + dy,
});

/** Whether two boxes overlap across (their ranges of x), or up and down (their ranges of y) */
const across = (a: Box, b: Box) => a.left < b.right && b.left < a.right;
const upDown = (a: Box, b: Box) => a.top < b.bottom && b.top < a.bottom;

/**
 * Keeps the bottom corners of maplibre-gl's controls in `container` (the map's container) clear
 * of the interface in `root` and of the attribution. root.css moves them by the custom properties
 * this sets on the container:
 *
 * - --mgd-ui-lift-left and --mgd-ui-lift-right lift a corner above the toolbar while the toolbar
 *   reaches it across, by the distance from the top of the toolbar to the bottom of the map; the
 *   controls of the bottom right moved to the left (below) count as reaching it where they are
 *   moved to
 * - --mgd-ui-shift-right moves the controls of the bottom right, not the attribution, to the left
 *   while the right region covers the stage (the inset's right) and they are under it up and
 *   down: by the inset and gap-md
 * - --mgd-ui-lift-left also lifts the bottom left corner above the attribution's box while that
 *   box reaches the corner across, but on a narrow map: there the attribution is folded to its
 *   (i) button (mapControls), and the band the button opens is not lifted for
 *
 * The boxes are measured where maplibre-gl places them, without what this moved. The attribution
 * and the right region are followed with a ResizeObserver, as the toolbar and the corners are:
 * the boxes are read in the observer's delivery and the custom properties are written in the next
 * frame, so that what they move is not measured again in the same delivery.
 */
export function cornerLift(container: HTMLElement, root: HTMLElement): CornerLift {
  let destroyed = false;
  let observer: ResizeObserver | undefined;
  // The frame that writes what the observer measured, or 0
  let frame = 0;
  let observed: Element[] = [];
  let inset: ShellInset = { top: 0, right: 0, bottom: 0, left: 0 };
  let narrow = false;
  // What is applied now, to measure the boxes without it
  let now = { left: 0, right: 0, shift: 0 };
  let last = '';
  container.setAttribute(LIFT_ATTRIBUTE, '');

  const corner = (side: 'left' | 'right') =>
    container.querySelector<HTMLElement>(
      `:scope > .maplibregl-control-container > .maplibregl-ctrl-bottom-${side}`,
    );
  const bar = () => root.querySelector<HTMLElement>('[data-region="bottom"] [data-role="drawbar"]');
  const attribution = () =>
    corner('right')?.querySelector<HTMLElement>(':scope > .maplibregl-ctrl-attrib') ?? null;
  const rightRegion = () =>
    root.querySelector<HTMLElement>('[data-role="shell"] [data-region="right"]');
  /** The controls of the bottom right that move to the left: all but the attribution */
  const rightControls = () => [
    ...(corner('right')?.querySelectorAll<HTMLElement>(
      ':scope > .maplibregl-ctrl:not(.maplibregl-ctrl-attrib)',
    ) ?? []),
  ];

  /** gap-md of the interface in px, measured in the root where kata's tokens are */
  function gap(): number {
    const probe = document.createElement('div');
    probe.style.cssText =
      'position:absolute;visibility:hidden;pointer-events:none;height:0;width:var(--kata-gap-md)';
    root.appendChild(probe);
    const width = probe.getBoundingClientRect().width;
    probe.remove();
    return width;
  }

  function set(left: number, right: number, shift: number) {
    now = { left, right, shift };
    const key = `${left} ${right} ${shift}`;
    if (key === last) return;
    last = key;
    container.style.setProperty('--mgd-ui-lift-left', `${left}px`);
    container.style.setProperty('--mgd-ui-lift-right', `${right}px`);
    container.style.setProperty('--mgd-ui-shift-right', `${shift}px`);
  }

  /** What to apply, measured now: the lift of each corner and the shift of the right controls */
  function measure(): { left: number; right: number; shift: number } {
    if (!container.isConnected) return { left: 0, right: 0, shift: 0 };
    const box = container.getBoundingClientRect();
    // The corners where maplibre-gl places them (a corner keeps its place across)
    const place = (side: 'left' | 'right'): Box | null => {
      const el = corner(side);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      if (r.width === 0) return null;
      return moved(r, 0, side === 'left' ? now.left : now.right);
    };
    const left = place('left');
    const right = place('right');

    // The toolbar: the band it takes at the bottom of the map
    const measured = bar()?.getBoundingClientRect();
    const b = measured && measured.width > 0 && measured.height > 0 ? measured : null;
    const band = b ? Math.round(Math.max(0, Math.min(box.bottom - b.top, box.height))) : 0;
    const reachesBar = (r: Box | null) => !!r && !!b && across(r, b);

    let liftRight = reachesBar(right) ? band : 0;

    // The controls of the bottom right, to the left of the right region while it covers them
    let shift = 0;
    const controls = rightControls()
      .map((el) => el.getBoundingClientRect())
      .filter((r) => r.width > 0 && r.height > 0)
      .map((r) => moved(r, now.shift, now.right));
    const region = inset.right > 0 ? rightRegion()?.getBoundingClientRect() : undefined;
    if (region && region.width > 0 && controls.length > 0) {
      const stack: Box = {
        left: Math.min(...controls.map((r) => r.left)),
        right: Math.max(...controls.map((r) => r.right)),
        top: Math.min(...controls.map((r) => r.top)),
        bottom: Math.max(...controls.map((r) => r.bottom)),
      };
      if (upDown(moved(stack, 0, -liftRight), region)) {
        shift = Math.round(inset.right + gap());
        // Moved to the left, they may reach the toolbar across
        if (liftRight === 0 && reachesBar(moved(stack, -shift, 0))) liftRight = band;
      }
    }

    // The bottom left corner: above the toolbar, and above the attribution's box but on a narrow
    // map
    let liftLeft = reachesBar(left) ? band : 0;
    const attrib = narrow ? undefined : attribution()?.getBoundingClientRect();
    if (left && attrib && attrib.width > 0 && attrib.height > 0) {
      // Where the attribution goes, and the corner lifted as far as the toolbar asks
      const a = moved(attrib, 0, now.right - liftRight);
      const l = moved(left, 0, -liftLeft);
      if (across(a, l) && upDown(a, l)) liftLeft = Math.round(left.bottom - a.top);
    }
    return { left: Math.max(0, liftLeft), right: liftRight, shift };
  }

  function apply() {
    if (destroyed) return;
    // What a delivery measured before is out of date
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    const next = measure();
    set(next.left, next.right, next.shift);
  }

  /** The observer's delivery: measures now, and writes in the next frame */
  function delivered() {
    if (destroyed) return;
    const next = measure();
    if (frame) cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      frame = 0;
      if (!destroyed) set(next.left, next.right, next.shift);
    });
  }

  function follow() {
    const next = [
      container,
      bar(),
      corner('left'),
      corner('right'),
      attribution(),
      inset.right > 0 ? rightRegion() : null,
    ].filter((el): el is HTMLElement => !!el);
    if (next.length === observed.length && next.every((el, i) => el === observed[i])) return;
    observer?.disconnect();
    observed = next;
    if (typeof ResizeObserver === 'undefined') return;
    observer ??= new ResizeObserver(delivered);
    for (const el of observed) observer.observe(el);
  }

  return {
    update(next?: ShellInset, nextNarrow?: boolean) {
      if (destroyed) return;
      if (next) inset = { ...next };
      if (nextNarrow !== undefined) narrow = nextNarrow;
      follow();
      apply();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      observer?.disconnect();
      observer = undefined;
      observed = [];
      container.removeAttribute(LIFT_ATTRIBUTE);
      container.style.removeProperty('--mgd-ui-lift-left');
      container.style.removeProperty('--mgd-ui-lift-right');
      container.style.removeProperty('--mgd-ui-shift-right');
    },
  };
}
