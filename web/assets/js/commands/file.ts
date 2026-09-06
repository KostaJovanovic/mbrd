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
  board, historyDepth, historyState, historyWeight,
} from '../state.ts';
import { ask } from '../ui/dialog.ts';
import { hasContent } from '../onboarding.ts';
import {
  boardSafety, exportBoard, lastSaveFailure, newBoard,
  openBoard, packForShare, pushBoardToCloud, saveBlob, shareBoard,
  startSyncingBoard, stopSyncingBoard, storageBreakdown,
} from '../storage/storage.ts';
import { shareLinkFor } from '../storage/cloud/provider.ts';
import { paintPanel } from '../ui/panel.ts';
import { connectCloud } from '../ui/cloud-connect.ts';
import { homePath } from '../page.ts';
import { assetBytes } from '../storage/assets.ts';
import { openLibrary } from '../ui/library.ts';
import { boardPdf, boardPng } from '../ui/snapshot.ts';
import { saveWithCooldown } from '../ui/board-actions.ts';
import { isDesktop } from '../platform/platform.ts';

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

// ── The history question, which is no longer a question ──
//
// askHistory() stood here and put up a dialog before every share: "Include the
// history?", with Leave it out as the primary. Every path that once called it
// now passes `history: true` and asks nothing.
//
// **The argument it was making was real and is worth keeping written down**,
// because the way this comes back is somebody re-deriving it from scratch. A
// board's step history records what was tried and thrown away - every rejected
// picture, every deleted note - so a shared file carrying it hands the
// recipient the discards along with the board. The dialog existed so that a
// share to a client and a share to your own second machine could be told apart,
// by the only party who knows which is which.
//
// What it cost was a modal in front of a button somebody had just deliberately
// pressed, on the boards most likely to be worth sharing - it only appeared
// when there *was* a history, which is to say on the board somebody had been
// working on all afternoon. Two dialogs already stand between that press and
// the upload on a first share (this one, then sign-in), and a question people
// meet often enough to answer without reading has stopped doing the job it was
// added for.
//
// So the behaviour is now: **a shared board carries its history, always.** The
// consequence is stated rather than hidden - see privacy.html, which is where a
// person can actually go and read what leaves this machine.
//
// If it should ever be a choice again, it belongs in ui/settings-schema.ts as a
// setting somebody sets once, not as a dialog in front of every share. That was
// considered and rejected when this was written the first time, on the grounds
// that a preference "quietly turns leaking back on six months later" - a fair
// point about a stored answer, and the reason a returning question would need
// to be visible in the panel rather than remembered from a modal.

// connectTo() was here and is now connectCloud() in ui/cloud-connect.ts - the
// board switcher's foot grew a Connect button of its own, and two callers is
// where a helper in a command file stops being one. Its header carries the
// user-gesture argument that used to be here.

// anchorFor() was here too, for the anchored menu cloud-open used to raise. That
// menu is gone: the boards in Drive are drawn in the board switcher beside the
// ones on this machine, which is the panel they belong in. See cmds.cloudOpen.

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
    // Save means two different things and the shell decides which.
    //
    // In a browser it is "keep this here" - no dialog, no file, the copy this
    // browser is holding for you, and the cooldown that stops a held Ctrl+S
    // writing forty times. That is the whole argument at the top of storage.js
    // and it is right for a page.
    //
    // On the desktop the board *is* a file, and a document application that
    // answered Ctrl+S with "kept in this app" would be lying about where the
    // work is. So Save writes the .mbrd: the picker only on a board that has
    // never been saved, silence after that. Both still autosave underneath;
    // what changes is what the person is told they just did.
    save: () => isDesktop() ? exportBoard() : saveWithCooldown(),
    saveAs: async () => { if (await confirmEmptyExport()) await exportBoard({ pickNew: true }); },
    // A file you write to your own disk keeps everything, because an export
    // without its history opens as a board with no past and nothing can put that
    // back. Both ask first if there is nothing to write - see
    // confirmEmptyExport(), and note that a board with anything on it never
    // reaches the dialog.
    //
    // Export keeps its meaning on both shells: write a copy somewhere. On the
    // desktop that is the difference between Save and this one - Save writes
    // *the* file, Export writes *a* file - and it is also where Share's
    // no-history path lands where a file cannot be shared.
    export: async () => { if (await confirmEmptyExport()) await exportBoard(); },
    exportAs: async () => { if (await confirmEmptyExport()) await exportBoard({ pickNew: true }); },
    // The mobile face of Export: the same packed .mbrd, handed to the OS share
    // sheet instead of a download folder a phone has no good way to reach. Falls
    // back to Export where files cannot be shared - see shareBoard(), which
    // carries this flag into that fallback.
    //
    // `history: true` outright, like every other packing path in this file. The
    // dialog that used to stand here is gone; the block where askHistory() was
    // says what it argued and what would have to be true to bring it back.
    share: async () => {
      if (!await confirmEmptyExport()) return;
      await shareBoard({ history: true });
    },
    // And the other kind of share: a URL rather than a file. The whole design is
    // in storage/cloud/provider.ts; what is here is the order the questions are
    // asked in, and that order is not arbitrary.
    //
    // **Sign-in must be the last thing before the work starts.** Every browser
    // blocks a popup that is not opened from a live user gesture, and a dialog
    // spends it: a person reading a question for ten seconds has an expired
    // activation by the time they answer. So the sign-in gets its own dialog
    // immediately in front of it, and the popup is opened out of *that* button's
    // press. That is still true with one question fewer in front of it - the
    // empty-board check can put up a dialog of its own - and it also happens to
    // be the honest interface: a Google window appearing unannounced over
    // somebody's board is a worse surprise than a sentence saying it is about
    // to.
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
        packed = await packForShare({ history: true });
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
    connectGdrive: async () => { await connectCloud('gdrive'); },
    /**
     * Let go of the account. One command for every provider, unlike connect-*.
     *
     * The asymmetry is deliberate and is not an oversight of the rule above.
     * Connecting is *to* somewhere and so needs a name; disconnecting is from
     * whatever is attached, and this app attaches one account at a time. A
     * second provider changes that, and the answer then is a picker on this
     * row rather than a second command - `openAnchored()`, like cloud-open.
     *
     * It asks, for the reason cloudStop asks: what happens to the copies
     * already in Drive is the thing somebody wants to know *before* pressing a
     * button called Log out, and every honest reading of that phrase - "does
     * this delete my boards", "does this stop the syncing for good" - has an
     * answer that is only reassuring if it arrives first.
     */
    cloudSignOut: async () => {
      const { shareProvider } = await import('../storage/cloud/cloud.ts');
      const provider = shareProvider('gdrive');
      if (!provider?.signedIn()) { toast('No account is connected'); return; }

      const answer = await ask({
        title: `Log out of ${provider.label}?`,
        body: 'Everything already in your Drive stays there, and boards you keep in Drive '
          + 'stay marked as kept — what stops is the sending, until you connect again. '
          + 'This browser forgets the sign-in; your Drive account itself is untouched.',
        go: 'Log out',
        cancel: 'Cancel',
        danger: false,
      });
      if (answer !== 'go') return;
      provider.signOut();
      toast(`Logged out of ${provider.label}`);
      // Same repaint connectTo() ends on and for the same reason: the section's
      // whole shape hangs off signedIn(), and no bus event fires for this.
      paintPanel();
    },
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
        body: 'The copy already in your Drive stays exactly where it is — nothing is '
          + 'removed. What stops is the sending: changes from here on stay in this '
          + 'browser until you turn it back on.',
        go: 'Stop syncing',
        cancel: 'Cancel',
        danger: false,
      });
      if (answer !== 'go') return;
      await stopSyncingBoard();
      toast('No longer syncing — the copy in your Drive is untouched');
      paintPanel();
    },
    /**
     * Take everything this app has put in the person's Drive back out.
     *
     * **The one command in this file that removes somebody's data**, so it is
     * the one that argues hardest for its own guards.
     *
     * It cannot reach anything mbrd did not create. That is not care taken here
     * but a property of the token: `drive.file` gives this app sight of its own
     * files and nothing else, so the query behind it is incapable of naming a
     * photograph somebody's family put in the same Drive. Worth knowing when
     * reading the dialog below, which is written to be frightening in exact
     * proportion to what this actually does and no more.
     *
     * What it does is move those files to the Drive trash, where they sit for
     * thirty days. The dialog says so in those words rather than "delete",
     * because the way back matters and because thirty days is the real promise
     * - not a comforting vagueness.
     *
     * `danger: true`, unlike cloudStop beside it. The distinction the two draw
     * is the one the whole section is built on: Stop syncing changes what this
     * browser does, and this changes what is in somebody's Drive.
     *
     * The local table is cleared afterwards and never before - sync.ts's
     * forgetAllSyncs() says why, and the short version is that a half-finished
     * purge needs those rows to finish from.
     */
    cloudPurge: async () => {
      const { shareProvider } = await import('../storage/cloud/cloud.ts');
      const provider = shareProvider('gdrive');
      if (!provider?.signedIn()) { toast('Connect an account first', 'error'); return; }
      const store = provider.store;
      if (!store) { toast(`${provider.label} cannot do that`, 'error'); return; }

      const answer = await ask({
        title: `Remove everything from ${provider.label}?`,
        body: 'Every board this app has put in your Drive goes to your Drive trash — the '
          + 'synced copies and the files behind any links you have shared, which stop '
          + 'working. Boards stay on this machine and nothing on screen is touched. '
          + 'Nothing else in your Drive can be reached: this app only ever sees what it '
          + 'made itself. Trashed files stay recoverable for thirty days.',
        go: 'Remove them',
        cancel: 'Cancel',
        danger: true,
      });
      if (answer !== 'go') return;

      const job = busy(`Clearing ${provider.label}`);
      try {
        const gone = await store.purge((done, total) => job.step(done, total));
        // "items" and not "files", deliberately: the number counts the things
        // that were removed at the top, one of which can be a folder holding a
        // whole board. See the note at the end of purge().
        const { forgetAllSyncs } = await import('../storage/cloud/sync.ts');
        await forgetAllSyncs();
        toast(gone
          ? `Removed ${gone} item${gone === 1 ? '' : 's'} from ${provider.label} — they are in your Drive trash`
          : `There was nothing of mbrd's in ${provider.label}`);
      } catch (err) {
        console.error(err);
        // The local table is deliberately left alone on a failure. Some of it
        // may still be up there, and those rows are the only way back to it.
        toast('Could not clear your Drive: ' + why(err), 'error');
      } finally {
        job.end();
        paintPanel();
      }
    },
    /**
     * The boards in Drive - which is the board switcher, because they are
     * boards.
     *
     * **This used to raise a menu of its own** listing board ids and dates
     * against nothing, on the reasoning that a board in Drive was a different
     * kind of thing from a board on the shelf. It is not. It is the same board
     * somewhere else, often literally the same board - the ids match, because
     * both are what ensureBoardId() minted - so the two lists shown separately
     * asked people to hold a merge in their heads that the app could do for
     * them.
     *
     * So there is one shelf. ui/library.ts draws the local boards immediately
     * and the cloud ones as they arrive, marks the ones that are in both, and
     * offers to connect an account in its foot when there is none. This command
     * is now the same call the Boards button makes, and stays only because the
     * Sync section has a row that should still take you there.
     */
    cloudOpen: () => openLibrary(),
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
