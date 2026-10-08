// The pen bar: drawing mode's tools, inks and sizes, up while the mode is on,
// and the Draw button pressed with it. Markup is #pen-bar in index.html; the
// state is canvas/pen.ts's, and this only shows it and writes presses to it.
// Not a menu - it stays while you draw, which a menu by design does not.

import { bus } from '../state.ts';
import { cue } from '../cuelume/engine.ts';
import { drawingEnabled, onPen, penState, setPen, type PenState } from '../canvas/pen.ts';
import { isInk } from '../canvas/strokes.ts';

export function initPenBar(): void {
  const bar = document.getElementById('pen-bar');
  if (!bar) return;
  const drawBtn = document.querySelector('#toolbar [data-cmd="draw"]');

  bar.addEventListener('click', e => {
    if (!(e.target instanceof Element)) return;
    const btn = e.target.closest<HTMLElement>('button');
    if (!btn) return;
    const { penTool, penInk, penSize } = btn.dataset;
    if (penTool === 'pen' || penTool === 'highlighter' || penTool === 'eraser') setPen({ tool: penTool });
    // An ink picked with the eraser out means "draw in this": the pen comes back.
    else if (isInk(penInk)) setPen({ ink: penInk, tool: penState().tool === 'eraser' ? 'pen' : penState().tool });
    else if (penSize === '0') setPen({ size: 0 });
    else if (penSize === '1') setPen({ size: 1 });
    else if (penSize === '2') setPen({ size: 2 });
    else return;
    cue('pick');
  });

  const show = (s: PenState) => {
    bar.hidden = !s.on;
    bar.dataset.tool = s.tool;
    drawBtn?.setAttribute('aria-pressed', String(s.on));
    if (drawBtn instanceof HTMLElement) drawBtn.hidden = !drawingEnabled();
    for (const b of bar.querySelectorAll<HTMLElement>('button')) {
      const { penTool, penInk, penSize } = b.dataset;
      const pressed = penTool ? penTool === s.tool
        : penInk ? penInk === s.ink
        : penSize === String(s.size);
      b.setAttribute('aria-pressed', String(pressed));
    }
  };
  onPen(show);
  show(penState());

  // A board opening or the layout changing puts the pen down, as both put the
  // Join tool down (ui/toolbar.ts).
  bus.on('board:load', () => { if (penState().on) setPen({ on: false }); });
  bus.on('layout', () => { if (penState().on) setPen({ on: false }); });
}
