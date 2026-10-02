// The export box: asked by Save image and Save PDF before either draws. How
// much detail (dots per inch of board), how hard the JPEG squeezes, how much
// clear board around the edge, whether only the selection, and the marks that
// can be left out, with the export drawn small beside them. Held for the session only - every load
// starts again from EXPORT_DEFAULTS.
//
// Its own <dialog> (#export-opts in index.html), for the reason link-props.ts
// has one: ask() holds one field. Reaches document only inside
// askExportOptions(), so nothing here runs at import.

import { board, byId, isFence, selection, travelling } from '../state.ts';
import { readToken } from '../util.ts';
import { formatSize, MM_PER_INCH } from '../measure.ts';
import { EXPORT_DEFAULTS, boardPreview, boardShadows, boardTilts, exportSize } from './snapshot.ts';
import type { ExportOpts } from './snapshot.ts';
import { cue } from '../cuelume/engine.ts';
import { onTouch } from '../canvas/viewport.ts';

/** Which of the two buttons asked. Each keeps its own options. */
export type ExportKind = 'image' | 'pdf';

/** What the box can leave out, each a checkbox and an ExportOpts flag. */
type Mark = 'web' | 'sheet' | 'grid' | 'grain' | 'tilt' | 'shadows';
const MARKS: readonly Mark[] = ['web', 'sheet', 'grid', 'grain', 'tilt', 'shadows'];

/**
 * The bounds a typed number is held to. Below 36 ppi a card's text is a
 * smear; past 1200 every board is held to the edge ceiling in snapshot.ts
 * anyway, so the number would only be a promise the picture does not keep.
 */
const PPI_MIN = 36;
const PPI_MAX = 1200;
const MARGIN_MAX = 200;

/** The preview's long edge in CSS pixels, and how long typing may run before it redraws. */
const PREVIEW_EDGE = 320;
const SETTLE_MS = 180;

/**
 * The session's working copies, one per button. Save writes its own; Cancel
 * leaves it. Kept apart because the two are asked for different ends - a
 * picture to send is often wanted lighter than a PDF to print - and a change
 * made for one should not turn up unasked in the other.
 */
const kept: Record<ExportKind, ExportOpts> = {
  image: { ...EXPORT_DEFAULTS },
  pdf: { ...EXPORT_DEFAULTS },
};

/** Whether the last Save asked for only the selection, per button. Off to start:
 *  a selection is often left standing, and the whole board is the usual ask. */
const wantOnly: Record<ExportKind, boolean> = { image: false, pdf: false };

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
  const mount = document.getElementById('xo-preview-mount');
  const caption = document.getElementById('xo-preview-cap');
  const go = document.getElementById('xo-go');
  const cancel = document.getElementById('xo-cancel');
  const ppi = input('xo-ppi');
  const quality = input('xo-quality');
  const margin = input('xo-margin');
  const web = input('xo-web');
  const sheet = input('xo-sheet');
  const grid = input('xo-grid');
  const grain = input('xo-grain');
  const tilt = input('xo-tilt');
  const shadows = input('xo-shadows');
  const only = input('xo-only');
  const onlyRow = document.getElementById('xo-only-row');
  const onlyLabel = document.getElementById('xo-only-label');
  if (!title || !size || !qualityOut || !include || !mount || !caption || !go || !cancel
      || !ppi || !quality || !margin || !web || !sheet || !grid || !grain || !tilt || !shadows
      || !only || !onlyRow || !onlyLabel) return null;
  const boxes: Record<Mark, HTMLInputElement> = { web, sheet, grid, grain, tilt, shadows };

  if (showing) return null;
  showing = true;

  // What "only the selection" would draw: what is selected and what travels
  // with it, so a selected fence comes out with what it holds, framed on it.
  // Asked fresh each time the box opens - the selection is not the session's.
  const picked = travelling(selection);
  onlyRow.hidden = !picked.length;
  onlyLabel.textContent = selection.size === 1 && isFence(byId([...selection][0]))
    ? 'Only this fence' : 'Only the selection';
  only.checked = !!picked.length && wantOnly[kind];

  // A mark the board is not wearing has nothing to leave out, so its box is
  // absent rather than offered and ignored - the sidebar's rule for controls
  // that do not apply. snapshot.ts ands each option with the same setting.
  const s = board.settings;
  const applies: Record<Mark, boolean> = {
    web: !!s.web && board.connections.length > 0,
    sheet: !!s.paperShow && !!s.paper,
    grid: !!s.grid,
    grain: (parseFloat(readToken('--grain')) || 0) > 0,
    tilt: boardTilts(),
    shadows: boardShadows(),
  };

  title.textContent = kind === 'pdf' ? 'Save PDF' : 'Save image';
  const current = kept[kind];
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
    quality: numberIn(quality, 0, 100, current.quality * 100) / 100,
    margin: numberIn(margin, 0, MARGIN_MAX, current.margin),
    web: boxes.web.checked,
    sheet: boxes.sheet.checked,
    grid: boxes.grid.checked,
    grain: boxes.grain.checked,
    tilt: boxes.tilt.checked,
    shadows: boxes.shadows.checked,
    only: only.checked && picked.length ? picked : null,
  });

  // The preview is the export drawn small. Only what changes the picture
  // redraws it - margin and the checkboxes - since ppi and quality change
  // the file's resolution, which a preview this size cannot show. A redraw
  // loads every picture on the board, so typing is let settle first, and a
  // render that finishes after a newer one started is thrown away.
  let drawn = '';
  let generation = 0;
  let timer = 0;
  const redraw = (o: ExportOpts) => {
    const key = JSON.stringify([o.margin, o.web, o.sheet, o.grid, o.grain, o.tilt, o.shadows, !!o.only]);
    if (key === drawn) return;
    drawn = key;
    const mine = ++generation;
    clearTimeout(timer);
    mount.classList.add('is-stale');
    timer = window.setTimeout(() => {
      const edge = Math.round(PREVIEW_EDGE * Math.min(2, window.devicePixelRatio || 1));
      boardPreview(o, edge).then(canvas => {
        if (mine !== generation) return;
        mount.replaceChildren(...(canvas ? [canvas] : []));
        mount.classList.remove('is-stale');
      }, err => { console.error(err); if (mine === generation) mount.classList.remove('is-stale'); });
    }, drawn && mount.childElementCount ? SETTLE_MS : 0);
  };

  // The readout answers the question the ppi field raises - how big is that? -
  // and says so when a ceiling took the detail down, so the number typed is
  // never quietly not what came out. The caption under the preview answers
  // the other one: how big on paper.
  const paint = () => {
    const o = read();
    qualityOut.textContent = `${Math.round(o.quality * 100)}%`;
    redraw(o);
    const out = exportSize(o);
    if (!out) { size.textContent = ''; caption.textContent = ''; return; }
    const px = `${out.w} × ${out.h} px`;
    size.textContent = out.capped ? `${px}, held to ${Math.floor(out.ppi)} ppi` : px;
    const system = board.settings.units === 'imperial' ? 'imperial' : 'metric';
    // formatSize() at a scale of 1 reads its units as millimetres.
    const mm = (n: number) => n / out.ppi * MM_PER_INCH;
    caption.textContent = `${kind === 'pdf' ? 'Page' : 'Prints at'} ${formatSize(mm(out.w), mm(out.h), 1, system)}`;
  };

  return new Promise<ExportOpts | null>(resolve => {
    let answer: ExportOpts | null = null;
    const close = () => { cue('pick'); el.close(); };
    const save = () => {
      answer = read();
      // The ids are this selection's; only the wish carries to the next box.
      kept[kind] = { ...answer, only: null };
      if (picked.length) wantOnly[kind] = only.checked;
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
      // Nothing late may land, and the picture goes with the box.
      clearTimeout(timer);
      generation++;
      mount.replaceChildren();
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
