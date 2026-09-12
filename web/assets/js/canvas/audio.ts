// Audio engine: one global volume, one clip at a time, "what is playing".
// No DOM, no queue, no waveform — those live in transport.ts, playlist-queue.ts,
// waveform.ts. Everything depends on this, not the other way round.

import { clamp } from '../util.ts';
import { readPref, writePref } from '../prefs.ts';
import { reportPlayError } from '../media/transport.ts';
import type { Item } from '../board-model.ts';

export type Player = HTMLMediaElement;

export type NowPlaying = { el: Player; item: Item };

const VOLUME_KEY = 'mbrd.volume';
const DEFAULT_VOLUME = 0.6;

let volume = DEFAULT_VOLUME;
const players = new Set<Player>();
// Weak so a deleted card's element is not kept alive by this map.
const owners = new WeakMap<Player, Item>();

const volumeWatchers = new Set<(v: number) => void>();
const playingWatchers = new Set<(now: NowPlaying | null) => void>();
// Told when an element is destroyed — the queue drops its references through this.
const releaseWatchers = new Set<(el: Player) => void>();

// Not cleared on pause — a paused track is still "now playing" until the element goes away.
let current: NowPlaying | null = null;

export const nowPlaying = () => current;
export const getVolume = () => volume;

// Returns false when nothing is loaded, so Space can fall back.
export function togglePlayback() {
  const el = current?.el;
  if (!el) return false;
  if (el.paused) el.play().catch(reportPlayError); else el.pause();
  return true;
}

// Clears current so the next play on the same card registers as a change.
export function clearNowPlaying() {
  setNowPlaying(null);
}

export function onNowPlaying(fn: (now: NowPlaying | null) => void) {
  playingWatchers.add(fn);
  return () => playingWatchers.delete(fn);
}

export function onVolume(fn: (v: number) => void) {
  volumeWatchers.add(fn);
  return () => volumeWatchers.delete(fn);
}

export function onPlayerReleased(fn: (el: Player) => void) {
  releaseWatchers.add(fn);
  return () => releaseWatchers.delete(fn);
}

// Exported for the queue, which repoints a long-lived element without any event firing.
export function setNowPlaying(next: NowPlaying | null): void {
  if (current?.el === next?.el && current?.item === next?.item) return;
  current = next;
  for (const fn of playingWatchers) fn(current);
}

export const registeredPlayers = () => players.values();
export const ownerOf = (el: Player) => owners.get(el);

export function claimPlayer(el: Player, item: Item | null | undefined): void {
  if (item) owners.set(el, item);
}

export function initAudio() {
  volume = readVolume();
  // pagehide + visibilitychange: iOS Safari skips beforeunload, discarded tabs skip both unload events.
  addEventListener('pagehide', flushVolume);
  addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushVolume();
  });
}

// True on iPhone Safari where script volume is locked to hardware.
export function volumeLocked() {
  try {
    const probe = new Audio();
    probe.volume = 0.5;
    return probe.volume === 1;
  } catch {
    return false;
  }
}

// Square law: half travel = -12 dB ≈ half as loud. Stored value is amplitude.
const VOLUME_GAMMA = 2;

export const sliderToVolume = (pos: number) => clamp(pos, 0, 1) ** VOLUME_GAMMA;
export const volumeToSlider = (v: number) => clamp(v, 0, 1) ** (1 / VOLUME_GAMMA);

export function setVolume(v: number): void {
  volume = clamp(+v || 0, 0, 1);
  for (const a of players) a.volume = volume;
  storeVolume();
  for (const fn of volumeWatchers) fn(volume);
}

// Throttle localStorage writes during slider drag.
const PREF_MS = 200;
let prefTimer = 0;

function storeVolume(now = false) {
  if (now) {
    if (prefTimer) { clearTimeout(prefTimer); prefTimer = 0; }
    writePref(VOLUME_KEY, volume);
    return;
  }
  if (prefTimer) return;
  prefTimer = setTimeout(() => {
    prefTimer = 0;
    writePref(VOLUME_KEY, volume);
  }, PREF_MS);
}

function flushVolume() {
  if (prefTimer) storeVolume(true);
}

function readVolume() {
  const n = parseFloat(readPref(VOLUME_KEY) ?? '');
  return Number.isFinite(n) ? clamp(n, 0, 1) : DEFAULT_VOLUME;
}

// Survives culling (detach+reattach) but not destruction — see releasePlayers.
export function registerPlayer(el: Player, item: Item | null = null): void {
  el.volume = volume;
  players.add(el);
  if (item) owners.set(el, item);

  // On 'play' rather than button click: catches media keys, seeks, OS controls.
  el.addEventListener('play', () => {
    for (const other of players) {
      // Yielding clip rewinds — this is a player, not bookmarks.
      if (other !== el && !other.paused) { other.pause(); other.currentTime = 0; }
    }
    const owner = owners.get(el);
    if (owner) setNowPlaying({ el, item: owner });
  });
}

// Tears down every player inside a card being destroyed.
export function releasePlayers(root: Element): void {
  for (const el of root.querySelectorAll?.<Player>('audio, video') || []) {
    el.pause();
    players.delete(el);
    owners.delete(el);
    if (current?.el === el) setNowPlaying(null);
    for (const fn of releaseWatchers) fn(el);
  }
}
