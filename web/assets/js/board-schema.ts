// @ts-nocheck - TypeScript migration debt, not a judgement about this file.
//
// The tree was renamed from .js to .ts mechanically, which moved 104 modules in
// one step and annotated none of them. This module is carried unchecked so that
// npm run typecheck stays green and keeps meaning something, rather than going
// red and being ignored. Converting this module IS deleting this block and
// fixing what tsc then says - tests/ts-debt.test.js holds the count and lets it
// only fall.
// The `.mbrd` schema, in both directions: what a board looks like on the way in
// from a file, and what it looks like on the way out to one.
//
// This is the app's whole contract with a document it did not necessarily
// write. `board.json` arrives parsed but unvalidated - it may have been
// hand-edited, truncated, produced by a build of this app that no longer
// exists, or produced by something else entirely - and every field in it is a
// claim rather than a fact. normalizeBoard() turns that claim into a complete,
// well-shaped board or into a default, one field at a time, and **cannot
// throw**. serializeBoard() is the same promise pointing the other way: what it
// returns is exactly what lands in the file, already held to the same rules the
// reader will apply to it.
//
// It sits here, below state.js, for three reasons that are all the same reason.
//
//   1. These are pure `raw -> clean` functions over data. Nothing here mutates
//      the board; normalizeBoard() *builds* a replacement and hands it back, and
//      the assignments that swap it in stay in state.js where the rest of the
//      mutation door lives. That split is not cosmetic - it is what makes a
//      failed open impossible to see, because there is no half-way point at
//      which one of these can give up. See loadBoard().
//   2. A format is testable in a way a mutation is not. Feeding this module a
//      broken object and asserting the board it returns needs no bus, no
//      history and no selection.
//   3. state.js was the only file that knew the format, which meant every
//      change to the format was a change to the mutation door. The one door and
//      the one schema are different jobs that happened to share a file.
//
// **What must not move in here.** Anything that writes to `board`. The
// temptation is loadBoard() itself, since it is where normalizeBoard() is
// called and it reads like the other half of this file - but it clears the
// history, empties the clipboard, reseeds the stick and fence memos and fires
// six events, none of which is schema work. state.js keeps whole-board
// replacement; this keeps the shape of what is being put there.
//
// Note also that serializeBoard() is not pure and is not pretending to be: it
// calls captureLayout() and captureLayoutSettings() first, because a file has
// to record where things are *now* rather than where the last layout switch
// left them. That is the one write-shaped thing in here and it writes to the
// layout profiles rather than to the board's content. It was tried as a
// caller's responsibility and moved back: two call sites (the autosave and the
// export) would each have had to remember, and the one that forgot would ship
// files a day out of date.
//
// Nothing here imports state.js - see tests/layers.test.js, where this is BASE.

import { clamp, isFamily, isHash } from './util.ts';
// The board's link to real-world sizes, and the sheet catalogue. A scale and a
// paper id arriving from a file both have to be held to what the app can draw.
import { clampScale, PAPERS } from './measure.ts';
import { splitAppearance } from './layout-settings.ts';
import {
  board, makeItem, dedupeIds, cleanBoardTitle, cloneSettings, layoutSettingsOf,
  settingsFor, MAX_ITEMS, TRASH_LIMIT, MOBILE_COLUMNS, MOBILE_APPEARANCE_VARS,
  DEFAULT_SETTINGS, DEFAULT_MOBILE_HEADER, mobileColumnCount,
  normalizeConnections, normalizeAudioOrder,
} from './board-model.ts';
// Geometry profiles. The reader has to fill in the layout a file does not carry
// and the writer has to record both of them, so the whole of the profile
// machinery is on this side of the door.
import {
  captureLayout, captureLayoutSettings, completeLayout, geometryOf, layoutMap,
  normalizeLayout,
} from './layout.ts';
// The two durable relation records. Both are *measured* at write time from live
// geometry rather than copied out of a stale field - see the notes at their use
// below - which is why the writer reaches for these two modules at all.
import { isSticky, stuckTo } from './sticky.ts';
import { fenceOf } from './fences.ts';

// ---------------------------------------------------------------------------
// Reading a board
// ---------------------------------------------------------------------------

/**
 * A whole board, built from whatever arrived, with no way to fail.
 *
 * Every container is checked for the shape it is about to be used as rather
 * than assumed, so a hand-written or truncated board.json degrades to defaults
 * one field at a time instead of throwing half-way through a load.
 */
export function normalizeBoard(data) {
  const src = data && typeof data === 'object' ? data : {};
  const rawSettings = src.settings && typeof src.settings === 'object' ? src.settings : {};
  const desktopSettings = normalizeSettings(rawSettings, 'desktop');
  // The Mobile profile, as far as it can be read out of a Desktop-shaped file.
  //
  // Spacing is zeroed on the way through and that is a migration, not a rule:
  // top-level `settings` describes Desktop (see research/docs/mbrd-format.md), so a file
  // with no Mobile record of its own would hand the column Desktop's 12 - and
  // for every board written before Mobile had a gap at all, zero is what it was
  // actually saved looking like. A file that *does* carry a Mobile record keeps
  // whatever gap that record names; normalizeLayoutSettings() spreads the
  // record over this, so the record wins wherever it has an opinion.
  const mobileSettings = { ...normalizeSettings(rawSettings, 'mobile'), spacing: 0 };
  const { shared: sharedAppearance } = splitAppearance(desktopSettings.appearance);
  const items = (Array.isArray(src.items) ? src.items : [])
    .filter(it => it && typeof it === 'object')
    .slice(0, MAX_ITEMS);
  const trash = (Array.isArray(src.trash) ? src.trash : [])
    .filter(t => t && t.item && typeof t.item === 'object')
    .slice(0, TRASH_LIMIT);
  // One id space across the live board and the bin: a restored item must not
  // collide with a live one.
  const ids = new Set();
  // makeItem() defaults a missing `z` to topZ() + 1, which reads the *live*
  // board - and the live board here is still the previous one, about to be
  // thrown away. Harmless, and worth recording why rather than fixing: every
  // file this app writes carries a z, and for one that does not,
  // normalizeLayout()/completeLayout() below overwrite the geometry anyway. What
  // it must never become is load-bearing.
  const normalizedItems = dedupeIds(items.map(makeItem), ids);
  const rawLayouts = src.layouts && typeof src.layouts === 'object' ? src.layouts : {};
  const desktopRecord = layoutRecord(rawLayouts.desktop);
  const mobileRecord = layoutRecord(rawLayouts.mobile);
  const desktop = normalizeLayout(desktopRecord.items, normalizedItems);
  const mobile = normalizeLayout(mobileRecord.items, normalizedItems);
  const desktopById = layoutMap(desktop);
  const legacyArrangement = typeof src.arrangement === 'string' && src.arrangement
    ? src.arrangement : 'spiral';

  return {
    title: cleanBoardTitle(src.title) || 'Untitled board',
    view: {
      pan: { x: +src.view?.pan?.x || 0, y: +src.view?.pan?.y || 0 },
      zoom: +src.view?.zoom || 1,
    },
    // Board-level now; a file written before it moved here carries the style
    // under settings.mobileHeader, so that is the fallback source.
    mobileHeader: normalizeMobileHeader(src.mobileHeader ?? rawSettings.mobileHeader),
    titleHidden: !!src.titleHidden,
    mediaFit: normalizeMediaFit(src.mediaFit),
    paletteSources: normalizePaletteSources(src.paletteSources),
    sharedAppearance,
    layoutSettings: {
      desktop: desktopRecord.settings
        ? normalizeLayoutSettings(desktopRecord.settings, 'desktop', desktopSettings)
        : layoutSettingsOf(desktopSettings),
      mobile: mobileRecord.settings
        ? normalizeLayoutSettings(mobileRecord.settings, 'mobile', mobileSettings)
        : layoutSettingsOf(mobileSettings),
    },
    arrangements: {
      desktop: desktopRecord.arrangement || legacyArrangement,
      mobile: mobileRecord.arrangement || legacyArrangement,
    },
    layouts: {
      // `items` remains the Desktop-compatible representation. A file written
      // before profiles existed therefore already contains its desktop layout,
      // and an older reader opening a new file still sees the desktop board.
      desktop: normalizedItems.map(it => desktopById.get(it.id) || geometryOf(it)),
      mobile,
    },
    items: normalizedItems,
    trash: dedupeIds(trash.map(t => makeItem(t.item)), ids)
      .map((item, i) => ({ item, at: +trash[i].at || 0 })),
    // Against `ids`, which dedupeIds() has by now filled with every id on the
    // board *and* every id in the bin - and filled with the ids as they ended
    // up, so a pair naming a duplicate that was renamed on the way in is pruned
    // rather than pointing at whichever card won the collision. A connection to
    // a binned card is kept: restoring it has to bring its lines back with it.
    connections: normalizeConnections(src.connections, ids),
    // Held to the same id union as connections - the board's cards and the bin's -
    // so a saved order that names a since-thrown-away track survives to be restored
    // with it. The Playlist filters this to the audio it actually has.
    audioOrder: normalizeAudioOrder(src.audioOrder, ids),
  };
}

function layoutRecord(raw) {
  if (Array.isArray(raw)) return { items: raw, settings: null, arrangement: '' };
  if (!raw || typeof raw !== 'object') return { items: [], settings: null, arrangement: '' };
  return {
    items: Array.isArray(raw.items) ? raw.items : [],
    settings: raw.settings && typeof raw.settings === 'object' ? raw.settings : null,
    arrangement: typeof raw.arrangement === 'string' && raw.arrangement
      ? raw.arrangement : '',
  };
}

function normalizeLayoutSettings(raw, mode, fallback) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const base = settingsFor(layoutSettingsOf(fallback), {});
  const baseLook = base.appearance || {};
  const sourceLook = source.appearance && typeof source.appearance === 'object'
    ? source.appearance : {};
  return layoutSettingsOf(normalizeSettings({
    ...base,
    ...source,
    appearance: {
      ...baseLook,
      ...sourceLook,
      vars: { ...(baseLook.vars || {}), ...(sourceLook.vars || {}) },
    },
  }, mode));
}

function normalizeSettings(raw, mode) {
  const settings = raw && typeof raw === 'object' ? raw : {};
  const appearance = settings.appearance && typeof settings.appearance === 'object'
    ? settings.appearance : {};
  const vars = {
    ...(mode === 'mobile' ? MOBILE_APPEARANCE_VARS : {}),
    ...(appearance.vars && typeof appearance.vars === 'object' ? appearance.vars : {}),
  };
  return {
    ...DEFAULT_SETTINGS,
    snap: mode === 'mobile',
    ...settings,
    mobileColumns: mode === 'mobile'
      ? mobileColumnCount(settings.mobileColumns ?? MOBILE_COLUMNS)
      : DEFAULT_SETTINGS.mobileColumns,
    appearance: {
      ...(appearance.whimsy != null ? { whimsy: appearance.whimsy } : {}),
      palette: typeof appearance.palette === 'string' ? appearance.palette : '',
      vars,
      ...(appearance.auto === false ? { auto: false } : {}),
      ...(appearance.derived === true && Object.keys(vars).length ? { derived: true } : {}),
    },
    // Both names and hashes become declarations or asset paths downstream.
    fonts: normalizeFonts(settings.fonts),
    scale: clampScale(settings.scale),
    units: settings.units === 'imperial' ? 'imperial' : 'metric',
    paper: PAPERS.some(p => p.id === settings.paper) ? settings.paper : '',
    paperLandscape: !!settings.paperLandscape,
    paperResize: !!settings.paperResize,
  };
}

/**
 * The faces a board carries, reduced to the ones it may.
 *
 * `{ hash, family }` and nothing else - the hash names bytes in the asset store
 * and the family becomes a CSS family name, so a bad one of either is a bad
 * declaration or a dangling reference. Filtered entry by entry rather than
 * rejected wholesale, which is how everything else in this function behaves: a
 * board carrying four faces and one broken record should open with four.
 *
 * Capped, because this list is walked by the packer and registered against the
 * document, and neither wants a thousand entries out of a hand-written file.
 */
export function normalizeFonts(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const f of raw) {
    if (!f || typeof f !== 'object') continue;
    if (!isHash(f.hash) || seen.has(f.hash) || !isFamily(f.family)) continue;
    seen.add(f.hash);
    const font = { hash: f.hash, family: f.family };
    const axes = normalizeFontAxes(f.axes);
    // One or the other, never both. `variable` says only "this file has an
    // fvar", which is all a bracketless .woff2 can be asked - its axes are
    // behind Brotli. It exists so ui/fonts.js can still declare a weight range
    // wide enough to reach the axis instead of defaulting to a flat 400; with
    // real axes present that range comes from them and this would be a second
    // source for the same fact.
    if (axes.length) font.axes = axes;
    else if (f.variable === true) font.variable = true;
    out.push(font);
    if (out.length >= MAX_FONTS) break;
  }
  return out;
}

/** Variable axes a font record may carry from its OpenType `fvar` table. */
function normalizeFontAxes(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const axis of raw) {
    const tag = typeof axis?.tag === 'string' ? axis.tag : '';
    const min = +axis?.min, max = +axis?.max, fallback = +axis?.default;
    if (!/^[A-Za-z0-9 ]{4}$/.test(tag) || seen.has(tag)) continue;
    if (![min, max, fallback].every(Number.isFinite) || !(max > min)) continue;
    seen.add(tag);
    out.push({ tag, min, default: clamp(fallback, min, max), max });
    if (out.length >= MAX_FONT_AXES) break;
  }
  return out;
}

/** The Mobile title style, held to values its controls and CSS can represent. */
/** The board-wide media fit, defaulting to fit (contain) - fill is opt-in. */
export function normalizeMediaFit(value) {
  return value === 'cover' ? 'cover' : 'contain';
}

/**
 * How many pictures the palette reads: [1, 24], or 0 for every one of them.
 *
 * Zero is past the top of the dial rather than below its bottom - the slider's
 * last stop reads "Every photo" - and it is stored as 0 because a number cannot
 * say "all" and the alternative was a second key saying it instead. 24 is the
 * highest *count* the sampler defaults to (MAX_SOURCES); asking for all of them
 * lifts that, which is the whole of what this option does.
 */
export function normalizePaletteSources(value) {
  const n = Math.round(+value);
  if (!Number.isFinite(n)) return 12;
  return n === 0 ? 0 : Math.max(1, Math.min(24, n));
}

export function normalizeMobileHeader(raw) {
  const header = raw && typeof raw === 'object' ? raw : {};
  const axes = {};
  if (header.axes && typeof header.axes === 'object') {
    for (const [tag, value] of Object.entries(header.axes)) {
      if (!/^[A-Za-z0-9 ]{4}$/.test(tag) || !Number.isFinite(+value)) continue;
      axes[tag] = +value;
      if (Object.keys(axes).length >= MAX_FONT_AXES) break;
    }
  }
  return {
    font: header.font === '' || isFamily(header.font) ? header.font : '',
    size: clamp(+header.size || DEFAULT_MOBILE_HEADER.size, 7, 24),
    // Half height to five times it. The top of that range already fills the
    // band and spills past what its overflow will show, which is a thing
    // somebody may well want on a title page; the floor is a floor because a
    // scaleY heading for 0 erases the name rather than styling it.
    stretch: clamp(+header.stretch || DEFAULT_MOBILE_HEADER.stretch, 50, 500),
    // 100 is `normal` - the face's own line height. See the default above.
    leading: clamp(+header.leading || DEFAULT_MOBILE_HEADER.leading, 60, 250),
    weight: clamp(Math.round(+header.weight || DEFAULT_MOBILE_HEADER.weight), 1, 1000),
    // Signed, so `|| 0` cannot swallow a real value - only 0 itself falls back
    // to 0, which is where it belongs. Half the band either way is enough to sit
    // the name against the top or bottom edge; further only pushes it out under
    // the band's own overflow clip.
    offset: clamp(Number.isFinite(+header.offset) ? +header.offset : 0, -50, 50),
    italic: !!header.italic,
    // Absent means on. Every board written before this setting existed wrapped
    // its name, and !!undefined would quietly turn that off for all of them.
    wrap: header.wrap !== false,
    axes,
  };
}

/** Matches MAX_FONTS in ui/fonts.js - the two are one limit in two layers. */
const MAX_FONTS = 8;
/**
 * Matches MAX_AXES in ui/fonts.js. 32, up from 16: the parametric families are
 * the reason - Roboto Flex ships thirteen axes and Amstelvar more than twenty,
 * and a limit that truncated them was cutting off exactly the fonts a variable
 * axis panel exists for. Still a bound rather than none, since this is what a
 * hand-made .mbrd is held to on the way in.
 */
const MAX_FONT_AXES = 32;

// ---------------------------------------------------------------------------
// Writing a board
// ---------------------------------------------------------------------------

/** The serialisable board, exactly as it lands in board.json. */
export function serializeBoard() {
  captureLayout();
  captureLayoutSettings();
  // Ghost cards never reach a file. They are onboarding hints the app puts on a
  // blank board, not anything of the user's, and a .mbrd carrying three of them
  // would hand them to whoever opened it - on a board that is by then no longer
  // empty, so nothing would ever take them away again. Stripping here rather
  // than at each of the three sinks below is what keeps the format from having
  // to know the type exists at all.
  const ghost = new Set(board.items.filter(i => i.type === 'ghost').map(i => i.id));
  const real = ghost.size ? board.items.filter(i => !ghost.has(i.id)) : board.items;
  const shed = list => (ghost.size ? list.filter(g => !ghost.has(g.id)) : list);
  const desktop = shed(completeLayout('desktop'));
  const mobile = shed(completeLayout('mobile'));
  // Every id this file will carry: the real items and the bin's. What
  // connections are pruned against - see the note beside them below.
  const filed = new Set([...real.map(i => i.id), ...board.trash.map(t => t.item.id)]);
  const desktopSettings = settingsFor(board.layoutSettings.desktop, board.sharedAppearance);
  const desktopById = layoutMap(desktop);
  const itemIn = (item, geometry) => {
    const meta = { ...item.meta };
    if (geometry?.presnap) meta.presnap = { ...geometry.presnap };
    else delete meta.presnap;
    // Stamp the durable stick record. Measured now from live geometry, not read
    // from a stale field, so the file records where the note actually sits; a
    // load seeds the memo back from it. Null is a real answer and is kept.
    if (isSticky(item)) meta.stuckTo = stuckTo(item)?.id ?? null;
    // And the durable membership record, on any type rather than on one - a
    // fence nested in a bigger fence carries it too. It does the same small job
    // the stick record does, keeping a pixel of drift across a save from losing
    // a grouping somebody plainly made, and one larger one that has no
    // equivalent: a board opened straight into Mobile cannot measure membership
    // at all, since it is measured on Desktop geometry and there is none of that
    // on screen. For that board this key *is* the membership. See seedFences().
    //
    // Written only when there is one, unlike stuckTo, which keeps its null. A
    // note is one item in a hundred and a fence record would otherwise land on
    // every card on the board; `"fence": null` five hundred times is noise in a
    // format whose second promise is that you can read it. Absent means loose,
    // which is also what a fresh measurement says, so the two agree. Deleted
    // rather than left when it goes, or a card dragged out of a fence would keep
    // the stale key it arrived with.
    const fence = fenceOf(item)?.id;
    if (fence) meta.fence = fence;
    else delete meta.fence;
    return { ...item, ...(geometry || null), meta };
  };
  return {
    title: board.title,
    view: { pan: { ...board.view.pan }, zoom: board.view.zoom },
    // Board-level: the one style behind the Mobile masthead and the Desktop
    // title card. Also mirrored into settings below (see desktopSettings) so a
    // reader predating the move still finds it.
    mobileHeader: normalizeMobileHeader(board.mobileHeader),
    titleHidden: !!board.titleHidden,
    mediaFit: normalizeMediaFit(board.mediaFit),
    paletteSources: normalizePaletteSources(board.paletteSources),
    // Legacy readers see the Desktop half, matching the Desktop geometry kept in
    // items. New readers use each layout record below.
    settings: { ...desktopSettings, mobileHeader: normalizeMobileHeader(board.mobileHeader) },
    arrangement: board.arrangements.desktop,
    // Desktop stays in the traditional item fields for readers predating
    // profiles. New readers take the active geometry from `layouts`.
    items: real.map(item => serializeItem(itemIn(item, desktopById.get(item.id)))),
    layouts: {
      desktop: {
        items: desktop.map(serializeGeometry),
        settings: cloneSettings(board.layoutSettings.desktop),
        arrangement: board.arrangements.desktop,
      },
      mobile: {
        items: mobile.map(serializeGeometry),
        settings: cloneSettings(board.layoutSettings.mobile),
        arrangement: board.arrangements.mobile,
      },
    },
    // The bin travels with the board. Saving is the moment a board becomes a
    // file you might not open again for a month, and a bin that emptied itself
    // at exactly that moment would be a trapdoor rather than a safety net.
    trash: board.trash.map(t => ({ at: t.at, item: serializeItem(t.item) })),
    // Pruned against what this file actually holds, which is the *shed* item
    // list plus the bin. Two things fall out of that and both are meant to:
    // a connection to a hint card cannot reach a file, because ghosts are
    // stripped a few lines up and a pair naming one would dangle in every
    // reader; and a connection to a binned card is kept, because restoring
    // that card has to bring its lines back with it.
    //
    // This is the only place dangling pairs are collected. While the app is
    // running they are simply not drawn - see the note over toggleConnection().
    connections: normalizeConnections(board.connections, filed),
    // The Playlist's order, pruned to the same union the connections are. An
    // empty one is written as [] rather than dropped, so a board that had its
    // playlist arranged and then cleared does not silently re-sort on reload.
    audioOrder: normalizeAudioOrder(board.audioOrder, filed),
  };
}

const serializeItem = i => ({
  id: i.id, type: i.type,
  x: round(i.x), y: round(i.y), w: round(i.w), h: round(i.h),
  rot: round(i.rot), z: i.z,
  name: i.name, asset: i.asset, meta: i.meta,
});

const serializeGeometry = geometry => ({
  id: geometry.id,
  x: round(geometry.x), y: round(geometry.y),
  w: round(geometry.w), h: round(geometry.h),
  rot: round(geometry.rot), z: geometry.z,
  ...(geometry.presnap ? {
    presnap: {
      x: round(geometry.presnap.x), y: round(geometry.presnap.y),
      w: round(geometry.presnap.w), h: round(geometry.presnap.h),
    },
  } : {}),
});

const round = n => Math.round(n * 100) / 100;
