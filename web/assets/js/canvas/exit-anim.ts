// The animation a card plays as it is deleted.
//
// A delete is instant in state - removeItems() drops the item and items.js
// discards its node the same tick. That is correct and must stay correct:
// nothing here touches state, undo, media release or culling. The animation
// runs on a *clone* of the doomed node, lifted into a screen-space overlay,
// while the real node is discarded on schedule. Cloning is the whole trick:
//
//   - Undo can rebuild the item immediately (its id is free) without a ghost
//     fighting the rebuilt node for the same slot.
//   - The clone owns no registered player and no live <video>/<audio> source
//     (we strip them), so a card fading out cannot keep a stream open - the
//     one thing discard() in items.js exists to prevent.
//
// The overlay is screen space, so the world's +y-up sign flip and the pan/zoom
// transform on #world are all irrelevant here: a clone placed at the node's
// client rect stays put while the board pans underneath it.
//
// The feel is chosen by the whimsy tier (Softish/Middle/Harsh), except the
// title card, which is a singleton headed for its own restore button in the
// bin dock: it simply vanishes, and a small chip tumbles down to the bin in its
// place - a hint at where it went, not the whole card sailing over.

/** The four feels, each of which is a `.exit-<kind>` rule in the stylesheet. */
export type ExitKind = 'chip' | 'fall' | 'shatter' | 'dissolve';

/** The whimsy tiers, as the dataset string or the raw number tests pass. */
const TIER_KIND: Record<string, ExitKind> = { 0: 'fall', 2: 'shatter' };

/**
 * The exit animation kind for an item, as a bare string the CSS turns into
 * keyframes (`.exit-<kind>`). Pure and DOM-free so it can be unit-tested:
 *
 *   - a title card is a 'chip' (the card vanishes, a scrap falls to the bin),
 *     whatever the whimsy tier;
 *   - otherwise the whimsy tier picks the feel, defaulting to a plain dissolve
 *     for the middle tier and any unset/unknown value.
 */
export function exitKindFor(
  type: string | undefined,
  whimsy: string | number | null | undefined,
): ExitKind {
  if (type === 'title') return 'chip';
  return (whimsy == null ? undefined : TIER_KIND[whimsy]) ?? 'dissolve';
}

/** ms to keep a clone before force-removing it, if animationend never fires. */
const FALLBACK_MS = 700;

/** The lazily-created overlay every fly-out clone lives in. */
function exitLayer(): HTMLElement {
  let layer: HTMLElement | null = document.getElementById('exit-layer');
  if (!layer) {
    layer = document.createElement('div');
    layer.id = 'exit-layer';
    document.body.append(layer);
  }
  return layer;
}

/** Remove `node` when its animation ends, with a timeout in case it never does. */
function sweepOnEnd(node: Element): void {
  let done = false;
  const finish = () => { if (done) return; done = true; clearTimeout(timer); node.remove(); };
  const timer = setTimeout(finish, FALLBACK_MS);
  // `e.target !== node` fences it. animationend bubbles, and the ghost is a
  // *deep* clone of a card - so any descendant that happens to be animating
  // when the copy was taken (a spinner, a waveform, an is-landing note) ended
  // the whole ghost's life on its own first frame. `once` is kept: the first
  // event this filter admits is the one it was waiting for.
  node.addEventListener('animationend', function onEnd(e) {
    if (e.target !== node) return;
    node.removeEventListener('animationend', onEnd);
    finish();
  });
}

/**
 * The title card's exit: the card itself vanishes (its node is discarded by the
 * caller) and a small chip appears just above the bin button, lifts, then drops
 * into it. The motion is entirely at the bin - the chip does not travel from
 * where the card was. A no-op if there is no bin, so the card just disappears.
 */
function dropChip() {
  const bin = document.getElementById('bin-btn')?.getBoundingClientRect();
  if (!bin) return;

  const chip = document.createElement('div');
  chip.className = 'exit-anim exit-chip';
  chip.style.left = Math.round(bin.left + bin.width / 2) + 'px';
  chip.style.top = Math.round(bin.top + bin.height / 2) + 'px';

  exitLayer().append(chip);
  sweepOnEnd(chip);
}

/**
 * Send `el`'s appearance flying out as its item is deleted. The title card
 * drops a chip toward the bin (dropChip); every other card clones its own node,
 * parks the clone at the node's current screen position, and plays the whimsy
 * tier's keyframes. A no-op for a node that is detached or off-screen - there
 * is nothing to watch leave.
 */
export function flyOut(el: HTMLElement | null | undefined): void {
  if (!el?.isConnected) return;
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return;

  const kind = exitKindFor(el.dataset.type, document.documentElement.dataset.whimsy);
  if (kind === 'chip') { dropChip(); return; }

  const g = el.cloneNode(true) as HTMLElement;
  // The ghost is not selected and holds nothing that could play or fetch.
  g.classList.remove('is-selected', 'is-stick-target');
  for (const m of g.querySelectorAll('video, audio, iframe')) m.removeAttribute('src');

  g.style.position = 'fixed';
  g.style.margin = '0';
  g.style.left = rect.left + 'px';
  g.style.top = rect.top + 'px';
  g.style.width = rect.width + 'px';
  g.style.height = rect.height + 'px';

  g.classList.add('exit-anim', 'exit-' + kind);
  exitLayer().append(g);
  sweepOnEnd(g);
}
