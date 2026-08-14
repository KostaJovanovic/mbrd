// What this board looked like before, and how to go back to it.
//
// Undo lives in memory and dies at the refresh, so until this existed the only
// recovery from *I have spent an hour making this worse* was to have thought to
// save a copy first. These are that copy, kept inside the board and travelling
// with it in the `.mbrd` - see BoardVersion in board-model.ts for why that costs
// no photographs, and for the price it does charge.
//
// ── Two kinds, because there are two questions ──
//
// An automatic version answers *what did I just break*: taken while you work,
// eight deep, oldest falling off the end. A named one answers *the version I
// showed the client*: taken because you said so, and never evicted. A single
// ring would answer the first and lose the second on the afternoon it mattered.
//
// ── Restoring is one undoable command ──
//
// state.ts owns that (restoreVersion), and it is the whole reason this file is
// small. Landing on the wrong version is exactly as likely as landing on the
// wrong anything else, and a history feature whose own central action could not
// be taken back would be the worst joke available.
//
// ── The sheet says the truth about the ring ──
//
// The automatic list is shown as what it is - a shallow ring that turns over -
// rather than as a permanent record. A person who thinks the app is keeping
// everything will find out that it is not at the moment they need the thing it
// dropped, which is the one moment no interface should be teaching that lesson.

import { board, boardVersions, forgetVersion, restoreVersion, saveVersion, bus } from '../state.ts';
import { VERSION_RING, VERSION_LABEL_MAX } from '../board-model.ts';
import type { BoardVersion } from '../board-model.ts';
import { el } from '../util.ts';
import { toast } from '../notify.ts';
import { ask } from './dialog.ts';

let wired = false;

/** Open the versions sheet. Idempotent; safe without a document. */
export function openVersions(): void {
  if (typeof document === 'undefined') return;
  const dlg = el('versions') as HTMLDialogElement | null;
  if (!dlg || typeof dlg.showModal !== 'function') return;

  paint();

  if (!wired) {
    wired = true;
    dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close(); });
    el('versions-close')?.addEventListener('click', () => dlg.close());
    el('versions-save')?.addEventListener('click', () => { void nameAndSave(); });
    // Repainted rather than rebuilt on open alone, because restoring from this
    // sheet changes the very list it is drawn from - and because an automatic
    // version can land while it is open.
    bus.on('versions', () => { if (dlg.open) paint(); });
  }
  if (!dlg.open) dlg.showModal();
}

/** Ask for a name, then keep this board under it. */
async function nameAndSave() {
  // With a field, ask() answers with what was typed rather than with a button -
  // see the two overloads on it. Not `danger`, because keeping a copy of your
  // own board is the least destructive thing in the app.
  const name = await ask({
    title: 'Name this version',
    body: 'Named versions are kept until you remove them.',
    go: 'Keep it',
    danger: false,
    field: { placeholder: 'Before the redesign', maxLength: VERSION_LABEL_MAX },
  });
  if (name === null) return;
  const label = String(name).trim();
  if (!label) {
    toast('A kept version needs a name');
    return;
  }
  saveVersion(label);
  toast(`Kept as "${label}"`);
}

function paint() {
  const body = el('versions-body');
  if (!body) return;
  const all = boardVersions();
  const kept = all.filter(v => v.kept);
  const auto = all.filter(v => !v.kept);
  const out: HTMLElement[] = [];

  if (!all.length) {
    out.push(note('Nothing stored yet. This board keeps a copy of itself as you '
      + 'work, and you can keep one by name at any time.'));
  }

  if (kept.length) {
    out.push(heading('Kept'));
    out.push(list(kept));
  }
  if (auto.length) {
    out.push(heading('As you worked'));
    out.push(list(auto));
    out.push(note(`The last ${VERSION_RING} are kept automatically and the oldest `
      + 'drops off. Give one a name to keep it for good.'));
  }
  body.replaceChildren(...out);
}

function list(versions: BoardVersion[]): HTMLElement {
  const ul = document.createElement('ul');
  ul.className = 'ver-list';
  for (const version of versions) ul.append(row(version));
  return ul;
}

function row(version: BoardVersion): HTMLElement {
  const li = document.createElement('li');
  li.className = 'ver-row';

  const name = document.createElement('span');
  name.className = 'ver-name';
  name.textContent = version.label || when(version.at);
  // A named version still has to say when it was, or two versions of the same
  // name are indistinguishable at exactly the moment you are choosing between
  // them.
  if (version.label) {
    const at = document.createElement('span');
    at.className = 'ver-when';
    at.textContent = when(version.at);
    name.append(' ', at);
  }

  const restore = document.createElement('button');
  restore.type = 'button';
  restore.className = 'ver-restore';
  restore.textContent = 'Restore';
  restore.addEventListener('click', () => {
    if (!restoreVersion(version.id)) { toast('That version is gone'); return; }
    // Said plainly, because the thing a person needs to know here is not that
    // it worked - the board in front of them says that - but that it can be
    // taken back.
    toast('Restored. Undo puts it back.');
    (el('versions') as HTMLDialogElement | null)?.close();
  });

  const forget = document.createElement('button');
  forget.type = 'button';
  forget.className = 'ver-forget';
  forget.textContent = 'Forget';
  forget.title = 'Remove this version';
  forget.addEventListener('click', () => {
    forgetVersion(version.id);
  });

  li.append(name, restore, forget);
  return li;
}

/**
 * When a version was taken, in words rather than in a timestamp.
 *
 * Relative near the present and absolute past it, which is how somebody
 * actually holds this: the version from twenty minutes ago is *the one before
 * lunch*, and the one from last week is a date. Built from the browser's own
 * locale, so it says it in the reader's own order.
 */
function when(at: number): string {
  if (!at) return 'some time ago';
  const ms = Date.now() - at;
  const mins = Math.round(ms / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;
  const date = new Date(at);
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
    + ', ' + date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function heading(text: string): HTMLElement {
  const h = document.createElement('h3');
  h.className = 'ver-head';
  h.textContent = text;
  return h;
}

function note(text: string): HTMLElement {
  const p = document.createElement('p');
  p.className = 'ver-note';
  p.textContent = text;
  return p;
}

/** Whether this board has anything to show. Read by the panel row's title. */
export const hasVersions = () => board.versions.length > 0;
