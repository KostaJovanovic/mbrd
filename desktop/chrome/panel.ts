// One open menu, drawn in a window of its own. It has to be a window: the board
// is a child view composited above the bar's page, so a panel drawn there would
// sit under the board and never show. Main sends the menu as plain data, then
// sizes, places and shows this window from the size it reports back.

import type { MenuModel, PanelBridge, Point } from './bridge.ts';
import { accelLabel } from './accel.ts';

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
   window to the answer and only then shows it. */
function report(bridge: PanelBridge, list: HTMLElement, at: Point): void {
  const box = list.getBoundingClientRect();
  bridge.size(Math.ceil(box.width), Math.ceil(box.height), at);
}

if (api && root) {
  api.onMenu(({ menu, at, opening }) => {
    draw(root, menu, id => api.run(id));
    // Restarted while the window is still hidden, so its first frame on screen
    // is the animation's first.
    root.classList.remove('is-opening');
    if (opening) {
      void root.offsetWidth;
      root.classList.add('is-opening');
    }
    report(api, root, at);
    // Again once the fonts are in. A hidden window paints no frames, so this
    // cannot wait on requestAnimationFrame.
    document.fonts.ready.then(() => report(api, root, at)).catch(() => {});
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
