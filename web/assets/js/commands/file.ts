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
import { hasContent } from '../onboarding.ts';
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
 * Whether this share should carry the step history, asked.
 *
 * The history records everything that was tried and thrown away, so a file
 * carrying it hands the recipient every rejected picture and every deleted note.
 * That is worth having between two machines of your own and is not worth
 * leaking, and nobody can be expected to remember which case they are in - so
 * this asks, and the safe answer is the primary button.
 *
 * **Share only.** Export used to ask as well and no longer does: a file you
 * write to your own disk is one you will open again yourself, and an export
 * without its history opens as a board that has never been touched. Share is
 * where the file is going to somebody else by definition, so the question is
 * about the one path where the answer can matter.
 *
 * **It only asks when there is something to ask about.** A board whose history
 * is empty - a file just opened, a board never edited this session - shares
 * without a word, which is what keeps this from becoming a dialog people learn
 * to dismiss without reading. The one that then appears on the board they have
 * been working on all afternoon is a question they will actually read.
 *
 * The answer is deliberately **not remembered**. A preference that quietly
 * turns leaking back on six months later is precisely the failure this exists to
 * prevent, and the cost of not remembering is one keystroke on the shares where
 * it matters.
 *
 * Cancelling the dialog answers "leave it out" rather than abandoning the share,
 * on the same reasoning ask() gives for every accidental way out resolving to
 * the harmless answer: this question is not "do you want to share", and a stray
 * Escape must not turn into a file with somebody's discarded work in it.
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

/**
 * Say so before writing a file with nothing in it, and let it through anyway.
 *
 * A board with no content packs and writes perfectly happily - the format does
 * not require anything to be on the paper - so the failure here is silent by
 * construction: you get a `.mbrd`, it is the right size for what it holds, and
 * you find out it was empty when you open it somewhere else. A tester hit this
 * and the complaint was not that it failed, it was that it did not say.
 *
 * A question and not a refusal, because an empty board is a real thing to want
 * to keep. The title, the palette, the grid and every layout setting are in
 * that file, and a board saved with nothing on it is how you carry a look to
 * the next one. Refusing would be the app deciding it knows better about the
 * one case where it plainly does not.
 *
 * hasContent() rather than `board.items.length`, and that is the whole of the
 * emptiness test: it is the same rule the onboarding hints ask, so a board
 * holding nothing but fences and the hint ghosts counts as the empty board it
 * looks like. See onboarding.ts, where it is argued.
 *
 * The short-circuit is load-bearing. ask() answers 'cancel' with no document -
 * a test, a headless run - so reaching it unconditionally would make every
 * export refuse there. A board with anything on it never gets that far.
 */
async function confirmEmptyExport(): Promise<boolean> {
  if (hasContent()) return true;
  const answer = await ask({
    title: 'There is nothing on this board',
    body: 'The file will still carry the board’s name, its palette and its '
      + 'layout settings, so this is a reasonable way to keep a look for a '
      + 'board you have not made yet. It just will not have anything on it.',
    go: 'Export anyway',
    cancel: 'Cancel',
    danger: false,
  });
  return answer === 'go';
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
      // Built rather than interpolated straight, because the obvious sentence
      // was wrong twice and a tester caught it by asking what it meant.
      //
      // `plan.total` is *bytes*, and `plan.done` is a *count*, and this row used
      // to print both bare and side by side - "50528374 could be made smaller, 3
      // already are", two units in one sentence with neither of them named.
      // `plan.total` is also not the thing the sentence claimed: it is
      // everything not already done, video included, and video is bucketed into
      // plan.skipped precisely because it is never encoded. So the number that
      // answers "what could be made smaller" is the picture and sound jobs, and
      // nothing else in the plan is that number.
      //
      // The empty cases are spelled out for the same reason. This is the row a
      // person opens when they want to know whether optimising is worth it, and
      // "0 could be made smaller, 0 already are" is a shrug where the answer
      // should be plainly no.
      const jobs = [...plan.pictures, ...plan.sounds];
      const shrinkable = jobs.reduce((n, job) => n + job.size, 0);
      const verdict = jobs.length
        ? `${jobs.length} could be made smaller - ${formatBytes(shrinkable)} as they stand.`
        : plan.done ? 'Nothing left to shrink.'
          : 'Nothing here can be made smaller.';
      const already = plan.done ? ` ${plan.done} already optimised.` : '';
      const left = plan.skipped.length ? ` ${plan.skipped.length} left alone.` : '';
      toast(`${count} files, ${formatBytes(bytes)} in this browser. ${verdict}${already}${left}`);
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
    // Neither of these asks about the history any more: a file you write to your
    // own disk keeps everything, because an export without its history opens as
    // a board with no past and nothing can put that back. See askHistory().
    // Both ask first if there is nothing to write - see confirmEmptyExport(),
    // and note that a board with anything on it never reaches the dialog.
    export: async () => { if (await confirmEmptyExport()) await exportBoard(); },
    exportAs: async () => { if (await confirmEmptyExport()) await exportBoard({ pickNew: true }); },
    // The mobile face of Export: the same packed .mbrd, handed to the OS share
    // sheet instead of a download folder a phone has no good way to reach. Falls
    // back to Export where files cannot be shared - see shareBoard(), which
    // carries the answer below into that fallback.
    // The emptiness question comes first, ahead of the history one: there is no
    // sense asking what to put in a file somebody is about to decide not to
    // write. An empty board has no history to ask about anyway, so in practice
    // this is one dialog rather than two.
    share: async () => {
      if (!await confirmEmptyExport()) return;
      await shareBoard({ history: await askHistory() });
    },
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
