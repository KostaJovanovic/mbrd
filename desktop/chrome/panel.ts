// One open menu, drawn in a window of its own. It has to be a window: the board
// is a child view composited above the bar's page, so a panel drawn there would
// sit under the board and never show. Main sends the menu as plain data, then
// sizes, places and shows this window from the size it reports back. The
// window lives all session, so it follows a look change as the bar does.

import type { MenuModel, PanelBridge, Point } from './bridge.ts';
import { accelLabel } from './accel.ts';
import { followLook } from './look.ts';

declare global {
  interface Window {
    mbrdPanel?: PanelBridge;
  }
}

const api = window.mbrdPanel;
const isMac = api?.platform === 'darwin';
const root = document.getElementById('panel');

function draw(list: HTMLElement, menu: MenuModel, run: (id: string) => void): void {
  list.textContent = '';
  for (const item of menu.items) {
    if ('separator' in item) {
      const sep = document.createElement('div');
      sep.className = 'panel-sep';
      list.append(sep);
      continue;
    }
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'panel-item';
    row.setAttribute('role', 'menuitem');
    const label = document.createElement('span');
    label.textContent = item.label;
    const key = document.createElement('span');
    key.className = 'panel-key';
    key.textContent = accelLabel(item.accel, isMac);
    row.append(label, key);
    row.addEventListener('click', () => run(item.id));
    list.append(row);
  }
}

/* The list keeps its natural size whatever the window is (#panel in
   titlebar.css), so it can be measured straight after drawing. Main sizes the
   window to the answer, plus the room its shadow is drawn in, and only then
   shows it. */
function report(bridge: PanelBridge, list: HTMLElement, at: Point): void {
  const box = list.getBoundingClientRect();
  const css = getComputedStyle(document.documentElement);
  const side = parseFloat(css.getPropertyValue('--panel-side')) || 0;
  const foot = parseFloat(css.getPropertyValue('--panel-foot')) || 0;
  bridge.size(Math.ceil(box.width + 2 * side), Math.ceil(box.height + foot), { x: at.x - side, y: at.y });
}

/** After the next frame is painted. */
const afterPaint = (fn: () => void) => requestAnimationFrame(() => requestAnimationFrame(fn));

followLook();

if (api && root) {
  api.onMenu(({ menu, at, opening }) => {
    draw(root, menu, id => api.run(id));
    // A menu dropped fresh waits, drawn but clear, for the window to be on
    // screen: a hidden window paints no frames, so a fade started now would be
    // spent by the time anybody saw it. One slid to from the next title shows at once.
    root.classList.remove('is-blank');
    root.classList.toggle('is-waiting', opening);
    report(api, root, at);
    // Again once the fonts are in. A hidden window paints no frames, so this
    // cannot wait on requestAnimationFrame.
    document.fonts.ready.then(() => report(api, root, at)).catch(() => {});
  });

  // On screen, with a clear frame painted first, so the fade starts from nothing.
  api.onShown(() => afterPaint(() => root.classList.remove('is-waiting')));

  // A window hidden keeps its last frame and shows it again on the next show,
  // where the next menu has not drawn yet: that frame, the last menu at full
  // strength, was the flash before every drop. So the last frame is a clear one.
  api.onBlank(() => {
    root.classList.add('is-blank');
    afterPaint(() => api.blanked());
  });

  // The shadow's margin is still this window, so a press there would land
  // nowhere. It closes the menu, as a press anywhere else outside it does.
  document.addEventListener('pointerdown', e => {
    if (!(e.target instanceof Node) || !root.contains(e.target)) api.close();
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      api.close();
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const rows = [...root.querySelectorAll<HTMLElement>('.panel-item')];
    if (!rows.length) return;
    const at = rows.findIndex(row => row === document.activeElement);
    const step = e.key === 'ArrowDown' ? 1 : -1;
    rows[(at + step + rows.length) % rows.length]?.focus();
  });
}
