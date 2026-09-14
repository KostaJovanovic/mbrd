// The two bridges chrome/preload.ts exposes: mbrdChrome for the title bar, and
// mbrdPanel for an open menu. Types only, shared by the preload, both pages and
// menu.ts, which are separate bundles with no scope between them.

export interface WinState {
  maximized: boolean;
  fullScreen: boolean;
  focused: boolean;
}

/** An update the bar's Update button offers. `install`: this copy can put it in
 *  place itself (the Windows install, the AppImage), and it has downloaded.
 *  Otherwise the button says how to get it (macOS, a portable copy). */
export interface UpdateOffer {
  version: string;
  install: boolean;
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

export interface PanelBridge {
  platform: string;
  onMenu(fn: (open: { menu: MenuModel, at: Point }) => void): void;
  size(w: number, h: number, at: Point): void;
  run(id: string): void;
  close(): void;
}
