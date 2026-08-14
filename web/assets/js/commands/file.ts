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
import { formatBytes } from '../util.ts';
import { board, historyDepth, historyState, historyWeight, selection } from '../state.ts';
import {
  boardSafety, exportBoard, lastSaveFailure, newBoard, openBoard,
  saveBlob, shareBoard, storageReport,
} from '../storage/storage.ts';
import { assetBytes } from '../storage/assets.ts';
import { openLibrary } from '../ui/library.ts';
import { boardPdf, boardPng, styleTilePng, styleTilePdf } from '../ui/snapshot.ts';
import { saveWithCooldown } from '../ui/board-actions.ts';

/**
 * A download name for a board's derived PNG/PDF, from its title. Held to word
 * characters, spaces and dashes - the artefact carries the board's name, not its
 * punctuation, and it is a filename bound for a dozen different filesystems.
 */
function boardArtefactName(ext: string, suffix = ''): string {
  const base = (board.title || '').replace(/[^\w -]+/g, '').trim().slice(0, 60) || 'board';
  // The suffix keeps a style tile from overwriting a picture of the same board
  // in the same folder - two derived artefacts, one name, and the second one
  // silently replacing the first would be the export losing somebody's work.
  return suffix ? `${base} ${suffix}.${ext}` : `${base}.${ext}`;
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
    // behind it is in storage/library.js.
    //
    // It used to be distinct from New: New guarded a single session slot and
    // offered to export first, while the library had the shelf to set the old
    // board on and never had to ask. That asymmetry is gone - Open and New file
    // the outgoing board on the shelf too, and there is one New. This is now the
    // same door with a list in front of it.
    library: () => openLibrary(),
    /**
     * The four Debug readouts. Buttons that report, not live rows, and that
     * shape is forced rather than chosen: ui/panel.ts repaints on `board`,
     * `settings`, `layout` and `lens` and on nothing else - not on `items`, not
     * on `history`, and not when the panel is opened. A hint showing the undo
     * depth or the asset weight would therefore be stale the moment anybody
     * looked at it, which is worse than a button, because a wrong number reads
     * as a fact.
     *
     * Each says its answer twice: a toast for the person who pressed it, and a
     * console line for the person reading it back off a bug report. The toast
     * has to fit on a phone, so anything longer than a sentence goes to the
     * console alone.
     */
    boardSafe: () => {
      const { state, detail } = boardSafety();
      const failure = lastSaveFailure();
      const headline = state === 'saved' ? 'Your work is saved in this browser'
        : state === 'unsaved' ? 'There are changes that are not saved'
          : 'Cannot tell whether the last changes were saved';
      toast(detail ? `${headline} - ${detail}` : headline, state === 'unsaved' ? 'error' : undefined);
      console.info('[mbrd] board safety:', { state, detail, lastSaveFailure: failure || null });
    },
    /**
     * Whether the browser has promised to keep this origin, and roughly how much
     * room it thinks there is.
     *
     * The one Debug row that answers a question people genuinely have and no
     * other surface answers: "if I close this tab, is my board still here
     * tomorrow?" `persisted` is null until the first explicit Save, because that
     * is when the app asks - and null is reported as such rather than as "no".
     */
    storageState: async () => {
      const { persisted, used, quota } = await storageReport();
      const durable = persisted === null ? 'not asked yet - save once and it will be'
        : persisted ? 'durable: the browser has promised to keep it'
          : 'best-effort: the browser may clear it to make room';
      const room = used == null ? '' : ` Using ${formatBytes(used)}${quota ? ' of ' + formatBytes(quota) : ''}.`;
      toast(`Storage is ${durable}.${room}`);
      console.info('[mbrd] storage:', { persisted, used, quota });
    },
    /**
     * What is on this board and how much of it is already optimised.
     *
     * The import is dynamic and must stay dynamic. `optimize/` is deliberately
     * unranked in tests/layers.test.js because it is loaded on demand and is a
     * button; a static import here would make the whole optimiser a dependency
     * of the settings panel and quietly end that.
     */
    boardWeight: async () => {
      const { bytes, count } = assetBytes();
      const { planOptimize, describeSaving } = await import('../optimize/optimize.ts');
      const plan = planOptimize();
      toast(`${count} files, ${formatBytes(bytes)} in this browser. `
        + `${plan.total} could be made smaller, ${plan.done} already are.`);
      console.info('[mbrd] board weight:', { files: count, bytes, plan, saving: describeSaving });
    },
    /** How deep the undo stack is, and what it is holding on to. */
    historyState: () => {
      const { undo, redo } = historyDepth();
      const { undo: undoLabel, redo: redoLabel } = historyState();
      toast(`${undo} back, ${redo} forward, holding ${historyWeight()} items.`);
      console.info('[mbrd] history:', { undo, redo, next: { undo: undoLabel, redo: redoLabel },
        weight: historyWeight() });
    },
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
    /**
     * The other document: a summary rather than a photograph.
     *
     * The two above both answer *show me the board*, which is only readable by
     * somebody who was in the room. This one answers *what does this board look
     * like* - the palette with its values, the faces in use, a few pictures,
     * the name and the date. It is the thing that goes in a deck.
     *
     * The selection is handed over rather than read inside the renderer, so
     * "these four cards" is an ordinary export of a chosen set and the same
     * command with nothing selected is an export of the board. One command,
     * because they are one document with a different input.
     *
     * Entries beside the other exports rather than a door of their own, and
     * through the same saveBlob and the same artefact naming: this is a third
     * derived artefact, not a third kind of saving.
     */
    exportStyleTile: async () => {
      const job = busy('Drawing the tile');
      try {
        const blob = await styleTilePng(selection);
        if (!blob) { toast('There is nothing on the board to summarise yet'); return; }
        saveBlob(blob, boardArtefactName('png', 'style'));
        toast(selection.size ? 'Saved a style tile from the selection' : 'Saved a style tile');
      } catch (err) {
        console.error(err);
        toast('Could not draw the tile: ' + why(err), 'error');
      } finally { job.end(); }
    },
    exportStyleTilePdf: async () => {
      const job = busy('Drawing the tile');
      try {
        const blob = await styleTilePdf(selection);
        if (!blob) { toast('There is nothing on the board to summarise yet'); return; }
        saveBlob(blob, boardArtefactName('pdf', 'style'));
        toast('Saved a style tile PDF');
      } catch (err) {
        console.error(err);
        toast('Could not draw the tile: ' + why(err), 'error');
      } finally { job.end(); }
    },
    // Strictly asked for, never automatic - see optimize/optimize.js. Loaded on
    // demand as well as run on demand: the encoder behind it is thirty megabytes
    // and a board of photographs never needs it.
    optimize: () => import('../optimize/ui.ts').then(m => m.optimizeBoard()),
    discardOriginals: () => import('../optimize/ui.ts').then(m => m.discardOptimizeOriginals()),
  };
}
