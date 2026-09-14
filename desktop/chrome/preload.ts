// The title bar's and the menu panel's preload. Not the board's (../preload.ts):
// the bar moves the window and draws the menus, and has no business reaching
// the store, the files or ffmpeg, so it cannot. Two disjoint bridges, and main
// checks the sender of every message. CommonJS, as a sandboxed preload must be.

import { contextBridge, ipcRenderer } from 'electron';
import type { ChromeBridge, MenuModel, PanelBridge, Point, Subject, UpdateOffer, WinState } from './bridge.ts';

// Kept here, so a handler registered late still gets the last value and the bar
// paints the right glyph and title on its first frame. One handler each: one
// page, registered once.
let winState: WinState = { maximized: false, fullScreen: false, focused: true };
let subject: Subject = { title: '', dirty: false };
let onState: ((state: WinState) => void) | null = null;
let onSubject: ((subject: Subject) => void) | null = null;
let onMenuClosed: (() => void) | null = null;
let onMenu: ((open: { menu: MenuModel, at: Point }) => void) | null = null;
let offer: UpdateOffer | null = null;
let onUpdate: ((offer: UpdateOffer | null) => void) | null = null;

ipcRenderer.on('chrome:state', (_event, state: WinState) => {
  winState = state;
  onState?.(state);
});
ipcRenderer.on('chrome:subject', (_event, next: Subject) => {
  subject = next;
  onSubject?.(next);
});
ipcRenderer.on('chrome:update', (_event, next: UpdateOffer | null) => {
  offer = next;
  onUpdate?.(next);
});
ipcRenderer.on('chrome:menu-closed', () => onMenuClosed?.());
ipcRenderer.on('panel:menu', (_event, open: { menu: MenuModel, at: Point }) => onMenu?.(open));

const chrome: ChromeBridge = {
  platform: process.platform,
  minimize: () => { void ipcRenderer.invoke('chrome:win', 'minimize'); },
  toggleMaximize: () => { void ipcRenderer.invoke('chrome:win', 'maximize'); },
  close: () => { void ipcRenderer.invoke('chrome:win', 'close'); },
  menuModel: () => ipcRenderer.invoke('chrome:menu-model'),
  openMenu: (id, x, y) => ipcRenderer.send('chrome:menu-open', { id, x, y }),
  closeMenu: () => ipcRenderer.send('chrome:menu-close'),
  onState: fn => {
    onState = fn;
    fn(winState);
  },
  onSubject: fn => {
    onSubject = fn;
    fn(subject);
  },
  onMenuClosed: fn => { onMenuClosed = fn; },
  onUpdate: fn => {
    onUpdate = fn;
    fn(offer);
  },
  update: () => ipcRenderer.send('chrome:update-press'),
  height: px => ipcRenderer.send('chrome:height', px),
  ready: () => ipcRenderer.send('chrome:ready'),
};

const panel: PanelBridge = {
  platform: process.platform,
  onMenu: fn => { onMenu = fn; },
  size: (w, h, at) => ipcRenderer.send('panel:size', { w, h, at }),
  run: id => ipcRenderer.send('panel:run', id),
  close: () => ipcRenderer.send('panel:close'),
};

contextBridge.exposeInMainWorld('mbrdChrome', chrome);
contextBridge.exposeInMainWorld('mbrdPanel', panel);
