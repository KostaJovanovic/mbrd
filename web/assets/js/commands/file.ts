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
import {
  board, historyDepth, historyState, historyWeight, timelineSteps,
} from '../state.ts';
import { ask } from '../ui/dialog.ts';
import {
  boardSafety, exportBoard, lastSaveFailure, newBoard, openBoard,
  saveBlob, shareBoard, storageReport,
} from '../storage/storage.ts';
import { assetBytes } from '../storage/assets.ts';
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
  // There was a `suffix` parameter here, defaulted to '', with a comment
  // arguing that it kept a style tile from overwriting a picture of the same
  // board in the same folder. Both call sites pass one argument, the style tile
  // it was written for is gone, and the two artefacts that remain differ by
  // their extension. A parameter nobody passes is a claim about a collision
  // that cannot happen.
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
const why = (err: unknown): string =>
  // SAFETY: every caller hands this a value out of a `catch`, and what this app
  // throws is an Error - the paragraph above is about the *text* of one, not
  // about its shape. A thrown string would read `undefined` here rather than
  // throw, which is the failure the paragraph says is acceptable.
  (err as Error).message;

/**
 * Whether this export should carry the step history, asked.
 *
 * The history records everything that was tried and thrown away, so a file
 * carrying it hands the recipient every rejected picture and every deleted note.
 * That is worth having between two machines of your own and is not worth
 * leaking, and nobody can be expected to remember which case they are in - so
 * this asks, and the safe answer is the primary button.
 *
 * **It only asks when there is something to ask about.** A board whose history
 * is empty - a file just opened, a board never edited this session - exports
 * without a word, which is what keeps this from becoming a dialog people learn
 * to dismiss without reading. The one that then appears on the board they have
 * been working on all afternoon is a question they will actually read.
 *
 * The answer is deliberately **not remembered**. A preference that quietly
 * turns leaking back on six months later is precisely the failure this exists to
 * prevent, and the cost of not remembering is one keystroke on the exports where
 * it matters.
 *
 * Cancelling the dialog answers "leave it out" rather than abandoning the
 * export, on the same reasoning ask() gives for every accidental way out
 * resolving to the harmless answer: this question is not "do you want to
 * export", and a stray Escape must not turn into a file with somebody's
 * discarded work in it.
 */
async function askHistory(): Promise<boolean> {
  if (!timelineSteps().length) return false;
  const answer = await ask({
    title: 'Include the history?',
    body: 'This board has a step history. Including it lets whoever opens the '
      + 'file walk back through every change - which also means everything you '
      + 'tried and threw away. Leave it out and they get the board as it '
      + 'stands.',
    go: 'Leave it out',
    keep: 'Include it',
    cancel: 'Cancel',
    danger: false,
  });
  return answer === 'keep';
}

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
    export: async () => exportBoard({ history: await askHistory() }),
    exportAs: async () => exportBoard({ pickNew: true, history: await askHistory() }),
    // The mobile face of Export: the same packed .mbrd, handed to the OS share
    // sheet instead of a download folder a phone has no good way to reach. Falls
    // back to Export where files cannot be shared - see shareBoard().
    share: async () => shareBoard({ history: await askHistory() }),
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
    // The style tile used to be a third derived artefact here - a PNG and a PDF
    // beside the two above. It is a card on the board now, so it is minted like
    // every other card and lives in commands.js with the rest of the adders:
    // this file is the one that has no `vp`, and a thing you place needs one.
    // Strictly asked for, never automatic - see optimize/optimize.js. Loaded on
    // demand as well as run on demand: the encoder behind it is thirty megabytes
    // and a board of photographs never needs it.
    optimize: () => import('../optimize/ui.ts').then(m => m.optimizeBoard()),
    discardOriginals: () => import('../optimize/ui.ts').then(m => m.discardOptimizeOriginals()),
  };
}
