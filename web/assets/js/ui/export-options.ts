// The export box: asked by Save image and Save PDF before either draws. How
// much detail (dots per inch of board), how hard the JPEG squeezes, how much
// clear board around the edge, and four marks that can be left out. Held for
// the session only - every load starts again from EXPORT_DEFAULTS.
//
// Its own <dialog> (#export-opts in index.html), for the reason link-props.ts
// has one: ask() holds one field. Reaches document only inside
// askExportOptions(), so nothing here runs at import.

import { board } from '../state.ts';
import { readToken } from '../util.ts';
import { EXPORT_DEFAULTS, exportSize } from './snapshot.ts';
import type { ExportOpts } from './snapshot.ts';
import { cue } from '../cuelume/engine.ts';
import { onTouch } from '../canvas/viewport.ts';

/** Which of the two buttons asked. Only the title differs. */
export type ExportKind = 'image' | 'pdf';

/** The four marks the box can leave out, each a checkbox and an ExportOpts flag. */
type Mark = 'web' | 'sheet' | 'grid' | 'grain';
const MARKS: readonly Mark[] = ['web', 'sheet', 'grid', 'grain'];

/**
 * The bounds a typed number is held to. Below 36 ppi a card's text is a
 * smear; past 1200 every board is held to the edge ceiling in snapshot.ts
 * anyway, so the number would only be a promise the picture does not keep.
 */
const PPI_MIN = 36;
const PPI_MAX = 1200;
const MARGIN_MAX = 200;

/** The session's working copy. Save writes it; Cancel leaves it. */
let current: ExportOpts = { ...EXPORT_DEFAULTS };

// One at a time: a second call while the box is up is ignored, not stacked.
let showing = false;

/** A number out of a field, held to its bounds, or `was` when it is not one. */
function numberIn(field: HTMLInputElement, min: number, max: number, was: number) {
  const n = parseFloat(field.value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : was;
}

/**
 * Ask how to export. Resolves to the options on Save, null on any other way
 * out - including a missing <dialog> or no document, which is a cancel rather
 * than a silent export at defaults nobody saw.
 */
export async function askExportOptions(kind: ExportKind): Promise<ExportOpts | null> {
  if (typeof document === 'undefined') return null;
  // SAFETY: #export-opts is a static <dialog> in index.html; the showModal
  // guard below also rules out a browser with no <dialog> support.
  const el = document.getElementById('export-opts') as HTMLDialogElement | null;
  if (!el || typeof el.showModal !== 'function') return null;

  // Every control is a static node in index.html's #export-opts block.
  // Narrowed by instanceof rather than asserted, so lost markup bails
  // instead of throwing.
  const input = (id: string) => {
    const node = document.getElementById(id);
    return node instanceof HTMLInputElement ? node : null;
  };
  const title = document.getElementById('xo-title');
  const size = document.getElementById('xo-size');
  const qualityOut = document.getElementById('xo-quality-out');
  const include = document.getElementById('xo-include');
  const go = document.getElementById('xo-go');
  const cancel = document.getElementById('xo-cancel');
  const ppi = input('xo-ppi');
  const quality = input('xo-quality');
  const margin = input('xo-margin');
  const web = input('xo-web');
  const sheet = input('xo-sheet');
  const grid = input('xo-grid');
  const grain = input('xo-grain');
  if (!title || !size || !qualityOut || !include || !go || !cancel
      || !ppi || !quality || !margin || !web || !sheet || !grid || !grain) return null;
  const boxes: Record<Mark, HTMLInputElement> = { web, sheet, grid, grain };

  if (showing) return null;
  showing = true;

  // A mark the board is not wearing has nothing to leave out, so its box is
  // absent rather than offered and ignored - the sidebar's rule for controls
  // that do not apply. snapshot.ts ands each option with the same setting.
  const s = board.settings;
  const applies: Record<Mark, boolean> = {
    web: !!s.web && board.connections.length > 0,
    sheet: !!s.paperShow && !!s.paper,
    grid: !!s.grid,
    grain: (parseFloat(readToken('--grain')) || 0) > 0,
  };

  title.textContent = kind === 'pdf' ? 'Save PDF' : 'Save image';
  ppi.value = String(current.ppi);
  quality.value = String(Math.round(current.quality * 100));
  margin.value = String(current.margin);
  for (const key of MARKS) {
    boxes[key].checked = current[key];
    // The <label> wrapping the box is the row.
    const row = boxes[key].closest('label');
    if (row) row.hidden = !applies[key];
  }
  include.hidden = !Object.values(applies).some(Boolean);

  /** The options as the box shows them now, bounded. */
  const read = (): ExportOpts => ({
    ppi: Math.round(numberIn(ppi, PPI_MIN, PPI_MAX, current.ppi)),
    quality: numberIn(quality, 1, 100, current.quality * 100) / 100,
    margin: numberIn(margin, 0, MARGIN_MAX, current.margin),
    web: boxes.web.checked,
    sheet: boxes.sheet.checked,
    grid: boxes.grid.checked,
    grain: boxes.grain.checked,
  });

  // The readout answers the question the ppi field raises - how big is that? -
  // and says so when a ceiling took the detail down, so the number typed is
  // never quietly not what came out.
  const paint = () => {
    const o = read();
    qualityOut.textContent = `${Math.round(o.quality * 100)}%`;
    const out = exportSize(o);
    if (!out) { size.textContent = ''; return; }
    const px = `${out.w} × ${out.h} px`;
    size.textContent = out.capped ? `${px}, held to ${Math.floor(out.ppi)} ppi` : px;
  };

  return new Promise<ExportOpts | null>(resolve => {
    let answer: ExportOpts | null = null;
    const close = () => { cue('pick'); el.close(); };
    const save = () => {
      answer = read();
      current = { ...answer };
      close();
    };

    const onGo = (e: Event) => { e.preventDefault(); save(); };
    const onCancel = () => close();
    // A click on the <dialog> itself (the backdrop), not a child, cancels.
    const onClick = (e: MouseEvent) => { if (e.target === el) close(); };
    // Enter anywhere in the box saves; Escape is the browser's own cancel→close.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter' && !(e.target instanceof HTMLButtonElement)) { e.preventDefault(); save(); }
    };

    const onClose = () => {
      go.removeEventListener('click', onGo);
      cancel.removeEventListener('click', onCancel);
      el.removeEventListener('click', onClick);
      el.removeEventListener('keydown', onKey);
      el.removeEventListener('input', paint);
      el.removeEventListener('close', onClose);
      showing = false;
      resolve(answer);
    };

    go.addEventListener('click', onGo);
    cancel.addEventListener('click', onCancel);
    el.addEventListener('click', onClick);
    el.addEventListener('keydown', onKey);
    // One listener for every control: each changes either the readout or nothing.
    el.addEventListener('input', paint);
    el.addEventListener('close', onClose);

    paint();
    el.showModal();
    // Touch: focus the dialog, not a field, so the keyboard does not spring
    // up before a tap. Desktop: Save, since the defaults are the usual answer.
    if (onTouch()) { el.tabIndex = -1; el.focus(); } else go.focus();
  });
}
