// Show and hide a panel that is built when it opens — the drawer, the sticker
// pad, the Playlist. #sidebar is in index.html and only toggles `is-open`, so
// its slide always runs; a sheet appended a moment before the class is styled
// in the same pass as the append and simply appears. The read below is what
// separates the two passes, and is the whole reason this module exists.

/** How long to wait for the slide out before taking the node anyway. */
const EXIT_MS = 500;

/** Per element, so a quick close-and-reopen cannot drop the first one's backstop. */
const exits = new WeakMap<Element, number>();

/** Slide a freshly appended sheet in. Call after it is in the document. */
export function showSheet(el: HTMLElement): void {
  el.setAttribute('aria-hidden', 'false');
  void el.offsetWidth;
  el.classList.add('is-open');
}

/** Slide it out and take it away after — on the transition's own end where
 *  there is one, and on a timer where there is not. */
export function hideSheet(el: HTMLElement): void {
  el.setAttribute('aria-hidden', 'true');
  el.classList.remove('is-open');
  clearTimeout(exits.get(el));
  const done = () => {
    clearTimeout(exits.get(el));
    exits.delete(el);
    el.remove();
  };
  el.addEventListener('transitionend',
    e => { if (e.propertyName === 'transform') done(); }, { once: true });
  exits.set(el, setTimeout(done, EXIT_MS));
}
