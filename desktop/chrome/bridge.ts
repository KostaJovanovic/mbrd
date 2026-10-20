// The two bridges chrome/preload.ts exposes: mbrdChrome for the title bar, and
// mbrdPanel for an open menu. Types only, shared by the preload, both pages and
// menu.ts, which are separate bundles with no scope between them.

export interface WinState {
  maximized: boolean;
  fullScreen: boolean;
  focused: boolean;
}

/** What the bar's Update button says (desktop/updates.ts). `available`: a
 *  newer version this copy can install, and a press downloads it, then
 *  installs it. `downloading` counts `progress` from 0 to 1. `installing`:
 *  the app is closing into the new version. `manual`: this copy cannot
 *  replace itself (macOS, a portable copy), and a press opens the download
 *  page. `failed`: a press tries again. `checking`, `current` and `dev`
 *  answer Help > Check for updates, and pass. */
export type UpdateState =
  'available' | 'downloading' | 'installing' | 'manual' | 'failed' | 'checking' | 'current' | 'dev';

export interface UpdateOffer {
  state: UpdateState;
  /** The version on offer, or '' for an answer about none. */
  version: string;
  /** How much has downloaded, from 0 to 1, while `downloading`. */
  progress?: number;
  /** The button's tooltip: the whole sentence the word stands for. */
  note: string;
}

/** What the bar names: the board's title, and whether it has unsaved work. */
export interface Subject {
  title: string;
  dirty: boolean;
}

export interface MenuEntry {
  id: string;
  label: string;
  /** An Electron accelerator string, or '' for none. */
  accel: string;
}

export interface MenuSeparator {
  separator: true;
}

export type MenuItem = MenuEntry | MenuSeparator;

/** One top-level menu, as plain data. A click comes back as an entry's id. */
export interface MenuModel {
  id: string;
  label: string;
  items: MenuItem[];
}

export interface Point {
  x: number;
  y: number;
}

export interface ChromeBridge {
  platform: string;
  minimize(): void;
  toggleMaximize(): void;
  close(): void;
  menuModel(): Promise<MenuModel[]>;
  /** Drop a menu under a title, at the title's box in the bar's own coordinates. */
  openMenu(id: string, x: number, y: number): void;
  closeMenu(): void;
  onState(fn: (state: WinState) => void): void;
  onSubject(fn: (subject: Subject) => void): void;
  onMenuClosed(fn: () => void): void;
  /** The update to offer, or null for no button. */
  onUpdate(fn: (offer: UpdateOffer | null) => void): void;
  /** The Update button was pressed. */
  update(): void;
  /** The bar's measured height, in its own CSS pixels. */
  height(px: number): void;
  ready(): void;
}

/** A menu to draw. `opening`: the panel was hidden, so it fades in once shown. */
export interface MenuOpen {
  menu: MenuModel;
  at: Point;
  opening: boolean;
}

export interface PanelBridge {
  platform: string;
  onMenu(fn: (open: MenuOpen) => void): void;
  /** The window is on screen: the fade can start. */
  onShown(fn: () => void): void;
  /** The window is about to hide: draw nothing, then say so with blanked(). */
  onBlank(fn: () => void): void;
  blanked(): void;
  size(w: number, h: number, at: Point): void;
  run(id: string): void;
  close(): void;
}
