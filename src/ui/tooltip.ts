// `use:tooltip={text}`: a themed hover/focus popover for controls, replacing
// native `title` bubbles so every hint looks the same in every theme.

const DELAY_MS = 350;

export interface TooltipOptions {
  text: string;
  placement?: 'top' | 'bottom';
}

/**
 * Attaches a tooltip to `node`, shown on hover and on keyboard focus.
 *
 * A null, empty or absent `param` attaches nothing and removes whatever was
 * there, so a hint can be made conditional without conditionally applying the
 * action. The bubble appears after `DELAY_MS`, is clamped to the viewport, and
 * flips to the other side when the preferred one has no room. Text only, set
 * through `textContent`: nothing here interpolates markup.
 *
 * Cleans up after itself on `destroy`, including a bubble still on screen and a
 * timer still pending, so a node removed mid-hover leaves nothing behind.
 */
export function tooltip(node: HTMLElement, param: string | TooltipOptions | null | undefined) {
  let opts = normalize(param);
  let el: HTMLDivElement | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const show = () => {
    if (!opts?.text || el) return;
    el = document.createElement('div');
    el.className = 'abix-tip';
    el.setAttribute('role', 'tooltip');
    el.textContent = opts.text;
    document.body.appendChild(el);
    node.setAttribute(
      'aria-describedby',
      (el.id = 'tip-' + Math.random().toString(36).slice(2, 8)),
    );
    position();
  };
  const position = () => {
    if (!el) return;
    const r = node.getBoundingClientRect();
    const tw = el.offsetWidth;
    const th = el.offsetHeight;
    let x = r.left + r.width / 2 - tw / 2;
    x = Math.max(8, Math.min(x, window.innerWidth - tw - 8));
    const below = r.bottom + 8;
    const above = r.top - th - 8;
    const place =
      opts?.placement === 'top'
        ? above >= 8
          ? 'top'
          : 'bottom'
        : below + th <= window.innerHeight - 8
          ? 'bottom'
          : 'top';
    el.style.left = `${x}px`;
    el.style.top = `${place === 'bottom' ? below : above}px`;
    el.dataset['place'] = place;
  };
  const hide = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (el) {
      el.remove();
      el = null;
      node.removeAttribute('aria-describedby');
    }
  };
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(show, DELAY_MS);
  };

  node.addEventListener('mouseenter', schedule);
  node.addEventListener('mouseleave', hide);
  node.addEventListener('focus', schedule);
  node.addEventListener('blur', hide);
  node.addEventListener('mousedown', hide);
  node.addEventListener('keydown', hide);
  window.addEventListener('scroll', hide, true);

  return {
    update(p: string | TooltipOptions | null | undefined) {
      opts = normalize(p);
      if (el && opts) {
        el.textContent = opts.text;
        position();
      }
    },
    destroy() {
      hide();
      node.removeEventListener('mouseenter', schedule);
      node.removeEventListener('mouseleave', hide);
      node.removeEventListener('focus', schedule);
      node.removeEventListener('blur', hide);
      node.removeEventListener('mousedown', hide);
      node.removeEventListener('keydown', hide);
      window.removeEventListener('scroll', hide, true);
    },
  };
}

function normalize(p: string | TooltipOptions | null | undefined): TooltipOptions | null {
  if (!p) return null;
  return typeof p === 'string' ? { text: p } : p;
}
