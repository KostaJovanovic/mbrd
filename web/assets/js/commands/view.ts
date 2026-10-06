// View commands: camera, lenses (Canvas/Feed/Playlist), debug overlays,
// zoom lock, scale/appearance/quality resets, the way out to the patch notes,
// the way to the apps and the update check. The only
// command run that takes the Viewport — fit, recenter, and zoom lock are
// the app's entire camera relationship. resetAppearance is injected
// because ui/appearance.ts touches globals at import time.

import { toast } from '../notify.ts';
import { goHome, homePath } from '../page.ts';
import {
  board, isContent, isFiltered, select, setSetting, setTagFilter, tagFilter,
  setBoardMode as selectBoardMode,
} from '../state.ts';
import { DEFAULT_SCALE } from '../measure.ts';
import { platform } from '../platform/platform.ts';
import { clearQualityOverrides } from '../quality.ts';
import { cueLogOn, dumpCueLog, setCueLog } from '../cuelume/engine.ts';
import { BASE_ZOOM, onNarrowScreen, travelMs } from '../canvas/viewport.ts';
import type { Viewport } from '../canvas/viewport.ts';
import type { ViewPerf } from '../perf/view-perf.ts';

/**
 * Where every app is downloaded from: the latest release of KostaJovanovic/mbrd.
 * Not a file in it, since each file's name carries its version and a fixed link
 * dies on the next release. The desktop's updater opens the same page
 * (desktop/updates.ts).
 */
export const RELEASES = 'https://github.com/KostaJovanovic/mbrd/releases/latest';
/** Where Report a problem sends somebody, with the details on their clipboard. */
export const ISSUES = 'https://github.com/KostaJovanovic/mbrd/issues/new';
/** The source, for the About sheet. */
export const SOURCE = 'https://github.com/KostaJovanovic/mbrd';
import { togglePlayback } from '../canvas/audio.ts';
import { currentLens, setLens } from '../ui/board-view.ts';
import {
  goToStop, startTour, stepTour, stopTour, tourActive, tourAt, tourLength,
} from '../ui/tour.ts';
import { deleteStop, stopTourEdit, toggleTourEdit, tourEditing } from '../ui/tour-edit.ts';
import { togglePlayerWindow } from '../ui/playlist.ts';
import { openCredits } from '../ui/credits.ts';
import { openInventory } from '../ui/inventory.ts';
import { toggleTimeline } from '../ui/timeline-view.ts';
import { paintZoom, zoomText } from '../ui/hud.ts';
import { ask } from '../ui/dialog.ts';
import { parsePoint } from '../ui/palette-match.ts';
import { reloadBoard, restartApp, scaleFromItem } from '../ui/board-actions.ts';

/** Alias so commands.ts can extend with its own surface without re-importing viewport. */
export type CommandViewport = Viewport;

/** What main.ts hands in through createCommands, of which this run wants one. */
export interface ViewDeps {
  resetAppearance: () => void;
  perf: ViewPerf;
}

/** Back to the canvas, as the Canvas command does it. */
function toCanvas() {
  if (goHome('canvas')) return;
  if (selectBoardMode('desktop')) toast('Back to the canvas');
}

/**
 * A command the Feed cannot do, refused with the way to where it can: the
 * message carries a Switch to canvas button rather than leaving somebody to
 * find the switch themselves.
 */
export function canvasOnly(message: string) {
  toast(message, '', { label: 'Switch to canvas', run: toCanvas });
}

export function viewCommands(vp: CommandViewport, { resetAppearance, perf }: ViewDeps) {
  return {
    /**
     * Tag filter — which tags the board is showing. Lives in this run (view),
     * not item-meta (writes). Not undoable, not saved, gone when the board closes.
     */
    tagFilter: () => [...tagFilter],
    hasTagFilter: () => tagFilter.size > 0,
    isTagFiltered: (tag: string) => tagFilter.has(tag),
    toggleTagFilter: (tag: string) => {
      const next = new Set(tagFilter);
      if (!next.delete(tag)) next.add(tag);
      setTagFilter(next);
    },
    clearTagFilter: () => setTagFilter([]),
    filterCounts: () => {
      // Single-pass count instead of building two arrays.
      let shown = 0, all = 0;
      for (const i of board.items) {
        if (!isContent(i)) continue;
        all++;
        if (!isFiltered(i)) shown++;
      }
      return { shown, all };
    },
    /** Select everything passing the filter, so the user can act on the narrowed set. */
    selectFiltered: () => {
      if (!tagFilter.size) return;
      const ids = board.items.filter(i => isContent(i) && !isFiltered(i)).map(i => i.id);
      if (!ids.length) { toast('Nothing on the board carries those tags'); return; }
      select(ids);
    },
    /** Back to freeform canvas. Idempotent — Feed and Playlist are toggles, this is not. */
    canvas: toCanvas,
    /** Feed lens toggle. Already-up → back to canvas. setLens before mode switch so entry lands right. */
    feed: () => {
      if (goHome('feed')) return;
      if (board.layoutMode === 'mobile') {
        if (currentLens() === 'feed') { selectBoardMode('desktop'); toast('Back to the canvas'); }
        else setLens('feed');
        return;
      }
      setLens('feed');
      selectBoardMode('mobile');
    },
    /**
     * Playlist: lens on narrow screens, floating window on wide ones. Not a
     * toggle-out like Feed — closing a player that hides the track you were
     * choosing is wrong; Canvas is the named way back.
     */
    playlist: () => {
      if (goHome('playlist')) return;
      if (onNarrowScreen()) {
        setLens('playlist');
        if (board.layoutMode !== 'mobile') selectBoardMode('mobile');
        return;
      }
      if (board.layoutMode === 'mobile') {
        if (currentLens() === 'playlist') { selectBoardMode('desktop'); toast('Back to the canvas'); }
        else setLens('playlist');
        return;
      }
      togglePlayerWindow();
    },
    /**
     * Tour: board as a sequence of stops. Lives here (view), not item-meta
     * (writes). tourStep/tourStop return whether they consumed the press,
     * so input.ts can fall through to nudge/escape.
     */
    tourStart: () => startTour(),
    // Tour editor: a mode, not a camera move. tourEditStop returns consumed-press for Escape.
    tourEdit: () => toggleTourEdit(),
    tourEditStop: () => stopTourEdit(),
    tourEditing: () => tourEditing(),
    tourEditDelete: () => deleteStop(),
    tourStop: () => stopTour(),
    tourStep: (delta: number) => stepTour(delta),
    tourGo: (i: number) => goToStop(i),
    inTour: () => tourActive(),
    tourLength: () => tourLength(),
    // Current stop index for menu greying and editor highlighting. -1 when idle.
    tourAt: () => tourAt(),
    // Space: play/pause. Returns false when nothing loaded, so Space falls back to pan.
    playPause: () => togglePlayback(),
    // The sheet up or down, with its size left where it was. A command rather
    // than a listener on the button, so the row in the panel is the ordinary
    // `data-cmd` kind and this can be put in a menu later without moving.
    togglePaper: () => setSetting('paperShow', !board.settings.paperShow),
    scaleFromItem,
    // Resets scale and sheet size together — the sheet is drawn at whatever A4
    // works out to under the current scale.
    resetScale: () => {
      if (board.settings.scale === DEFAULT_SCALE) return;
      setSetting('scale', DEFAULT_SCALE);
      toast('Back to the default size');
    },
    // Title card excluded on Mobile — it is parked off-screen by completeLayout().
    fit: () => vp.fit(
      board.items.filter((i: { type: string }) =>
        board.layoutMode !== 'mobile' || i.type !== 'title'),
      80, travelMs()),
    recenter: () => vp.recenter(travelMs()),
    // The camera to a board point, as the readout names it: given, or asked
    // for with where the view is now filled in. Canvas only - the Feed has one axis.
    moveTo: async (x?: number, y?: number) => {
      if (vp.isMobile) { canvasOnly('Moving to a point is a canvas thing'); return; }
      let at = typeof x === 'number' && typeof y === 'number' && Number.isFinite(x) && Number.isFinite(y)
        ? { x, y } : null;
      if (!at) {
        const here = vp.toWorld(vp.left + vp.cx, vp.top + vp.cy);
        const typed = await ask({
          title: 'Move to',
          body: 'A point on the board as the readout says it: x, then y.',
          go: 'Move',
          field: { value: `${Math.round(here.x)}, ${Math.round(here.y)}` },
        });
        if (typed === null) return;
        at = parsePoint(typed);
        if (!at) { toast('That is not a point. Two numbers: x, then y'); return; }
      }
      vp.centreOn(at, travelMs());
    },
    // 100% without moving the view: the 1 key, and the same call a click on the
    // zoom readout makes (ui/hud.ts). Nothing under a lock, as the readout is
    // dead there, and nothing on Mobile, whose zoom is the column width.
    zoomActual: () => {
      if (vp.zoomLocked || vp.isMobile) return;
      vp.viewTo(vp.pan, BASE_ZOOM, travelMs());
    },
    // Dev: paint resize grab zones (no ink of their own). Also on mbrd.debugGrips() and #grips URL.
    debugGrips: () => {
      const on = document.documentElement.toggleAttribute('data-debug-grips');
      document.querySelector('[data-cmd="debug-grips"]')?.setAttribute('aria-pressed', String(on));
      return on;
    },
    /** Arm/disarm the frame profiler. Writes its own aria-pressed — console and #perf also toggle it. */
    debugPerf: () => {
      const on = !perf.active;
      if (on) perf.on(); else perf.off();
      document.querySelector('[data-cmd="debug-perf"]')?.setAttribute('aria-pressed', String(on));
      toast(on ? 'Profiling - pan and zoom for a while, then Print the report' : 'Profiling off');
      return on;
    },
    /** Print the profiler report. Separate from the toggle so you can read mid-session. */
    debugPerfReport: () => {
      if (!perf.active) { toast('Turn profiling on first, then pan and zoom'); return; }
      const r = perf.report();
      toast(r ? 'Report printed to the console' : 'Nothing sampled yet - pan or zoom first');
    },
    /**
     * Cue log: transcript of every interface sound and what became of it.
     * Value is the lines that are *not* there — a missing cue means a call
     * site is missing. Remembered across reload (unlike the profiler).
     */
    debugSound: () => {
      const on = setCueLog(!cueLogOn());
      document.querySelector('[data-cmd="debug-sound"]')?.setAttribute('aria-pressed', String(on));
      toast(on
        ? 'Logging cues - use the board, then Print the cue log'
        : 'Cue logging off');
      return on;
    },
    /** The transcript as a table. Its own row, for the reason the report is. */
    debugSoundReport: () => {
      if (!cueLogOn()) { toast('Turn cue logging on first, then use the board'); return; }
      const rows = dumpCueLog();
      toast(rows.length
        ? `${rows.length} cue${rows.length === 1 ? '' : 's'} printed to the console`
        : 'Nothing logged yet - press something first');
    },
    // Lock/unlock the current magnification.
    lockZoom: () => {
      if (vp.isMobile) {
        toast(`Mobile zoom follows the ${board.settings.mobileColumns}-column width`);
        return;
      }
      vp.zoomLocked = !vp.zoomLocked;
      paintZoom(true);
      toast(vp.zoomLocked ? `Zoom locked at ${zoomText()}` : 'Zoom unlocked');
    },
    resetAppearance,
    // Reset all quality overrides back to the dial.
    resetQuality: () => {
      clearQualityOverrides();
      toast('Quality back to the dial');
    },
    reload: reloadBoard,
    restart: () => restartApp(),
    // Credits sheet.
    credits: () => openCredits(),
    // Board inventory report.
    inventory: () => openInventory(),
    // Toggle the timeline. Which face (strip or sheet) is decided by ui/timeline-view.ts.
    timeline: () => toggleTimeline(),
    // Navigate to patch notes. Same tab — board is flushed on pagehide/visibilitychange
    // (the desktop shell asks for the flush first), and in-place navigation avoids
    // the theme flash a new tab would show.
    patchNotes: () => { location.href = homePath() + 'patch'; },
    // The latest release on GitHub, in a new tab, so the board stays open. No
    // leaving question (ui/leaving.ts): this button says where it goes.
    getApp: () => { window.open(RELEASES, '_blank', 'noopener,noreferrer'); },
    // The desktop answers on its title bar. The phone answers on the page, a
    // moment later, so the press itself is said at once there, and a check
    // that fails is said too. On the web this does nothing.
    checkUpdates: async () => {
      const updates = platform.updates;
      if (!updates.answersOnPage) return updates.check();
      toast('Checking for a newer version of mbrd.');
      try {
        await updates.check();
      } catch (err) {
        toast(`mbrd could not check for updates: ${err instanceof Error ? err.message : String(err)}`, 'error');
      }
    },
  };
}
