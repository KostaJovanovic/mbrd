// What the pointing device means: whether a plain wheel notch zooms or scrolls,
// and which way round a zoom goes. Per device, in localStorage — which mouse is
// on the desk is not a property of a moodboard, so none of this travels in a
// .mbrd. canvas/input.ts reads it on every wheel event; ui/settings-schema.ts
// writes it. Imports prefs.ts and nothing else.

import { readPref, writePref } from './prefs.ts';

/**
 * What a plain wheel notch does.
 *
 * 'zoom' is the app's own default and what a board has always done: a notch
 * over an infinite canvas is a zoom, the way it is in every drawing tool.
 * 'scroll' is the other convention - the one a browser, a document and a map
 * all use - where a notch moves the board and Control is what zooms.
 * 'zoom-all' is the way out when the wheel is taken for a touchpad, which
 * Chromium on Linux makes impossible to rule out (a hi-res wheel and a pad
 * send the same numbers): every plain scroll zooms, a two-finger swipe too.
 */
type WheelMode ='zoom' | 'scroll' | 'zoom-all';

const MODES: readonly WheelMode[] = ['zoom', 'scroll', 'zoom-all'];
const asMode = (v: unknown): WheelMode =>
  MODES.find(m => m === v) ?? 'zoom';

/** Both answers together, as readWheel() takes them. */
export type WheelPrefs = { mode: WheelMode, reverse: boolean };

/** What the wheel does with nothing stored: the board's own convention. */
export const DEFAULT_WHEEL: WheelPrefs = { mode: 'zoom', reverse: false };

const MODE_PREF = 'mbrd.wheelMode';
const REVERSE_PREF = 'mbrd.wheelReverse';

export function wheelMode(): WheelMode {
  return asMode(readPref(MODE_PREF));
}

export function setWheelMode(mode: string): void {
  writePref(MODE_PREF, asMode(mode));
}

export function zoomReversed(): boolean {
  return readPref(REVERSE_PREF) === 'true';
}

export function setZoomReversed(on: boolean): void {
  writePref(REVERSE_PREF, !!on);
}

/**
 * Read fresh on every wheel event rather than cached in a module variable.
 *
 * A localStorage read is a few microseconds and a wheel is at most a few
 * hundred events a second; a cache would be a second copy of the answer that
 * the panel then has to remember to invalidate, which is the shape of bug
 * where a setting works until the second time you change it.
 */
export function wheelPrefs(): WheelPrefs {
  return { mode: wheelMode(), reverse: zoomReversed() };
}
