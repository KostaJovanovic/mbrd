// Native menu bar. Every item names a command string; the renderer dispatches
// it through the same cmds table the toolbar uses. Roles (cut/copy/paste)
// handle native text fields where the page handler cannot reach.
// tests/desktop-menu.test.js asserts every cmd name exists in createCommands().

import { app, Menu, shell, BrowserWindow } from 'electron';
import type { MenuItemConstructorOptions } from 'electron';
import { logDir } from './log.ts';

// A submenu row: either a cmd, a role, a separator, a url, or a main action.
interface Row {
  label?: string;
  cmd?: string;
  role?: MenuItemConstructorOptions['role'];
  accelerator?: string;
  separator?: true;
  url?: string;
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
      // No accelerator: a copy is a deliberate act.
      { label: 'Export a Copy…', cmd: 'exportAs' },
      { label: 'Export as Picture…', cmd: 'exportImage' },
      { label: 'Export as PDF…', cmd: 'exportPdf' },
      { separator: true },
      { label: 'Add Files…', cmd: 'addFiles' },
      { separator: true },
      { label: 'Close Window', role: 'close' },
      // macOS has its own Quit in the app menu.
      ...(process.platform === 'darwin' ? [] : [{ label: 'Quit', main: 'quit' as const }]),
    ],
  },
  {
    label: '&Edit',
    rows: [
      { label: 'Undo', cmd: 'undo', accelerator: 'CmdOrCtrl+Z' },
      { label: 'Redo', cmd: 'redo', accelerator: 'CmdOrCtrl+Shift+Z' },
      { separator: true },
      // Roles: must work inside native text fields.
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
      // Page zoom (accessibility), not board zoom (canvas/input.ts).
      { label: 'Actual Size', role: 'resetZoom' },
      { label: 'Zoom In', role: 'zoomIn' },
      { label: 'Zoom Out', role: 'zoomOut' },
      { separator: true },
      { label: 'Full Screen', role: 'togglefullscreen' },
      { separator: true },
      // A role: reload picks up the last build from disk, and the recovery
      // store means the board survives it.
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
      // Opens the log directory on disk.
      { label: 'Show Logs', main: 'logs' },
      { label: 'Report a Problem', url: 'https://github.com/valjdakosta/mbrd/issues' },
    ],
  },
];

// Build and install the menu. `send` dispatches a cmd to the renderer.
export function installMenu(send: (cmd: string) => void): void {
  const template: MenuItemConstructorOptions[] = MENU.map(section => ({
    label: section.label,
    submenu: section.rows.map(row => toItem(row, send)),
  }));

  // macOS needs an app menu first or File disappears.
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
    // app.quit() not role:quit — must go through holdCloseForFlush.
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

export const anyWindow = () => BrowserWindow.getAllWindows()[0] ?? null;
