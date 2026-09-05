// Putting a floating panel under the control that opened it, and keeping it
// there.
//
// The panels this positions hang off chips in a row that can be anywhere: in
// the strip above the dock, or inside a dock panel that clips its own
// contents and may be a few hundred pixels wide. So the panel is moved to the
// document and placed by measurement rather than by the cascade: `absolute`
// inside the row would be clipped, and a `fixed` element inside a transformed
// ancestor is positioned against the ancestor rather than the viewport, which
// dockview gives us on a floating group.

import type { Action } from 'svelte/action';

/** Space kept between the panel and the edge of the screen. */
const MARGIN = 8;
/** Space between the control and the panel it opened. */
const GAP = 5;

/**
 * Moves `node` to the end of the document and puts it under `anchor`, on the
 * screen: left-aligned with the anchor where there is room, above it where
 * there is none below, and never past an edge. Follows a resize or a scroll,
 * and puts the node back on the way out.
 */
export const anchored: Action<HTMLElement, HTMLElement> = (node, anchor) => {
  let target = anchor;
  node.style.position = 'fixed';
  // Over the dock, whose own overlays sit at 999.
  node.style.zIndex = '1000';
  document.body.append(node);

  const place = () => {
    const a = target.getBoundingClientRect();
    const w = node.offsetWidth;
    const h = node.offsetHeight;
    const room = Math.max(MARGIN, window.innerWidth - w - MARGIN);
    node.style.left = `${String(Math.min(Math.max(MARGIN, a.left), room))}px`;
    // Below by preference; above when the room below is not enough and the
    // room above is more.
    const below = window.innerHeight - a.bottom - GAP - MARGIN;
    const above = a.top - GAP - MARGIN;
    const top = below < h && above > below ? a.top - GAP - h : a.bottom + GAP;
    node.style.top = `${String(Math.min(Math.max(MARGIN, top), Math.max(MARGIN, window.innerHeight - h - MARGIN)))}px`;
  };

  place();
  // Measured again after the browser has laid the panel out: the first pass
  // reads a height the content has not settled into.
  const frame = requestAnimationFrame(place);
  const observer = new ResizeObserver(place);
  observer.observe(node);
  window.addEventListener('resize', place);
  // Capturing, so a scroll in any box the anchor sits in is heard.
  window.addEventListener('scroll', place, true);

  return {
    update(next: HTMLElement) {
      target = next;
      place();
    },
    destroy() {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
      node.remove();
    },
  };
};
