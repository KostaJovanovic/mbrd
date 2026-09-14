// File commands: New, Open, Save, Export, Share, PNG/PDF, cloud sync,
// and the optimizer. No Viewport dependency — a board being written
// out has no camera. Session policy lives in ui/board-actions.ts.

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
  startSyncingBoard, stopSyncingBoard, storageBreakdown, boardFolder, saveDocument,
} from '../storage/storage.ts';
import { shareLinkFor } from '../storage/cloud/provider.ts';
import { SHARE_SITE } from '../storage/cloud/config.ts';
import { paintPanel } from '../ui/panel.ts';
import { connectCloud } from '../ui/cloud-connect.ts';
import { homePath } from '../page.ts';
import { assetBytes } from '../storage/assets.ts';
import { openLibrary } from '../ui/library.ts';
import { boardPdf, boardPng } from '../ui/snapshot.ts';
import { saveWithCooldown } from '../ui/board-actions.ts';
import { isDesktop, platform } from '../platform/platform.ts';

/** A filesystem-safe download name from the board title. */
function boardArtefactName(ext: string): string {
  const base = (board.title || '').replace(/[^\w -]+/g, '').trim().slice(0, 60) || 'board';
  return `${base}.${ext}`;
}

/** Human name for a storage slice; unknown names pass through. */
function storageLabel(what: string): string {
  switch (what) {
    case 'idb:kv': return 'session';
    case 'idb:assets': return 'this board';
    case 'idb:library': return 'shelf';
    case 'idb:matte': return 'cut-outs';
    default: break;
  }
  const cache = what.startsWith('cache:') ? what.slice(6) : '';
  if (!cache) return what;
  return cache.startsWith('mbrd-') ? 'app cache' : `cache ${cache}`;
}

// SAFETY: every caller passes a caught value, and no module here throws a literal or rejects with one.
const why = (err: unknown): string => (err as Error).message;

// Shared boards always carry history now — see privacy.html.

// Push the board to the cloud. A conflict (another machine wrote since us)
// is asked about rather than failed, because there is no merge.
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

// ~1 min on a typical upstream — warn, but do not refuse.
const HEAVY_SHARE = 100 * 1024 * 1024;

// Copy the share link to the clipboard, or show it in a dialog if the
// clipboard write is refused (stale gesture, no secure context, etc.).
async function handOverLink(link: string): Promise<void> {
  const copy = async (): Promise<boolean> => {
    try {
      if (!navigator.clipboard?.writeText) return false;
      await navigator.clipboard.writeText(link);
      return true;
    } catch {
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
  if (again === null) return;
  if (await copy()) toast('Link copied — anyone with it can open this board');
  else toast('Could not reach the clipboard — the link is in the console', 'error');
}

// Warn (but allow) exporting an empty board. The short-circuit is
// load-bearing: ask() returns 'cancel' with no document.
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
    // The sidebar's Update row (Android). The board goes to its file first,
    // quietly, since installing closes the app.
    installUpdate: async () => {
      await saveDocument().catch(() => false);
      await platform.updates.install();
    },
    library: () => openLibrary(),
    // Debug readouts: each toasts the summary and logs the detail. In the apps
    // there is no browser to name: a board is a file, and the store under it
    // is only the crash copy.
    boardSafe: () => {
      const { state, detail } = boardSafety();
      const failure = lastSaveFailure();
      const headline = state === 'saved' ? (isDesktop() ? 'Your work is saved' : 'Your work is saved in this browser')
        : state === 'unsaved' ? 'There are changes that are not saved'
          : 'Cannot tell whether the last changes were saved';
      toast(detail ? `${headline} - ${detail}` : headline, state === 'unsaved' ? 'error' : undefined);
      console.info('[mbrd] board safety:', { state, detail, lastSaveFailure: failure || null });
    },
    /** Storage persistence state and per-store breakdown. */
    storageState: async () => {
      // The apps keep boards as files, so the question is where they are.
      // Android names no folder yet (see boardFolder in storage/storage.ts).
      if (isDesktop()) {
        const home = boardFolder();
        toast(home ? `Boards are kept in ${home}` : 'Boards are kept inside the app');
        console.info('[mbrd] storage:', { folder: home });
        return;
      }
      const { slices, measured, others, persisted, rest, used, quota } = await storageBreakdown();
      const durable = persisted === null ? 'not asked yet - save once and it will be'
        : persisted ? 'durable: the browser has promised to keep it'
          : 'best-effort: the browser may clear it to make room';
      const room = used == null ? '' : ` Using ${formatBytes(used)}${quota ? ' of ' + formatBytes(quota) : ''}.`;
      const parts = slices.filter(s => s.bytes > 0).map(s => `${storageLabel(s.what)} ${formatBytes(s.bytes)}`);
      // Show the gap between measured and reported so missing megabytes are visible.
      if (rest != null && rest > measured * 0.1) parts.push(`elsewhere ${formatBytes(Math.max(0, rest))}`);
      const where = parts.length ? ` ${parts.join(', ')}.` : '';
      toast(`Storage is ${durable}.${room}${where}`);
      console.info('[mbrd] storage:', { persisted, used, quota, measured, rest, slices, others });
    },
    // Dynamic import: optimize/ must not become a static dependency.
    boardWeight: async () => {
      const { bytes, count } = assetBytes();
      const { planOptimize, describeSaving } = await import('../optimize/optimize.ts');
      const plan = planOptimize();
      const jobs = [...plan.pictures, ...plan.sounds];
      const shrinkable = jobs.reduce((n, job) => n + job.size, 0);
      const verdict = jobs.length
        ? `${jobs.length} could be made smaller - ${formatBytes(shrinkable)} as they stand.`
        : plan.done ? 'Nothing left to shrink.'
          : 'Nothing here can be made smaller.';
      const already = plan.done ? ` ${plan.done} already optimised.` : '';
      const left = plan.skipped.length ? ` ${plan.skipped.length} left alone.` : '';
      const where = isDesktop() ? '' : ' in this browser';
      toast(`${count} files, ${formatBytes(bytes)}${where}. ${verdict}${already}${left}`);
      console.info('[mbrd] board weight:', { files: count, bytes, plan, saving: describeSaving });
    },
    /** Undo stack depth and weight. */
    historyState: () => {
      const { undo, redo } = historyDepth();
      const { undo: undoLabel, redo: redoLabel } = historyState();
      toast(`${undo} back, ${redo} forward, holding ${historyWeight()} items.`);
      console.info('[mbrd] history:', { undo, redo, next: { undo: undoLabel, redo: redoLabel },
        weight: historyWeight() });
    },
    // Browser: keep in IDB. Desktop: write the .mbrd file.
    save: () => isDesktop() ? exportBoard() : saveWithCooldown(),
    saveAs: async () => { if (await confirmEmptyExport()) await exportBoard({ pickNew: true }); },
    export: async () => { if (await confirmEmptyExport()) await exportBoard(); },
    exportAs: async () => { if (await confirmEmptyExport()) await exportBoard({ pickNew: true }); },
    // Hand the .mbrd to the OS share sheet; falls back to Export.
    share: async () => {
      if (!await confirmEmptyExport()) return;
      await shareBoard({ history: true });
    },
    // Upload the board and hand over a share URL. Sign-in must come last
    // before the work, because browsers block popups without a fresh gesture.
    shareLink: async () => {
      if (!await confirmEmptyExport()) return;
      const { shareProvider } = await import('../storage/cloud/cloud.ts');
      const provider = shareProvider('gdrive');
      if (!provider?.canSignIn()) { toast('Sharing a link is not set up in this build', 'error'); return; }

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

      // A try that stops is offered again with the same pack, and the provider
      // goes on from the last byte that landed rather than from the first.
      let id: string | null = null;
      while (!id) {
        const job = busy(`Uploading to ${provider.label}`);
        try {
          id = await provider.upload(packed.blob, packed.name,
            (sent, total) => job.step(sent, total));
        } catch (err) {
          console.error(err);
          job.end();
          const again = await ask({
            title: 'The upload stopped',
            body: `${why(err)}. What reached ${provider.label} is kept for now, `
              + 'so another try sends only the rest.',
            go: 'Try again',
            cancel: 'Stop',
            danger: false,
          });
          if (again !== 'go') return;
        } finally { job.end(); }
      }
      // In the apps, location is app:// or https://app, which only this
      // machine can open, so the link names the website (SHARE_SITE).
      const site = isDesktop() ? new URL(SHARE_SITE) : null;
      const link = shareLinkFor(site?.origin ?? location.origin, site?.pathname ?? homePath(),
        { provider: provider.id, id });
      console.info('[mbrd] share link:', link);
      await handOverLink(link);
    },
    // ── The cloud copy ───────────────────────────────────────────────────
    connectGdrive: async () => { await connectCloud('gdrive'); },
    /** Log out of the cloud account. Asks first — Drive copies are kept. */
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
      paintPanel();
    },
    cloudSync: async () => {
      if (!await confirmEmptyExport()) return;
      const { shareProvider } = await import('../storage/cloud/cloud.ts');
      const provider = shareProvider('gdrive');
      if (!provider?.signedIn()) { toast('Connect an account first', 'error'); return; }

      const job = busy(`Copying the board to ${provider.label}`);
      try {
        const out = await startSyncingBoard(provider.id);
        if (!out.ok) {
          toast('A copy of this board is already in Drive — open it from the cloud instead', 'error');
          return;
        }
        toast(`Kept in ${provider.label} — ${out.uploaded} file${out.uploaded === 1 ? '' : 's'} sent`);
      } catch (err) {
        console.error(err);
        toast('Could not copy the board: ' + why(err), 'error');
      } finally {
        job.end();
        paintPanel();
      }
    },
    /** Push now, without waiting for autosave. */
    cloudPush: async () => {
      await runSync({ force: false });
      paintPanel();
    },
    /** Stop syncing. Drive copy stays. */
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
    // Trash every file this app put in Drive. drive.file scope means only
    // mbrd's own files are reachable. Local table cleared after, not before.
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
        const { forgetAllSyncs } = await import('../storage/cloud/sync.ts');
        await forgetAllSyncs();
        toast(gone
          ? `Removed ${gone} item${gone === 1 ? '' : 's'} from ${provider.label} — they are in your Drive trash`
          : `There was nothing of mbrd's in ${provider.label}`);
      } catch (err) {
        console.error(err);
        // On failure, keep the local table — it is the only way to retry.
        toast('Could not clear your Drive: ' + why(err), 'error');
      } finally {
        job.end();
        paintPanel();
      }
    },
    // Opens the library, which shows local and cloud boards in one list.
    cloudOpen: () => openLibrary(),
    // Derived artefacts: composited via ui/snapshot.ts, not the live DOM.
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
    // Dynamic import: the encoder is ~30 MB and loaded only on demand.
    optimize: () => import('../optimize/ui.ts').then(m => m.optimizeBoard()),
    discardOriginals: () => import('../optimize/ui.ts').then(m => m.discardOptimizeOriginals()),
  };
}
