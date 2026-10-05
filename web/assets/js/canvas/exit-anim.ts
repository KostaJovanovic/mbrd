// Delete animation: clones the doomed card into a screen-space overlay and
// plays a whimsy-tiered exit. The real node is discarded immediately.
// Media sources are stripped from the clone so nothing keeps playing.

export type ExitKind = 'chip' | 'fall' | 'shatter' | 'dissolve';
const TIER_KIND: Record<string, ExitKind> = { 0: 'fall', 2: 'shatter' };

export function exitKindFor(
  type: string | undefined,
  whimsy: string | number | null | undefined,
): ExitKind {
  if (type === 'title') return 'chip';
  return (whimsy == null ? undefined : TIER_KIND[whimsy]) ?? 'dissolve';
}

const FALLBACK_MS = 700;

function exitLayer(): HTMLElement {
  let layer: HTMLElement | null = document.getElementById('exit-layer');
  if (!layer) {
    layer = document.createElement('div');
    layer.id = 'exit-layer';
    document.body.append(layer);
  }
  return layer;
}

function sweepOnEnd(node: Element): void {
  let done = false;
  const finish = () => { if (done) return; done = true; clearTimeout(timer); node.remove(); };
  const timer = setTimeout(finish, FALLBACK_MS);
  // Filter to own event — animationend bubbles from animated descendants.
  node.addEventListener('animationend', function onEnd(e) {
    if (e.target !== node) return;
    node.removeEventListener('animationend', onEnd);
    finish();
  });
}

/** Take back an exit still playing: its card has come back (an undo inside
 *  the exit's few hundred ms), and the ghost would fall over the card itself.
 *  The ghost's wrapper carries the card's data-id - see flyOut(). */
export function cancelExit(id: string): void {
  if (typeof document === 'undefined') return;
  const layer = document.getElementById('exit-layer');
  if (!layer) return;
  for (const g of layer.querySelectorAll<HTMLElement>('.exit-anim')) {
    if (g.dataset.id === id) g.remove();
  }
}

function dropChip() {
  const dock = document.getElementById('drawer-btn')?.getBoundingClientRect();
  if (!dock) return;

  const chip = document.createElement('div');
  chip.className = 'exit-anim exit-chip';
  chip.style.left = Math.round(dock.left + dock.width / 2) + 'px';
  chip.style.top = Math.round(dock.top + dock.height / 2) + 'px';

  exitLayer().append(chip);
  sweepOnEnd(chip);
}

/**
 * Play `el`'s exit from where it stands on screen. `zoom` is the board's, which
 * the clone needs because it leaves the world's own scale behind.
 *
 * The clone keeps its board size, lean and inline transform (the card's rot and
 * device snap) and is scaled by the zoom, so its first frame is the card. The
 * exit keyframes animate `transform` and play on a wrapper round it, centred on
 * the card, so they compose over all of that instead of replacing it: a turned
 * card leaves turned, and the contents never reflow to the screen box.
 */
export function flyOut(el: HTMLElement | null | undefined, zoom = 1): void {
  if (!el?.isConnected) return;
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return;

  const kind = exitKindFor(el.dataset.type, document.documentElement.dataset.whimsy);
  if (kind === 'chip') { dropChip(); return; }

  // SAFETY: cloneNode() keeps the interface of the node it copies, and el is an HTMLElement.
  const g = el.cloneNode(true) as HTMLElement;
  g.classList.remove('is-selected', 'is-stick-target');
  for (const m of g.querySelectorAll('video, audio, iframe')) m.removeAttribute('src');

  const w = el.offsetWidth, h = el.offsetHeight;
  g.style.position = 'absolute';
  g.style.margin = '0';
  g.style.left = -w / 2 + 'px';
  g.style.top = -h / 2 + 'px';
  g.style.width = w + 'px';
  g.style.height = h + 'px';
  g.style.scale = String(zoom);

  // A zero-size box on the card's centre, so the keyframes pivot about it.
  const wrap = document.createElement('div');
  wrap.className = 'exit-anim exit-' + kind;
  // cancelExit() finds the ghost by this.
  if (el.dataset.id) wrap.dataset.id = el.dataset.id;
  wrap.style.position = 'fixed';
  wrap.style.left = rect.left + rect.width / 2 + 'px';
  wrap.style.top = rect.top + rect.height / 2 + 'px';
  wrap.append(g);
  exitLayer().append(wrap);
  sweepOnEnd(wrap);
}
