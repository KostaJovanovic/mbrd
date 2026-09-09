// The native menu bar, as a table.
//
// A table and not a `Menu.buildFromTemplate()` call with logic in it, and the
// reason is the same one CLAUDE.md gives for `cmds`: **a user-facing action is
// an entry in the command table, never a second implementation.** The menu is a
// second *surface* onto the same commands, which is fine; a menu that did
// anything a command does not would be a second place the app's behaviour is
// written, and the first thing to drift.
//
// So every item that acts names a command by string and nothing else. The click
// sends `cmd:<name>`, the renderer looks it up in the object createCommands()
// builds, and `tests/desktop-menu.test.js` reads this file as text and asserts
// every name is a key that object returns - the same job tests/icons.test.js
// does for icon names, for the same failure: a menu item wired to a name
// nothing defines draws, is clickable, and does nothing at all.
//
// ── roles, and where they are not optional ──
//
// Cut, Copy, Paste and Select All carry Electron `role`s rather than commands.
// That is not laziness about the app's own clipboard: a role is what makes the
// item work inside a *native text field* - the board title, a note being
// edited, the find box - where the page's own handler is not what the OS is
// talking to. The board's clipboard commands are still bound to the same
// keystrokes by canvas/input.ts and still act on cards. Both are correct at
// once because they act on different things, and which one fires is decided by
// what has focus, by the OS, which is the only place that knows.
//
// ── Accelerators, and the open question ──
//
// The accelerators here are the same keystrokes canvas/input.ts binds. On some
// systems Electron fires the menu item *and* delivers the keydown to the page,
// which would run the command twice. Both roads end at the same `cmds` entry,
// so a double-fire is a duplicate save rather than a wrong one - but it is an
// open question in the plan's §12, to be answered by pressing the keys on each
// OS with DevTools open, not by guessing here.

import { app, Menu, shell, BrowserWindow } from 'electron';
import type { MenuItemConstructorOptions } from 'electron';
import { logDir } from './log.ts';

/**
 * One row of a submenu.
 *
 * `cmd` and `role` are the two ways an item can act and an item has exactly
 * one. `separator` is neither, and is the third shape a row can take.
 */
interface Row {
  label?: string;
  /** A key of the object createCommands() returns. Checked by a test. */
  cmd?: string;
  role?: MenuItemConstructorOptions['role'];
  accelerator?: string;
  separator?: true;
  /** A URL to open in the system browser. Help's outward links. */
  url?: string;
  /** Something only main can do - show a folder, quit. */
  main?: 'logs' | 'quit';
}

const MENU: { label: string, rows: Row[] }[] = [
  {
    label: '&File',
    rows: [
      { label: 'New Board', cmd: 'new', accelerator: 'CmdOrCtrl+N' },
      { label: 'Open…', cmd: 'open', accelerator: 'CmdOrCtrl+O' },
      { label: 'Boards…', cmd: 'library', accelerator: 'CmdOrCtrl+B' },
      { separator: true },
      { label: 'Save', cmd: 'save', accelerator: 'CmdOrCtrl+S' },
      { label: 'Save As…', cmd: 'saveAs', accelerator: 'CmdOrCtrl+Shift+S' },
      { separator: true },
      // Export is "write a copy", which is what it means on both shells - see
      // commands/file.ts. It has no accelerator: Ctrl+Shift+S is Save As here,
      // and a copy is a deliberate act rather than a reflex.
      { label: 'Export a Copy…', cmd: 'exportAs' },
      { label: 'Export as Picture…', cmd: 'exportImage' },
      { label: 'Export as PDF…', cmd: 'exportPdf' },
      { separator: true },
      { label: 'Add Files…', cmd: 'addFiles' },
      { separator: true },
      { label: 'Close Window', role: 'close' },
      // Quit is main's, not a command: there is nothing in web/ that ends a
      // process, and there should not be. macOS puts its own Quit on the app
      // menu, so this row is for the other two.
      ...(process.platform === 'darwin' ? [] : [{ label: 'Quit', main: 'quit' as const }]),
    ],
  },
  {
    label: '&Edit',
    rows: [
      { label: 'Undo', cmd: 'undo', accelerator: 'CmdOrCtrl+Z' },
      { label: 'Redo', cmd: 'redo', accelerator: 'CmdOrCtrl+Shift+Z' },
      { separator: true },
      // Roles, for the reason the header gives: these have to work inside a
      // text field, and only the OS knows when one has focus.
      { label: 'Cut', role: 'cut' },
      { label: 'Copy', role: 'copy' },
      { label: 'Paste', role: 'paste' },
      { separator: true },
      { label: 'Select All', cmd: 'selectAll', accelerator: 'CmdOrCtrl+A' },
      { label: 'Duplicate', cmd: 'duplicate', accelerator: 'CmdOrCtrl+D' },
      { label: 'Delete', cmd: 'deleteSelection' },
      { separator: true },
      { label: 'Find…', cmd: 'find', accelerator: 'CmdOrCtrl+F' },
    ],
  },
  {
    label: '&View',
    rows: [
      { label: 'Fit to Board', cmd: 'fit' },
      { label: 'Recentre', cmd: 'recenter' },
      { separator: true },
      { label: 'Canvas', cmd: 'canvas' },
      { label: 'Feed', cmd: 'feed' },
      { label: 'Timeline', cmd: 'timeline' },
      { separator: true },
      { label: 'Rearrange', cmd: 'rearrange' },
      { label: 'Optimise…', cmd: 'optimize' },
      { separator: true },
      // Zoom is the window's, not the board's. Electron's zoom roles scale the
      // whole page - the sidebar, the toolbar, the type - which is an
      // accessibility control; the board's own zoom is the wheel and the
      // trackpad and belongs to canvas/input.ts, where the coordinate model is.
      { label: 'Actual Size', role: 'resetZoom' },
      { label: 'Zoom In', role: 'zoomIn' },
      { label: 'Zoom Out', role: 'zoomOut' },
      { separator: true },
      { label: 'Full Screen', role: 'togglefullscreen' },
      { separator: true },
      // Ctrl+R, which a frameless Electron window does not bind on its own -
      // the accelerator comes from the menu bar, and until this row existed
      // there was no menu item to carry it, so the keystroke did nothing at
      // all. It is here rather than left out because this is how a change to
      // web/ is seen: the protocol handler reads that tree off the disk fresh
      // on every request, so a reload picks up the last build with no relaunch.
      //
      // A role rather than a command. Reloading is the window's own affair and
      // the page has no say in it, which is also why it is safe: the board is
      // written to the recovery store as it changes and the app reads it back
      // on boot, so a reload lands on the same board. Not `forceReload` - that
      // one empties the HTTP cache too, and there is nothing here to empty.
      { label: 'Reload', role: 'reload', accelerator: 'CmdOrCtrl+R' },
      { label: 'Developer Tools', role: 'toggleDevTools' },
    ],
  },
  {
    label: '&Help',
    rows: [
      { label: 'About mbrd', cmd: 'credits' },
      { label: 'What Changed', cmd: 'patchNotes' },
      { label: 'Take the Tour', cmd: 'tourStart' },
      { separator: true },
      { label: "What's on This Board", cmd: 'inventory' },
      { separator: true },
      // The one thing an unsigned build on somebody else's machine needs and
      // cannot get from the app: the log file. See desktop/log.ts.
      { label: 'Show Logs', main: 'logs' },
      { label: 'Report a Problem', url: 'https://github.com/valjdakosta/mbrd/issues' },
    ],
  },
];

/**
 * Build the menu and install it.
 *
 * `send` is how a row reaches the app - one function, passed in, rather than a
 * BrowserWindow this module reaches for. It keeps the table above readable as a
 * table and means the menu can be built before the window exists.
 */
export function installMenu(send: (cmd: string) => void): void {
  const template: MenuItemConstructorOptions[] = MENU.map(section => ({
    label: section.label,
    submenu: section.rows.map(row => toItem(row, send)),
  }));

  // macOS insists on an application menu in the first position - without one,
  // the first section this file defines is drawn under the app's name and File
  // disappears. `role: 'appMenu'` is Electron's own, with the Services and Hide
  // items a Mac user expects and this app has no opinion about.
  if (process.platform === 'darwin') {
    template.unshift({ role: 'appMenu' });
  }

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function toItem(row: Row, send: (cmd: string) => void): MenuItemConstructorOptions {
  if (row.separator) return { type: 'separator' };
  const item: MenuItemConstructorOptions = { label: row.label, accelerator: row.accelerator };
  if (row.role) {
    item.role = row.role;
    return item;
  }
  if (row.url) {
    const url = row.url;
    item.click = () => { void shell.openExternal(url); };
    return item;
  }
  if (row.main === 'quit') {
    // Not `role: 'quit'`: that ends the process without the close handler, and
    // the close handler is what flushes the board. app.quit() closes the
    // windows first, which is what holdCloseForFlush() is waiting for.
    item.click = () => app.quit();
    return item;
  }
  if (row.main === 'logs') {
    item.click = () => {
      const dir = logDir();
      if (dir) void shell.openPath(dir);
    };
    return item;
  }
  const cmd = row.cmd;
  if (cmd) item.click = () => send(cmd);
  return item;
}

/** Whether there is a window to send to. Used by main when a row fires early. */
export const anyWindow = () => BrowserWindow.getAllWindows()[0] ?? null;
