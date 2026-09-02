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
  boardSafety, currentBoardId, exportBoard, lastSaveFailure, newBoard,
  openBoard, openCloudBoard, packForShare, pushBoardToCloud, saveBlob, shareBoard,
  startSyncingBoard, stopSyncingBoard, storageBreakdown,
} from '../storage/storage.ts';
import { shareLinkFor } from '../storage/cloud/provider.ts';
import { justDismissed, openAnchored } from '../ui/menu.ts';
import { paintPanel } from '../ui/panel.ts';
import { homePath } from '../page.ts';
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
 * What to call one slice of the storage readout in a sentence.
 *
 * storage.ts hands back source names (`idb:library`, `cache:mbrd-v263`) because
 * naming the stores is its job and wording a toast is not. This is the wording,
 * and it is deliberately in the user's terms rather than the schema's: nobody
 * pressing a Debug row knows what `matte` is, and everybody knows what a cut-out
 * is. An unrecognised name prints as itself - a store added later shows up as a
 * row nobody labelled, which is better than being silently left out of a total.
 */
function storageLabel(what: string): string {
  switch (what) {
    case 'idb:kv': return 'session';
    case 'idb:assets': return 'this board';
    case 'idb:library': return 'shelf';
    case 'idb:matte': return 'cut-outs';
    default: break;
  }
  // Cache Storage is shared by every worker on the host, so a cache this app
  // did not name is another project's - worth showing under its own name, since
  // on a dev server that is where the unexplained megabytes usually are.
  const cache = what.startsWith('cache:') ? what.slice(6) : '';
  if (!cache) return what;
  return cache.startsWith('mbrd-') ? 'app cache' : `cache ${cache}`;
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
 * Attach a cloud account: say what is about to happen, then open the popup.
 *
 * **The dialog is not ceremony, it is what makes the popup open at all.** Every
 * browser blocks a window that is not opened from a live user gesture, and a
 * press on this dialog's own button is the freshest gesture there is. It also
 * happens to be the honest interface - somebody else's login page appearing
 * unannounced over a board is a worse surprise than a sentence saying it is
 * about to.
 *
 * The panel is repainted afterwards because the Sync section's whole shape hangs
 * off whether an account is connected, and paintPanel() listens for four bus
 * events of which none is "somebody signed in".
 */
async function connectTo(id: string): Promise<void> {
  const { shareProvider } = await import('../storage/cloud/cloud.ts');
  const provider = shareProvider(id);
  if (!provider) { toast('That account is not set up in this build', 'error'); return; }
  if (provider.signedIn()) { toast(`Already connected to ${provider.label}`); return; }

  const go = await ask({
    title: `Connect ${provider.label}?`,
    body: `Boards you choose are copied into your own ${provider.label} and kept up to `
      + 'date while this tab is open — never onto a server of ours. Photographs are '
      + 'uploaded once each, so only what changes is sent again. A sign-in window opens '
      + 'next, and the connection lasts until you reload.',
    go: 'Sign in',
    cancel: 'Cancel',
    danger: false,
  });
  if (go !== 'go') return;
  try {
    await provider.signIn();
    toast(`Connected to ${provider.label}`);
  } catch (err) {
    console.error(err);
    toast('Sign-in failed: ' + why(err), 'error');
  } finally {
    paintPanel();
  }
}

/**
 * The box to hang a menu off, from the button that opened it.
 *
 * A menu anchored to nothing lands in the top-left corner, which reads as a bug
 * rather than as a menu. The fallback is the middle of the viewport, for the one
 * case that can produce it: a command fired from the console or a keystroke
 * while the panel that carries the row is shut.
 */
function anchorFor(button: Element | null) {
  if (button) return button.getBoundingClientRect();
  const x = innerWidth / 2, y = innerHeight / 3;
  return { left: x, right: x, top: y, bottom: y };
}

/**
 * Push the open board, and turn the one answer that is not a failure into a
 * question.
 *
 * A conflict is not an error and must not be toasted as one: it means another
 * machine has written this board since we last did, and the only safe answer is
 * to ask. There is no merge - item positions are absolute and there is no CRDT -
 * so the two real choices are overwrite and leave it, and a person has to pick.
 */
async function runSync({ force }: { force: boolean }): Promise<void> {
  const job = busy('Syncing to Google Drive');
  try {
    const out = await pushBoardToCloud({
      force,
      onProgress: (done, total) => job.step(done, total),
    });
    if (out.ok) {
      toast(out.uploaded
        ? `Synced — ${out.uploaded} new file${out.uploaded === 1 ? '' : 's'} sent`
        : 'Synced — nothing new to send');
      return;
    }
    job.end();
    const answer = await ask({
      title: 'This board changed somewhere else',
      body: `The copy in Drive was written on ${new Date(out.theirs).toLocaleString()}, `
        + 'which was not from this machine. There is no way to merge two boards — item '
        + 'positions are absolute — so this is a choice between the two copies.',
      go: 'Overwrite the cloud copy',
      cancel: 'Leave it alone',
      danger: true,
    });
    if (answer === 'go') await runSync({ force: true });
  } catch (err) {
    console.error(err);
    toast('Could not sync: ' + why(err), 'error');
  } finally { job.end(); }
}

/**
 * When a board is big enough that uploading it is worth a sentence.
 *
 * Not a ceiling and deliberately not one: nothing here refuses, and there is no
 * `CeilingId` in consent.ts for it, because a ceiling in this app means "larger
 * than something a reader can safely allocate" and this is only "larger than
 * somebody would like to wait for". A hundred megabytes is about a minute on a
 * typical upstream connection, which is the point at which a person deserves to
 * be told rather than left watching a bar.
 */
const HEAVY_SHARE = 100 * 1024 * 1024;

/**
 * Put the finished link where the person can use it, and say which happened.
 *
 * The clipboard is the answer people actually want - a share link exists to be
 * pasted - but writeText() is refused in more situations than is comfortable to
 * rely on: no secure context (a phone reaching a dev board over the LAN), a
 * permission policy, a browser that wants a fresher gesture than an upload that
 * took a minute. So a refusal is not an error, it is the other branch: the link
 * goes into a dialog with a box round it, which is selectable and is the same
 * thing the Debug rows fall back to.
 *
 * The dialog's Copy button is not decoration and is the reason this is worth two
 * attempts rather than one. The commonest refusal is a browser wanting a fresher
 * user gesture than an upload that has just taken a minute, and a press on that
 * button is exactly that - so the retry usually works where the automatic one
 * did not. What the field answers with is thrown away: `link` is what gets
 * copied, not whatever ended up in a box somebody may have typed into.
 */
async function handOverLink(link: string): Promise<void> {
  const copy = async (): Promise<boolean> => {
    try {
      if (!navigator.clipboard?.writeText) return false;
      await navigator.clipboard.writeText(link);
      return true;
    } catch {
      // Refused, which is one of the two ordinary outcomes rather than a fault.
      return false;
    }
  };

  if (await copy()) {
    toast('Link copied — anyone with it can open this board');
    return;
  }
  const again = await ask({
    title: 'The board is shared',
    body: 'Anyone with this link can open the board, and nobody needs an account.',
    go: 'Copy',
    cancel: 'Close',
    field: { value: link },
  });
  // Null is every way out that is not the Copy button, and all of them mean the
  // same thing here: the link was on screen to be read, and it has been.
  if (again === null) return;
  if (await copy()) toast('Link copied — anyone with it can open this board');
  else toast('Could not reach the clipboard — the link is in the console', 'error');
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
      const { slices, measured, others, persisted, rest, used, quota } = await storageBreakdown();
      const durable = persisted === null ? 'not asked yet - save once and it will be'
        : persisted ? 'durable: the browser has promised to keep it'
          : 'best-effort: the browser may clear it to make room';
      const room = used == null ? '' : ` Using ${formatBytes(used)}${quota ? ' of ' + formatBytes(quota) : ''}.`;
      // The estimate alone is a number nobody can act on - "306 MB" on a board
      // with nothing on it reads as a bug in the app, and is usually the shelf,
      // or another project sharing localhost. So the toast carries the parts,
      // biggest first, and only the ones with bytes in them.
      const parts = slices.filter(s => s.bytes > 0).map(s => `${storageLabel(s.what)} ${formatBytes(s.bytes)}`);
      // Named rather than dropped. The gap between what this app owns and what
      // the engine reports is padding and per-record overhead on a quiet origin
      // and somebody else's database on a busy one, and a reader who cannot see
      // it goes looking for the missing megabytes inside this app.
      if (rest != null && rest > measured * 0.1) parts.push(`elsewhere ${formatBytes(Math.max(0, rest))}`);
      const where = parts.length ? ` ${parts.join(', ')}.` : '';
      toast(`Storage is ${durable}.${room}${where}`);
      console.info('[mbrd] storage:', { persisted, used, quota, measured, rest, slices, others });
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
    // And the other kind of share: a URL rather than a file. The whole design is
    // in storage/cloud/provider.ts; what is here is the order the questions are
    // asked in, and that order is not arbitrary.
    //
    // **Sign-in must be the last thing before the work starts.** Every browser
    // blocks a popup that is not opened from a live user gesture, and the two
    // questions above spend it: a person reading the history dialog for ten
    // seconds has an expired activation by the time they answer. So the sign-in
    // gets its own dialog immediately in front of it, and the popup is opened
    // out of *that* button's press. It also happens to be the honest interface -
    // a Google window appearing unannounced over somebody's board is a worse
    // surprise than a sentence saying it is about to.
    //
    // The provider is loaded on demand, on the terms optimize/ is two rows
    // below: a graph seam rather than a download saving - the build does not
    // split - so what it buys is that the command surface does not statically
    // depend on an OAuth flow, and that nothing in it runs until somebody
    // presses this.
    shareLink: async () => {
      if (!await confirmEmptyExport()) return;
      const { shareProvider } = await import('../storage/cloud/cloud.ts');
      // 'gdrive' by name rather than through a picker, and the plan's own reason:
      // choosing one of three is a menu, ui/menu.ts renders every menu in this
      // app, and a menu with one row is worse than no menu. See share.ts.
      const provider = shareProvider('gdrive');
      if (!provider) { toast('Sharing a link is not set up in this build', 'error'); return; }

      const history = await askHistory();

      if (!provider.signedIn()) {
        const go = await ask({
          title: `Sign in to ${provider.label}?`,
          body: `The board is uploaded to your own ${provider.label} and the link `
            + 'points there — it never touches a server of ours, and whoever you send '
            + 'it to needs no account. A sign-in window opens next.',
          go: 'Sign in',
          cancel: 'Cancel',
          danger: false,
        });
        if (go !== 'go') return;
        try {
          await provider.signIn();
        } catch (err) {
          console.error(err);
          toast('Sign-in failed: ' + why(err), 'error');
          return;
        }
      }

      let packed;
      const packing = busy('Packing the board');
      try {
        packed = await packForShare({ history });
      } catch (err) {
        console.error(err);
        toast('Could not pack the board: ' + why(err), 'error');
        return;
      } finally { packing.end(); }

      // Asked after packing because that is the first moment the number is
      // known, and asked at all because this is the version of the feature that
      // uploads the originals. A board of video is slow to send and - the part
      // that is not obvious from this end - the recipient waits through the whole
      // download before they see anything at all. The lighter viewing copy is the
      // next phase of this work; until it exists, saying the number is the honest
      // substitute. See research/docs/cloud.md.
      if (packed.blob.size > HEAVY_SHARE) {
        const go = await ask({
          title: `That is ${formatBytes(packed.blob.size)} to upload`,
          body: 'Uploading will take a while on a slow connection, and whoever opens '
            + 'the link downloads all of it before they see the board. Optimising the '
            + 'board first (System → Optimize) usually cuts it a long way.',
          go: 'Upload anyway',
          cancel: 'Cancel',
          danger: false,
        });
        if (go !== 'go') return;
      }

      const job = busy(`Uploading to ${provider.label}`);
      try {
        const id = await provider.upload(packed.blob, packed.name,
          (sent, total) => job.step(sent, total));
        const link = shareLinkFor(location.origin, homePath(), { provider: provider.id, id });
        // Said twice, the way every Debug row is: a receipt for the person who
        // pressed it, and a console line for the one case the receipt cannot
        // cover - a clipboard write the browser refused, on a board the person
        // now has to be able to get the link off somehow.
        console.info('[mbrd] share link:', link);
        await handOverLink(link);
      } catch (err) {
        console.error(err);
        toast('Could not share the board: ' + why(err), 'error');
      } finally { job.end(); }
    },
    // ── The cloud copy ───────────────────────────────────────────────────
    //
    // The same Google account the share link uses, doing the other thing it is
    // good for. `research/docs/cloud.md` and the header of
    // storage/cloud/sync.ts carry the design; what is here is the order of the
    // questions, which follows the share command's for the same reason - the
    // sign-in popup has to be the last thing before the work, or the browser
    // blocks it.
    // Attach an account, and nothing else. The whole of the Sync section until
    // this has happened, because every other row in it is meaningless without
    // somewhere to sync to.
    //
    // One command per provider rather than one taking an id, because a
    // `data-cmd` is a name and not a call - there is nowhere in the markup to
    // put an argument, and inventing somewhere would be a second dispatch
    // mechanism beside the one every button in this app already uses.
    connectGdrive: () => connectTo('gdrive'),
    // Start keeping this board in the cloud. The section only shows this row
    // once an account is attached and on a board that is not already kept, so
    // there is neither a sign-in branch nor an "already synced" branch here -
    // those are connect-* and cloud-push, and the schema decides which is on
    // screen.
    cloudSync: async () => {
      if (!await confirmEmptyExport()) return;
      const { shareProvider } = await import('../storage/cloud/cloud.ts');
      const provider = shareProvider('gdrive');
      if (!provider?.signedIn()) { toast('Connect an account first', 'error'); return; }

      const job = busy(`Copying the board to ${provider.label}`);
      try {
        const out = await startSyncingBoard(provider.id);
        if (!out.ok) {
          // A board of this id is already up there and this machine has never
          // pushed it. That is somebody's other machine, and the answer is to
          // open theirs rather than to flatten it from here.
          toast('A copy of this board is already in Drive — open it from the cloud instead', 'error');
          return;
        }
        toast(`Kept in ${provider.label} — ${out.uploaded} file${out.uploaded === 1 ? '' : 's'} sent`);
      } catch (err) {
        console.error(err);
        toast('Could not copy the board: ' + why(err), 'error');
      } finally {
        job.end();
        // The section reads a synchronous mirror that this press has just
        // changed, and the panel repaints on four bus events of which none is
        // "a board started syncing". Repainting by hand is the same move
        // ui/quality.ts makes for the same reason.
        paintPanel();
      }
    },
    /** Push now, for somebody about to close the lid rather than wait for an autosave. */
    cloudPush: async () => {
      await runSync({ force: false });
      paintPanel();
    },
    /**
     * Stop syncing. Asks, because it is not obvious from the button what happens
     * to the copy that is already up there - and the answer, that it stays, is
     * the thing somebody needs to hear before they press it rather than after.
     */
    cloudStop: async () => {
      const answer = await ask({
        title: 'Stop keeping this board in Drive?',
        body: 'The copy already in your Drive stays exactly where it is — this app cannot '
          + 'delete it, and will not try. What stops is the sending: changes from here on '
          + 'stay in this browser until you turn it back on.',
        go: 'Stop syncing',
        cancel: 'Cancel',
        danger: false,
      });
      if (answer !== 'go') return;
      await stopSyncingBoard();
      toast('No longer syncing — the copy in your Drive is untouched');
      paintPanel();
    },
    // The boards this app has put in the person's Drive, from any machine. A
    // menu rather than a modal, and anchored to the row that opened it -
    // ui/menu.ts renders every menu in this app and a second implementation is
    // the thing CLAUDE.md forbids by name.
    cloudOpen: async () => {
      const { shareProvider } = await import('../storage/cloud/cloud.ts');
      const provider = shareProvider('gdrive');
      if (!provider) { toast('Cloud storage is not set up in this build', 'error'); return; }

      const button = document.querySelector('[data-cmd="cloud-open"]');
      // The trap CLAUDE.md names: the menu closes on an outside pointerdown in
      // the capture phase and this button is outside it, so without this the
      // second press closes the menu and the click reopens it.
      if (justDismissed(button)) return;

      // No sign-in branch: this row is only drawn once an account is attached,
      // and the connect-* command is the only place that opens a popup.
      if (!provider.signedIn()) { toast('Connect an account first', 'error'); return; }

      const job = busy(`Looking in ${provider.label}`);
      let boards;
      try {
        const { remoteBoards } = await import('../storage/cloud/sync.ts');
        boards = await remoteBoards(provider);
      } catch (err) {
        console.error(err);
        toast('Could not read your Drive: ' + why(err), 'error');
        return;
      } finally { job.end(); }

      if (!boards.length) { toast('No boards in Drive yet'); return; }

      const here = await currentBoardId();
      openAnchored(anchorFor(button), boards.map(remote => ({
        label: remote.boardId === here ? 'This board (cloud copy)' : remote.boardId,
        // The date the cloud copy was last written, which is the only thing that
        // distinguishes two rows for somebody who never sees a board id.
        accel: new Date(remote.modifiedTime).toLocaleDateString(),
        action: () => { void openCloudBoard(remote); },
      })), { label: 'Boards in Drive', focus: true, owner: button });
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
