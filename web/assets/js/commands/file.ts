// The file half of the command surface: what a board is, saved and sent out.
//
// New, Open, the library, Save, the three ways out (Export, Export as, Share),
// the two derived artefacts (PNG, PDF), and the optimiser's two doors. One
// contiguous run of the object in commands.ts, lifted whole - the keys, their
// order and their behaviour are exactly what they were, because `data-cmd` in
// index.html names them and tests/settings-panel.test.js checks that every one
// of those names resolves.
//
// ── Why these five files rather than one ──
//
// createCommands() had grown to ~830 lines in a single object literal, which is
// not a design so much as the absence of one: five unrelated subjects with no
// boundary between them except a `// ---` comment, and a reader looking for the
// export path had to scroll past the fence prompt and the sticker tints to be
// sure they had found all of it. The runs were already contiguous. This makes
// each of them a file and merges them back in one place.
//
// The merge is a spread, so the object commands.ts hands out is the same object
// with the same keys in the same order. Nothing downstream can tell the
// difference, which is the property that made this safe to do at all.
//
// ── What must not move in here ──
//
// Anything that needs the Viewport. Nothing in this run does - a board being
// written out has no camera - and that is not a coincidence, it is what makes
// this the easiest of the five to reason about. A command here that suddenly
// wanted `vp` would be a command that had stopped being about a file.
//
// Nor the session slot's own policy. saveWithCooldown(), armClear(),
// reloadBoard() and the rest live in ui/board-actions.ts and are called from
// here; what is here is only which button reaches which of them.

import { busy, toast } from '../notify.ts';
import { board } from '../state.ts';
import { exportBoard, newBoard, openBoard, saveBlob, shareBoard } from '../storage/storage.ts';
import { openLibrary } from '../ui/library.ts';
import { boardPdf, boardPng } from '../ui/snapshot.ts';
import { saveWithCooldown } from '../ui/board-actions.ts';

/**
 * A download name for a board's derived PNG/PDF, from its title. Held to word
 * characters, spaces and dashes - the artefact carries the board's name, not its
 * punctuation, and it is a filename bound for a dozen different filesystems.
 */
function boardArtefactName(ext: string): string {
  const base = (board.title || '').replace(/[^\w -]+/g, '').trim().slice(0, 60) || 'board';
  return `${base}.${ext}`;
}

/**
 * The message off a caught failure.
 *
 * The cast rather than an `instanceof` test, and it is deliberate: this is a
 * move, and reading `.message` off whatever was thrown is exactly what the two
 * catch blocks below did before it. Both of them catch a canvas or an encoder
 * failure, which is an Error every time in practice; narrowing here would be a
 * change to the text on a path nothing reaches, made in a commit that is
 * supposed to change nothing at all.
 */
const why = (err: unknown): string => (err as Error).message;

export function fileCommands() {
  return {
    new: () => newBoard(),
    open: () => openBoard(),
    // The board library - several boards kept in this browser, not just the one
    // the session slot holds. Opens the switcher (ui/library.js); the storage
    // behind it is in storage/library.js. Distinct from New, which still guards
    // the single session slot by offering to export first: the library's own New
    // has the shelf to set the old board on, so it never has to ask.
    library: () => openLibrary(),
    save: () => saveWithCooldown(),
    export: () => exportBoard(),
    exportAs: () => exportBoard({ pickNew: true }),
    // The mobile face of Export: the same packed .mbrd, handed to the OS share
    // sheet instead of a download folder a phone has no good way to reach. Falls
    // back to Export where files cannot be shared - see shareBoard().
    share: () => shareBoard(),
    // A picture of the board, for showing rather than reopening. A moodboard
    // exists to be presented, and until these two the only thing that left mbrd
    // was a .mbrd only mbrd can read. The board is composited onto a canvas
    // (ui/snapshot.js) - not the live DOM, which taints the canvas the moment it
    // holds a picture - and handed out as a PNG, or wrapped in a one-page PDF for
    // printing. Both are derived artefacts, never .mbrd: their own types, their
    // own filenames, and they never touch the file handle Export remembers.
    exportImage: async () => {
      const job = busy('Drawing the board');
      try {
        const blob = await boardPng();
        if (!blob) { toast('There is nothing on the board to save yet'); return; }
        saveBlob(blob, boardArtefactName('png'));
        toast('Saved a picture of the board');
      } catch (err) {
        console.error(err);
        toast('Could not draw the board: ' + why(err), 'error');
      } finally { job.end(); }
    },
    exportPdf: async () => {
      const job = busy('Drawing the board');
      try {
        const blob = await boardPdf();
        if (!blob) { toast('There is nothing on the board to save yet'); return; }
        saveBlob(blob, boardArtefactName('pdf'));
        toast('Saved a PDF of the board');
      } catch (err) {
        console.error(err);
        toast('Could not draw the board: ' + why(err), 'error');
      } finally { job.end(); }
    },
    // Strictly asked for, never automatic - see optimize/optimize.js. Loaded on
    // demand as well as run on demand: the encoder behind it is thirty megabytes
    // and a board of photographs never needs it.
    optimize: () => import('../optimize/ui.ts').then(m => m.optimizeBoard()),
    discardOriginals: () => import('../optimize/ui.ts').then(m => m.discardOptimizeOriginals()),
  };
}
