// The title bar page: the mark, the drawn menus, the board's name, a drag
// spacer and the window buttons. It is the window's own web contents; the board
// is a separate view below it, so everything arrives through mbrdChrome. A port
// of FileAnalyser's chrome/titlebar.js, without its back and forward arrows.

import type { ChromeBridge, MenuModel, Subject, UpdateOffer, UpdateState, WinState } from './bridge.ts';
import { followLook } from './look.ts';

declare global {
  interface Window {
    mbrdChrome?: ChromeBridge;
  }
}

type Glyph = 'min' | 'max' | 'restore' | 'close';

/* On Windows the system's own caption glyphs (Segoe MDL2 Assets, Segoe Fluent
   Icons), so the buttons match every native title bar at any DPI. Those fonts
   exist nowhere else, so other systems get a small SVG set. Escapes, because
   the codepoints are private-use and show as blanks in an editor. */
const FONT_GLYPH: Record<Glyph, string> = {
  min: '',
  max: '',
  restore: '',
  close: '',
};

const SVG_NS = 'http://www.w3.org/2000/svg';
const SVG_GLYPH: Record<Glyph, [string, Record<string, string>][]> = {
  min: [['path', { d: 'M1 6.5h10' }]],
  max: [['rect', { x: '1.5', y: '1.5', width: '9', height: '9' }]],
  restore: [
    ['path', { d: 'M3.5 3.5v-2h7v7h-2' }],
    ['rect', { x: '1.5', y: '3.5', width: '7', height: '7' }],
  ],
  close: [['path', { d: 'M2 2 10 10M10 2 2 10' }]],
};

const bridge = window.mbrdChrome;
const isMac = bridge?.platform === 'darwin';
const useFont = bridge?.platform === 'win32';

function icon(name: Glyph, extra = ''): Element {
  if (useFont) {
    const span = document.createElement('span');
    span.className = `tb-ico tb-ico-font ${extra}`.trim();
    span.setAttribute('aria-hidden', 'true');
    span.textContent = FONT_GLYPH[name];
    return span;
  }
  const svg = document.createElementNS(SVG_NS, 'svg');
  const attrs = {
    class: `tb-ico ${extra}`.trim(), width: '12', height: '12', viewBox: '0 0 12 12',
    'aria-hidden': 'true', focusable: 'false', fill: 'none', stroke: 'currentColor', 'stroke-width': '1',
  };
  for (const [key, value] of Object.entries(attrs)) svg.setAttribute(key, value);
  for (const [tag, shape] of SVG_GLYPH[name]) {
    const part = document.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(shape)) part.setAttribute(key, value);
    svg.append(part);
  }
  return svg;
}

function button(cls: string, label: string, ...inner: Element[]): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `tb-btn ${cls}`;
  b.title = label;
  b.setAttribute('aria-label', label);
  b.append(...inner);
  return b;
}

/** The window's state, on <html>, for the maximise glyph and the unfocused look. */
function applyState(state: WinState): void {
  const classes = document.documentElement.classList;
  classes.toggle('win-max', state.maximized);
  classes.toggle('win-full', state.fullScreen);
  classes.toggle('win-focused', state.focused);
}

/* The menus. The titles are drawn here, and each open menu is a window of its
   own (panel.ts): the board is a child view that composites above this page,
   so it would cover a panel drawn here. Main owns the panel, the bar owns which
   title is lit. Click to open, slide across to switch, Escape or a click away
   to close. */
let openMenu: HTMLElement | null = null;

/* `menu-open` makes the whole bar no-drag while a menu is down. Otherwise the
   OS takes a press on the drag region before the page sees it, and a click on
   the bar starts a window drag instead of closing the menu. */
function markClosed(): void {
  openMenu?.classList.remove('is-open');
  openMenu = null;
  document.documentElement.classList.remove('menu-open');
}

function closeMenu(): void {
  if (!openMenu) return;
  markClosed();
  bridge?.closeMenu();
}

function showMenu(entry: HTMLElement): void {
  if (openMenu === entry) return;
  openMenu?.classList.remove('is-open');
  entry.classList.add('is-open');
  openMenu = entry;
  document.documentElement.classList.add('menu-open');
  // The title's box in this page's coordinates. Only main knows where the
  // window is on the screen.
  const box = entry.getBoundingClientRect();
  bridge?.openMenu(entry.dataset.menu ?? '', Math.round(box.left), Math.round(box.bottom));
}

function menuEntry(menu: MenuModel): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'tb-menu';
  wrap.dataset.menu = menu.id;
  const title = document.createElement('button');
  title.type = 'button';
  title.className = 'tb-btn tb-menu-title';
  title.textContent = menu.label;
  title.setAttribute('aria-haspopup', 'true');
  title.addEventListener('click', () => {
    if (openMenu === wrap) closeMenu();
    else showMenu(wrap);
  });
  // Once one menu is open, sliding across the others switches between them.
  wrap.addEventListener('mouseenter', () => {
    if (openMenu && openMenu !== wrap) showMenu(wrap);
  });
  wrap.append(title);
  return wrap;
}

// A press anywhere on the bar but the open title closes the menu. A press
// outside this window closes it through main, when the panel loses focus.
document.addEventListener('pointerdown', e => {
  if (openMenu && !(e.target instanceof Node && openMenu.contains(e.target))) closeMenu();
}, true);
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeMenu();
});

/**
 * The Update button, as Discord has one: a green arrow and the word, at the
 * right of the bar, only while updates.ts has something to say. Every answer
 * about updates is said here, and never in a dialog. Built by hand rather than
 * through icon(), whose glyphs are the window buttons' and one colour.
 */
function updateButton(api: ChromeBridge): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'tb-btn tb-update';
  btn.hidden = true;
  const svg = document.createElementNS(SVG_NS, 'svg');
  for (const [key, value] of Object.entries({
    width: '12', height: '12', viewBox: '0 0 12 12', 'aria-hidden': 'true', focusable: 'false',
    fill: 'none', stroke: 'currentColor', 'stroke-width': '1.6', 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
  })) svg.setAttribute(key, value);
  const arrow = document.createElementNS(SVG_NS, 'path');
  arrow.setAttribute('d', 'M6 1.5v7M3 5.5l3 3 3-3M2 10.5h8');
  svg.append(arrow);
  const word = document.createElement('span');
  word.className = 'tb-update-word';
  word.textContent = 'Update';
  btn.append(svg, word);
  btn.addEventListener('click', () => api.update());
  return btn;
}

/** The word the button says in each state. The tooltip carries the sentence. */
const WORDS: Record<UpdateState, (offer: UpdateOffer) => string> = {
  available: () => 'Update',
  downloading: offer => `Downloading ${Math.round((offer.progress ?? 0) * 100)}%`,
  installing: () => 'Restarting',
  manual: () => 'Update',
  failed: () => 'Retry update',
  checking: () => 'Checking for updates',
  current: () => 'Up to date',
  dev: () => 'No updates in a dev copy',
};

/** The states in which a press does something. */
const PRESSABLE = new Set<UpdateState>(['available', 'manual', 'failed']);

function paintUpdate(btn: HTMLButtonElement, offer: UpdateOffer | null): void {
  btn.hidden = !offer;
  if (!offer) return;
  const word = btn.querySelector('.tb-update-word');
  if (word) word.textContent = WORDS[offer.state](offer);
  btn.dataset.state = offer.state;
  btn.title = offer.note;
  btn.setAttribute('aria-label', offer.note);
  btn.disabled = !PRESSABLE.has(offer.state);
  btn.style.setProperty('--progress', String(offer.progress ?? 0));
}

/** The board's name and the dirty mark, forwarded by main from setDocument. */
function paintSubject(el: HTMLElement, subject: Subject): void {
  el.textContent = subject.title || 'Untitled board';
  el.toggleAttribute('data-dirty', subject.dirty);
}

function build(api: ChromeBridge): void {
  document.documentElement.classList.toggle('mac', isMac);
  const bar = document.createElement('div');
  bar.id = 'titlebar';

  // Not on macOS, where the traffic lights sit in this corner.
  const mark = document.createElement('img');
  mark.className = 'tb-mark';
  mark.src = '/assets/img/icon.svg';
  mark.alt = '';
  mark.width = 16;
  mark.height = 16;
  mark.hidden = isMac;

  let menubar = document.createElement('div');
  menubar.className = 'tb-menubar';
  const subject = document.createElement('div');
  subject.className = 'tb-subject';
  const space = document.createElement('div');
  space.className = 'tb-space';

  // macOS keeps its own three buttons, and a second set would be one too many.
  const controls = document.createElement('div');
  controls.className = 'tb-ctl';
  controls.hidden = isMac;
  const minBtn = button('tb-min', 'Minimise', icon('min'));
  const maxBtn = button('tb-max', 'Maximise', icon('max', 'tb-ico-max'), icon('restore', 'tb-ico-restore'));
  const closeBtn = button('tb-close', 'Close', icon('close'));
  minBtn.addEventListener('click', () => api.minimize());
  maxBtn.addEventListener('click', () => api.toggleMaximize());
  closeBtn.addEventListener('click', () => api.close());
  controls.append(minBtn, maxBtn, closeBtn);
  const update = updateButton(api);

  bar.append(mark, menubar, subject, space, update, controls);
  document.body.append(bar);

  // A double-click on the bar's own surface maximises, as a title bar does.
  // The OS does that only when it draws the frame.
  bar.addEventListener('dblclick', e => {
    if (e.target instanceof Element && e.target.closest('button')) return;
    api.toggleMaximize();
  });

  api.menuModel().then(model => {
    const next = document.createElement('div');
    next.className = 'tb-menubar';
    next.append(...model.map(menuEntry));
    menubar.replaceWith(next);
    menubar = next;
  }).catch(() => { /* no drawn menus is survivable: every entry has an accelerator */ });

  api.onState(applyState);
  // The panel is another window, so the bar cannot see it dismissed. Main says so.
  api.onMenuClosed(markClosed);
  api.onSubject(next => paintSubject(subject, next));
  api.onUpdate(next => paintUpdate(update, next));

  // Measured from --tb-h in titlebar.css, so the number is written once. Again
  // on resize, because a zoom or a DPI change moves it.
  const report = () => api.height(bar.getBoundingClientRect().height);
  report();
  addEventListener('resize', report);
  document.fonts.ready.then(report).catch(() => {});
  // The bar loads before the board, so it asks for the state rather than
  // waiting to be told.
  api.ready();
}

followLook();

if (bridge) build(bridge);
