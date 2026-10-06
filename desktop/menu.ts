// The application menu: one table, three consumers. buildMenu() makes the
// hidden Electron Menu, which is what registers every accelerator. menuModel()
// hands the title bar (chrome/titlebar.ts) the same rows as plain data to draw.
// runMenuItem() runs a drawn click by id, so what an entry does is written here
// once. tests/desktop-menu.test.js checks every cmd name here against createCommands().

import { app, Menu, shell } from 'electron';
import type { MenuItemConstructorOptions } from 'electron';
import type { MenuItem, MenuModel } from './chrome/bridge.ts';
import { mkdir } from 'node:fs/promises';
import { logDir } from './log.ts';
import { backupFolder } from './files.ts';

const isMac = process.platform === 'darwin';

/** The rows that were Electron roles. A role means something only inside a real
 * Menu, and the drawn one is not, so main runs each against the board's view. */
export type ViewAction = 'reload' | 'devTools' | 'zoomIn' | 'zoomOut' | 'zoomReset' | 'fullScreen' | 'close';

/** What the menu asks of main. */
export interface MenuActions {
  /** Dispatch a command in the board, through the cmds table the toolbar uses. */
  send(cmd: string): void;
  view(what: ViewAction): void;
  showData(): void;
  checkUpdates(): void;
}

// A submenu row: a cmd, a view action, a main action, a url, a role or a separator.
interface Row {
  /** What the drawn menu sends back. Every clickable row has one. */
  id?: string;
  label?: string;
  cmd?: string;
  view?: ViewAction;
  main?: 'logs' | 'quit' | 'data' | 'updates' | 'backups';
  url?: string;
  /** In the hidden Menu only: a role cannot run from the drawn one. */
  role?: MenuItemConstructorOptions['role'];
  accelerator?: string;
  separator?: true;
}

const MENU: { id: string, label: string, rows: Row[] }[] = [
  {
    id: 'file',
    label: '&File',
    rows: [
      { id: 'file.new', label: 'New Board', cmd: 'new', accelerator: 'CmdOrCtrl+N' },
      { id: 'file.open', label: 'Open…', cmd: 'open', accelerator: 'CmdOrCtrl+O' },
      { id: 'file.boards', label: 'Boards…', cmd: 'library', accelerator: 'CmdOrCtrl+B' },
      { separator: true },
      { id: 'file.save', label: 'Save', cmd: 'save', accelerator: 'CmdOrCtrl+S' },
      { id: 'file.saveAs', label: 'Save As…', cmd: 'saveAs', accelerator: 'CmdOrCtrl+Shift+S' },
      { separator: true },
      // No accelerator: a copy is a deliberate act.
      { id: 'file.exportAs', label: 'Export a Copy…', cmd: 'exportAs' },
      { id: 'file.exportImage', label: 'Export as Picture…', cmd: 'exportImage' },
      { id: 'file.exportPdf', label: 'Export as PDF…', cmd: 'exportPdf' },
      { separator: true },
      { id: 'file.addFiles', label: 'Add Files…', cmd: 'addFiles' },
      { separator: true },
      { id: 'file.close', label: 'Close Window', view: 'close', accelerator: 'CmdOrCtrl+W' },
      // macOS has its own Quit in the app menu.
      ...(isMac ? [] : [{ id: 'file.quit', label: 'Quit', main: 'quit' as const }]),
    ],
  },
  {
    id: 'edit',
    label: '&Edit',
    rows: [
      { id: 'edit.undo', label: 'Undo', cmd: 'undo', accelerator: 'CmdOrCtrl+Z' },
      { id: 'edit.redo', label: 'Redo', cmd: 'redo', accelerator: 'CmdOrCtrl+Shift+Z' },
      { separator: true },
      // Roles: must work inside native text fields. The drawn menu leaves them
      // out, and the page's own context menu carries them.
      { label: 'Cut', role: 'cut' },
      { label: 'Copy', role: 'copy' },
      { label: 'Paste', role: 'paste' },
      { separator: true },
      { id: 'edit.selectAll', label: 'Select All', cmd: 'selectAll', accelerator: 'CmdOrCtrl+A' },
      { id: 'edit.duplicate', label: 'Duplicate', cmd: 'duplicate', accelerator: 'CmdOrCtrl+D' },
      { id: 'edit.delete', label: 'Delete', cmd: 'deleteSelection' },
      { separator: true },
      { id: 'edit.find', label: 'Find…', cmd: 'find', accelerator: 'CmdOrCtrl+F' },
    ],
  },
  {
    id: 'view',
    label: '&View',
    rows: [
      { id: 'view.fit', label: 'Fit to Board', cmd: 'fit' },
      { id: 'view.recenter', label: 'Recentre', cmd: 'recenter' },
      { separator: true },
      { id: 'view.canvas', label: 'Canvas', cmd: 'canvas' },
      { id: 'view.feed', label: 'Feed', cmd: 'feed' },
      { id: 'view.timeline', label: 'Timeline', cmd: 'timeline' },
      { separator: true },
      { id: 'view.rearrange', label: 'Rearrange', cmd: 'rearrange' },
      { id: 'view.optimize', label: 'Optimise…', cmd: 'optimize' },
      { separator: true },
      // Page zoom (accessibility), not board zoom (canvas/input.ts). The
      // accelerators are the ones the roles carried.
      { id: 'view.zoomReset', label: 'Actual Size', view: 'zoomReset', accelerator: 'CmdOrCtrl+0' },
      { id: 'view.zoomIn', label: 'Zoom In', view: 'zoomIn', accelerator: 'CmdOrCtrl+Plus' },
      { id: 'view.zoomOut', label: 'Zoom Out', view: 'zoomOut', accelerator: 'CmdOrCtrl+-' },
      { separator: true },
      { id: 'view.fullScreen', label: 'Full Screen', view: 'fullScreen', accelerator: isMac ? 'Ctrl+Cmd+F' : 'F11' },
      { separator: true },
      // Reload picks up the last build from disk, and the recovery store means
      // the board survives it.
      { id: 'view.reload', label: 'Reload', view: 'reload', accelerator: 'CmdOrCtrl+R' },
      { id: 'view.devTools', label: 'Developer Tools', view: 'devTools', accelerator: isMac ? 'Alt+Cmd+I' : 'Ctrl+Shift+I' },
    ],
  },
  {
    id: 'help',
    label: '&Help',
    rows: [
      { id: 'help.about', label: 'About mbrd', cmd: 'credits' },
      { id: 'help.changes', label: 'What Changed', cmd: 'patchNotes' },
      { id: 'help.tour', label: 'Take the Tour', cmd: 'appTour' },
      { id: 'help.example', label: 'Open the Example Board', cmd: 'exampleBoard' },
      // No accelerator: '?' is a character, and a native accelerator would take
      // it out of every note and field. The page's own keydown answers it.
      { id: 'help.shortcuts', label: 'Keyboard Shortcuts', cmd: 'shortcuts' },
      { separator: true },
      { id: 'help.inventory', label: "What's on This Board", cmd: 'inventory' },
      { separator: true },
      // A portable copy keeps everything beside the program. This makes that checkable.
      { id: 'help.data', label: 'Where My Data Is Stored', main: 'data' },
      // updates.ts also checks by itself. This is the check on demand.
      { id: 'help.updates', label: 'Check for Updates', main: 'updates' },
      { separator: true },
      // Opens the log directory on disk.
      { id: 'help.logs', label: 'Show Logs', main: 'logs' },
      // The rolling copies files.ts keeps before a save overwrites a board.
      { id: 'help.backups', label: 'Show Backups', main: 'backups' },
      { id: 'help.report', label: 'Report a Problem', cmd: 'reportProblem' },
    ],
  },
];

/** The real Menu. Never shown on Windows or Linux, where the window has no
 * frame to drop it from, but setting it is what makes the accelerators live. */
export function buildMenu(actions: MenuActions): Menu {
  const template: MenuItemConstructorOptions[] = MENU.map(section => ({
    label: section.label,
    submenu: section.rows.map(row => toItem(row, actions)),
  }));

  // macOS needs an app menu first or File disappears.
  if (isMac) template.unshift({ role: 'appMenu' });

  return Menu.buildFromTemplate(template);
}

/** The same table as plain data, for the title bar to draw. No function crosses
 * the IPC boundary: a click comes back as an id. */
export function menuModel(): MenuModel[] {
  return MENU.map(section => {
    const items: MenuItem[] = [];
    for (const row of section.rows) {
      if (row.separator) {
        // Never first and never two in a row: leaving the roles out can make both.
        const last = items.at(-1);
        if (last && !('separator' in last)) items.push({ separator: true });
        continue;
      }
      if (!row.id || row.role) continue;
      items.push({ id: row.id, label: plain(row.label ?? ''), accel: row.accelerator ?? '' });
    }
    const last = items.at(-1);
    if (last && 'separator' in last) items.pop();
    return { id: section.id, label: plain(section.label), items };
  });
}

/** Run the entry the title bar reports. The id arrives from a renderer, so it
 * is looked up in the table, and an unknown one does nothing. */
export function runMenuItem(id: string, actions: MenuActions): boolean {
  for (const section of MENU) {
    for (const row of section.rows) {
      if (row.id !== id || row.role) continue;
      const run = clickOf(row, actions);
      if (!run) return false;
      run();
      return true;
    }
  }
  return false;
}

/** '&File' -> 'File'. The ampersand marks the Alt key for the hidden Menu. */
const plain = (label: string) => label.replace(/&(?=\S)/g, '');

function toItem(row: Row, actions: MenuActions): MenuItemConstructorOptions {
  if (row.separator) return { type: 'separator' };
  if (row.role) return { label: row.label, role: row.role };
  return { label: row.label, accelerator: row.accelerator, click: clickOf(row, actions) };
}

/** What a row does. The one place that says so. */
function clickOf(row: Row, actions: MenuActions): (() => void) | undefined {
  const { cmd, view, url, main } = row;
  if (cmd) return () => actions.send(cmd);
  if (view) return () => actions.view(view);
  if (url) return () => { void shell.openExternal(url); };
  switch (main) {
    // app.quit() not role:quit, so the close goes through holdCloseForFlush.
    case 'quit': return () => app.quit();
    case 'logs': return () => {
      const dir = logDir();
      if (dir) void shell.openPath(dir);
    };
    case 'backups': return () => {
      const dir = backupFolder();
      if (dir) void mkdir(dir, { recursive: true }).then(() => shell.openPath(dir));
    };
    case 'data': return () => actions.showData();
    case 'updates': return () => actions.checkUpdates();
    default: return undefined;
  }
}
